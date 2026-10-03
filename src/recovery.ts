/**
 * recovery_action resolve verb: plan the reconciler-policy resolve behind the
 * existing `applyMutations` flag (default off).
 *
 * Pure planning only — this module NEVER mutates. Each plan carries a stable
 * idempotency key (`recovery-resolve:<action-id>`) so a retry, a re-sweep, or
 * a duplicate edge row resolves the same action at most once. When
 * `applyMutations` is false (shadow default) plans come back as
 * `mode: "propose"` — recorded in the sweep result and the last-sweep state,
 * nothing applied. `mode: "apply"` only marks the live intent the cutover
 * slice may act on once an SDK resolve capability exists (gap G-02); there is
 * still no live call on this path.
 *
 * Resolve follows the existing reconciler policy (`routing.ts` R-30): the only
 * planned outcome is `resolve`. `park` / `escalate` arrive via the CEO grammar
 * (`RESOLVE <id> <outcome>`) once live reads land. Skip paths fail closed:
 * malformed rows, non-attention statuses, and duplicate keys never resolve.
 */
import type { RecoveryOutcome } from "./routing.js";

export interface RecoveryActionInput {
  /** Stable recovery-action id (the `RESOLVE <id>` target). */
  id: string;
  /** Action kind (e.g. missing_disposition, stranded_assigned_issue). */
  kind: string;
  /** Action status; only active/escalated attention resolves. */
  status: string;
}

export type RecoveryDecision = "resolve" | "skip";

/** Plan mode: propose-only in shadow, live intent behind `applyMutations`. */
export type RecoveryPlanMode = "propose" | "apply";

export interface RecoveryPlan {
  actionId: string;
  kind: string;
  decision: RecoveryDecision;
  /** Always `resolve` when the decision is `resolve` (reconciler policy R-30). */
  outcome: RecoveryOutcome;
  mode: RecoveryPlanMode;
  /** Stable across sweeps: `recovery-resolve:<action-id>`. */
  idempotencyKey: string;
  reason: string;
}

export interface PlanRecoveryOptions {
  /** From `DecisionRouterConfig.applyMutations` (default false → propose). */
  applyMutations: boolean;
  /** Keys already planned this process (or a prior sweep page). Duplicates skip. */
  seenKeys?: Set<string> | readonly string[];
}

/** Attentional statuses the worker sweep surfaces (see worker listRelations). */
const RESOLVABLE_STATUSES = new Set(["active", "escalated"]);

/** Stable idempotency key for one recovery action. */
export function recoveryIdempotencyKey(actionId: string): string {
  return `recovery-resolve:${actionId}`;
}

function seenHas(seen: PlanRecoveryOptions["seenKeys"], key: string): boolean {
  if (!seen) return false;
  if (seen instanceof Set) return seen.has(key);
  return seen.includes(key);
}

/** Plan one recovery action: resolve per the reconciler policy or skip with a reason. */
export function planRecoveryAction(action: RecoveryActionInput, opts: PlanRecoveryOptions): RecoveryPlan {
  const id = action.id ?? "";
  const kind = action.kind ?? "";
  const status = action.status ?? "";
  const key = recoveryIdempotencyKey(id);
  const mode: RecoveryPlanMode = opts.applyMutations ? "apply" : "propose";

  if (id.trim() === "") {
    return {
      actionId: id,
      kind,
      decision: "skip",
      outcome: "resolve",
      mode,
      idempotencyKey: key,
      reason: "skip: malformed recovery row (missing action id) — never resolves",
    };
  }
  if (seenHas(opts.seenKeys, key)) {
    return {
      actionId: id,
      kind,
      decision: "skip",
      outcome: "resolve",
      mode,
      idempotencyKey: key,
      reason: `skip: duplicate key ${key} already planned — idempotent on the action key`,
    };
  }
  if (!RESOLVABLE_STATUSES.has(status)) {
    return {
      actionId: id,
      kind,
      decision: "skip",
      outcome: "resolve",
      mode,
      idempotencyKey: key,
      reason: `skip: status "${status || "(missing)"}" is not attention (active/escalated) — history never resolves`,
    };
  }
  return {
    actionId: id,
    kind,
    decision: "resolve",
    outcome: "resolve",
    mode,
    idempotencyKey: key,
    reason: "resolve per the reconciler policy (R-30); park/escalate arrive via the CEO grammar",
  };
}

/**
 * Plan a batch, de-duplicating within the batch as well as against `seenKeys`.
 * Returned in input order; the caller's `seenKeys` set is NOT mutated.
 */
export function planRecoveryActions(
  actions: readonly RecoveryActionInput[],
  opts: PlanRecoveryOptions,
): RecoveryPlan[] {
  const batchSeen = new Set<string>();
  const prior = opts.seenKeys;
  return actions.map((action) => {
    const key = recoveryIdempotencyKey(action.id ?? "");
    const combined: Set<string> =
      prior instanceof Set
        ? new Set<string>([...prior, ...batchSeen])
        : new Set<string>([...(Array.isArray(prior) ? prior : []), ...batchSeen]);
    const plan = planRecoveryAction(action, { applyMutations: opts.applyMutations, seenKeys: combined });
    batchSeen.add(key);
    return plan;
  });
}
