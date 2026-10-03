import { describe, expect, it } from "vitest";

import { planApprovalAction, planApprovalActions, approvalIdempotencyKey } from "../src/approval.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { sweepDecisions, type SweepReads } from "../src/sweep.js";

const PENDING = { id: "ap-1", issueId: "issue-1", status: "pending" };

describe("planApprovalAction", () => {
  it("approves a pending approval propose-only when the flag is off", () => {
    const plan = planApprovalAction(PENDING, { applyMutations: false });
    expect(plan).toMatchObject({
      approvalId: "ap-1",
      decision: "approve",
      outcome: "approve",
      mode: "propose",
      idempotencyKey: "approval-approve:ap-1",
    });
  });

  it("marks apply intent when the flag is on, on the same idempotency key", () => {
    const plan = planApprovalAction(PENDING, { applyMutations: true });
    expect(plan.mode).toBe("apply");
    expect(plan.decision).toBe("approve");
    expect(plan.idempotencyKey).toBe(approvalIdempotencyKey("ap-1"));
  });

  it("plans company-scope approvals (no linked issue) the same way", () => {
    const plan = planApprovalAction({ id: "ap-9", issueId: null, status: "pending" }, { applyMutations: false });
    expect(plan.decision).toBe("approve");
    expect(plan.issueId).toBeNull();
  });

  it("skips a duplicate key already planned", () => {
    const seen = new Set([approvalIdempotencyKey("ap-1")]);
    const plan = planApprovalAction(PENDING, { applyMutations: false, seenKeys: seen });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("duplicate");
  });

  it("skips non-pending statuses (decided history never re-approves)", () => {
    for (const status of ["approved", "rejected", ""]) {
      const plan = planApprovalAction({ ...PENDING, status }, { applyMutations: false });
      expect(plan.decision).toBe("skip");
    }
  });

  it("skips malformed rows with no approval id", () => {
    const plan = planApprovalAction({ id: "", issueId: null, status: "pending" }, { applyMutations: false });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("malformed");
  });
});

describe("planApprovalActions", () => {
  it("de-duplicates within the batch on the approval key", () => {
    const plans = planApprovalActions([PENDING, PENDING], { applyMutations: false });
    expect(plans.map((plan) => plan.decision)).toEqual(["approve", "skip"]);
    expect(plans[1]?.reason).toContain("duplicate");
  });

  it("keeps keys stable across modes (idempotent retry)", () => {
    const propose = planApprovalActions([PENDING], { applyMutations: false });
    const apply = planApprovalActions([PENDING], {
      applyMutations: true,
      seenKeys: [],
    });
    expect(propose[0]?.idempotencyKey).toBe(apply[0]?.idempotencyKey);
  });
});

describe("sweep approval plans", () => {
  function reads(): SweepReads {
    return {
      async listOpenIssues() {
        return [{ id: "issue-1", identifier: "TOG-1", status: "todo", assigneeAgentId: "agent-a" }];
      },
      async listPendingInteractions() {
        return [];
      },
      async listRelations() {
        return { blockedByIds: [], blockers: [], activeRecovery: [] };
      },
      async listPendingApprovals() {
        return [{ id: "ap-1", issueId: "issue-1", status: "pending", createdAt: "2026-10-03T09:00:00Z" }];
      },
      async listFailedRuns() {
        return [];
      },
      async extraItems() {
        return [];
      },
    };
  }

  it("plans approval approves propose-only in shadow mode", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), new Date("2026-10-03T18:00:00Z"));
    expect(result.approvalPlans).toHaveLength(1);
    expect(result.approvalPlans[0]).toMatchObject({ decision: "approve", outcome: "approve", mode: "propose" });
  });

  it("plans apply intent when mutations are enabled (still no live call)", async () => {
    const result = await sweepDecisions(
      "company-1",
      { ...DEFAULT_CONFIG, applyMutations: true },
      reads(),
      new Date("2026-10-03T18:00:00Z"),
    );
    expect(result.approvalPlans[0]?.mode).toBe("apply");
  });

  it("leaves flag-off behavior unchanged for the routed approval item", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), new Date("2026-10-03T18:00:00Z"));
    const approval = result.routed.find((r) => r.item.kind === "approval");
    expect(approval?.destination.type).toBe("ceo-digest");
  });
});
