import { describe, expect, it } from "vitest";

import {
  planRequestConfirmationAction,
  planRequestConfirmationActions,
  requestConfirmationIdempotencyKey,
} from "../src/requestConfirmation.js";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.js";

/**
 * Test harness only: an in-memory fake wake store plus an accept-effect
 * applier. This is the parity surface — the applier walks accepted plans,
 * records every wake to a journal, and honors idempotency keys, so the tests
 * prove accepts route exactly like the host triage gate-for-gate (accepted
 * rows with a live wake write one accept record to the right assignee;
 * rejected rows and wakeless rows write nothing) with no live mutation.
 */
interface HarnessWake {
  interactionId: string;
  issueId: string;
  wakeAssignee: string;
  grammarLine: string;
}

interface Harness {
  wakes: HarnessWake[];
  seenKeys: Set<string>;
}

function makeHarness(): Harness {
  return { wakes: [], seenKeys: new Set() };
}

/** Apply an accepted plan to the fake store; returns the applied wake count (0 or 1). */
function applyRequestConfirmationPlan(
  plan: ReturnType<typeof planRequestConfirmationAction>,
  harness: Harness,
): number {
  if (plan.decision !== "accept" || plan.acceptance === null) return 0;
  if (harness.seenKeys.has(plan.idempotencyKey)) return 0;
  harness.wakes.push({
    interactionId: plan.interactionId,
    issueId: plan.issueId,
    wakeAssignee: plan.acceptance.wakeAssignee,
    grammarLine: plan.acceptance.grammarLine,
  });
  harness.seenKeys.add(plan.idempotencyKey);
  return 1;
}

const ACCEPTED = {
  interactionId: "rc-1",
  issueId: "issue-7",
  kind: "request_confirmation",
  status: "accepted",
  effectiveResolverPolicy: "board_or_agents",
  createdByAgentId: "agent-creator",
  assigneeAgentId: "agent-a",
  issueStatus: "todo",
  continuationPolicy: "wake_assignee",
};

describe("planRequestConfirmationAction", () => {
  it("is a flag-off no-op: skips without accepting and the harness writes nothing", () => {
    const plan = planRequestConfirmationAction(ACCEPTED, { enabled: false });
    expect(plan).toMatchObject({
      interactionId: "rc-1",
      issueId: "issue-7",
      decision: "skip",
      acceptance: null,
      triageVerdict: "AGENT_RESOLVABLE",
      triageContinuation: "WAKES",
      mode: "propose",
      idempotencyKey: "request-confirmation:rc-1",
    });
    expect(plan.reason).toContain("flag off");
    const harness = makeHarness();
    expect(applyRequestConfirmationPlan(plan, harness)).toBe(0);
    expect(harness.wakes).toEqual([]);
  });

  it("accepts under the flag and the harness records one wake to the assignee", () => {
    const plan = planRequestConfirmationAction(ACCEPTED, { enabled: true });
    expect(plan).toMatchObject({
      decision: "accept",
      triageVerdict: "AGENT_RESOLVABLE",
      triageContinuation: "WAKES",
      mode: "propose",
    });
    expect(plan.acceptance).toMatchObject({
      outcome: "accepted",
      wakeAssignee: "agent-a",
      grammarLine: "ANSWER rc-1 accept",
    });
    const harness = makeHarness();
    expect(applyRequestConfirmationPlan(plan, harness)).toBe(1);
    expect(harness.wakes).toEqual([
      { interactionId: "rc-1", issueId: "issue-7", wakeAssignee: "agent-a", grammarLine: "ANSWER rc-1 accept" },
    ]);
  });

  it("reject-path creates nothing: skip with zero harness writes", () => {
    const plan = planRequestConfirmationAction({ ...ACCEPTED, status: "rejected" }, { enabled: true });
    expect(plan.decision).toBe("skip");
    expect(plan.acceptance).toBeNull();
    expect(plan.reason).toContain("rejected");
    const harness = makeHarness();
    expect(applyRequestConfirmationPlan(plan, harness)).toBe(0);
    expect(harness.wakes).toEqual([]);
  });

  it("applies an accepted plan exactly once on a duplicate key", () => {
    const plan = planRequestConfirmationAction(ACCEPTED, { enabled: true });
    const harness = makeHarness();
    expect(applyRequestConfirmationPlan(plan, harness)).toBe(1);
    expect(applyRequestConfirmationPlan(plan, harness)).toBe(0);
    expect(harness.wakes).toHaveLength(1);
  });

  it("skips a duplicate interaction key already planned", () => {
    const seen = new Set([requestConfirmationIdempotencyKey("rc-1")]);
    const plan = planRequestConfirmationAction(ACCEPTED, { enabled: true, seenKeys: seen });
    expect(plan.decision).toBe("skip");
    expect(plan.acceptance).toBeNull();
    expect(plan.reason).toContain("duplicate");
    const harness = makeHarness();
    expect(applyRequestConfirmationPlan(plan, harness)).toBe(0);
  });

  it("fails closed on non-request_confirmation kinds (done verbs route elsewhere)", () => {
    for (const kind of ["suggest_tasks", "ask_user_questions", ""]) {
      const plan = planRequestConfirmationAction({ ...ACCEPTED, kind }, { enabled: true });
      expect(plan.decision).toBe("skip");
      expect(plan.acceptance).toBeNull();
      expect(plan.reason).toContain("request_confirmation");
    }
  });

  it("skips non-answer statuses (pending/expiry never re-propose)", () => {
    for (const status of ["pending", "expired", ""]) {
      const plan = planRequestConfirmationAction({ ...ACCEPTED, status }, { enabled: true });
      expect(plan.decision).toBe("skip");
      expect(plan.acceptance).toBeNull();
    }
  });

  it("skips malformed rows with no ids", () => {
    const noId = planRequestConfirmationAction({ ...ACCEPTED, interactionId: "" }, { enabled: true });
    expect(noId.decision).toBe("skip");
    expect(noId.reason).toContain("interaction id");
    const noIssue = planRequestConfirmationAction({ ...ACCEPTED, issueId: "  " }, { enabled: true });
    expect(noIssue.decision).toBe("skip");
    expect(noIssue.reason).toContain("issue id");
  });

  it("routes the owner path like the host: board_only accepted still plans (:2962)", () => {
    const plan = planRequestConfirmationAction(
      { ...ACCEPTED, effectiveResolverPolicy: "board_only" },
      { enabled: true },
    );
    expect(plan.decision).toBe("accept");
    expect(plan.triageVerdict).toBe("OWNER_ONLY");
    expect(plan.triageContinuation).toBe("WAKES");
    expect(plan.acceptance).toMatchObject({ outcome: "accepted", wakeAssignee: "agent-a" });
    const harness = makeHarness();
    expect(applyRequestConfirmationPlan(plan, harness)).toBe(1);
  });

  it("routes the review bypass like the host: named in_review accept plans (:2956)", () => {
    const plan = planRequestConfirmationAction(
      {
        ...ACCEPTED,
        effectiveResolverPolicy: "board_only",
        issueStatus: "in_review",
        namedReviewInteraction: true,
      },
      { enabled: true },
    );
    expect(plan.decision).toBe("accept");
    expect(plan.triageVerdict).toBe("AGENT_REVIEW_VERDICT");
    expect(plan.triageContinuation).toBe("WAKES");
    const harness = makeHarness();
    expect(applyRequestConfirmationPlan(plan, harness)).toBe(1);
  });

  it("never auto-plans the tool-action path beyond the flag: recorded accept records the board's answer (:2953)", () => {
    const plan = planRequestConfirmationAction(
      { ...ACCEPTED, hasToolAction: true, effectiveResolverPolicy: "board_or_agents" },
      { enabled: true },
    );
    expect(plan.decision).toBe("accept");
    expect(plan.triageVerdict).toBe("OWNER_ONLY");
    expect(plan.acceptance).toMatchObject({ outcome: "accepted" });
    const off = planRequestConfirmationAction(
      { ...ACCEPTED, hasToolAction: true, effectiveResolverPolicy: "board_or_agents" },
      { enabled: false },
    );
    expect(off.decision).toBe("skip");
    expect(off.triageVerdict).toBe("OWNER_ONLY");
    expect(applyRequestConfirmationPlan(off, makeHarness())).toBe(0);
  });

  it("skips INERT accepts: only the creator could answer, so withdraw and re-cut (:2975)", () => {
    const plan = planRequestConfirmationAction(
      { ...ACCEPTED, createdByAgentId: "agent-a" },
      { enabled: true },
    );
    expect(plan.decision).toBe("skip");
    expect(plan.triageVerdict).toBe("INERT");
    expect(plan.acceptance).toBeNull();
    expect(plan.reason).toContain("INERT");
    expect(applyRequestConfirmationPlan(plan, makeHarness())).toBe(0);
  });

  it("skips DEAD_WAKE accepts: an unassigned answer evaporates, so no effect to plan (:1253)", () => {
    const plan = planRequestConfirmationAction(
      { ...ACCEPTED, assigneeAgentId: null },
      { enabled: true },
    );
    expect(plan.decision).toBe("skip");
    expect(plan.triageContinuation).toBe("DEAD_WAKE");
    expect(plan.acceptance).toBeNull();
    expect(applyRequestConfirmationPlan(plan, makeHarness())).toBe(0);
  });

  it("skips closed-issue accepts: assignment cannot repair a closed wake (:1253)", () => {
    const plan = planRequestConfirmationAction({ ...ACCEPTED, issueStatus: "done" }, { enabled: true });
    expect(plan.decision).toBe("skip");
    expect(plan.triageContinuation).toBe("DEAD_WAKE");
    expect(plan.acceptance).toBeNull();
    expect(applyRequestConfirmationPlan(plan, makeHarness())).toBe(0);
  });

  it("skips no-wake-policy accepts: non-wake answers start nothing (:1265)", () => {
    const plan = planRequestConfirmationAction(
      { ...ACCEPTED, continuationPolicy: "none" },
      { enabled: true },
    );
    expect(plan.decision).toBe("skip");
    expect(plan.triageContinuation).toBe("NO_WAKE_REQUESTED");
    expect(plan.acceptance).toBeNull();
    expect(applyRequestConfirmationPlan(plan, makeHarness())).toBe(0);
  });

  it("skips unmeasured rows: UNKNOWN wake paths never report planned (:1253)", () => {
    const plan = planRequestConfirmationAction(
      { ...ACCEPTED, continuationPolicy: null },
      { enabled: true },
    );
    expect(plan.decision).toBe("skip");
    expect(plan.triageContinuation).toBe("UNKNOWN");
    expect(plan.acceptance).toBeNull();
    expect(applyRequestConfirmationPlan(plan, makeHarness())).toBe(0);
  });

  it("never marks live intent: always propose, no mutation fields", () => {
    const plan = planRequestConfirmationAction(ACCEPTED, { enabled: true });
    expect(plan.mode).toBe("propose");
    expect(plan).not.toHaveProperty("applyMutations");
    expect(JSON.stringify(plan)).not.toContain("apply\"");
  });

  it("keeps keys stable across flag states (idempotent retry)", () => {
    const off = planRequestConfirmationAction(ACCEPTED, { enabled: false });
    const on = planRequestConfirmationAction(ACCEPTED, { enabled: true, seenKeys: [] });
    expect(off.idempotencyKey).toBe(on.idempotencyKey);
    expect(off.idempotencyKey).toBe(requestConfirmationIdempotencyKey("rc-1"));
  });
});

describe("planRequestConfirmationActions", () => {
  it("de-duplicates within the batch on the interaction key", () => {
    const plans = planRequestConfirmationActions([ACCEPTED, ACCEPTED], { enabled: true });
    expect(plans.map((plan) => plan.decision)).toEqual(["accept", "skip"]);
    expect(plans[1]?.reason).toContain("duplicate");
  });

  it("does not mutate the caller's seen set", () => {
    const seen = new Set<string>();
    planRequestConfirmationActions([ACCEPTED, ACCEPTED], { enabled: true, seenKeys: seen });
    expect(seen.size).toBe(0);
  });
});

describe("requestConfirmationRoute config", () => {
  it("defaults off and resolves explicitly", () => {
    expect(DEFAULT_CONFIG.requestConfirmationRoute).toBe(false);
    expect(resolveConfig({}).requestConfirmationRoute).toBe(false);
    expect(resolveConfig({ requestConfirmationRoute: true }).requestConfirmationRoute).toBe(true);
    expect(resolveConfig({ requestConfirmationRoute: 1 }).requestConfirmationRoute).toBe(false);
  });
});
