// Actions-only probe of the real npm binary, using an ephemeral loopback registry.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);

// Toolchain/config prerequisites are separate from the behavioral policy verdicts.
test("Actions uses the selected native-policy npm and project settings", async () => {
  assert.equal((await exec("npm", ["--version"])).stdout.trim(), "11.19.0");
  assert.equal((await exec("npm", ["config", "get", "min-release-age"])).stdout.trim(), "3");
  assert.equal((await exec("npm", ["config", "get", "ignore-scripts"])).stdout.trim(), "true");
});

test("npm enforces three-day age and refuses root/dependency lifecycle scripts", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-policy-"));
  const server = createServer();
  try {
    const source = join(root, "source");
    const project = join(root, "project");
    await mkdir(join(source, "package"), { recursive: true });
    await mkdir(project);
    const marker = join(root, "hook-ran");
    const hook = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")'`;
    const artifacts = new Map();
    for (const version of ["1.0.0", "2.0.0"]) {
      await writeFile(join(source, "package/package.json"), JSON.stringify({
        name: "policy-probe", version, scripts: { postinstall: hook },
      }));
      const archive = join(root, `${version}.tgz`);
      await exec("tar", ["-czf", archive, "-C", source, "package"]);
      const tarball = await readFile(archive);
      artifacts.set(version, { tarball, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` });
    }
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const registry = `http://127.0.0.1:${server.address().port}`;
    const oldPublication = new Date(Date.now() - 10 * 86400_000).toISOString();
    const recentPublication = new Date(Date.now() - 3600_000).toISOString();
    let exactPublication = recentPublication;
    server.on("request", (req, res) => {
      const artifact = artifacts.get(req.url?.slice(1).replace(/\.tgz$/, ""));
      if (artifact) {
        res.end(artifact.tarball);
      } else if (req.url === "/policy-probe") {
        const versions = Object.fromEntries([...artifacts].map(([version, entry]) => [version, {
          name: "policy-probe", version, scripts: { postinstall: hook },
          dist: { tarball: `${registry}/${version}.tgz`, integrity: entry.integrity },
        }]));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ name: "policy-probe", "dist-tags": { latest: "2.0.0" }, versions,
          time: { "1.0.0": oldPublication, "2.0.0": exactPublication } }));
      } else {
        res.writeHead(404).end();
      }
    });
    await copyFile(new URL("../.npmrc", import.meta.url), join(project, ".npmrc"));
    await writeFile(join(project, "package.json"), JSON.stringify({
      name: "policy-consumer", version: "1.0.0", private: true, scripts: { preinstall: hook },
    }));
    // Isolate caches/config so an old cached packument cannot satisfy the age probe.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
    const options = { cwd: project, timeout: 30_000, env: { ...env,
      npm_config_cache: join(root, "cache"), npm_config_userconfig: join(root, "user.npmrc"),
      npm_config_globalconfig: join(root, "global.npmrc"),
    } };
    const args = ["install", "--registry", registry, "--no-audit", "--no-fund"];
    await exec("npm", [...args, "policy-probe@*"], options);
    const lock = JSON.parse(await readFile(join(project, "package-lock.json"), "utf8"));
    assert.equal(lock.packages["node_modules/policy-probe"].version, "1.0.0");
    await assert.rejects(access(marker), { code: "ENOENT" });
    const exactArgs = [...args, "policy-probe@2.0.0"];
    await assert.rejects(exec("npm", exactArgs, { ...options,
      env: { ...options.env, npm_config_cache: join(root, "recent-cache") },
    }), { code: 1 });
    const unchanged = JSON.parse(await readFile(join(project, "package-lock.json"), "utf8"));
    assert.equal(unchanged.packages["node_modules/policy-probe"].version, "1.0.0");
    await assert.rejects(access(marker), { code: "ENOENT" });
    // The same exact package must install when only its publication age changes.
    // Cold caches force both exact attempts to use the current registry metadata.
    exactPublication = oldPublication;
    await exec("npm", exactArgs, { ...options,
      env: { ...options.env, npm_config_cache: join(root, "eligible-cache") },
    });
    const eligible = JSON.parse(await readFile(join(project, "package-lock.json"), "utf8"));
    assert.equal(eligible.packages["node_modules/policy-probe"].version, "2.0.0");
    const exactInstalled = JSON.parse(await readFile(join(project, "node_modules/policy-probe/package.json"), "utf8"));
    assert.equal(exactInstalled.version, "2.0.0");
    await assert.rejects(access(marker), { code: "ENOENT" });
    exactPublication = recentPublication;
    // Native age filtering is resolution-only, not a retrospective lock audit.
    // A handcrafted, synchronized synthetic lock demonstrates that limitation
    // without ever disabling the project's age or script settings.
    const locked = join(root, "locked");
    await mkdir(locked);
    await copyFile(new URL("../.npmrc", import.meta.url), join(locked, ".npmrc"));
    const consumer = { name: "locked-consumer", version: "1.0.0", private: true,
      dependencies: { "policy-probe": "2.0.0" }, scripts: { preinstall: hook } };
    await writeFile(join(locked, "package.json"), JSON.stringify(consumer));
    await writeFile(join(locked, "package-lock.json"), JSON.stringify({
      name: consumer.name, version: consumer.version, lockfileVersion: 3, requires: true,
      packages: { "": consumer, "node_modules/policy-probe": {
        version: "2.0.0", resolved: `${registry}/2.0.0.tgz`, integrity: artifacts.get("2.0.0").integrity,
        hasInstallScript: true,
      } },
    }));
    await exec("npm", ["ci", "--registry", registry, "--no-audit", "--no-fund"], { ...options, cwd: locked });
    const installed = JSON.parse(await readFile(join(locked, "node_modules/policy-probe/package.json"), "utf8"));
    assert.equal(installed.version, "2.0.0");
    await assert.rejects(access(marker), { code: "ENOENT" });
    console.log("npm 11.19.0: old resolution selected; too-new exact resolution rejected; root/dependency hooks refused");
    console.log("Native limitation confirmed: npm ci reuses a too-new locked version; lock publication provenance needs separate review");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
