import { describe, expect, it } from "vitest";

import {
  budgetAlertIdempotencyKey,
  planBudgetAlertAction,
  planBudgetAlertActions,
  type BudgetAlertRouteInput,
} from "../src/budgetAlert.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { routeAttention, type RoutingContext } from "../src/routing.js";
import { sweepDecisions, type SweepReads } from "../src/sweep.js";

const TRIGGERED: BudgetAlertRouteInput = {
  id: "alert-1",
  issueId: "issue-1",
  severity: "critical",
  status: "triggered",
};

function ctx(): RoutingContext {
  return {
    codeReviewerAgentId: "agent-reviewer",
    focusAnchorIssueId: null,
    blockerOwners: {},
    focusIssueIds: [],
    retryAttempts: {},
    maxRetryAttempts: 2,
  };
}

describe("planBudgetAlertAction", () => {
  it("proposes a graded attention alert propose-only when the flag is off", () => {
    const plan = planBudgetAlertAction(TRIGGERED, { applyMutations: false });
    expect(plan).toMatchObject({
      alertId: "alert-1",
      issueId: "issue-1",
      decision: "propose",
      severity: "critical",
      mode: "propose",
      idempotencyKey: "budget-alert:alert-1",
    });
    expect(plan.reason).toContain("CEO digest");
  });

  it("marks apply intent when the flag is on, on the same idempotency key", () => {
    const plan = planBudgetAlertAction(TRIGGERED, { applyMutations: true });
    expect(plan.mode).toBe("apply");
    expect(plan.decision).toBe("propose");
    expect(plan.severity).toBe("critical");
    expect(plan.idempotencyKey).toBe(budgetAlertIdempotencyKey("alert-1"));
  });

  it("proposes every known severity", () => {
    for (const severity of ["info", "warning", "critical"]) {
      const plan = planBudgetAlertAction({ ...TRIGGERED, severity }, { applyMutations: false });
      expect(plan.decision).toBe("propose");
      expect(plan.severity).toBe(severity);
    }
  });

  it("proposes active and acknowledged alerts (still attention)", () => {
    for (const status of ["active", "acknowledged"]) {
      const plan = planBudgetAlertAction({ ...TRIGGERED, status }, { applyMutations: false });
      expect(plan.decision).toBe("propose");
    }
  });

  it("skips resolved-family and unknown statuses — history never re-proposes", () => {
    for (const status of ["resolved", "cancelled", "expired", "bogus", ""]) {
      const plan = planBudgetAlertAction({ ...TRIGGERED, status }, { applyMutations: false });
      expect(plan.decision).toBe("skip");
      expect(plan.severity).toBeNull();
      expect(plan.reason).toContain("not attention");
    }
  });

  it("skips ungraded severities (fails closed)", () => {
    for (const severity of [null, "", "urgent"]) {
      const plan = planBudgetAlertAction(
        { ...TRIGGERED, severity },
        { applyMutations: false },
      );
      expect(plan.decision).toBe("skip");
      expect(plan.severity).toBeNull();
      expect(plan.reason).toContain("ungraded");
    }
  });

  it("skips a duplicate key already planned", () => {
    const seen = new Set([budgetAlertIdempotencyKey("alert-1")]);
    const plan = planBudgetAlertAction(TRIGGERED, { applyMutations: false, seenKeys: seen });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("duplicate");
  });

  it("skips malformed rows with no alert id", () => {
    const plan = planBudgetAlertAction({ ...TRIGGERED, id: "  " }, { applyMutations: false });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("malformed");
  });
});

describe("planBudgetAlertActions", () => {
  it("de-duplicates within the batch on the alert key", () => {
    const plans = planBudgetAlertActions([TRIGGERED, TRIGGERED], { applyMutations: false });
    expect(plans.map((plan) => plan.decision)).toEqual(["propose", "skip"]);
    expect(plans[1]?.reason).toContain("duplicate");
  });

  it("keeps keys stable across modes (idempotent retry)", () => {
    const propose = planBudgetAlertActions([TRIGGERED], { applyMutations: false });
    const apply = planBudgetAlertActions([TRIGGERED], { applyMutations: true, seenKeys: [] });
    expect(propose[0]?.idempotencyKey).toBe(apply[0]?.idempotencyKey);
  });

  it("does not mutate the caller's seenKeys set", () => {
    const seen = new Set<string>();
    planBudgetAlertActions([TRIGGERED], { applyMutations: false, seenKeys: seen });
    expect(seen.size).toBe(0);
  });
});

describe("budget_alert routing", () => {
  it("sends budget alerts to the CEO digest (never auto-routed)", () => {
    const destination = routeAttention(
      {
        kind: "budget_alert",
        issueId: "issue-1",
        sourceId: "alert-1",
        pendingSince: "2026-10-03T11:00:00Z",
      },
      ctx(),
    );
    expect(destination).toMatchObject({ type: "ceo-digest" });
  });
});

describe("sweep budget-alert plans", () => {
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
        return [];
      },
      async listFailedRuns() {
        return [];
      },
      async extraItems() {
        return [
          {
            kind: "budget_alert",
            issueId: "issue-1",
            identifier: "TOG-1",
            sourceId: "alert-1",
            pendingSince: "2026-10-03T11:00:00Z",
            detail: "critical spend alert",
            budgetSeverity: "critical",
            budgetStatus: "triggered",
          },
          {
            kind: "budget_alert",
            issueId: "issue-1",
            identifier: "TOG-1",
            sourceId: "alert-resolved",
            pendingSince: "2026-10-03T11:00:00Z",
            detail: "resolved spend alert",
            budgetSeverity: "warning",
            budgetStatus: "resolved",
          },
          {
            kind: "budget_alert",
            issueId: "issue-1",
            identifier: "TOG-1",
            sourceId: "alert-ungraded",
            pendingSince: "2026-10-03T11:00:00Z",
            detail: "ungraded spend alert",
          },
        ];
      },
    };
  }

  const NOW = new Date("2026-10-03T18:00:00Z");

  it("routes budget alerts to the digest and plans propose/skip propose-only", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), NOW);
    const routed = result.routed.filter((r) => r.item.kind === "budget_alert");
    expect(routed).toHaveLength(3);
    expect(routed.every((r) => r.destination.type === "ceo-digest")).toBe(true);
    expect(result.budgetAlertPlans).toHaveLength(3);
    expect(result.budgetAlertPlans[0]).toMatchObject({
      alertId: "alert-1",
      decision: "propose",
      severity: "critical",
      mode: "propose",
      idempotencyKey: "budget-alert:alert-1",
    });
    expect(result.budgetAlertPlans[1]?.decision).toBe("skip");
    expect(result.budgetAlertPlans[2]?.decision).toBe("skip");
    expect(result.digest).toContain("budget_alert");
    expect(result.digest).toContain("verb: propose");
  });

  it("plans apply intent when mutations are enabled (still no live call)", async () => {
    const result = await sweepDecisions(
      "company-1",
      { ...DEFAULT_CONFIG, applyMutations: true },
      reads(),
      NOW,
    );
    expect(result.budgetAlertPlans[0]).toMatchObject({ decision: "propose", mode: "apply" });
  });

  it("emits no budget-alert plans when no budget rows arrive", async () => {
    const empty: SweepReads = {
      ...reads(),
      async extraItems() {
        return [];
      },
    };
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, empty, NOW);
    expect(result.budgetAlertPlans).toHaveLength(0);
  });
});
