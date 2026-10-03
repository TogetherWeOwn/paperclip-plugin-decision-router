import { describe, expect, it } from "vitest";

import { SWEEP_SCHEDULE } from "../src/constants.js";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.js";
import { HOST_CAPABILITY_GAPS } from "../src/gaps.js";
import manifest from "../src/manifest.js";

describe("manifest", () => {
  it("declares the sweep job on a 5-minute schedule", () => {
    expect(SWEEP_SCHEDULE).toBe("*/5 * * * *");
    const job = manifest.jobs?.find((entry) => entry.jobKey === "sweep-decisions");
    expect(job?.schedule).toBe("*/5 * * * *");
  });

  it("requests only the capabilities slice 1 uses (no mutation rights)", () => {
    const capabilities = manifest.capabilities as string[];
    for (const needed of [
      "issue.interactions.read",
      "issue.relations.read",
      "issues.orchestration.read",
      "issue.documents.read",
      "issue.documents.write",
      "approvals.read",
      "metrics.write",
      "events.subscribe",
      "jobs.schedule",
    ]) {
      expect(capabilities).toContain(needed);
    }
    // No mutation rights in shadow mode: respond/decide/wakeup arrive at cutover.
    for (const forbidden of ["issue.interactions.respond", "approvals.respond", "issues.wakeup", "issue.relations.write"]) {
      expect(capabilities).not.toContain(forbidden);
    }
  });

  it("stays in shadow mode by default", () => {
    expect(DEFAULT_CONFIG.applyMutations).toBe(false);
    expect(resolveConfig({}).applyMutations).toBe(false);
    expect(resolveConfig({ applyMutations: true }).applyMutations).toBe(true);
  });

  it("clamps invalid operator config instead of throwing", () => {
    expect(resolveConfig(null).sweepPageSize).toBe(DEFAULT_CONFIG.sweepPageSize);
    expect(resolveConfig({ sweepPageSize: -5 }).sweepPageSize).toBe(DEFAULT_CONFIG.sweepPageSize);
  });

  it("tracks all six attention sources as gaps or reads", () => {
    expect(HOST_CAPABILITY_GAPS.map((gap) => gap.id)).toEqual(["G-01", "G-02", "G-03", "G-04", "G-05", "G-06"]);
  });
});
