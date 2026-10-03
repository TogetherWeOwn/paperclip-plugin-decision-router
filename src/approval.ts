/**
 * approval approve verb: plan the `APPROVE <approval-id>` decision behind the
 * existing `applyMutations` flag (default off).
 *
 * Pure planning only — this module NEVER mutates. Each plan carries a stable
 * idempotency key (`approval-approve:<approval-id>`) so a retry, a re-sweep,
 * or a duplicate approvals.list row approves the same approval at most once.
 * When `applyMutations` is false (shadow default) plans come back as
 * `mode: "propose"` — recorded in the sweep result and the last-sweep state,
 * nothing applied. `mode: "apply"` only marks the live intent the cutover
 * slice may act on once an SDK decide capability exists
 * (`approvals.respond`, deliberately absent from the manifest until cutover);
 * there is still no live call on this path.
 *
 * The only planned outcome is `approve` (the digest verb for approval items,
 * `digest.ts` KIND_VERBS). Deny/reject arrives via the CEO grammar
 * (`APPROVE <id>` is approval-as-paired-board-user; a refusal is a DECIDE
 * line) once live reads land. Skip paths fail closed: malformed rows,
 * non-pending statuses, and duplicate keys never approve.
 */

export interface ApprovalActionInput {
  /** Stable approval id (the `APPROVE <id>` target). */
  id: string;
  /** Linked issue id when the approval payload names one, else null (company scope). */
  issueId: string | null;
  /** Approval status; only pending attention approves. */
  status: string;
}

export type ApprovalDecision = "approve" | "skip";

/** Plan mode: propose-only in shadow, live intent behind `applyMutations`. */
export type ApprovalPlanMode = "propose" | "apply";

export interface ApprovalPlan {
  approvalId: string;
  issueId: string | null;
  decision: ApprovalDecision;
  /** Always `approve` when the decision is `approve` (the digest verb). */
  outcome: "approve";
  mode: ApprovalPlanMode;
  /** Stable across sweeps: `approval-approve:<approval-id>`. */
  idempotencyKey: string;
  reason: string;
}

export interface PlanApprovalOptions {
  /** From `DecisionRouterConfig.applyMutations` (default false → propose). */
  applyMutations: boolean;
  /** Keys already planned this process (or a prior sweep page). Duplicates skip. */
  seenKeys?: Set<string> | readonly string[];
}

/** Attentional statuses the worker sweep surfaces (see worker listPendingApprovals). */
const APPROVABLE_STATUSES = new Set(["pending"]);

/** Stable idempotency key for one approval. */
export function approvalIdempotencyKey(approvalId: string): string {
  return `approval-approve:${approvalId}`;
}

function seenHas(seen: PlanApprovalOptions["seenKeys"], key: string): boolean {
  if (!seen) return false;
  if (seen instanceof Set) return seen.has(key);
  return seen.includes(key);
}

/** Plan one approval: approve per the digest verb or skip with a reason. */
export function planApprovalAction(action: ApprovalActionInput, opts: PlanApprovalOptions): ApprovalPlan {
  const id = action.id ?? "";
  const issueId = action.issueId ?? null;
  const status = action.status ?? "";
  const key = approvalIdempotencyKey(id);
  const mode: ApprovalPlanMode = opts.applyMutations ? "apply" : "propose";

  if (id.trim() === "") {
    return {
      approvalId: id,
      issueId,
      decision: "skip",
      outcome: "approve",
      mode,
      idempotencyKey: key,
      reason: "skip: malformed approval row (missing approval id) — never approves",
    };
  }
  if (seenHas(opts.seenKeys, key)) {
    return {
      approvalId: id,
      issueId,
      decision: "skip",
      outcome: "approve",
      mode,
      idempotencyKey: key,
      reason: `skip: duplicate key ${key} already planned — idempotent on the approval key`,
    };
  }
  if (!APPROVABLE_STATUSES.has(status)) {
    return {
      approvalId: id,
      issueId,
      decision: "skip",
      outcome: "approve",
      mode,
      idempotencyKey: key,
      reason: `skip: status "${status || "(missing)"}" is not attention (pending) — decided history never re-approves`,
    };
  }
  return {
    approvalId: id,
    issueId,
    decision: "approve",
    outcome: "approve",
    mode,
    idempotencyKey: key,
    reason: "approve per the digest verb; refusal arrives via a CEO DECIDE line",
  };
}

/**
 * Plan a batch, de-duplicating within the batch as well as against `seenKeys`.
 * Returned in input order; the caller's `seenKeys` set is NOT mutated.
 */
export function planApprovalActions(
  actions: readonly ApprovalActionInput[],
  opts: PlanApprovalOptions,
): ApprovalPlan[] {
  const batchSeen = new Set<string>();
  const prior = opts.seenKeys;
  return actions.map((action) => {
    const key = approvalIdempotencyKey(action.id ?? "");
    const combined: Set<string> =
      prior instanceof Set
        ? new Set<string>([...prior, ...batchSeen])
        : new Set<string>([...(Array.isArray(prior) ? prior : []), ...batchSeen]);
    const plan = planApprovalAction(action, { applyMutations: opts.applyMutations, seenKeys: combined });
    batchSeen.add(key);
    return plan;
  });
}
