import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the source review tier map conservative", () => {
  const map = readFileSync(new URL("../.github/review-tiers.yml", import.meta.url), "utf8");
  const data = map.split("\n").filter((line) => line.trim() && !line.trimStart().startsWith("#")).join("\n");

  expect(data).toBe([
    "version: 1",
    "default_tier: sensitive",
    "tiers:",
    "  low:",
    "    - LICENSE",
    "  ordinary: []",
    "  sensitive: []",
  ].join("\n"));
});
