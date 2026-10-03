/**
 * `failed_run` retry verb: bounded retry with backoff, idempotent on runKey.
 *
 * A `retry` route from `routing.ts` becomes a `RetryPlan` here. The plan is
 * pure data — the sweep never mutates. `applyRetryPlans` executes only
 * `fire` plans through an injected `fire` function, and only when
 * `applyMutations` is true. When the flag is off (the default) every eligible
 * retry stays a proposal: it is recorded in the sweep result and the CEO
 * digest carries the `RETRY <run-id>` stub, but nothing fires.
 *
 * Two independent gates keep this card mutation-free:
 *   1. `applyMutations: false` (default) — plans come out as `propose`.
 *   2. The manifest does not request `issues.wakeup` (see gap G-05). That
 *      capability enters the manifest only at the cutover slice with owner
 *      approval, so even a flipped flag cannot wake anything until then.
 *
 * Backoff: attempt n fires no earlier than `finishedAt + min(BASE * 2^(n-1),
 * MAX)`. A run whose `pendingSince` timestamp is missing or unparseable
 * counts as backoff-elapsed (fail-open): attempts are still bounded by
 * `maxAttempts` and the idempotency key dedups the crash window, so an
 * unknown age can never cause an unbounded or double retry.
 *
 * Idempotency: every fire carries a stable key,
 * `decision-router/retry/<runId>/attempt-<n>`, passed as the wakeup
 * `idempotencyKey`. A sweep that crashes between firing and persisting state
 * replays the same key, and the host dedups it. A key already present in the
 * persisted `retriedKeys` set plans as `skip/duplicate` without firing.
 */
import type { AttentionItem } from "./attention.js";

/** First-retry delay after the run finished. Attempt n waits BASE * 2^(n-1). */
export const RETRY_BACKOFF_BASE_MS = 15 * 60_000;

/** Backoff never exceeds this, no matter the attempt number. */
export const RETRY_BACKOFF_MAX_MS = 4 * 3_600_000;

/** Cap on persisted `retriedKeys` entries so the last-sweep record stays small. */
export const RETRY_KEYS_CAP = 500;

export function retryBackoffMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const shift = Math.min(n - 1, 10);
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** shift, RETRY_BACKOFF_MAX_MS);
}

/** Stable per-run key: the idempotency domain for one failed run. */
export function retryKeyForRun(runId: string): string {
  return `failed-run:${runId}`;
}

/**
 * Stable per-(run, attempt) key, passed as the wakeup `idempotencyKey` so a
 * replayed fire dedups on the host instead of waking twice.
 */
export function retryIdempotencyKey(runId: string, attempt: number): string {
  return `decision-router/retry/${runId}/attempt-${attempt}`;
}

/** Earliest time (epoch ms) attempt n may fire for a run that finished at `finishedAtMs`. */
export function retryNotBeforeMs(finishedAtMs: number, attempt: number): number {
  return finishedAtMs + retryBackoffMs(attempt);
}

export type RetryPlanAction = "fire" | "propose" | "defer" | "skip";

export interface RetryPlanBase {
  action: RetryPlanAction;
  /** Per-run idempotency domain key (`failed-run:<runId>`). */
  runKey: string;
  attempt: number;
  maxAttempts: number;
  reason: string;
}

export interface RetryFirePlan extends RetryPlanBase {
  action: "fire";
  issueId: string;
  idempotencyKey: string;
}

export interface RetryProposePlan extends RetryPlanBase {
  action: "propose";
  issueId: string;
  idempotencyKey: string;
}

export interface RetryDeferPlan extends RetryPlanBase {
  action: "defer";
  /** ISO 8601: the attempt becomes eligible at this time. */
  notBefore: string;
}

export interface RetrySkipPlan extends RetryPlanBase {
  action: "skip";
  reason: "exhausted attempts bound" | "duplicate retry already fired";
}

export type RetryPlan = RetryFirePlan | RetryProposePlan | RetryDeferPlan | RetrySkipPlan;

export interface PlanRetryInput {
  /** Failed-run attention item (sourceId is the run id). */
  item: Pick<AttentionItem, "issueId" | "sourceId" | "pendingSince">;
  /** Attempt number from the routing destination (1-based). */
  attempt: number;
  maxAttempts: number;
  /** Idempotency keys already fired in earlier sweeps (persisted state). */
  firedKeys: ReadonlySet<string>;
  /** Operator flag: false (default) means propose-only, never fire. */
  applyMutations: boolean;
  nowMs: number;
}

/** Pure: turn one routed `retry` destination into an executable-or-recorded plan. */
export function planRetry(input: PlanRetryInput): RetryPlan {
  const { item, attempt, maxAttempts, firedKeys, applyMutations, nowMs } = input;
  const runKey = retryKeyForRun(item.sourceId);
  const idempotencyKey = retryIdempotencyKey(item.sourceId, attempt);
  const base = { runKey, attempt, maxAttempts } as const;

  if (attempt > maxAttempts) {
    return { ...base, action: "skip", reason: "exhausted attempts bound" };
  }
  if (firedKeys.has(idempotencyKey)) {
    return { ...base, action: "skip", reason: "duplicate retry already fired" };
  }
  const finishedAtMs = Date.parse(item.pendingSince);
  if (Number.isFinite(finishedAtMs)) {
    const notBeforeMs = retryNotBeforeMs(finishedAtMs, attempt);
    if (nowMs < notBeforeMs) {
      return {
        ...base,
        action: "defer",
        notBefore: new Date(notBeforeMs).toISOString(),
        reason: `backoff not elapsed — attempt ${attempt} eligible at ${new Date(notBeforeMs).toISOString()}`,
      };
    }
  }
  // Unknown pendingSince fails open to eligible: bounded by maxAttempts and
  // the idempotency key, so it can never retry unbounded or twice.
  const eligibleReason = `failed run ${item.sourceId.slice(0, 8)} — attempt ${attempt}/${maxAttempts}, backoff elapsed`;
  if (!applyMutations) {
    return {
      ...base,
      action: "propose",
      issueId: item.issueId,
      idempotencyKey,
      reason: `${eligibleReason} (shadow proposal — flag off, nothing fired)`,
    };
  }
  return {
    ...base,
    action: "fire",
    issueId: item.issueId,
    idempotencyKey,
    reason: eligibleReason,
  };
}

export interface RetryApplyOutcome {
  plan: RetryPlan;
  /** True only when a `fire` plan actually fired. Proposals, defers and skips are never applied. */
  applied: boolean;
  /** Firing error when a `fire` plan failed; the plan stays unrecorded so the next sweep retries the same attempt. */
  error?: string;
}

export interface ApplyRetryPlansDeps {
  applyMutations: boolean;
  fire: (plan: RetryFirePlan) => Promise<void>;
}

/**
 * Execute `fire` plans through the injected `fire`, never throwing: one
 * failing wakeup must not strand the rest. Non-fire plans always come back
 * unapplied. The flag is re-checked here so a `fire` plan can never execute
 * while shadow mode is on, even if planning and applying ever disagree.
 */
export async function applyRetryPlans(
  plans: RetryPlan[],
  deps: ApplyRetryPlansDeps,
): Promise<RetryApplyOutcome[]> {
  const outcomes: RetryApplyOutcome[] = [];
  for (const plan of plans) {
    if (plan.action !== "fire" || !deps.applyMutations) {
      outcomes.push({ plan, applied: false });
      continue;
    }
    try {
      await deps.fire(plan);
      outcomes.push({ plan, applied: true });
    } catch (error) {
      outcomes.push({
        plan,
        applied: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}
