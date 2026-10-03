/**
 * decision-log emit verb: format one decision record per routed attention item
 * and emit it toward the Decisions-page pipeline in dry-run only — behind the
 * dedicated `decisionLogEmit` flag (default off).
 *
 * Pure planning only — this module NEVER mutates and NEVER responds. The only
 * emit channel is the metrics pipeline (`decision_router.decision_log.emitted`
 * counters, tagged per kind + destination) plus the propose-only record in the
 * sweep result and the last-sweep state. There is no live call on this path:
 * no issue mutation, no interaction respond, no wakeup. The manifest requests
 * no new capability for this verb (`metrics.write` and `plugin.state.write`
 * already cover the dry-run sinks).
 *
 * Each plan carries a stable key (`decision-log:<kind>:<source-id>`) so a
 * retry, a re-sweep, or a duplicate sweep row formats the same decision once
 * per batch. Keys are stable across sweeps for downstream dedup, but the
 * sweep emits the current routing decisions fresh on every run while the flag
 * is on — a log, not a work queue, so there is no cross-sweep suppression and
 * no persisted memory. Every plan, emit or skip, carries `mode: "dry-run"`.
 */
import type { MetricPoint } from "./metrics.js";

/** One routed attention item, as read off the sweep's routed rows. */
export interface DecisionLogInput {
  /** Attention kind (e.g. `issue_thread_interaction`, `failed_run`). */
  kind: string;
  /** Company issue id the item belongs to. */
  issueId: string;
  /** Human-readable board identifier when known. */
  identifier: string | null;
  /** Stable source id: interaction id, run id, approval id, ... */
  sourceId: string;
  /** Routing destination type (e.g. `ceo-digest`, `retry`, `code-reviewer`). */
  destination: string;
  /** Triage verdict when the item was triaged, else null. */
  triageVerdict: string | null;
}

/** The formatted decision record: JSON-safe, dry-run only. */
export interface DecisionRecord {
  /** Stable key: `decision-log:<kind>:<source-id>`. */
  key: string;
  kind: string;
  issueId: string;
  identifier: string | null;
  sourceId: string;
  destination: string;
  triage: string | null;
  /** Sweep timestamp (ISO 8601). */
  at: string;
  /** Always true: decision-log emit is dry-run only, never applied. */
  dryRun: true;
}

export type DecisionLogDecision = "emit" | "skip";

/** Plan mode: always dry-run — there is no live intent on this path. */
export type DecisionLogPlanMode = "dry-run";

export interface DecisionLogPlan {
  /** Stable across sweeps: `decision-log:<kind>:<source-id>`. */
  key: string;
  decision: DecisionLogDecision;
  /** The formatted record; null when skipped (flag off / malformed / duplicate). */
  record: DecisionRecord | null;
  mode: DecisionLogPlanMode;
  /**
   * Always `metrics`: records emit as metric points, never as interaction
   * responds. This field is the structural never-auto-respond guarantee.
   */
  channel: "metrics";
  reason: string;
}

export interface PlanDecisionLogOptions {
  /** From `DecisionRouterConfig.decisionLogEmit` (default false → no-op). */
  enabled: boolean;
  /** Sweep timestamp carried onto each record. Defaults to now. */
  now?: Date;
  /** Keys already planned this process (or a prior sweep page). Duplicates skip. */
  seenKeys?: Set<string> | readonly string[];
}

/** Stable key for one routed decision. */
export function decisionLogKey(kind: string, sourceId: string): string {
  return `decision-log:${kind}:${sourceId}`;
}

/** Pure: format one routed item as a decision record. Never throws. */
export function formatDecisionRecord(input: DecisionLogInput, now: Date = new Date()): DecisionRecord {
  return {
    key: decisionLogKey(input.kind ?? "", input.sourceId ?? ""),
    kind: input.kind ?? "",
    issueId: input.issueId ?? "",
    identifier: input.identifier ?? null,
    sourceId: input.sourceId ?? "",
    destination: input.destination ?? "",
    triage: input.triageVerdict ?? null,
    at: now.toISOString(),
    dryRun: true,
  };
}

function seenHas(seen: PlanDecisionLogOptions["seenKeys"], key: string): boolean {
  if (!seen) return false;
  if (seen instanceof Set) return seen.has(key);
  return seen.includes(key);
}

/** Plan one routed item: emit a dry-run record or skip with a reason. */
export function planDecisionLogAction(
  input: DecisionLogInput,
  opts: PlanDecisionLogOptions,
): DecisionLogPlan {
  const kind = input.kind ?? "";
  const sourceId = input.sourceId ?? "";
  const key = decisionLogKey(kind, sourceId);
  const now = opts.now ?? new Date();
  const skip = (reason: string): DecisionLogPlan => ({
    key,
    decision: "skip",
    record: null,
    mode: "dry-run",
    channel: "metrics",
    reason,
  });

  if (!opts.enabled) {
    return skip("skip: decisionLogEmit flag off — no-op, nothing formatted or emitted");
  }
  if (sourceId.trim() === "") {
    return skip("skip: malformed decision row (missing source id) — never emits");
  }
  if (seenHas(opts.seenKeys, key)) {
    return skip(`skip: duplicate key ${key} already planned — idempotent on the decision key`);
  }
  return {
    key,
    decision: "emit",
    record: formatDecisionRecord(input, now),
    mode: "dry-run",
    channel: "metrics",
    reason: "dry-run emit toward the Decisions-page pipeline (metrics counters + state record only)",
  };
}

/**
 * Plan a batch, de-duplicating within the batch as well as against `seenKeys`.
 * Returned in input order; the caller's `seenKeys` set is NOT mutated.
 */
export function planDecisionLogActions(
  inputs: readonly DecisionLogInput[],
  opts: PlanDecisionLogOptions,
): DecisionLogPlan[] {
  const batchSeen = new Set<string>();
  const prior = opts.seenKeys;
  const now = opts.now ?? new Date();
  return inputs.map((input) => {
    const key = decisionLogKey(input.kind ?? "", input.sourceId ?? "");
    const combined: Set<string> =
      prior instanceof Set
        ? new Set<string>([...prior, ...batchSeen])
        : new Set<string>([...(Array.isArray(prior) ? prior : []), ...batchSeen]);
    const plan = planDecisionLogAction(input, { enabled: opts.enabled, now, seenKeys: combined });
    batchSeen.add(key);
    return plan;
  });
}

/**
 * Aggregate emit plans into per-(kind, destination) counters for the metrics
 * pipeline. Skip plans contribute nothing, so flag-off sweeps emit zero
 * points. Bounded: at most (#kinds × #destinations) points per sweep.
 */
export function decisionLogMetrics(plans: readonly DecisionLogPlan[]): MetricPoint[] {
  const counts = new Map<string, { kind: string; destination: string; value: number }>();
  for (const plan of plans) {
    if (plan.decision !== "emit" || !plan.record) continue;
    const dictKey = `${plan.record.kind}\u0000${plan.record.destination}`;
    const entry = counts.get(dictKey);
    if (entry) {
      entry.value += 1;
    } else {
      counts.set(dictKey, { kind: plan.record.kind, destination: plan.record.destination, value: 1 });
    }
  }
  return [...counts.values()].map((entry) => ({
    name: "decision_router.decision_log.emitted",
    value: entry.value,
    tags: { kind: entry.kind, destination: entry.destination },
  }));
}
