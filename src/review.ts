/**
 * `review` choose-path verb: route in-focus reviews to the Code Reviewer, or
 * park out-of-focus reviews with an edge to the focus anchor — behind the
 * existing `applyMutations` flag (default off).
 *
 * Pure planning only — this module NEVER mutates. Each plan carries a stable
 * idempotency key (`review-choose-path:<review-id>`) so a retry, a re-sweep,
 * or a duplicate ledger row chooses the same review's path at most once. When
 * `applyMutations` is false (shadow default) plans come back as
 * `mode: "propose"` — recorded in the sweep result and the last-sweep state,
 * nothing applied. `mode: "apply"` only marks the live intent the cutover
 * slice may act on once SDK assign / relations-write capabilities exist (gaps
 * G-03/G-04); there is still no live call on this path, and the manifest
 * deliberately requests no mutation capability until cutover.
 *
 * The decision follows the routing destination (`routing.ts` R-10): a
 * `code-reviewer` destination plans `route`; a `park` destination plans
 * `park`; a `ceo-digest` destination (owner-reserved, human-capability, or no
 * focus anchor) plans `skip` — the item stays on the CEO digest. Skip paths
 * fail closed: malformed rows, duplicate keys, an unset reviewer, and a park
 * without an anchor never route anywhere.
 */
export interface ReviewRouteInput {
  /** Stable review row id (the attention item `sourceId`). */
  id: string;
  /** Issue the review belongs to. */
  issueId: string;
  /** Routing destination from `routeAttention` for this review row. */
  destination: "code-reviewer" | "park" | "ceo-digest";
  /** Configured Code Reviewer agent id; null when unconfigured. */
  codeReviewerAgentId: string | null;
  /** Configured focus anchor issue id; null when unconfigured. */
  focusAnchorIssueId: string | null;
}

export type ReviewDecision = "route" | "park" | "skip";

/** Plan mode: propose-only in shadow, live intent behind `applyMutations`. */
export type ReviewPlanMode = "propose" | "apply";

export interface ReviewPlan {
  reviewId: string;
  issueId: string;
  decision: ReviewDecision;
  /** Agent id for `route`, anchor issue id for `park`, null for `skip`. */
  target: string | null;
  mode: ReviewPlanMode;
  /** Stable across sweeps: `review-choose-path:<review-id>`. */
  idempotencyKey: string;
  reason: string;
}

export interface PlanReviewOptions {
  /** From `DecisionRouterConfig.applyMutations` (default false → propose). */
  applyMutations: boolean;
  /** Keys already planned this process (or a prior sweep page). Duplicates skip. */
  seenKeys?: Set<string> | readonly string[];
}

/** Stable idempotency key for one review row. */
export function reviewIdempotencyKey(reviewId: string): string {
  return `review-choose-path:${reviewId}`;
}

function seenHas(seen: PlanReviewOptions["seenKeys"], key: string): boolean {
  if (!seen) return false;
  if (seen instanceof Set) return seen.has(key);
  return seen.includes(key);
}

/** Plan one review row: route to the Code Reviewer, park at the anchor, or skip with a reason. */
export function planReviewAction(action: ReviewRouteInput, opts: PlanReviewOptions): ReviewPlan {
  const id = action.id ?? "";
  const key = reviewIdempotencyKey(id);
  const mode: ReviewPlanMode = opts.applyMutations ? "apply" : "propose";
  const skip = (reason: string): ReviewPlan => ({
    reviewId: id,
    issueId: action.issueId,
    decision: "skip",
    target: null,
    mode,
    idempotencyKey: key,
    reason,
  });

  if (id.trim() === "") {
    return skip("skip: malformed review row (missing review id) — never routes");
  }
  if (seenHas(opts.seenKeys, key)) {
    return skip(`skip: duplicate key ${key} already planned — idempotent on the review key`);
  }
  switch (action.destination) {
    case "code-reviewer": {
      const reviewer = (action.codeReviewerAgentId ?? "").trim();
      if (reviewer === "") {
        return skip("skip: in-focus review but no Code Reviewer configured — fails closed, stays on the digest");
      }
      return {
        reviewId: id,
        issueId: action.issueId,
        decision: "route",
        target: reviewer,
        mode,
        idempotencyKey: key,
        reason: "in-focus review — route to the Code Reviewer (R-10); exact-head review path stays intact",
      };
    }
    case "park": {
      const anchor = (action.focusAnchorIssueId ?? "").trim();
      if (anchor === "") {
        return skip("skip: out-of-focus review but no focus anchor configured — stays on the digest");
      }
      return {
        reviewId: id,
        issueId: action.issueId,
        decision: "park",
        target: anchor,
        mode,
        idempotencyKey: key,
        reason: "out-of-focus review — parked with an edge to the focus anchor (R-10)",
      };
    }
    default:
      return skip(
        `skip: destination is ceo-digest (${action.destination}) — owner-reserved, human-capability, or anchorless; no choose-path plan`,
      );
  }
}

/**
 * Plan a batch, de-duplicating within the batch as well as against `seenKeys`.
 * Returned in input order; the caller's `seenKeys` set is NOT mutated.
 */
export function planReviewActions(
  actions: readonly ReviewRouteInput[],
  opts: PlanReviewOptions,
): ReviewPlan[] {
  const batchSeen = new Set<string>();
  const prior = opts.seenKeys;
  return actions.map((action) => {
    const key = reviewIdempotencyKey(action.id ?? "");
    const combined: Set<string> =
      prior instanceof Set
        ? new Set<string>([...prior, ...batchSeen])
        : new Set<string>([...(Array.isArray(prior) ? prior : []), ...batchSeen]);
    const plan = planReviewAction(action, { applyMutations: opts.applyMutations, seenKeys: combined });
    batchSeen.add(key);
    return plan;
  });
}
