import { describe, expect, it } from "vitest";

import { planRespondAction, planRespondActions, respondIdempotencyKey } from "../src/respond.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { sweepDecisions, type SweepReads } from "../src/sweep.js";

const PENDING = { id: "ix-1", issueId: "issue-1", kind: "ask_user_questions", status: "pending" };

describe("planRespondAction", () => {
  it("drafts a respond propose-only when the flag is off", () => {
    const plan = planRespondAction(PENDING, { applyMutations: false });
    expect(plan).toMatchObject({
      interactionId: "ix-1",
      issueId: "issue-1",
      kind: "ask_user_questions",
      decision: "respond",
      outcome: "respond",
      mode: "propose",
      idempotencyKey: "interaction-respond:ix-1",
    });
  });

  it("marks apply intent when the flag is on, on the same idempotency key", () => {
    const plan = planRespondAction(PENDING, { applyMutations: true });
    expect(plan.mode).toBe("apply");
    expect(plan.decision).toBe("respond");
    expect(plan.idempotencyKey).toBe(respondIdempotencyKey("ix-1"));
  });

  it("skips a duplicate key already planned", () => {
    const seen = new Set([respondIdempotencyKey("ix-1")]);
    const plan = planRespondAction(PENDING, { applyMutations: false, seenKeys: seen });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("duplicate");
  });

  it("skips non-pending statuses (decided history never re-responds)", () => {
    for (const status of ["accepted", "rejected", "expired", ""]) {
      const plan = planRespondAction({ ...PENDING, status }, { applyMutations: false });
      expect(plan.decision).toBe("skip");
    }
  });

  it("skips malformed rows with no interaction id", () => {
    const plan = planRespondAction({ id: "", issueId: "issue-1", kind: "ask_user_questions", status: "pending" }, { applyMutations: false });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("malformed");
  });
});

describe("planRespondActions", () => {
  it("de-duplicates within the batch on the interaction key", () => {
    const plans = planRespondActions([PENDING, PENDING], { applyMutations: false });
    expect(plans.map((plan) => plan.decision)).toEqual(["respond", "skip"]);
    expect(plans[1]?.reason).toContain("duplicate");
  });

  it("keeps keys stable across modes (idempotent retry)", () => {
    const propose = planRespondActions([PENDING], { applyMutations: false });
    const apply = planRespondActions([PENDING], {
      applyMutations: true,
      seenKeys: [],
    });
    expect(propose[0]?.idempotencyKey).toBe(apply[0]?.idempotencyKey);
  });
});

describe("sweep respond plans", () => {
  function reads(): SweepReads {
    return {
      async listOpenIssues() {
        return [{ id: "issue-1", identifier: "TOG-1", status: "todo", assigneeAgentId: "agent-a" }];
      },
      async listPendingInteractions() {
        return [
          {
            id: "ix-1",
            kind: "ask_user_questions",
            status: "pending",
            effectiveResolverPolicy: "human_only",
            createdByAgentId: "agent-a",
            addresseeAgentId: null,
            hasToolAction: false,
            continuationPolicy: "wake_assignee",
            createdAt: "2026-10-03T15:24:00Z",
            title: "Should we cut over?",
          },
        ];
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
        return [];
      },
    };
  }

  it("drafts interaction responds propose-only in shadow mode", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), new Date("2026-10-03T18:00:00Z"));
    expect(result.respondPlans).toHaveLength(1);
    expect(result.respondPlans[0]).toMatchObject({
      interactionId: "ix-1",
      decision: "respond",
      outcome: "respond",
      mode: "propose",
      idempotencyKey: "interaction-respond:ix-1",
    });
  });

  it("plans apply intent when mutations are enabled (still no live call)", async () => {
    const result = await sweepDecisions(
      "company-1",
      { ...DEFAULT_CONFIG, applyMutations: true },
      reads(),
      new Date("2026-10-03T18:00:00Z"),
    );
    expect(result.respondPlans[0]?.mode).toBe("apply");
    expect(result.respondPlans[0]?.decision).toBe("respond");
  });

  it("leaves flag-off behavior unchanged for the routed interaction item", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), new Date("2026-10-03T18:00:00Z"));
    const interaction = result.routed.find((r) => r.item.kind === "issue_thread_interaction");
    expect(interaction?.destination.type).toBe("ceo-digest");
  });
});
