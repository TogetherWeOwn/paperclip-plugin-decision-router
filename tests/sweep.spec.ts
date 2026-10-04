import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import { JOB_KEYS, STATE_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { applyRetryPlans } from "../src/retry.js";
import { sweepDecisions, type SweepPrior, type SweepReads, type SweepResult } from "../src/sweep.js";
import { applyUnblockPlans } from "../src/unblock.js";
import { createPlugin } from "../src/worker.js";

const NOW = new Date("2026-10-03T18:00:00Z");

function reads(): SweepReads {
  return {
    async listOpenIssues() {
      return [
        { id: "issue-1", identifier: "TOG-1", status: "todo", assigneeAgentId: "agent-a" },
        { id: "issue-2", identifier: "TOG-2", status: "done", assigneeAgentId: null },
        { id: "issue-3", identifier: null, status: "in_progress", assigneeAgentId: "agent-b" },
      ];
    },
    async listPendingInteractions(issueId) {
      if (issueId !== "issue-1") return [];
      return [
        {
          id: "ix-1",
          kind: "ask_user_questions",
          status: "pending",
          effectiveResolverPolicy: "board_or_agents",
          createdByAgentId: "agent-c",
          addresseeAgentId: null,
          hasToolAction: false,
          continuationPolicy: "wake_assignee",
          createdAt: "2026-10-03T16:00:00Z",
          title: "Which plan?",
        },
      ];
    },
    async listRelations(issueId) {
      if (issueId === "issue-1") {
        return {
          blockedByIds: ["issue-9"],
          blockers: [{ id: "issue-9", identifier: "TOG-9", status: "todo" }],
          activeRecovery: [
            { id: "ra-1", kind: "missing_disposition", status: "active", createdAt: "2026-10-03T10:00:00Z" },
          ],
        };
      }
      return { blockedByIds: [], blockers: [], activeRecovery: [] };
    },
    async listPendingApprovals() {
      return [{ id: "ap-1", issueId: null, status: "pending", createdAt: "2026-10-03T09:00:00Z" }];
    },
    async listFailedRuns(issueId) {
      if (issueId !== "issue-3") return [];
      return [{ id: "run-1", issueId, status: "failed", finishedAt: "2026-10-03T17:00:00Z", error: "boom" }];
    },
    async extraItems() {
      return [
        {
          kind: "review",
          issueId: "issue-1",
          identifier: "TOG-1",
          sourceId: "review:TOG-1",
          pendingSince: "2026-10-03T11:00:00Z",
          detail: "choose review path",
        },
      ];
    },
  };
}

describe("sweepDecisions", () => {
  it("covers all six kinds across issues, approvals and extras", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), NOW);
    const kinds = new Set(result.items.map((item) => item.kind));
    expect(kinds).toEqual(
      new Set(["issue_thread_interaction", "blocker_attention", "recovery_action", "failed_run", "approval", "review"]),
    );
    // Closed issues are never scanned.
    expect(result.scannedIssues).toBe(2);
    expect(result.items.every((item) => item.issueId !== "issue-2")).toBe(true);
  });

  it("routes deterministically and digests the rest", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), NOW);
    const byKind = Object.fromEntries(result.routed.map((r) => [r.item.kind, r.destination.type]));
    expect(byKind).toMatchObject({
      issue_thread_interaction: "ceo-digest",
      blocker_attention: "blocker-owner",
      recovery_action: "reconciler",
      failed_run: "retry",
      approval: "ceo-digest",
      review: "code-reviewer",
    });
    const auto = result.routed.filter((r) => r.destination.type !== "ceo-digest").length;
    expect(auto).toBe(4); // blocker-owner + reconciler + retry + code-reviewer
    const total = result.metrics.find((point) => point.name === "decision_router.sweep.items_total");
    expect(total?.value).toBe(result.items.length);
  });

  it("renders a shadow digest with every section", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), NOW);
    for (const kind of ["blocker_attention", "recovery_action", "review", "issue_thread_interaction", "failed_run", "approval"]) {
      expect(result.digest).toContain(`## ${kind}`);
    }
    expect(result.digest).toContain("Shadow mode");
  });

  it("marks the digest live when mutations are enabled", async () => {
    const result = await sweepDecisions("company-1", { ...DEFAULT_CONFIG, applyMutations: true }, reads(), NOW);
    expect(result.digest).toContain("Live mode");
  });

  it("proposes (never fires) the failed-run retry in shadow mode", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), NOW);
    expect(result.retryPlans).toHaveLength(1);
    expect(result.retryPlans[0]).toMatchObject({
      action: "propose",
      runKey: "failed-run:run-1",
      attempt: 1,
      maxAttempts: DEFAULT_CONFIG.maxRetryAttempts,
    });
  });

  it("fires the retry plan when mutations are enabled and backoff elapsed", async () => {
    const result = await sweepDecisions(
      "company-1",
      { ...DEFAULT_CONFIG, applyMutations: true },
      reads(),
      NOW,
    );
    expect(result.retryPlans).toHaveLength(1);
    expect(result.retryPlans[0]).toMatchObject({
      action: "fire",
      idempotencyKey: "decision-router/retry/run-1/attempt-1",
    });
  });

  it("threads prior attempts so the next sweep retries at attempt 2", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), NOW, {
      retryAttempts: { "failed-run:run-1": 1 },
    });
    const destination = result.routed.find((r) => r.item.kind === "failed_run")?.destination;
    expect(destination).toMatchObject({ type: "retry", attempt: 2 });
    expect(result.retryPlans[0]).toMatchObject({ action: "propose", attempt: 2 });
  });

  it("digests exhausted runs and emits no plan for them", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), NOW, {
      retryAttempts: { "failed-run:run-1": 2 },
    });
    expect(result.routed.find((r) => r.item.kind === "failed_run")?.destination.type).toBe("ceo-digest");
    expect(result.retryPlans).toHaveLength(0);
  });

  it("skips an already-fired retry instead of planning it again", async () => {
    const result = await sweepDecisions("company-1", { ...DEFAULT_CONFIG, applyMutations: true }, reads(), NOW, {
      retriedKeys: ["decision-router/retry/run-1/attempt-1"],
    });
    expect(result.retryPlans).toHaveLength(1);
    expect(result.retryPlans[0]?.action).toBe("skip");
  });

  it("proposes (never fires) stale blocker edges in shadow mode", async () => {
    const staleReads: SweepReads = {
      ...reads(),
      async listRelations(issueId) {
        if (issueId === "issue-1") {
          return {
            blockedByIds: ["issue-9"],
            blockers: [{ id: "issue-9", identifier: "TOG-9", status: "done" }],
            activeRecovery: [],
          };
        }
        return { blockedByIds: [], blockers: [], activeRecovery: [] };
      },
    };
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, staleReads, NOW);
    expect(result.unblockPlans).toHaveLength(1);
    expect(result.unblockPlans[0]).toMatchObject({ action: "propose", blockerIssueId: "issue-9" });
    const blocker = result.routed.find((r) => r.item.kind === "blocker_attention");
    expect(blocker?.item.detail).toContain("TOG-9");
  });

  it("fires stale blocker edges when the flag is on and skips replayed keys", async () => {
    const staleReads: SweepReads = {
      ...reads(),
      async listRelations(issueId) {
        if (issueId === "issue-1") {
          return {
            blockedByIds: ["issue-9"],
            blockers: [{ id: "issue-9", identifier: "TOG-9", status: "cancelled" }],
            activeRecovery: [],
          };
        }
        return { blockedByIds: [], blockers: [], activeRecovery: [] };
      },
    };
    const config = { ...DEFAULT_CONFIG, applyMutations: true };
    const fired = await sweepDecisions("company-1", config, staleReads, NOW);
    expect(fired.unblockPlans[0]).toMatchObject({ action: "fire" });
    const replayed = await sweepDecisions("company-1", config, staleReads, NOW, {
      unblockedKeys: ["decision-router/unblock/issue-1/issue-9"],
    });
    expect(replayed.unblockPlans[0]).toMatchObject({ action: "skip" });
  });

  it("plans nothing for open blockers — the owner route stands", async () => {
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), NOW);
    expect(result.unblockPlans).toHaveLength(0);
    const blocker = result.routed.find((r) => r.item.kind === "blocker_attention");
    expect(blocker?.destination.type).toBe("blocker-owner");
  });
});

const SOURCES = ["issues", "interactions", "blockedByIds", "blockers", "recovery", "runs", "approvals", "extras"] as const;
type Source = (typeof SOURCES)[number];
const SHADOW_CONFIG = { ...DEFAULT_CONFIG, applyMutations: false, codeReviewerAgentId: "agent-reviewer" };
const PRIOR: SweepPrior = {
  retryAttempts: { "failed-run:run-1": 1 },
  retriedKeys: ["decision-router/retry/old-run/attempt-1"],
  unblockedKeys: ["decision-router/unblock/old-issue/old-blocker"],
};

// Reuse the six-kind fixture, with multiple rows on every source whose order can
// vary. A mask reverses each source independently; duplicates remain raw reads.
function matrixReads(mask = 0, duplicate?: Source): SweepReads {
  const base = reads();
  function order<T>(source: Source, rows: T[]): T[] {
    const expanded = duplicate === source ? [...rows, ...rows] : [...rows];
    return mask & (1 << SOURCES.indexOf(source)) ? expanded.reverse() : expanded;
  }
  return {
    async listOpenIssues(companyId, limit) {
      return order("issues", (await base.listOpenIssues(companyId, limit)).map((issue) => ({
        ...issue, identifier: issue.identifier === null ? null : `TASK-${issue.id}`,
      })));
    },
    async listPendingInteractions(issueId, companyId) {
      const rows = await base.listPendingInteractions(issueId, companyId);
      if (issueId !== "issue-1") return rows;
      const template = rows[0]!;
      return order("interactions", [
        ...rows,
        { ...template, id: "ix-human", effectiveResolverPolicy: "human_only", createdAt: "2026-10-03T14:00:00Z" },
        { ...template, id: "ix-not-creator", effectiveResolverPolicy: "not_creator" },
        { ...template, id: "ix-creator", createdByAgentId: "agent-a" },
        { ...template, id: "ix-addressed", addresseeAgentId: "agent-a" },
        { ...template, id: "ix-other-addressee", addresseeAgentId: "agent-d" },
        { ...template, id: "ix-tool", kind: "request_confirmation", hasToolAction: true },
      ]);
    },
    async listRelations(issueId, companyId) {
      const relations = await base.listRelations(issueId, companyId);
      if (issueId !== "issue-1") return relations;
      return {
        blockedByIds: order("blockedByIds", [...relations.blockedByIds, "issue-8", "issue-7"]),
        blockers: order("blockers", [
          ...relations.blockers.map((blocker) => ({ ...blocker, identifier: "TASK-9" })),
          { id: "issue-8", identifier: "TASK-8", status: "done" },
          { id: "issue-7", identifier: null, status: "cancelled" },
        ]),
        activeRecovery: order("recovery", [
          ...relations.activeRecovery,
          { id: "ra-2", kind: "stranded_assigned_issue", status: "escalated", createdAt: "2026-10-03T14:00:00Z" },
        ]),
      };
    },
    async listFailedRuns(issueId, companyId) {
      const rows = await base.listFailedRuns(issueId, companyId);
      if (issueId !== "issue-3") return rows;
      return order("runs", [
        ...rows,
        { id: "run-2", issueId, status: "failed", finishedAt: "2026-10-03T13:00:00Z", error: "synthetic failure" },
      ]);
    },
    async listPendingApprovals(companyId) {
      return order("approvals", [
        ...await base.listPendingApprovals(companyId),
        { id: "ap-2", issueId: "issue-1", status: "pending", createdAt: "2026-10-03T15:00:00Z" },
      ]);
    },
    async extraItems(companyId) {
      return order("extras", [
        ...(await base.extraItems(companyId)).map((item) => ({ ...item, sourceId: "review-1", identifier: "TASK-1" })),
        { kind: "review", issueId: "issue-3", sourceId: "review-2", pendingSince: "2026-10-03T17:00:00Z" },
      ]);
    },
  };
}

function sorted<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// Keep multiplicity, full destinations, triage and plan payloads. Only the
// blocker detail/digest presentation embeds read order, so do not compare it.
function semantics(result: SweepResult) {
  const identity = (item: SweepResult["items"][number]) => `${item.kind}/${item.issueId}/${item.sourceId}`;
  const semanticItem = (item: SweepResult["items"][number]) => ({
    ...item, detail: item.kind === "blocker_attention" ? undefined : item.detail,
  });
  const routed = result.routed.map(({ item, ...route }) => ({ ...route, item: semanticItem(item) }));
  return {
    scannedIssues: result.scannedIssues,
    items: sorted(result.items.map(semanticItem), identity),
    routed: sorted(routed, (row) => identity(row.item)),
    metrics: sorted(result.metrics, (point) => `${point.name}/${point.tags?.kind ?? ""}`),
    retry: sorted(result.retryPlans, (plan) => `${plan.runKey}/${plan.attempt}`),
    unblock: sorted(result.unblockPlans, (plan) => plan.unblockKey),
    recovery: sorted(result.recoveryPlans, (plan) => plan.idempotencyKey),
    approval: sorted(result.approvalPlans, (plan) => plan.idempotencyKey),
    review: sorted(result.reviewPlans, (plan) => plan.idempotencyKey),
    respond: sorted(result.respondPlans, (plan) => plan.idempotencyKey),
    budget: sorted(result.budgetAlertPlans, (plan) => plan.idempotencyKey),
    log: sorted(result.decisionLogPlans, (plan) => plan.key),
  };
}

function effectiveKeys(result: SweepResult): string[] {
  return [
    ...result.retryPlans.flatMap((plan) => plan.action === "propose" ? [plan.idempotencyKey] : []),
    ...result.unblockPlans.flatMap((plan) => plan.action === "propose" ? [plan.unblockKey] : []),
    ...[...result.recoveryPlans, ...result.approvalPlans, ...result.reviewPlans, ...result.respondPlans]
      .filter((plan) => plan.decision !== "skip").map((plan) => plan.idempotencyKey),
  ].sort();
}

function assertRestrictedControls(result: SweepResult) {
  const expected = {
    "ix-human": ["OWNER_ONLY", []],
    "ix-not-creator": ["OWNER_ONLY", []],
    "ix-creator": ["INERT", []],
    "ix-addressed": ["AGENT_RESOLVABLE", ["agent-a"]],
    "ix-other-addressee": ["INERT", []],
    "ix-tool": ["OWNER_ONLY", []],
  };
  for (const [id, [verdict, resolvers]] of Object.entries(expected)) {
    const routes = result.routed.filter((row) => row.item.sourceId === id);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.destination.type).toBe("ceo-digest");
      expect(route.triage).toMatchObject({ verdict, resolvers });
    }
    const plans = result.respondPlans.filter((plan) => plan.interactionId === id);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((plan) => plan.mode === "propose")).toBe(true);
    if (id === "ix-human") expect(plans.every((plan) => plan.decision === "skip")).toBe(true);
    else {
      // Current draft semantics only subtract human_only. A draft is not
      // resolver authority; other restricted rows retain their triage gate.
      expect(plans.filter((plan) => plan.decision === "respond")).toHaveLength(1);
    }
  }
}

async function assertShadow(result: SweepResult) {
  const fire = vi.fn(async () => {});
  const unblock = vi.fn(async () => {});
  const retryOutcomes = await applyRetryPlans(result.retryPlans, { applyMutations: false, fire });
  const unblockOutcomes = await applyUnblockPlans(result.unblockPlans, { applyMutations: false, unblock });
  expect(retryOutcomes.every((outcome) => !outcome.applied)).toBe(true);
  expect(unblockOutcomes.every((outcome) => !outcome.applied)).toBe(true);
  expect(fire).not.toHaveBeenCalled();
  expect(unblock).not.toHaveBeenCalled();
  expect(result.retryPlans.every((plan) => plan.action !== "fire")).toBe(true);
  expect(result.unblockPlans.every((plan) => plan.action !== "fire")).toBe(true);
  for (const plans of [result.recoveryPlans, result.approvalPlans, result.reviewPlans, result.respondPlans]) {
    expect(plans.every((plan) => plan.mode === "propose")).toBe(true);
  }
}

const ORDER_CASES = Array.from({ length: 1 << SOURCES.length }, (_, mask) => [mask] as const);

describe("shadow sweep order and replay invariants", () => {
  it.each(ORDER_CASES)("preserves six-kind semantics and restricted controls for source mask %i", async (mask) => {
    const priorBefore = structuredClone(PRIOR);
    const baseline = await sweepDecisions("company-1", SHADOW_CONFIG, matrixReads(), NOW, PRIOR);
    const permuted = await sweepDecisions("company-1", SHADOW_CONFIG, matrixReads(mask), NOW, PRIOR);
    const replay = await sweepDecisions("company-1", SHADOW_CONFIG, matrixReads(mask), NOW, PRIOR);
    expect(semantics(permuted)).toEqual(semantics(baseline));
    expect(semantics(replay)).toEqual(semantics(permuted));
    expect(effectiveKeys(replay)).toEqual(effectiveKeys(permuted));
    expect(PRIOR).toEqual(priorBefore);
    assertRestrictedControls(permuted);
    assertRestrictedControls(replay);
    await assertShadow(permuted);
    await assertShadow(replay);
  });

  it("pins nonempty plans, source identities and fixed-time counts/ages", async () => {
    const result = await sweepDecisions("company-1", SHADOW_CONFIG, matrixReads(), NOW, PRIOR);
    expect(result.scannedIssues).toBe(2);
    expect(result.items).toHaveLength(16);
    for (const [kind, count, median, max] of [
      ["issue_thread_interaction", 7, 2, 4], ["blocker_attention", 1, 0, 0],
      ["recovery_action", 2, 6, 8], ["failed_run", 2, 3, 5], ["approval", 2, 6, 9], ["review", 2, 4, 7],
    ] as const) {
      const value = (name: string) => result.metrics.find((point) => point.name === name && point.tags?.kind === kind)?.value;
      expect(value("decision_router.attention.count")).toBe(count);
      expect(value("decision_router.attention.age_median_hours")).toBe(median);
      expect(value("decision_router.attention.age_max_hours")).toBe(max);
    }
    expect(result.metrics.find((point) => point.name === "decision_router.sweep.routed_auto")?.value).toBe(7);
    expect(result.metrics.find((point) => point.name === "decision_router.sweep.routed_ceo")?.value).toBe(9);
    expect(effectiveKeys(result)).toEqual([
      "approval-approve:ap-1", "approval-approve:ap-2",
      "decision-router/retry/run-1/attempt-2", "decision-router/retry/run-2/attempt-1",
      "decision-router/unblock/issue-1/issue-7", "decision-router/unblock/issue-1/issue-8",
      "interaction-respond:ix-1", "interaction-respond:ix-addressed", "interaction-respond:ix-creator",
      "interaction-respond:ix-not-creator", "interaction-respond:ix-other-addressee", "interaction-respond:ix-tool",
      "recovery-resolve:ra-1", "recovery-resolve:ra-2", "review-choose-path:review-1", "review-choose-path:review-2",
    ].sort());
    expect(result.routed.find((row) => row.item.kind === "blocker_attention")?.item.sourceId).toBe("blocked-by:issue-1");
    expect(result.routed.find((row) => row.item.sourceId === "ap-1")?.item.issueId).toBe("company-1");
    expect(result.routed.find((row) => row.item.sourceId === "ap-2")?.item.issueId).toBe("issue-1");
    expect(result.budgetAlertPlans).toEqual([]);
    await assertShadow(result);
  });

  it("keeps prior fired keys skipped across shadow replay without advancing attempts", async () => {
    const prior: SweepPrior = {
      retryAttempts: { "failed-run:run-1": 1 },
      retriedKeys: ["decision-router/retry/run-1/attempt-2"],
      unblockedKeys: ["decision-router/unblock/issue-1/issue-8"],
    };
    const before = structuredClone(prior);
    const first = await sweepDecisions("company-1", SHADOW_CONFIG, matrixReads(), NOW, prior);
    const replay = await sweepDecisions("company-1", SHADOW_CONFIG, matrixReads(255), NOW, prior);
    expect(semantics(replay)).toEqual(semantics(first));
    expect(first.retryPlans.find((plan) => plan.runKey === "failed-run:run-1")).toMatchObject({ action: "skip", attempt: 2 });
    expect(first.unblockPlans.find((plan) => plan.blockerIssueId === "issue-8")?.action).toBe("skip");
    expect(effectiveKeys(first)).not.toContain(prior.retriedKeys![0]);
    expect(effectiveKeys(first)).not.toContain(prior.unblockedKeys![0]);
    expect(prior).toEqual(before);
    await assertShadow(replay);
  });

  it.each(SOURCES)("characterizes identical duplicate %s rows without inventing sweep-wide dedupe", async (source) => {
    const baseline = await sweepDecisions("company-1", SHADOW_CONFIG, matrixReads(), NOW, PRIOR);
    const duplicated = await sweepDecisions("company-1", SHADOW_CONFIG, matrixReads(0, source), NOW, PRIOR);
    const reversed = await sweepDecisions("company-1", SHADOW_CONFIG, matrixReads(255, source), NOW, PRIOR);
    const replay = await sweepDecisions("company-1", SHADOW_CONFIG, matrixReads(0, source), NOW, PRIOR);
    expect(semantics(reversed)).toEqual(semantics(duplicated));
    expect(semantics(replay)).toEqual(semantics(duplicated));
    expect(new Set(effectiveKeys(duplicated))).toEqual(new Set(effectiveKeys(baseline)));
    expect(new Set(duplicated.items.map((item) => `${item.kind}/${item.issueId}/${item.sourceId}`)))
      .toEqual(new Set(baseline.items.map((item) => `${item.kind}/${item.issueId}/${item.sourceId}`)));
    const increments: Record<Source, number> = {
      issues: 12, interactions: 7, blockedByIds: 0, blockers: 0, recovery: 2, runs: 2, approvals: 2, extras: 2,
    };
    expect(duplicated.items).toHaveLength(baseline.items.length + increments[source]);
    expect(duplicated.scannedIssues).toBe(source === "issues" ? 4 : 2);
    expect(duplicated.metrics.find((point) => point.name === "decision_router.sweep.items_total")?.value).toBe(duplicated.items.length);
    // Batch planners skip duplicate keys; raw retry/unblock maps retain repeated
    // proposals on the same key. Neither creates another effective identity.
    for (const plans of [duplicated.recoveryPlans, duplicated.approvalPlans, duplicated.reviewPlans, duplicated.respondPlans]) {
      const actionable = plans.filter((plan) => plan.decision !== "skip");
      expect(new Set(actionable.map((plan) => plan.idempotencyKey)).size).toBe(actionable.length);
    }
    expect(duplicated.retryPlans).toHaveLength(source === "issues" || source === "runs" ? 4 : 2);
    expect(duplicated.unblockPlans).toHaveLength(source === "issues" || source === "blockers" ? 4 : 2);
    assertRestrictedControls(duplicated);
    await assertShadow(duplicated);
  });

  it("leaves SDK write mocks unused on fixed-time worker replay with actionable shadow plans", async () => {
    const fixture = matrixReads();
    const harness = createTestHarness({ manifest, config: SHADOW_CONFIG });
    harness.seed({ companies: [{ id: "company-1", name: "Synthetic company" } as never] });
    vi.spyOn(harness.ctx.issues, "list").mockImplementation(async () => await fixture.listOpenIssues("company-1", 100) as never);
    vi.spyOn(harness.ctx.issues, "listInteractions").mockImplementation(async (issueId) => (
      await fixture.listPendingInteractions(issueId, "company-1")
    ).map((ix) => ({ ...ix, payload: ix.hasToolAction ? { toolAction: { tool: "synthetic" } } : {} })) as never);
    vi.spyOn(harness.ctx.issues.relations, "get").mockImplementation(async (issueId) => {
      const relations = await fixture.listRelations(issueId, "company-1");
      return {
        blockedBy: relations.blockers.map((blocker, index) => ({ ...blocker, activeRecoveryAction: relations.activeRecovery[index] })),
        blocks: [],
      } as never;
    });
    vi.spyOn(harness.ctx.issues.summaries, "getOrchestration").mockImplementation(async ({ issueId }) => ({
      runs: await fixture.listFailedRuns(issueId, "company-1"),
    }) as never);
    vi.spyOn(harness.ctx.approvals, "list").mockImplementation(async () => (
      await fixture.listPendingApprovals("company-1")
    ).map((approval) => ({ ...approval, payload: approval.issueId ? { issueId: approval.issueId } : {} })) as never);
    const writes = [
      vi.spyOn(harness.ctx.issues, "requestWakeup"), vi.spyOn(harness.ctx.issues, "requestWakeups"),
      vi.spyOn(harness.ctx.issues.relations, "removeBlockers"), vi.spyOn(harness.ctx.approvals, "decide"),
      vi.spyOn(harness.ctx.issues, "respondInteraction"),
    ];
    // Recovery resolve is absent from the SDK (G-02). A harness-only sentinel
    // records zero calls; it is not a claim that a live resolve API exists.
    expect("recoveryActions" in harness.ctx).toBe(false);
    const resolveRecovery = vi.fn(async () => {});
    Object.assign(harness.ctx, { recoveryActions: { resolve: resolveRecovery } });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await createPlugin().definition.setup(harness.ctx);
      await harness.runJob(JOB_KEYS.sweepDecisions);
      const scope = { scopeKind: "company" as const, scopeId: "company-1", stateKey: STATE_KEYS.lastSweep };
      const first = structuredClone(harness.getState(scope));
      await harness.runJob(JOB_KEYS.sweepDecisions);
      expect(harness.getState(scope)).toEqual(first);
      expect(first).toMatchObject({
        at: NOW.toISOString(), shadow: true, scannedIssues: 2, items: 14,
        retryAttempts: {}, retriedKeys: [], unblockedKeys: [], retryFired: 0, unblockFired: 0,
        recoveryProposed: 2, approvalProposed: 2, respondProposed: 6, respondSkipped: 1,
        recoveryModes: "propose-only", approvalModes: "propose-only", respondModes: "propose-only",
      });
      for (const write of [...writes, resolveRecovery]) expect(write).not.toHaveBeenCalled();
      expect(harness.activity).toEqual([]);
    } finally {
      vi.useRealTimers();
      for (const write of writes) write.mockRestore();
    }
  });
});
