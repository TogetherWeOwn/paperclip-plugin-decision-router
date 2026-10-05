/**
 * Sweep-silence probe (source-only, pages nothing).
 *
 * The 5-minute sweep persists its completion time as `at` on the last-sweep
 * state record (served read-only on the `sla-metrics` data endpoint,
 * `src/worker.ts`). This probe asserts that output is fresh: when the digest
 * timestamp age exceeds the threshold the probe reads DOWN, otherwise UP.
 *
 * Pure evaluation over an ISO timestamp — no SDK reads, no mutations, no
 * alert-route or paging change. Gatus/fleet wiring stays on the coverage card;
 * this file owns the plugin-side definition (mirrors the `sla-metrics` shape
 * probe precedent).
 */

export const SWEEP_SILENCE_PROBE_NAME = "decision-router-sweep-silence";

/**
 * Default staleness bound: 15 minutes = 3 missed 5-minute sweeps
 * (`SWEEP_SCHEDULE`). A single missed run stays UP; a dead scheduler trips
 * DOWN quickly without flapping on one slow tick.
 */
export const DEFAULT_SWEEP_SILENCE_THRESHOLD_SECONDS = 900;

export type SweepSilenceStatus = "UP" | "DOWN";

export interface SweepSilenceResult {
  status: SweepSilenceStatus;
  /**
   * Whole seconds between `at` and `now`. Null only when `at` is missing or
   * unparseable (absence is not youth — unknown age never reads fresh).
   * Future timestamps clamp to 0 (clock skew is not silence).
   */
  ageSeconds: number | null;
  thresholdSeconds: number;
  /** One-line reason, safe to surface on a status page. */
  reason: string;
}

function asThreshold(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SWEEP_SILENCE_THRESHOLD_SECONDS;
}

/**
 * Evaluate sweep-output freshness. `at` is the last-sweep record's `at`
 * field (ISO 8601); anything else (missing, empty, unparseable) reads DOWN.
 */
export function checkSweepSilence(
  at: string | null | undefined,
  now: Date = new Date(),
  thresholdSeconds: number = DEFAULT_SWEEP_SILENCE_THRESHOLD_SECONDS,
): SweepSilenceResult {
  const threshold = asThreshold(thresholdSeconds);
  if (typeof at !== "string" || at.length === 0) {
    return { status: "DOWN", ageSeconds: null, thresholdSeconds: threshold, reason: "no sweep yet" };
  }
  const since = Date.parse(at);
  if (!Number.isFinite(since)) {
    return { status: "DOWN", ageSeconds: null, thresholdSeconds: threshold, reason: `unparseable sweep timestamp ${at}` };
  }
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - since) / 1000));
  if (ageSeconds > threshold) {
    return {
      status: "DOWN",
      ageSeconds,
      thresholdSeconds: threshold,
      reason: `sweep silence: last sweep ${ageSeconds}s ago exceeds threshold ${threshold}s`,
    };
  }
  return {
    status: "UP",
    ageSeconds,
    thresholdSeconds: threshold,
    reason: `last sweep ${ageSeconds}s ago within threshold ${threshold}s`,
  };
}
