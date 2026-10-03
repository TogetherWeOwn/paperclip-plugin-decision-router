/**
 * `blocker_attention` unblock verb: clear provably-stale blocker edges.
 *
 * A blocker edge is stale when its target sits in a terminal status
 * (`done` or `cancelled`): a finished issue can never unblock anything, so
 * the edge only keeps the Decisions page (and the blocked issue) lit. Each
 * stale edge becomes an `UnblockPlan`. The plan is pure data — the sweep
 * never mutates. `applyUnblockPlans` executes only `fire` plans through an
 * injected `unblock` function, and only when `applyMutations` is true. When
 * the flag is off (the default) every stale edge stays a proposal: it is
 * recorded in the sweep result and surfaced in the item detail + CEO digest,
 * but nothing is removed.
 *
 * Two independent gates keep this card mutation-free:
 *   1. `applyMutations: false` (default) — plans come out as `propose`.
 *   2. The manifest does not request `issue.relations.write` (see gap G-03).
 *      That capability enters the manifest only at the cutover slice with
 *      owner approval, so even a flipped flag cannot clear an edge until
 *      then. The test harness proves the second gate: firing without the
 *      capability throws, and the failure is recorded, not retried blindly.
 *
 * Non-stale edges (target still open) are NOT plans — the item keeps its
 * normal route (blocker-owner / park / CEO digest) and the owner decides.
 *
 * Idempotency: every fire carries a stable key,
 * `decision-router/unblock/<blockedIssueId>/<blockerIssueId>`, checked
 * against the persisted `unblockedKeys` set before planning. A sweep that
 * crashes between removing and persisting state replays the same edge; the
 * host `removeBlockers` call is naturally idempotent (removing an absent
 * edge is a no-op), and the key check skips already-recorded fires.
 */

/** Terminal statuses: a blocker in one of these can never unblock anything. */
export const STALE_BLOCKER_STATUSES = ["done", "cancelled"] as const;

/** Cap on persisted `unblockedKeys` entries so the last-sweep record stays small. */
export const UNBLOCK_KEYS_CAP = 500;

/** True when the blocker's status proves the edge stale. Unknown statuses fail closed (never stale). */
export function isStaleBlockerStatus(status: string): boolean {
  return (STALE_BLOCKER_STATUSES as readonly string[]).includes(status);
}

/** Stable per-edge key: the idempotency domain for one blocker edge. */
export function unblockKeyForEdge(blockedIssueId: string, blockerIssueId: string): string {
  return `decision-router/unblock/${blockedIssueId}/${blockerIssueId}`;
}

/** One blocker edge with the target status resolved, as read from relations. */
export interface BlockerEdge {
  blockerIssueId: string;
  blockerIdentifier: string | null;
  blockerStatus: string;
}

export type UnblockPlanAction = "fire" | "propose" | "skip";

export interface UnblockPlanBase {
  action: UnblockPlanAction;
  /** Per-edge idempotency key. */
  unblockKey: string;
  issueId: string;
  blockerIssueId: string;
  blockerIdentifier: string | null;
  blockerStatus: string;
  reason: string;
}

export interface UnblockFirePlan extends UnblockPlanBase {
  action: "fire";
}

export interface UnblockProposePlan extends UnblockPlanBase {
  action: "propose";
}

export interface UnblockSkipPlan extends UnblockPlanBase {
  action: "skip";
  reason: "duplicate unblock already fired";
}

export type UnblockPlan = UnblockFirePlan | UnblockProposePlan | UnblockSkipPlan;

export interface PlanUnblockInput {
  /** Blocked issue the edge belongs to. */
  issueId: string;
  edge: BlockerEdge;
  /** Idempotency keys already fired in earlier sweeps (persisted state). */
  firedKeys: ReadonlySet<string>;
  /** Operator flag: false (default) means propose-only, never fire. */
  applyMutations: boolean;
}

/** Pure: turn one stale blocker edge into an executable-or-recorded plan. */
export function planUnblock(input: PlanUnblockInput): UnblockPlan {
  const { issueId, edge, firedKeys, applyMutations } = input;
  const unblockKey = unblockKeyForEdge(issueId, edge.blockerIssueId);
  const base = {
    unblockKey,
    issueId,
    blockerIssueId: edge.blockerIssueId,
    blockerIdentifier: edge.blockerIdentifier,
    blockerStatus: edge.blockerStatus,
  } as const;
  const label = edge.blockerIdentifier ?? edge.blockerIssueId.slice(0, 8);

  if (firedKeys.has(unblockKey)) {
    return { ...base, action: "skip", reason: "duplicate unblock already fired" };
  }
  const staleReason = `blocker ${label} is ${edge.blockerStatus} — edge is stale`;
  if (!applyMutations) {
    return {
      ...base,
      action: "propose",
      reason: `${staleReason} (shadow proposal — flag off, nothing removed)`,
    };
  }
  return { ...base, action: "fire", reason: staleReason };
}

export interface UnblockApplyOutcome {
  plan: UnblockPlan;
  /** True only when a `fire` plan actually removed the edge. Proposals and skips are never applied. */
  applied: boolean;
  /** Removal error when a `fire` plan failed; the plan stays unrecorded so the next sweep retries the same edge. */
  error?: string;
}

export interface ApplyUnblockPlansDeps {
  applyMutations: boolean;
  unblock: (plan: UnblockFirePlan) => Promise<void>;
}

/**
 * Execute `fire` plans through the injected `unblock`, never throwing: one
 * failing removal must not strand the rest. Non-fire plans always come back
 * unapplied. The flag is re-checked here so a `fire` plan can never execute
 * while shadow mode is on, even if planning and applying ever disagree.
 */
export async function applyUnblockPlans(
  plans: UnblockPlan[],
  deps: ApplyUnblockPlansDeps,
): Promise<UnblockApplyOutcome[]> {
  const outcomes: UnblockApplyOutcome[] = [];
  for (const plan of plans) {
    if (plan.action !== "fire" || !deps.applyMutations) {
      outcomes.push({ plan, applied: false });
      continue;
    }
    try {
      await deps.unblock(plan);
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

/** Filter helper: keep only the provably-stale edges of a blocked issue. */
export function staleEdges(edges: BlockerEdge[]): BlockerEdge[] {
  return edges.filter((edge) => isStaleBlockerStatus(edge.blockerStatus));
}

/** Human-readable proposal note appended to the attention item detail. */
export function unblockProposalNote(plans: UnblockPlan[]): string | null {
  const actionable = plans.filter((plan) => plan.action !== "skip");
  if (actionable.length === 0) return null;
  const parts = actionable.map((plan) => {
    const label = plan.blockerIdentifier ?? plan.blockerIssueId.slice(0, 8);
    const verb = plan.action === "fire" ? "unblocking" : "proposes unblock";
    return `${verb} stale edge → ${label} (${plan.blockerStatus})`;
  });
  return parts.join("; ");
}
