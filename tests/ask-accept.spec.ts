/**
 * ask_user_questions accept-path parity: an agent-resolvable `ask_user_questions`
 * row accepts without a human, while decline / non-accept outcomes leave state
 * untouched — all behind the existing `applyMutations` flag, never a live call.
 *
 * Parity anchors (host `interaction_triage.sh` / `routes/issues.js`):
 * triage classifies resolvability and the continuation wake; the CEO grammar
 * carries the outcome (`ANSWER <id> accept|reject`); the respond planner only
 * ever drafts a `respond` plan (propose in shadow, apply intent behind the
 * flag). Accept wakes the assignee (`wake_assignee_on_accept` → WAKES_ON_ACCEPT,
 * :1263); a REJECTION wakes nobody. Decided rows never re-respond, and the
 * sweep returns plans + routes + digest only — there is no mutation surface
 * (`issue.interactions.respond` is absent from the manifest until cutover;
 * see manifest.spec.ts).
 *
 * Distinct from the `request_confirmation` accept path (sibling card — that
 * kind carries the :2953 toolAction board-only gate) and from the `human_only`
 * skip path (pinned in human-only-skip.spec.ts; only proven-flaggable
 * `board_or_agents` rows appear here).
 */
import { describe, expect, it } from "vitest";

import type { AttentionItem } from "../src/attention.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { parseGrammar } from "../src/grammar.js";
import { planRespondAction, planRespondActions } from "../src/respond.js";
import { routeInteraction, type RoutingContext } from "../src/routing.js";
import { sweepDecisions, type SweepReads } from "../src/sweep.js";
import { triageInteraction, type TriageRow } from "../src/triage.js";

/** Agent-resolvable ask row: assigned + open + flaggable + accept-wakes. */
const ASK_ACCEPT = {
  id: "ix-ask",
  issueId: "issue-1",
  kind: "ask_user_questions",
  status: "pending",
  effectiveResolverPolicy: "board_or_agents",
};

function triageRow(kind: string): TriageRow {
  return {
    identifier: "TOG-1/ix-ask",
    kind,
    effectiveResolverPolicy: "board_or_agents",
    createdByAgentId: "agent-b",
    assigneeAgentId: "agent-a",
    addresseeAgentId: null,
    hasToolAction: false,
    issueStatus: "todo",
    namedReviewInteraction: false,
    continuationPolicy: "wake_assignee_on_accept",
  };
}

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
    pendingSince: "2026-10-04T10:00:00Z",
    detail: 'ask_user_questions "Which plan?"',
  };
}

describe("ask_user_questions accept-path parity", () => {
  it("triage resolves the accept path without a human: AGENT_RESOLVABLE + WAKES_ON_ACCEPT", () => {
    const triage = triageInteraction(triageRow("ask_user_questions"));
    expect(triage.verdict).toBe("AGENT_RESOLVABLE");
    expect(triage.resolvers).toEqual(["agent-a"]);
    expect(triage.continuation).toBe("WAKES_ON_ACCEPT");
    expect(triage.continuationWhy).toContain("REJECTION wakes nobody");
  });

  it("parses the CEO accept outcome for the row (ANSWER <id> accept)", () => {
    const parsed = parseGrammar("ANSWER ix-ask accept ship it");
    expect(parsed.errors).toEqual([]);
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.commands[0]).toMatchObject({ verb: "ANSWER", target: "ix-ask", arg: "accept" });
  });

  it("drafts the accept-path respond propose-only when the flag is off", () => {
    const plan = planRespondAction(ASK_ACCEPT, { applyMutations: false });
    expect(plan).toMatchObject({
      interactionId: "ix-ask",
      kind: "ask_user_questions",
      decision: "respond",
      outcome: "respond",
      mode: "propose",
      idempotencyKey: "interaction-respond:ix-ask",
    });
  });

  it("marks the same accept-path apply intent when the flag is on (still no live call)", () => {
    const plan = planRespondAction(ASK_ACCEPT, { applyMutations: true });
    expect(plan).toMatchObject({ decision: "respond", outcome: "respond", mode: "apply" });
    expect(plan.idempotencyKey).toBe("interaction-respond:ix-ask");
  });

  it("routes the agent-resolvable ask row to the CEO digest with its triage attached", () => {
    const routed = routeInteraction(attentionItem("ix-ask"), triageRow("ask_user_questions"), routingCtx());
    expect(routed.destination.type).toBe("ceo-digest");
    expect(routed.triage?.verdict).toBe("AGENT_RESOLVABLE");
    expect(routed.triage?.continuation).toBe("WAKES_ON_ACCEPT");
  });
});

describe("ask_user_questions decline / non-accept leaves state untouched", () => {
  it("parses the decline outcome (ANSWER <id> reject) — a rejection wakes nobody", () => {
    const parsed = parseGrammar("ANSWER ix-ask reject not now");
    expect(parsed.errors).toEqual([]);
    expect(parsed.commands[0]).toMatchObject({ verb: "ANSWER", target: "ix-ask", arg: "reject" });
    const triage = triageInteraction(triageRow("ask_user_questions"));
    expect(triage.continuation).toBe("WAKES_ON_ACCEPT");
    expect(triage.continuationWhy).toContain("REJECTION wakes nobody");
  });

  it("never re-responds decided ask rows in either mode (accepted/rejected/expired stay untouched)", () => {
    for (const status of ["accepted", "rejected", "expired"]) {
      for (const applyMutations of [false, true]) {
        const plan = planRespondAction({ ...ASK_ACCEPT, status }, { applyMutations });
        expect(plan.decision).toBe("skip");
        expect(plan.mode).toBe(applyMutations ? "apply" : "propose");
      }
    }
  });

  it("keeps idempotency on the accept path: a duplicate accept-path key drafts once", () => {
    const plans = planRespondActions([ASK_ACCEPT, ASK_ACCEPT], { applyMutations: false });
    expect(plans.map((plan) => plan.decision)).toEqual(["respond", "skip"]);
    expect(plans[1]?.reason).toContain("duplicate");
  });
});

describe("sweep ask accept-path parity (flag-gated, plans only)", () => {
  function reads(): SweepReads {
    return {
      async listOpenIssues() {
        return [{ id: "issue-1", identifier: "TOG-1", status: "todo", assigneeAgentId: "agent-a" }];
      },
      async listPendingInteractions() {
        return [
          {
            id: "ix-ask",
            kind: "ask_user_questions",
            status: "pending",
            effectiveResolverPolicy: "board_or_agents",
            createdByAgentId: "agent-b",
            addresseeAgentId: null,
            hasToolAction: false,
            continuationPolicy: "wake_assignee_on_accept",
            createdAt: "2026-10-04T10:00:00Z",
            title: "Which plan?",
          },
          {
            // Decided history leaking through the read still never re-responds.
            id: "ix-declined",
            kind: "ask_user_questions",
            status: "rejected",
            effectiveResolverPolicy: "board_or_agents",
            createdByAgentId: "agent-b",
            addresseeAgentId: null,
            hasToolAction: false,
            continuationPolicy: "wake_assignee_on_accept",
            createdAt: "2026-10-04T09:00:00Z",
            title: "Old question",
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

  const at = new Date("2026-10-04T12:00:00Z");

  it("drafts the pending ask propose-only in shadow mode and skips the declined row", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), at);
    expect(result.respondPlans).toHaveLength(2);
    expect(result.respondPlans[0]).toMatchObject({
      interactionId: "ix-ask",
      decision: "respond",
      outcome: "respond",
      mode: "propose",
      idempotencyKey: "interaction-respond:ix-ask",
    });
    expect(result.respondPlans[1]).toMatchObject({ interactionId: "ix-declined", decision: "skip" });
  });

  it("plans the same accept-path apply intent with mutations enabled (still no live call)", async () => {
    const result = await sweepDecisions("company-1", { ...DEFAULT_CONFIG, applyMutations: true }, reads(), at);
    expect(result.respondPlans[0]).toMatchObject({ interactionId: "ix-ask", decision: "respond", mode: "apply" });
    expect(result.respondPlans[1]).toMatchObject({ interactionId: "ix-declined", decision: "skip" });
  });

  it("routes identically in both modes — the flag changes plan mode, never routing", async () => {
    const shadow = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), at);
    const live = await sweepDecisions("company-1", { ...DEFAULT_CONFIG, applyMutations: true }, reads(), at);
    expect(live.routed.map((r) => r.destination)).toEqual(shadow.routed.map((r) => r.destination));
    expect(live.items).toEqual(shadow.items);
  });

  it("keeps the ANSWER stub on the digest in both modes (the CEO's accept channel)", async () => {
    for (const applyMutations of [false, true]) {
      const result = await sweepDecisions("company-1", { ...DEFAULT_CONFIG, applyMutations }, reads(), at);
      expect(result.digest).toContain("ANSWER ix-ask accept|reject");
      expect(result.digest).toContain("verb: respond/accept");
    }
  });
});
