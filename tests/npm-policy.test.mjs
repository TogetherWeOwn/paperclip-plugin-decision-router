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

test("npm enforces three-day age and refuses root/dependency lifecycle scripts", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-policy-"));
  const server = createServer();
  try {
    assert.equal((await exec("npm", ["--version"])).stdout.trim(), "11.19.0");
    assert.equal((await exec("npm", ["config", "get", "min-release-age"])).stdout.trim(), "3");
    assert.equal((await exec("npm", ["config", "get", "ignore-scripts"])).stdout.trim(), "true");
    const source = join(root, "source");
    const project = join(root, "project");
    await mkdir(join(source, "package"), { recursive: true });
    await mkdir(project);
    const marker = join(root, "hook-ran");
    const hook = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")'`;
    await writeFile(join(source, "package/package.json"), JSON.stringify({
      name: "policy-probe", version: "1.0.0", scripts: { postinstall: hook },
    }));
    const archive = join(root, "probe.tgz");
    await exec("tar", ["-czf", archive, "-C", source, "package"]);
    const tarball = await readFile(archive);
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const registry = `http://127.0.0.1:${server.address().port}`;
    server.on("request", (req, res) => {
      if (req.url === "/probe.tgz") {
        res.end(tarball);
      } else if (req.url === "/policy-probe") {
        const versions = Object.fromEntries(["1.0.0", "2.0.0"].map((version) => [version, {
          name: "policy-probe", version, scripts: { postinstall: hook },
          dist: { tarball: `${registry}/probe.tgz`, integrity },
        }]));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ name: "policy-probe", "dist-tags": { latest: "2.0.0" }, versions,
          time: { "1.0.0": new Date(Date.now() - 10 * 86400_000).toISOString(),
            "2.0.0": new Date(Date.now() - 3600_000).toISOString() } }));
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
    await assert.rejects(exec("npm", [...args, "policy-probe@2.0.0"], options), (error) => {
      assert.match(error.stderr, /ETARGET/);
      return true;
    });
    await assert.rejects(access(marker), { code: "ENOENT" });
    console.log("npm 11.19.0: old version selected; too-new exact version rejected; lifecycle markers absent");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
