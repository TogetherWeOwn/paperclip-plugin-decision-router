import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import {
  planRecoveryAction,
  planRecoveryActions,
  recoveryIdempotencyKey,
} from "../src/recovery.js";
import { sweepDecisions, type SweepReads } from "../src/sweep.js";

const ACTIVE = { id: "ra-1", kind: "missing_disposition", status: "active" };

describe("planRecoveryAction", () => {
  it("resolves an active action propose-only when the flag is off", () => {
    const plan = planRecoveryAction(ACTIVE, { applyMutations: false });
    expect(plan).toMatchObject({
      actionId: "ra-1",
      decision: "resolve",
      outcome: "resolve",
      mode: "propose",
      idempotencyKey: "recovery-resolve:ra-1",
    });
  });

  it("marks apply intent when the flag is on, on the same idempotency key", () => {
    const plan = planRecoveryAction(ACTIVE, { applyMutations: true });
    expect(plan.mode).toBe("apply");
    expect(plan.decision).toBe("resolve");
    expect(plan.idempotencyKey).toBe(recoveryIdempotencyKey("ra-1"));
  });

  it("resolves escalated attention too", () => {
    const plan = planRecoveryAction({ ...ACTIVE, status: "escalated" }, { applyMutations: false });
    expect(plan.decision).toBe("resolve");
  });

  it("skips a duplicate key already planned", () => {
    const seen = new Set([recoveryIdempotencyKey("ra-1")]);
    const plan = planRecoveryAction(ACTIVE, { applyMutations: false, seenKeys: seen });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("duplicate");
  });

  it("skips non-attention statuses (history never resolves)", () => {
    for (const status of ["resolved", "cancelled", ""]) {
      const plan = planRecoveryAction({ ...ACTIVE, status }, { applyMutations: false });
      expect(plan.decision).toBe("skip");
    }
  });

  it("skips malformed rows with no action id", () => {
    const plan = planRecoveryAction({ id: "", kind: "watchdog", status: "active" }, { applyMutations: false });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("malformed");
  });
});

describe("planRecoveryActions", () => {
  it("de-duplicates within the batch on the action key", () => {
    const plans = planRecoveryActions([ACTIVE, ACTIVE], { applyMutations: false });
    expect(plans.map((plan) => plan.decision)).toEqual(["resolve", "skip"]);
    expect(plans[1]?.reason).toContain("duplicate");
  });

  it("keeps keys stable across modes (idempotent retry)", () => {
    const propose = planRecoveryActions([ACTIVE], { applyMutations: false });
    const apply = planRecoveryActions([ACTIVE], {
      applyMutations: true,
      seenKeys: [],
    });
    expect(propose[0]?.idempotencyKey).toBe(apply[0]?.idempotencyKey);
  });
});

describe("sweep recovery plans", () => {
  function reads(): SweepReads {
    return {
      async listOpenIssues() {
        return [{ id: "issue-1", identifier: "TOG-1", status: "todo", assigneeAgentId: "agent-a" }];
      },
      async listPendingInteractions() {
        return [];
      },
      async listRelations() {
        return {
          blockedByIds: [],
          activeRecovery: [
            { id: "ra-1", kind: "missing_disposition", status: "active", createdAt: "2026-10-03T10:00:00Z" },
          ],
        };
      },
      async listPendingApprovals() {
        return [];
      },
      async listFailedRuns() {
        return [];
      },
      async extraItems() {
        return [];
      },
    };
  }

  it("plans recovery resolves propose-only in shadow mode", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), new Date("2026-10-03T18:00:00Z"));
    expect(result.recoveryPlans).toHaveLength(1);
    expect(result.recoveryPlans[0]).toMatchObject({ decision: "resolve", outcome: "resolve", mode: "propose" });
  });

  it("plans apply intent when mutations are enabled (still no live call)", async () => {
    const result = await sweepDecisions(
      "company-1",
      { ...DEFAULT_CONFIG, applyMutations: true },
      reads(),
      new Date("2026-10-03T18:00:00Z"),
    );
    expect(result.recoveryPlans[0]?.mode).toBe("apply");
  });
});
