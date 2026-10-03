import { describe, expect, it } from "vitest";

import type { AttentionItem } from "../src/attention.js";
import { routeAttention, type RoutingContext } from "../src/routing.js";

function item(kind: AttentionItem["kind"], overrides: Partial<AttentionItem> = {}): AttentionItem {
  return { kind, issueId: "issue-1", sourceId: "src-1", pendingSince: new Date().toISOString(), ...overrides };
}

function ctx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    codeReviewerAgentId: "agent-reviewer",
    focusAnchorIssueId: "issue-focus",
    blockerOwners: { "issue-1": "agent-owner" },
    focusIssueIds: [],
    retryAttempts: {},
    maxRetryAttempts: 2,
    ...overrides,
  };
}

describe("routeAttention", () => {
  it("sends in-focus reviews to the Code Reviewer", () => {
    expect(routeAttention(item("review"), ctx()).type).toBe("code-reviewer");
  });

  it("parks out-of-focus reviews against the focus anchor", () => {
    const destination = routeAttention(item("review"), ctx({ focusIssueIds: ["issue-other"] }));
    expect(destination).toMatchObject({ type: "park", focusAnchorIssueId: "issue-focus" });
  });

  it("digests out-of-focus reviews when no anchor is configured", () => {
    const destination = routeAttention(
      item("review"),
      ctx({ focusIssueIds: ["issue-other"], focusAnchorIssueId: null }),
    );
    expect(destination.type).toBe("ceo-digest");
  });

  it("sends in-focus blockers to the blocker's owner", () => {
    const destination = routeAttention(item("blocker_attention"), ctx());
    expect(destination).toMatchObject({ type: "blocker-owner", agentId: "agent-owner" });
  });

  it("parks out-of-focus blockers against the focus anchor", () => {
    const destination = routeAttention(item("blocker_attention"), ctx({ focusIssueIds: ["issue-other"] }));
    expect(destination).toMatchObject({ type: "park", focusAnchorIssueId: "issue-focus" });
  });

  it("digests out-of-focus blockers when no anchor is configured", () => {
    const destination = routeAttention(
      item("blocker_attention"),
      ctx({ focusIssueIds: ["issue-other"], focusAnchorIssueId: null }),
    );
    expect(destination.type).toBe("ceo-digest");
  });

  it("digests in-focus blockers with no known owner", () => {
    const destination = routeAttention(item("blocker_attention", { issueId: "issue-unknown" }), ctx());
    expect(destination.type).toBe("ceo-digest");
  });

  it("sends recovery actions to the reconciler", () => {
    expect(routeAttention(item("recovery_action"), ctx())).toMatchObject({ type: "reconciler", outcome: "resolve" });
  });

  it("retries failed runs within the bound", () => {
    expect(routeAttention(item("failed_run", { sourceId: "run-1" }), ctx())).toMatchObject({
      type: "retry",
      attempt: 1,
      maxAttempts: 2,
    });
  });

  it("digests failed runs past the retry bound", () => {
    const destination = routeAttention(
      item("failed_run", { sourceId: "run-1" }),
      ctx({ retryAttempts: { "failed-run:run-1": 2 } }),
    );
    expect(destination.type).toBe("ceo-digest");
  });

  it("never auto-routes owner-reserved matters to an agent", () => {
    const reserved = ctx({ isOwnerReserved: () => true });
    for (const kind of ["review", "blocker_attention", "recovery_action", "failed_run"] as const) {
      expect(routeAttention(item(kind), reserved).type).toBe("ceo-digest");
    }
  });

  it("sends interactions and approvals to the CEO digest", () => {
    expect(routeAttention(item("issue_thread_interaction"), ctx()).type).toBe("ceo-digest");
    expect(routeAttention(item("approval"), ctx()).type).toBe("ceo-digest");
  });
});
