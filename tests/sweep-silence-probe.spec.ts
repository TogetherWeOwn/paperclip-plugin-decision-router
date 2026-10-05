import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  checkSweepSilence,
  DEFAULT_SWEEP_SILENCE_THRESHOLD_SECONDS,
} from "../src/sweepSilence.js";

// Source-only probe for sweep-output freshness (digest timestamp age over a
// threshold = DOWN). Fixture pins the fresh/stale records; the live
// `checkSweepSilence` evaluator must agree. No alert-route or paging change,
// no host install, no Gatus wiring.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/sweep-silence.json", import.meta.url), "utf8"),
) as { now: string; thresholdSeconds: number; fresh: { at: string }; stale: { at: string } };

const NOW = new Date(fixture.now);

describe("sweep-silence probe", () => {
  it("fixture carries a fixed now, a threshold, and fresh/stale records", () => {
    expect(Number.isNaN(Date.parse(fixture.now))).toBe(false);
    expect(fixture.thresholdSeconds).toBe(DEFAULT_SWEEP_SILENCE_THRESHOLD_SECONDS);
    expect(Number.isNaN(Date.parse(fixture.fresh.at))).toBe(false);
    expect(Number.isNaN(Date.parse(fixture.stale.at))).toBe(false);
    expect(NOW.getTime() - Date.parse(fixture.fresh.at)).toBeLessThanOrEqual(
      fixture.thresholdSeconds * 1000,
    );
    expect(NOW.getTime() - Date.parse(fixture.stale.at)).toBeGreaterThan(fixture.thresholdSeconds * 1000);
  });

  it("reads UP on a fresh digest timestamp", () => {
    const result = checkSweepSilence(fixture.fresh.at, NOW, fixture.thresholdSeconds);
    expect(result.status).toBe("UP");
    expect(result.ageSeconds).toBe(300);
    expect(result.thresholdSeconds).toBe(fixture.thresholdSeconds);
  });

  it("reads DOWN on a stale digest timestamp", () => {
    const result = checkSweepSilence(fixture.stale.at, NOW, fixture.thresholdSeconds);
    expect(result.status).toBe("DOWN");
    expect(result.ageSeconds).toBe(2400);
    expect(result.thresholdSeconds).toBe(fixture.thresholdSeconds);
    expect(result.reason).toContain("sweep silence");
  });

  it("reads DOWN when the timestamp is missing or unparseable (absence is not youth)", () => {
    for (const at of [null, undefined, "", "not-a-timestamp"] as const) {
      const result = checkSweepSilence(at, NOW, fixture.thresholdSeconds);
      expect(result.status).toBe("DOWN");
      expect(result.ageSeconds).toBeNull();
    }
  });

  it("reads UP exactly at the threshold, DOWN one second past it", () => {
    const atThreshold = new Date(NOW.getTime() - fixture.thresholdSeconds * 1000).toISOString();
    expect(checkSweepSilence(atThreshold, NOW, fixture.thresholdSeconds).status).toBe("UP");
    const pastThreshold = new Date(NOW.getTime() - (fixture.thresholdSeconds + 1) * 1000).toISOString();
    expect(checkSweepSilence(pastThreshold, NOW, fixture.thresholdSeconds).status).toBe("DOWN");
  });

  it("honours a caller-supplied threshold override", () => {
    // The stale fixture (2400s) is fresh under a 1-hour bound.
    expect(checkSweepSilence(fixture.stale.at, NOW, 3600).status).toBe("UP");
    // The fresh fixture (300s) is stale under a 1-minute bound.
    expect(checkSweepSilence(fixture.fresh.at, NOW, 60).status).toBe("DOWN");
  });

  it("clamps future timestamps to age 0 (clock skew is not silence)", () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    const result = checkSweepSilence(future, NOW, fixture.thresholdSeconds);
    expect(result.status).toBe("UP");
    expect(result.ageSeconds).toBe(0);
  });
});
