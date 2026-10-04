/**
 * human_only skip-path parity: the plugin SKIPS human_only
 * issue_thread_interaction items and never drafts a respond for them,
 * while still handling flaggable (board_or_agents) verbs.
 *
 * Parity anchor: triage marks these rows OWNER_ONLY (no agent run can
 * resolve them); the respond planner must agree by planning `skip`.
 * A respond proposal drafted against an OWNER_ONLY item is the plugin
 * answering a question only a human may answer.
 */
import { describe, expect, it } from "vitest";

import type { AttentionItem } from "../src/attention.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { planRespondAction, planRespondActions } from "../src/respond.js";
import { routeInteraction, type RoutingContext } from "../src/routing.js";
import { sweepDecisions, type SweepReads } from "../src/sweep.js";
import { triageInteraction, type TriageRow } from "../src/triage.js";

const HUMAN_ONLY = {
  id: "ix-human",
  issueId: "issue-1",
  kind: "ask_user_questions",
  status: "pending",
  effectiveResolverPolicy: "human_only",
};

const FLAGGABLE = {
  id: "ix-flag",
  issueId: "issue-1",
  kind: "ask_user_questions",
  status: "pending",
  effectiveResolverPolicy: "board_or_agents",
};

function routingCtx(): RoutingContext {
  return {
    codeReviewerAgentId: "agent-reviewer",
    focusAnchorIssueId: null,
    blockerOwners: {},
    focusIssueIds: [],
    retryAttempts: {},
    maxRetryAttempts: 2,
  };
}

function attentionItem(id: string): AttentionItem {
  return {
    kind: "issue_thread_interaction",
    issueId: "issue-1",
    identifier: "TOG-1",
    sourceId: id,
    pendingSince: "2026-10-03T15:24:00Z",
    detail: "Should we cut over?",
  };
}

function triageRow(id: string, policy: string): TriageRow {
  return {
    identifier: `TOG-1/${id.slice(0, 8)}`,
    kind: "ask_user_questions",
    effectiveResolverPolicy: policy,
    createdByAgentId: "agent-b",
    assigneeAgentId: "agent-a",
    addresseeAgentId: null,
    hasToolAction: false,
    issueStatus: "todo",
    namedReviewInteraction: false,
    continuationPolicy: "wake_assignee",
  };
}

describe("human_only skip-path parity", () => {
  it("triage and the respond planner agree: human_only is OWNER_ONLY and skips", () => {
    const triage = triageInteraction(triageRow("ix-human", "human_only"));
    expect(triage.verdict).toBe("OWNER_ONLY");
    const plan = planRespondAction(HUMAN_ONLY, { applyMutations: false });
    expect(plan.decision).toBe("skip");
    expect(plan.reason).toContain("human_only");
  });

  it("never drafts a respond for human_only, even with mutations enabled", () => {
    const plan = planRespondAction(HUMAN_ONLY, { applyMutations: true });
    expect(plan.decision).toBe("skip");
    expect(plan.mode).toBe("apply");
  });

  it("still drafts flaggable (board_or_agents) verbs in both modes", () => {
    const propose = planRespondAction(FLAGGABLE, { applyMutations: false });
    expect(propose).toMatchObject({ decision: "respond", outcome: "respond", mode: "propose" });
    const apply = planRespondAction(FLAGGABLE, { applyMutations: true });
    expect(apply).toMatchObject({ decision: "respond", outcome: "respond", mode: "apply" });
  });

  it("leaves rows with no policy on the legacy path (explicit human_only match only)", () => {
    const plan = planRespondAction(
      { id: "ix-legacy", issueId: "issue-1", kind: "ask_user_questions", status: "pending" },
      { applyMutations: false },
    );
    expect(plan.decision).toBe("respond");
  });

  it("skips human_only rows in a mixed batch while drafting the flaggable one", () => {
    const plans = planRespondActions([HUMAN_ONLY, FLAGGABLE], { applyMutations: false });
    expect(plans.map((plan) => plan.decision)).toEqual(["skip", "respond"]);
    expect(plans[0]?.reason).toContain("human_only");
    expect(plans[1]?.idempotencyKey).toBe("interaction-respond:ix-flag");
  });

  it("dedups a repeated human_only key instead of planning it twice", () => {
    const plans = planRespondActions([HUMAN_ONLY, HUMAN_ONLY], { applyMutations: false });
    expect(plans.map((plan) => plan.decision)).toEqual(["skip", "skip"]);
    expect(plans[1]?.reason).toContain("duplicate");
  });

  it("routes the human_only item to the CEO digest with its OWNER_ONLY triage attached", () => {
    const routed = routeInteraction(attentionItem("ix-human"), triageRow("ix-human", "human_only"), routingCtx());
    expect(routed.destination.type).toBe("ceo-digest");
    expect(routed.triage?.verdict).toBe("OWNER_ONLY");
  });
});

describe("sweep human_only parity", () => {
  function reads(): SweepReads {
    return {
      async listOpenIssues() {
        return [{ id: "issue-1", identifier: "TOG-1", status: "todo", assigneeAgentId: "agent-a" }];
      },
      async listPendingInteractions() {
        return [
          {
            id: "ix-human",
            kind: "ask_user_questions",
            status: "pending",
            effectiveResolverPolicy: "human_only",
            createdByAgentId: "agent-b",
            addresseeAgentId: null,
            hasToolAction: false,
            continuationPolicy: "wake_assignee",
            createdAt: "2026-10-03T15:24:00Z",
            title: "Should we cut over?",
          },
          {
            id: "ix-flag",
            kind: "ask_user_questions",
            status: "pending",
            effectiveResolverPolicy: "board_or_agents",
            createdByAgentId: "agent-b",
            addresseeAgentId: null,
            hasToolAction: false,
            continuationPolicy: "wake_assignee",
            createdAt: "2026-10-03T16:00:00Z",
            title: "Which plan?",
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

  it("skips the human_only interaction and still drafts the flaggable one", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), new Date("2026-10-03T18:00:00Z"));
    expect(result.respondPlans).toHaveLength(2);
    expect(result.respondPlans[0]).toMatchObject({ interactionId: "ix-human", decision: "skip" });
    expect(result.respondPlans[0]?.reason).toContain("human_only");
    expect(result.respondPlans[1]).toMatchObject({
      interactionId: "ix-flag",
      decision: "respond",
      mode: "propose",
    });
  });

  it("keeps both items in the CEO digest with the ANSWER grammar stub (the CEO's channel)", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), new Date("2026-10-03T18:00:00Z"));
    const interactions = result.routed.filter((r) => r.item.kind === "issue_thread_interaction");
    expect(interactions).toHaveLength(2);
    expect(interactions.every((r) => r.destination.type === "ceo-digest")).toBe(true);
    expect(result.digest).toContain("ANSWER ix-human accept|reject");
    expect(result.digest).toContain("ANSWER ix-flag accept|reject");
  });
});
