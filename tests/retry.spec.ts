import { describe, expect, it } from "vitest";

import {
  applyRetryPlans,
  planRetry,
  retryBackoffMs,
  retryIdempotencyKey,
  retryKeyForRun,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  type PlanRetryInput,
} from "../src/retry.js";

const NOW = new Date("2026-10-03T18:00:00Z").getTime();
const FINISHED = new Date("2026-10-03T17:00:00Z").toISOString(); // 60 min before NOW

function input(overrides: Partial<PlanRetryInput> = {}): PlanRetryInput {
  return {
    item: { issueId: "issue-1", sourceId: "run-1", pendingSince: FINISHED },
    attempt: 1,
    maxAttempts: 2,
    firedKeys: new Set(),
    applyMutations: false,
    nowMs: NOW,
    ...overrides,
  };
}

describe("retryBackoffMs", () => {
  it("starts at the base delay and doubles per attempt", () => {
    expect(retryBackoffMs(1)).toBe(RETRY_BACKOFF_BASE_MS);
    expect(retryBackoffMs(2)).toBe(RETRY_BACKOFF_BASE_MS * 2);
    expect(retryBackoffMs(3)).toBe(RETRY_BACKOFF_BASE_MS * 4);
  });

  it("caps at the maximum instead of growing forever", () => {
    expect(retryBackoffMs(100)).toBe(RETRY_BACKOFF_MAX_MS);
    expect(retryBackoffMs(100)).toBeLessThanOrEqual(RETRY_BACKOFF_MAX_MS);
  });

  it("treats non-positive attempts as the first attempt", () => {
    expect(retryBackoffMs(0)).toBe(RETRY_BACKOFF_BASE_MS);
  });
});

describe("retry keys", () => {
  it("namespaces the per-run key and the per-attempt idempotency key", () => {
    expect(retryKeyForRun("run-1")).toBe("failed-run:run-1");
    expect(retryIdempotencyKey("run-1", 1)).toBe("decision-router/retry/run-1/attempt-1");
  });

  it("keeps the idempotency key stable across sweeps for the same attempt", () => {
    expect(retryIdempotencyKey("run-1", 2)).toBe(retryIdempotencyKey("run-1", 2));
    expect(retryIdempotencyKey("run-1", 1)).not.toBe(retryIdempotencyKey("run-1", 2));
  });
});

describe("planRetry", () => {
  it("proposes (never fires) when the flag is off and backoff has elapsed", () => {
    const plan = planRetry(input());
    expect(plan.action).toBe("propose");
    expect(plan).toMatchObject({ runKey: "failed-run:run-1", attempt: 1, maxAttempts: 2 });
  });

  it("fires when the flag is on and backoff has elapsed", () => {
    const plan = planRetry(input({ applyMutations: true }));
    expect(plan.action).toBe("fire");
    if (plan.action !== "fire") throw new Error("expected a fire plan");
    expect(plan.issueId).toBe("issue-1");
    expect(plan.idempotencyKey).toBe("decision-router/retry/run-1/attempt-1");
  });

  it("defers while backoff has not elapsed, naming the eligibility time", () => {
    // Attempt 2 needs 30 min; the run finished 60 min ago so attempt 1 is due
    // but a 10-minute-old failure is not.
    const recent = new Date(NOW - 10 * 60_000).toISOString();
    const plan = planRetry(input({ item: { issueId: "issue-1", sourceId: "run-1", pendingSince: recent } }));
    expect(plan.action).toBe("defer");
    if (plan.action !== "defer") throw new Error("expected a defer plan");
    expect(plan.notBefore).toBe(new Date(new Date(recent).getTime() + RETRY_BACKOFF_BASE_MS).toISOString());
  });

  it("skips exhausted attempts without proposing", () => {
    const plan = planRetry(input({ attempt: 3 }));
    expect(plan.action).toBe("skip");
    if (plan.action !== "skip") throw new Error("expected a skip plan");
    expect(plan.reason).toBe("exhausted attempts bound");
  });

  it("skips an already-fired idempotency key instead of refiring", () => {
    const firedKeys = new Set(["decision-router/retry/run-1/attempt-1"]);
    const plan = planRetry(input({ applyMutations: true, firedKeys }));
    expect(plan.action).toBe("skip");
    if (plan.action !== "skip") throw new Error("expected a skip plan");
    expect(plan.reason).toBe("duplicate retry already fired");
  });

  it("fails open on an unknown age (bounded by attempts and the idempotency key)", () => {
    const plan = planRetry(input({ item: { issueId: "issue-1", sourceId: "run-1", pendingSince: "not-a-time" } }));
    expect(plan.action).toBe("propose");
  });
});

describe("applyRetryPlans", () => {
  it("fires fire-plans when the flag is on and reports per-plan outcomes", async () => {
    const fired: string[] = [];
    const plans = [
      planRetry(input({ applyMutations: true })),
      planRetry(input({ applyMutations: true, item: { issueId: "issue-9", sourceId: "run-9", pendingSince: FINISHED } })),
    ];
    const outcomes = await applyRetryPlans(plans, {
      applyMutations: true,
      fire: async (plan) => {
        fired.push(plan.idempotencyKey);
      },
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.applied)).toBe(true);
    expect(fired).toEqual(["decision-router/retry/run-1/attempt-1", "decision-router/retry/run-9/attempt-1"]);
  });

  it("never fires while the flag is off, even for a fire plan", async () => {
    let calls = 0;
    const outcomes = await applyRetryPlans([planRetry(input({ applyMutations: true }))], {
      applyMutations: false,
      fire: async () => {
        calls += 1;
      },
    });
    expect(calls).toBe(0);
    expect(outcomes).toEqual([{ plan: expect.objectContaining({ action: "fire" }), applied: false }]);
  });

  it("records one failing wakeup without stranding the rest", async () => {
    const second = planRetry(
      input({ applyMutations: true, item: { issueId: "issue-9", sourceId: "run-9", pendingSince: FINISHED } }),
    );
    const outcomes = await applyRetryPlans([planRetry(input({ applyMutations: true })), second], {
      applyMutations: true,
      fire: async (plan) => {
        if (plan.idempotencyKey.endsWith("run-1/attempt-1")) throw new Error("host denied wakeup");
      },
    });
    expect(outcomes[0]).toMatchObject({ applied: false, error: "host denied wakeup" });
    expect(outcomes[1]).toMatchObject({ applied: true });
  });

  it("leaves proposals, defers and skips unapplied", async () => {
    let calls = 0;
    const recent = new Date(NOW - 10 * 60_000).toISOString();
    const outcomes = await applyRetryPlans(
      [
        planRetry(input()),
        planRetry(input({ item: { issueId: "issue-1", sourceId: "run-2", pendingSince: recent } })),
        planRetry(input({ attempt: 3 })),
      ],
      {
        applyMutations: true,
        fire: async () => {
          calls += 1;
        },
      },
    );
    expect(calls).toBe(0);
    expect(outcomes.every((outcome) => !outcome.applied)).toBe(true);
  });
});
