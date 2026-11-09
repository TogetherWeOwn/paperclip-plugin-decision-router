import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const held = JSON.parse(readFileSync(new URL("./fixtures/held-dependencies.json", import.meta.url), "utf8"));

interface LockEntry {
  version?: string;
  integrity?: string;
  resolved?: string;
  dependencies?: Record<string, string>;
}
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const selected = ["@paperclipai/plugin-sdk", "@paperclipai/shared", "zod"];

function checkPins(packages: Record<string, LockEntry>) {
  for (const name of selected) {
    const version = name === "zod" ? "4.6.7" : "2026.831.0";
    expect(pkg.dependencies[name]).toBe(version);
    expect(packages[""]!.dependencies?.[name]).toBe(version);
    expect(packages[`node_modules/${name}`]!.version).toBe(version);
  }
  expect(packages["node_modules/@paperclipai/plugin-sdk"]!.dependencies?.["@paperclipai/shared"]).toBe("2026.831.0");
  const zodPaths = Object.keys(packages).filter((path) => /(^|\/)node_modules\/zod$/.test(path));
  expect(zodPaths.length).toBeGreaterThan(0);
  for (const path of zodPaths) {
    // Stable numeric versions only: a prerelease is not proof of the patched floor.
    const version = packages[path]!.version ?? "";
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    expect(major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6)))).toBe(true);
  }
  const actualHeld = Object.fromEntries(Object.entries(packages)
    .filter(([path]) => path !== "" && !selected.some((name) => path === `node_modules/${name}`))
    .map(([path, entry]) => [path, Object.fromEntries(
      ["version", "integrity", "resolved"].filter((key) => key in entry)
        .map((key) => [key, entry[key as keyof LockEntry]]),
    )]));
  expect(actualHeld).toEqual(held);
}

describe("dependency remediation pins", () => {
  it("keeps every held lock path/version/integrity and patches every Zod copy", () => {
    checkPins(lock.packages);
    expect(pkg.devDependencies).toEqual(lock.packages[""].devDependencies);
  });

  it("rejects a vulnerable nested Zod even with a patched root", () => {
    const packages = structuredClone(lock.packages);
    packages["node_modules/@paperclipai/shared/node_modules/zod"] = { version: "3.25.76" };
    expect(() => checkPins(packages)).toThrow();
  });

  it("rejects held optional-platform drift and integrity replacement", () => {
    for (const key of ["version", "integrity"]) {
      const packages = structuredClone(lock.packages);
      packages["node_modules/@esbuild/linux-x64"][key] = "unexpected";
      expect(() => checkPins(packages)).toThrow();
    }
  });
});
