import { describe, expect, it, vi } from "vitest";

import {
  applyUnblockPlans,
  isStaleBlockerStatus,
  planUnblock,
  staleEdges,
  unblockKeyForEdge,
  unblockProposalNote,
  UNBLOCK_KEYS_CAP,
  type BlockerEdge,
  type UnblockFirePlan,
} from "../src/unblock.js";

function edge(overrides: Partial<BlockerEdge> = {}): BlockerEdge {
  return { blockerIssueId: "blocker-1", blockerIdentifier: "TOG-9", blockerStatus: "done", ...overrides };
}

describe("isStaleBlockerStatus", () => {
  it("treats done and cancelled as stale", () => {
    expect(isStaleBlockerStatus("done")).toBe(true);
    expect(isStaleBlockerStatus("cancelled")).toBe(true);
  });

  it("fails closed on open and unknown statuses", () => {
    for (const status of ["todo", "in_progress", "in_review", "blocked", "backlog", "", "DONE"]) {
      expect(isStaleBlockerStatus(status)).toBe(false);
    }
  });
});

describe("unblockKeyForEdge", () => {
  it("is stable and edge-scoped", () => {
    expect(unblockKeyForEdge("issue-a", "blocker-b")).toBe("decision-router/unblock/issue-a/blocker-b");
    expect(unblockKeyForEdge("issue-a", "blocker-b")).toBe(unblockKeyForEdge("issue-a", "blocker-b"));
    expect(unblockKeyForEdge("issue-a", "blocker-c")).not.toBe(unblockKeyForEdge("issue-a", "blocker-b"));
  });
});

describe("planUnblock", () => {
  it("proposes (never fires) when the flag is off", () => {
    const plan = planUnblock({ issueId: "issue-1", edge: edge(), firedKeys: new Set(), applyMutations: false });
    expect(plan.action).toBe("propose");
    expect(plan.reason).toContain("TOG-9");
    expect(plan.reason).toContain("done");
  });

  it("fires when the flag is on", () => {
    const plan = planUnblock({ issueId: "issue-1", edge: edge(), firedKeys: new Set(), applyMutations: true });
    expect(plan.action).toBe("fire");
    expect(plan.unblockKey).toBe("decision-router/unblock/issue-1/blocker-1");
  });

  it("skips an already-fired edge without firing again", () => {
    const firedKeys = new Set(["decision-router/unblock/issue-1/blocker-1"]);
    const plan = planUnblock({ issueId: "issue-1", edge: edge(), firedKeys, applyMutations: true });
    expect(plan.action).toBe("skip");
    expect(plan.reason).toBe("duplicate unblock already fired");
  });
});

describe("staleEdges", () => {
  it("keeps only terminal-status targets", () => {
    const edges = [
      edge({ blockerIssueId: "b-done", blockerStatus: "done" }),
      edge({ blockerIssueId: "b-cancelled", blockerStatus: "cancelled" }),
      edge({ blockerIssueId: "b-open", blockerStatus: "in_progress" }),
    ];
    expect(staleEdges(edges).map((entry) => entry.blockerIssueId)).toEqual(["b-done", "b-cancelled"]);
  });
});

describe("unblockProposalNote", () => {
  it("returns null when nothing is actionable", () => {
    expect(unblockProposalNote([])).toBeNull();
  });

  it("names each actionable stale edge", () => {
    const plans = [
      planUnblock({ issueId: "issue-1", edge: edge(), firedKeys: new Set(), applyMutations: false }),
    ];
    expect(unblockProposalNote(plans)).toContain("TOG-9");
  });
});

describe("applyUnblockPlans", () => {
  const firePlan: UnblockFirePlan = {
    action: "fire",
    unblockKey: "decision-router/unblock/issue-1/blocker-1",
    issueId: "issue-1",
    blockerIssueId: "blocker-1",
    blockerIdentifier: "TOG-9",
    blockerStatus: "done",
    reason: "stale",
  };

  it("applies fire plans through the injected unblock", async () => {
    const unblock = vi.fn().mockResolvedValue(undefined);
    const outcomes = await applyUnblockPlans([firePlan], { applyMutations: true, unblock });
    expect(outcomes).toMatchObject([{ plan: firePlan, applied: true }]);
    expect(unblock).toHaveBeenCalledOnce();
    expect(unblock).toHaveBeenCalledWith(firePlan);
  });

  it("never fires while shadow mode is on, even for fire plans", async () => {
    const unblock = vi.fn().mockResolvedValue(undefined);
    const outcomes = await applyUnblockPlans([firePlan], { applyMutations: false, unblock });
    expect(outcomes).toMatchObject([{ plan: firePlan, applied: false }]);
    expect(unblock).not.toHaveBeenCalled();
  });

  it("records the error and continues past a failing removal", async () => {
    const failing = vi.fn().mockRejectedValueOnce(new Error("host denied")).mockResolvedValue(undefined);
    const second: UnblockFirePlan = { ...firePlan, blockerIssueId: "blocker-2" };
    const outcomes = await applyUnblockPlans([firePlan, second], { applyMutations: true, unblock: failing });
    expect(outcomes[0]).toMatchObject({ applied: false, error: "host denied" });
    expect(outcomes[1]).toMatchObject({ applied: true });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("leaves non-fire plans unapplied", async () => {
    const unblock = vi.fn().mockResolvedValue(undefined);
    const propose = planUnblock({ issueId: "issue-1", edge: edge(), firedKeys: new Set(), applyMutations: false });
    const outcomes = await applyUnblockPlans([propose], { applyMutations: false, unblock });
    expect(outcomes).toMatchObject([{ applied: false }]);
    expect(unblock).not.toHaveBeenCalled();
  });

  it("caps the persisted key set", () => {
    expect(UNBLOCK_KEYS_CAP).toBe(500);
  });
});
