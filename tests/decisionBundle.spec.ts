import { describe, expect, it } from "vitest";

import {
  decisionBundleEffectIdempotencyKey,
  decisionBundleIdempotencyKey,
  planDecisionBundleAction,
  type DecisionBundleEffectType,
  type DecisionBundlePlan,
} from "../src/decisionBundle.js";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.js";

/**
 * Test harness only: an in-memory fake issue store plus a bundle applier.
 * This is the parity surface — the applier walks `plan.effects` in plan
 * order, records every write to a journal, and honors idempotency keys, so
 * the tests prove planned order == applied order with no live mutation.
 */
interface HarnessIssue {
  comments: string[];
  assigneeAgentId: string | null;
  status: string;
}

interface HarnessWrite {
  order: number;
  type: DecisionBundleEffectType;
  targetIssueId: string;
  detail: string;
}

interface Harness {
  issues: Map<string, HarnessIssue>;
  journal: HarnessWrite[];
  seenKeys: Set<string>;
}

function makeHarness(): Harness {
  return { issues: new Map(), journal: [], seenKeys: new Set() };
}

function issueOf(harness: Harness, targetIssueId: string): HarnessIssue {
  let issue = harness.issues.get(targetIssueId);
  if (!issue) {
    issue = { comments: [], assigneeAgentId: null, status: "todo" };
    harness.issues.set(targetIssueId, issue);
  }
  return issue;
}

/** Apply a bundle plan to the fake store; returns the applied write count. */
function applyDecisionBundlePlan(plan: DecisionBundlePlan, harness: Harness): number {
  if (plan.decision !== "propose" || plan.effects.length === 0) return 0;
  if (harness.seenKeys.has(plan.idempotencyKey)) return 0;
  let applied = 0;
  for (const effect of plan.effects) {
    if (harness.seenKeys.has(effect.idempotencyKey)) continue;
    const issue = issueOf(harness, plan.targetIssueId);
    if (effect.type === "comment_on_issue") {
      issue.comments.push(effect.detail.body ?? "");
    } else if (effect.type === "assign_issue") {
      issue.assigneeAgentId = effect.detail.assigneeAgentId ?? null;
    } else {
      issue.status = effect.detail.status ?? issue.status;
    }
    harness.journal.push({
      order: effect.order,
      type: effect.type,
      targetIssueId: plan.targetIssueId,
      detail: JSON.stringify(effect.detail),
    });
    harness.seenKeys.add(effect.idempotencyKey);
    applied += 1;
  }
  harness.seenKeys.add(plan.idempotencyKey);
  return applied;
}

const FULL_BUNDLE = {
  bundleId: "bundle-1",
  targetIssueId: "issue-9",
  effects: [
    { type: "update_issue_status", status: "done" },
    { type: "assign_issue", assigneeAgentId: "agent-1" },
    { type: "comment_on_issue", body: "decision: ship it" },
  ],
};

describe("planDecisionBundleAction", () => {
  it("is a flag-off no-op: skips without proposing and the harness writes nothing", () => {
    const plan = planDecisionBundleAction(FULL_BUNDLE, { enabled: false });
    expect(plan).toMatchObject({
      bundleId: "bundle-1",
      decision: "skip",
      effects: [],
      mode: "propose",
      idempotencyKey: "decision-bundle:bundle-1",
    });
    expect(plan.reason).toContain("flag off");
    const harness = makeHarness();
    expect(applyDecisionBundlePlan(plan, harness)).toBe(0);
    expect(harness.journal).toEqual([]);
    expect(harness.issues.size).toBe(0);
  });

  it("proposes the full bundle in canonical order regardless of input order", () => {
    const plan = planDecisionBundleAction(FULL_BUNDLE, { enabled: true });
    expect(plan.decision).toBe("propose");
    expect(plan.mode).toBe("propose");
    expect(plan.effects.map((effect) => effect.type)).toEqual([
      "comment_on_issue",
      "assign_issue",
      "update_issue_status",
    ]);
    expect(plan.effects.map((effect) => effect.order)).toEqual([0, 1, 2]);
  });

  it("applies the bundle in plan order under the flag (planned order == applied order)", () => {
    const plan = planDecisionBundleAction(FULL_BUNDLE, { enabled: true });
    const harness = makeHarness();
    expect(applyDecisionBundlePlan(plan, harness)).toBe(3);
    expect(harness.journal.map((write) => write.type)).toEqual(
      plan.effects.map((effect) => effect.type),
    );
    expect(harness.journal.map((write) => write.order)).toEqual([0, 1, 2]);
    const issue = harness.issues.get("issue-9");
    expect(issue?.comments).toEqual(["decision: ship it"]);
    expect(issue?.assigneeAgentId).toBe("agent-1");
    expect(issue?.status).toBe("done");
  });

  it("applies a duplicate idempotency key exactly once", () => {
    const plan = planDecisionBundleAction(FULL_BUNDLE, { enabled: true });
    const harness = makeHarness();
    expect(applyDecisionBundlePlan(plan, harness)).toBe(3);
    expect(applyDecisionBundlePlan(plan, harness)).toBe(0);
    expect(harness.journal).toHaveLength(3);
    const issue = harness.issues.get("issue-9");
    expect(issue?.comments).toEqual(["decision: ship it"]);
  });

  it("skips a duplicate key already planned", () => {
    const seen = new Set([decisionBundleIdempotencyKey("bundle-1")]);
    const plan = planDecisionBundleAction(FULL_BUNDLE, { enabled: true, seenKeys: seen });
    expect(plan.decision).toBe("skip");
    expect(plan.effects).toEqual([]);
    expect(plan.reason).toContain("duplicate");
    const harness = makeHarness();
    expect(applyDecisionBundlePlan(plan, harness)).toBe(0);
  });

  it("fails closed on an unknown effect type (never partially proposes)", () => {
    const plan = planDecisionBundleAction(
      {
        bundleId: "bundle-2",
        targetIssueId: "issue-9",
        effects: [{ type: "delete_issue" }, { type: "comment_on_issue", body: "hi" }],
      },
      { enabled: true },
    );
    expect(plan.decision).toBe("skip");
    expect(plan.effects).toEqual([]);
    expect(plan.reason).toContain("unknown effect type");
  });

  it("skips malformed bundles with no id, no target, or no effects", () => {
    const noId = planDecisionBundleAction({ ...FULL_BUNDLE, bundleId: "" }, { enabled: true });
    expect(noId.decision).toBe("skip");
    expect(noId.reason).toContain("bundle id");
    const noTarget = planDecisionBundleAction(
      { ...FULL_BUNDLE, targetIssueId: "  " },
      { enabled: true },
    );
    expect(noTarget.decision).toBe("skip");
    expect(noTarget.reason).toContain("target issue id");
    const noEffects = planDecisionBundleAction(
      { bundleId: "bundle-3", targetIssueId: "issue-9", effects: [] },
      { enabled: true },
    );
    expect(noEffects.decision).toBe("skip");
    expect(noEffects.reason).toContain("no effects");
  });

  it("fails closed on invalid effect fields (empty body, empty assignee, unknown status)", () => {
    const emptyBody = planDecisionBundleAction(
      {
        bundleId: "bundle-4",
        targetIssueId: "issue-9",
        effects: [{ type: "comment_on_issue", body: "  " }],
      },
      { enabled: true },
    );
    expect(emptyBody.decision).toBe("skip");
    expect(emptyBody.reason).toContain("comment_on_issue");
    const emptyAssignee = planDecisionBundleAction(
      {
        bundleId: "bundle-5",
        targetIssueId: "issue-9",
        effects: [{ type: "assign_issue", assigneeAgentId: "" }],
      },
      { enabled: true },
    );
    expect(emptyAssignee.decision).toBe("skip");
    expect(emptyAssignee.reason).toContain("assign_issue");
    const badStatus = planDecisionBundleAction(
      {
        bundleId: "bundle-6",
        targetIssueId: "issue-9",
        effects: [{ type: "update_issue_status", status: "shipped" }],
      },
      { enabled: true },
    );
    expect(badStatus.decision).toBe("skip");
    expect(badStatus.reason).toContain("update_issue_status");
  });

  it("never marks live intent: always propose, no mutation fields", () => {
    const plan = planDecisionBundleAction(FULL_BUNDLE, { enabled: true });
    expect(plan.mode).toBe("propose");
    expect(plan).not.toHaveProperty("applyMutations");
    expect(JSON.stringify(plan)).not.toContain("apply\"");
  });

  it("keeps keys stable across flag states (idempotent retry)", () => {
    const off = planDecisionBundleAction(
      { bundleId: "bundle-7", targetIssueId: "issue-9", effects: FULL_BUNDLE.effects },
      { enabled: false },
    );
    const on = planDecisionBundleAction(
      { bundleId: "bundle-7", targetIssueId: "issue-9", effects: FULL_BUNDLE.effects },
      { enabled: true, seenKeys: [] },
    );
    expect(off.idempotencyKey).toBe(on.idempotencyKey);
    expect(off.idempotencyKey).toBe(decisionBundleIdempotencyKey("bundle-7"));
    expect(on.effects.map((effect) => effect.idempotencyKey)).toEqual([
      decisionBundleEffectIdempotencyKey("bundle-7", 0, "comment_on_issue"),
      decisionBundleEffectIdempotencyKey("bundle-7", 1, "assign_issue"),
      decisionBundleEffectIdempotencyKey("bundle-7", 2, "update_issue_status"),
    ]);
  });

  it("does not mutate the caller's seen set", () => {
    const seen = new Set<string>();
    planDecisionBundleAction(FULL_BUNDLE, { enabled: true, seenKeys: seen });
    expect(seen.size).toBe(0);
  });
});

describe("decisionBundleRoute config", () => {
  it("defaults off and resolves explicitly", () => {
    expect(DEFAULT_CONFIG.decisionBundleRoute).toBe(false);
    expect(resolveConfig({}).decisionBundleRoute).toBe(false);
    expect(resolveConfig({ decisionBundleRoute: true }).decisionBundleRoute).toBe(true);
    expect(resolveConfig({ decisionBundleRoute: 1 }).decisionBundleRoute).toBe(false);
  });
});
