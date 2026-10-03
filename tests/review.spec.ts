import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import {
  planReviewAction,
  planReviewActions,
  reviewIdempotencyKey,
  type ReviewRouteInput,
} from "../src/review.js";
import { sweepDecisions, type SweepReads } from "../src/sweep.js";

const IN_FOCUS: ReviewRouteInput = {
  id: "review-1",
  issueId: "issue-1",
  destination: "code-reviewer",
  codeReviewerAgentId: "agent-reviewer",
  focusAnchorIssueId: "issue-focus",
};

const OUT_OF_FOCUS: ReviewRouteInput = { ...IN_FOCUS, destination: "park" };

describe("planReviewAction", () => {
  it("routes an in-focus review propose-only when the flag is off", () => {
    const plan = planReviewAction(IN_FOCUS, { applyMutations: false });
    expect(plan).toMatchObject({
      reviewId: "review-1",
      issueId: "issue-1",
      decision: "route",
      target: "agent-reviewer",
      mode: "propose",
      idempotencyKey: "review-choose-path:review-1",
    });
  });

  it("marks apply intent when the flag is on, on the same idempotency key", () => {
    const plan = planReviewAction(IN_FOCUS, { applyMutations: true });
    expect(plan.mode).toBe("apply");
    expect(plan.decision).toBe("route");
    expect(plan.target).toBe("agent-reviewer");
    expect(plan.idempotencyKey).toBe(reviewIdempotencyKey("review-1"));
  });

  it("parks an out-of-focus review at the focus anchor", () => {
    const plan = planReviewAction(OUT_OF_FOCUS, { applyMutations: false });
    expect(plan).toMatchObject({
      decision: "park",
      target: "issue-focus",
      mode: "propose",
      idempotencyKey: "review-choose-path:review-1",
    });
  });

  it("parks with apply intent when the flag is on (still no live call)", () => {
    const plan = planReviewAction(OUT_OF_FOCUS, { applyMutations: true });
    expect(plan).toMatchObject({ decision: "park", target: "issue-focus", mode: "apply" });
  });

  it("skips a ceo-digest destination — the item stays on the digest", () => {
    const plan = planReviewAction({ ...IN_FOCUS, destination: "ceo-digest" }, { applyMutations: true });
    expect(plan.decision).toBe("skip");
    expect(plan.target).toBeNull();
    expect(plan.reason).toContain("ceo-digest");
  });

  it("skips a duplicate key already planned", () => {
    const seen = new Set([reviewIdempotencyKey("review-1")]);
    const plan = planReviewAction(IN_FOCUS, { applyMutations: false, seenKeys: seen });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("duplicate");
  });

  it("skips malformed rows with no review id", () => {
    const plan = planReviewAction({ ...IN_FOCUS, id: "  " }, { applyMutations: false });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("malformed");
  });

  it("skips the route when no Code Reviewer is configured (fails closed)", () => {
    const plan = planReviewAction({ ...IN_FOCUS, codeReviewerAgentId: null }, { applyMutations: true });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("no Code Reviewer");
  });

  it("skips the park when no focus anchor is configured", () => {
    const plan = planReviewAction({ ...OUT_OF_FOCUS, focusAnchorIssueId: null }, { applyMutations: false });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("no focus anchor");
  });
});

describe("planReviewActions", () => {
  it("de-duplicates within the batch on the review key", () => {
    const plans = planReviewActions([IN_FOCUS, IN_FOCUS], { applyMutations: false });
    expect(plans.map((plan) => plan.decision)).toEqual(["route", "skip"]);
    expect(plans[1]?.reason).toContain("duplicate");
  });

  it("keeps keys stable across modes (idempotent retry)", () => {
    const propose = planReviewActions([IN_FOCUS], { applyMutations: false });
    const apply = planReviewActions([IN_FOCUS], { applyMutations: true, seenKeys: [] });
    expect(propose[0]?.idempotencyKey).toBe(apply[0]?.idempotencyKey);
  });
});

describe("sweep review plans", () => {
  function reads(): SweepReads {
    return {
      async listOpenIssues() {
        return [{ id: "issue-1", identifier: "TOG-1", status: "todo", assigneeAgentId: "agent-a" }];
      },
      async listPendingInteractions() {
        return [];
      },
      async listRelations() {
        return { blockedByIds: [], activeRecovery: [] };
      },
      async listPendingApprovals() {
        return [];
      },
      async listFailedRuns() {
        return [];
      },
      async extraItems() {
        return [
          {
            kind: "review",
            issueId: "issue-1",
            identifier: "TOG-1",
            sourceId: "review-1",
            pendingSince: "2026-10-03T11:00:00Z",
            detail: "choose review path",
          },
        ];
      },
    };
  }

  const NOW = new Date("2026-10-03T18:00:00Z");
  const WITH_REVIEWER = { ...DEFAULT_CONFIG, codeReviewerAgentId: "agent-reviewer" };

  it("plans review routes propose-only in shadow mode", async () => {
    const result = await sweepDecisions("company-1", WITH_REVIEWER, reads(), NOW);
    expect(result.reviewPlans).toHaveLength(1);
    expect(result.reviewPlans[0]).toMatchObject({
      reviewId: "review-1",
      decision: "route",
      target: "agent-reviewer",
      mode: "propose",
      idempotencyKey: "review-choose-path:review-1",
    });
  });

  it("plans apply intent when mutations are enabled (still no live call)", async () => {
    const result = await sweepDecisions(
      "company-1",
      { ...WITH_REVIEWER, applyMutations: true },
      reads(),
      NOW,
    );
    expect(result.reviewPlans[0]?.mode).toBe("apply");
    expect(result.reviewPlans[0]?.decision).toBe("route");
  });

  it("skips when no Code Reviewer is configured (fails closed, stays on digest)", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), NOW);
    expect(result.reviewPlans).toHaveLength(1);
    expect(result.reviewPlans[0]).toMatchObject({ decision: "skip", target: null });
  });
});
