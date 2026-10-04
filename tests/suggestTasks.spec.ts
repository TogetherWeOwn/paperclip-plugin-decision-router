import { describe, expect, it } from "vitest";

import {
  planSuggestTasksAction,
  planSuggestTasksActions,
  suggestSubtaskIdempotencyKey,
  suggestTasksIdempotencyKey,
} from "../src/suggestTasks.js";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.js";

/**
 * Test harness only: an in-memory fake issue store plus a subtask applier.
 * This is the parity surface — the applier walks `plan.subtasks` in plan
 * order, records every write to a journal, and honors idempotency keys, so
 * the tests prove accepted tasks become real subtasks (and rejected tasks
 * create nothing) with no live mutation.
 */
interface HarnessIssue {
  subtasks: { clientKey: string; title: string; description: string | null }[];
}

interface HarnessWrite {
  interactionId: string;
  clientKey: string;
  parentIssueId: string;
  title: string;
}

interface Harness {
  issues: Map<string, HarnessIssue>;
  journal: HarnessWrite[];
  seenKeys: Set<string>;
}

function makeHarness(): Harness {
  return { issues: new Map(), journal: [], seenKeys: new Set() };
}

function issueOf(harness: Harness, issueId: string): HarnessIssue {
  let issue = harness.issues.get(issueId);
  if (!issue) {
    issue = { subtasks: [] };
    harness.issues.set(issueId, issue);
  }
  return issue;
}

/** Apply an accepted plan to the fake store; returns the applied subtask count. */
function applySuggestTasksPlan(
  plan: ReturnType<typeof planSuggestTasksAction>,
  harness: Harness,
): number {
  if (plan.decision !== "accept" || plan.subtasks.length === 0) return 0;
  if (harness.seenKeys.has(plan.idempotencyKey)) return 0;
  let applied = 0;
  for (const subtask of plan.subtasks) {
    if (harness.seenKeys.has(subtask.idempotencyKey)) continue;
    issueOf(harness, plan.issueId).subtasks.push({
      clientKey: subtask.clientKey,
      title: subtask.title,
      description: subtask.description,
    });
    harness.journal.push({
      interactionId: plan.interactionId,
      clientKey: subtask.clientKey,
      parentIssueId: plan.issueId,
      title: subtask.title,
    });
    harness.seenKeys.add(subtask.idempotencyKey);
    applied += 1;
  }
  harness.seenKeys.add(plan.idempotencyKey);
  return applied;
}

const ACCEPTED = {
  interactionId: "sx-1",
  issueId: "issue-7",
  kind: "suggest_tasks",
  status: "accepted",
  tasks: [
    { clientKey: "t-1", title: "Probe the staging queue", description: "read-only probe" },
    { clientKey: "t-2", title: "Draft the digest note" },
  ],
};

describe("planSuggestTasksAction", () => {
  it("is a flag-off no-op: skips without accepting and the harness writes nothing", () => {
    const plan = planSuggestTasksAction(ACCEPTED, { enabled: false });
    expect(plan).toMatchObject({
      interactionId: "sx-1",
      issueId: "issue-7",
      decision: "skip",
      subtasks: [],
      mode: "propose",
      idempotencyKey: "suggest-tasks:sx-1",
    });
    expect(plan.reason).toContain("flag off");
    const harness = makeHarness();
    expect(applySuggestTasksPlan(plan, harness)).toBe(0);
    expect(harness.journal).toEqual([]);
    expect(harness.issues.size).toBe(0);
  });

  it("accepts under the flag and the harness creates real subtask fixtures", () => {
    const plan = planSuggestTasksAction(ACCEPTED, { enabled: true });
    expect(plan.decision).toBe("accept");
    expect(plan.mode).toBe("propose");
    expect(plan.subtasks.map((subtask) => subtask.clientKey)).toEqual(["t-1", "t-2"]);
    const harness = makeHarness();
    expect(applySuggestTasksPlan(plan, harness)).toBe(2);
    expect(harness.journal.map((write) => write.clientKey)).toEqual(["t-1", "t-2"]);
    expect(harness.journal.every((write) => write.parentIssueId === "issue-7")).toBe(true);
    const issue = harness.issues.get("issue-7");
    expect(issue?.subtasks).toEqual([
      { clientKey: "t-1", title: "Probe the staging queue", description: "read-only probe" },
      { clientKey: "t-2", title: "Draft the digest note", description: null },
    ]);
  });

  it("reject-path creates nothing: skip with zero harness writes", () => {
    const plan = planSuggestTasksAction({ ...ACCEPTED, status: "rejected" }, { enabled: true });
    expect(plan.decision).toBe("skip");
    expect(plan.subtasks).toEqual([]);
    expect(plan.reason).toContain("rejected");
    const harness = makeHarness();
    expect(applySuggestTasksPlan(plan, harness)).toBe(0);
    expect(harness.journal).toEqual([]);
    expect(harness.issues.size).toBe(0);
  });

  it("applies an accepted plan exactly once on a duplicate key", () => {
    const plan = planSuggestTasksAction(ACCEPTED, { enabled: true });
    const harness = makeHarness();
    expect(applySuggestTasksPlan(plan, harness)).toBe(2);
    expect(applySuggestTasksPlan(plan, harness)).toBe(0);
    expect(harness.journal).toHaveLength(2);
    expect(harness.issues.get("issue-7")?.subtasks).toHaveLength(2);
  });

  it("skips a duplicate interaction key already planned", () => {
    const seen = new Set([suggestTasksIdempotencyKey("sx-1")]);
    const plan = planSuggestTasksAction(ACCEPTED, { enabled: true, seenKeys: seen });
    expect(plan.decision).toBe("skip");
    expect(plan.subtasks).toEqual([]);
    expect(plan.reason).toContain("duplicate");
    const harness = makeHarness();
    expect(applySuggestTasksPlan(plan, harness)).toBe(0);
  });

  it("fails closed on non-suggest_tasks kinds (done verbs route elsewhere)", () => {
    for (const kind of ["request_confirmation", "ask_user_questions", ""]) {
      const plan = planSuggestTasksAction({ ...ACCEPTED, kind }, { enabled: true });
      expect(plan.decision).toBe("skip");
      expect(plan.subtasks).toEqual([]);
      expect(plan.reason).toContain("suggest_tasks");
    }
  });

  it("skips non-attention statuses (pending/expiry are not accept-path outcomes)", () => {
    for (const status of ["pending", "expired", ""]) {
      const plan = planSuggestTasksAction({ ...ACCEPTED, status }, { enabled: true });
      expect(plan.decision).toBe("skip");
      expect(plan.subtasks).toEqual([]);
    }
  });

  it("skips malformed rows with no ids, no tasks, or empty task fields", () => {
    const noId = planSuggestTasksAction({ ...ACCEPTED, interactionId: "" }, { enabled: true });
    expect(noId.decision).toBe("skip");
    expect(noId.reason).toContain("interaction id");
    const noParent = planSuggestTasksAction({ ...ACCEPTED, issueId: "  " }, { enabled: true });
    expect(noParent.decision).toBe("skip");
    expect(noParent.reason).toContain("parent issue id");
    const noTasks = planSuggestTasksAction({ ...ACCEPTED, tasks: [] }, { enabled: true });
    expect(noTasks.decision).toBe("skip");
    expect(noTasks.reason).toContain("no suggested tasks");
    const noKey = planSuggestTasksAction(
      { ...ACCEPTED, tasks: [{ clientKey: "", title: "x" }] },
      { enabled: true },
    );
    expect(noKey.decision).toBe("skip");
    expect(noKey.reason).toContain("client key");
    const noTitle = planSuggestTasksAction(
      { ...ACCEPTED, tasks: [{ clientKey: "t-9", title: "  " }] },
      { enabled: true },
    );
    expect(noTitle.decision).toBe("skip");
    expect(noTitle.reason).toContain("empty title");
  });

  it("never marks live intent: always propose, no mutation fields", () => {
    const plan = planSuggestTasksAction(ACCEPTED, { enabled: true });
    expect(plan.mode).toBe("propose");
    expect(plan).not.toHaveProperty("applyMutations");
    expect(JSON.stringify(plan)).not.toContain("apply\"");
  });

  it("keeps keys stable across flag states (idempotent retry)", () => {
    const off = planSuggestTasksAction(ACCEPTED, { enabled: false });
    const on = planSuggestTasksAction(ACCEPTED, { enabled: true, seenKeys: [] });
    expect(off.idempotencyKey).toBe(on.idempotencyKey);
    expect(off.idempotencyKey).toBe(suggestTasksIdempotencyKey("sx-1"));
    expect(on.subtasks.map((subtask) => subtask.idempotencyKey)).toEqual([
      suggestSubtaskIdempotencyKey("sx-1", "t-1"),
      suggestSubtaskIdempotencyKey("sx-1", "t-2"),
    ]);
  });
});

describe("planSuggestTasksActions", () => {
  it("de-duplicates within the batch on the interaction key", () => {
    const plans = planSuggestTasksActions([ACCEPTED, ACCEPTED], { enabled: true });
    expect(plans.map((plan) => plan.decision)).toEqual(["accept", "skip"]);
    expect(plans[1]?.reason).toContain("duplicate");
  });

  it("does not mutate the caller's seen set", () => {
    const seen = new Set<string>();
    planSuggestTasksActions([ACCEPTED, ACCEPTED], { enabled: true, seenKeys: seen });
    expect(seen.size).toBe(0);
  });
});

describe("suggestTasksRoute config", () => {
  it("defaults off and resolves explicitly", () => {
    expect(DEFAULT_CONFIG.suggestTasksRoute).toBe(false);
    expect(resolveConfig({}).suggestTasksRoute).toBe(false);
    expect(resolveConfig({ suggestTasksRoute: true }).suggestTasksRoute).toBe(true);
    expect(resolveConfig({ suggestTasksRoute: 1 }).suggestTasksRoute).toBe(false);
  });
});
