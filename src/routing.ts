/**
 * Deterministic auto-routing: the first pass of every sweep, before anything
 * reaches the CEO digest. Order matters — the first matching rule wins:
 *
 *   1. reviews → the Code Reviewer (exact-head review path stays intact).
 *   2. blockers → the blocker's owner; parked with an edge to the focus
 *      anchor when the blocked issue is out of focus.
 *   3. recovery actions → the existing reconciler policy outcome.
 *   4. failed runs → the bounded retry policy.
 *   5. everything else → the CEO digest (one card, decision grammar).
 *
 * Owner-reserved matters (spend, credentials, org structure, reversals of
 * stated owner preference, public commitments) are NEVER auto-routed to an
 * agent — they go to the CEO digest as decision briefs. This mirrors the
 * reserved-matter gate in `interaction_route.sh route`.
 */
import type { AttentionItem } from "./attention.js";
import { retryKeyForRun } from "./retry.js";
import { triageInteraction, type TriageResult } from "./triage.js";

export const RECOVERY_OUTCOMES = ["resolve", "park", "escalate"] as const;
export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number];

export type RouteDestination =
  | { type: "code-reviewer"; reason: string }
  | { type: "blocker-owner"; agentId: string; reason: string }
  | { type: "park"; focusAnchorIssueId: string; reason: string }
  | { type: "reconciler"; outcome: RecoveryOutcome; reason: string }
  | { type: "retry"; attempt: number; maxAttempts: number; reason: string }
  | { type: "ceo-digest"; reason: string };

export interface RoutingContext {
  /** Agent id of the Code Reviewer (reviews go here). */
  codeReviewerAgentId: string;
  /** Issue id of the focus anchor (out-of-focus blockers park against it). */
  focusAnchorIssueId: string | null;
  /** Blocker owner lookup: blocked issue id → owning agent id. */
  blockerOwners: Record<string, string>;
  /** Issue ids currently in focus. Empty means "everything is in focus". */
  focusIssueIds: string[];
  /** Failed-run attempts so far: runKey (`failed-run:<runId>`) → completed attempts. */
  retryAttempts: Record<string, number>;
  maxRetryAttempts: number;
  /** When true, the item needs a human capability, not a decision (work order). */
  needsHumanCapability?: (item: AttentionItem) => boolean;
  /** When true, the item is owner-reserved (spend/credential/org/reversal/public). */
  isOwnerReserved?: (item: AttentionItem) => boolean;
}

export interface RoutedItem {
  item: AttentionItem;
  triage: TriageResult | null;
  destination: RouteDestination;
}

function inFocus(issueId: string, ctx: RoutingContext): boolean {
  if (ctx.focusIssueIds.length === 0) return true;
  return ctx.focusIssueIds.includes(issueId);
}

export function routeAttention(item: AttentionItem, ctx: RoutingContext): RouteDestination {
  if (ctx.isOwnerReserved?.(item) ?? false) {
    return { type: "ceo-digest", reason: "owner-reserved matter — decision brief for the CEO, never an agent" };
  }
  if (ctx.needsHumanCapability?.(item) ?? false) {
    return { type: "ceo-digest", reason: "needs a human capability, not a decision — work order via the CEO desk" };
  }
  switch (item.kind) {
    case "review":
      return { type: "code-reviewer", reason: "reviews go to the Code Reviewer" };
    case "blocker_attention": {
      if (!inFocus(item.issueId, ctx)) {
        if (!ctx.focusAnchorIssueId) {
          return { type: "ceo-digest", reason: "out-of-focus blocker with no focus anchor configured" };
        }
        return {
          type: "park",
          focusAnchorIssueId: ctx.focusAnchorIssueId,
          reason: "out-of-focus blocker — parked with an edge to the focus anchor",
        };
      }
      const owner = ctx.blockerOwners[item.issueId];
      if (!owner) {
        return { type: "ceo-digest", reason: "in-focus blocker with no known owner" };
      }
      return { type: "blocker-owner", agentId: owner, reason: "in-focus blocker — routed to the blocker's owner" };
    }
    case "recovery_action":
      // Slice 1 default: resolve per the reconciler policy. Park/escalate
      // outcomes arrive via the CEO grammar (RESOLVE) once live reads land.
      return { type: "reconciler", outcome: "resolve", reason: "recovery action — reconciler policy outcome" };
    case "failed_run": {
      // Keyed by runKey (`failed-run:<runId>`), the same domain the sweep
      // persists in last-sweep state — so attempts survive across sweeps.
      const attempt = (ctx.retryAttempts[retryKeyForRun(item.sourceId)] ?? 0) + 1;
      if (attempt > ctx.maxRetryAttempts) {
        return { type: "ceo-digest", reason: `failed run exhausted ${ctx.maxRetryAttempts} retries — needs a decision` };
      }
      return { type: "retry", attempt, maxAttempts: ctx.maxRetryAttempts, reason: "failed run — bounded retry policy" };
    }
    case "issue_thread_interaction":
    case "approval":
      return { type: "ceo-digest", reason: `${item.kind} — CEO decision via the digest grammar` };
  }
}

/** Route one interaction row: triage first (resolvability), then the deterministic destination. */
export function routeInteraction(
  item: AttentionItem,
  row: Parameters<typeof triageInteraction>[0],
  ctx: RoutingContext,
): RoutedItem {
  const triage = triageInteraction(row);
  // An agent-resolvable interaction on an in-focus issue still lands in the
  // digest unless a deterministic rule owns it — but the triage verdict rides
  // along so the digest can say WHO could answer it today.
  return { item, triage, destination: routeAttention(item, ctx) };
}
