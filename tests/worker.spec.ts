/**
 * Worker slice test through the SDK test harness: one seeded company with an
 * interaction, a blocker edge, a failed run and a pending approval. The sweep
 * job must persist metrics, the last-sweep state record, and (with a desk
 * card configured) the CEO digest document — and mutate nothing.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { CEO_DIGEST_DOCUMENT_KEY, DATA_KEYS, JOB_KEYS, STATE_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const DESK_ISSUE = "22222222-2222-4222-8222-222222222222";
const ISSUE = "33333333-3333-4333-8333-333333333333";

function seed(harness: ReturnType<typeof createTestHarness>) {
  harness.seed({
    companies: [{ id: COMPANY, name: "Acme" } as never],
    issues: [
      {
        id: ISSUE,
        companyId: COMPANY,
        identifier: "TOG-1",
        status: "todo",
        assigneeAgentId: "agent-a",
        title: "Seeded issue",
      } as never,
      {
        id: DESK_ISSUE,
        companyId: COMPANY,
        identifier: "TOG-2",
        status: "todo",
        assigneeAgentId: "agent-ceo",
        title: "CEO desk",
      } as never,
    ],
    issueInteractions: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        companyId: COMPANY,
        issueId: ISSUE,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        resolverPolicy: "board_or_agents",
        requestedResolverPolicy: "board_or_agents",
        effectiveResolverPolicy: "board_or_agents",
        createdByAgentId: "agent-c",
        addresseeAgentId: null,
        title: "Which plan?",
        payload: { version: 1 },
        createdAt: new Date("2026-10-03T16:00:00Z"),
        updatedAt: new Date("2026-10-03T16:00:00Z"),
      } as never,
    ],
    approvals: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        companyId: COMPANY,
        type: "request_board_approval",
        status: "pending",
        payload: {},
        createdAt: new Date("2026-10-03T09:00:00Z"),
        updatedAt: new Date("2026-10-03T09:00:00Z"),
      } as never,
    ],
  });
}

async function setup(config: Record<string, unknown>) {
  const harness = createTestHarness({ manifest, config });
  seed(harness);
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return harness;
}

describe("decision-router worker", () => {
  it("sweeps to metrics, state and the digest document without mutating", async () => {
    const harness = await setup({ ceoDeskIssueId: DESK_ISSUE, codeReviewerAgentId: "agent-reviewer" });
    await harness.runJob(JOB_KEYS.sweepDecisions);

    // SLA metrics written per kind.
    const countMetric = harness.metrics.find(
      (point) => point.name === "decision_router.attention.count" && point.tags?.kind === "issue_thread_interaction",
    );
    expect(countMetric?.value).toBe(1);

    // Last-sweep state recorded, shadow-flagged.
    const lastSweep = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.lastSweep,
    }) as { items: number; shadow: boolean } | undefined;
    expect(lastSweep?.items).toBeGreaterThanOrEqual(2); // interaction + approval
    expect(lastSweep?.shadow).toBe(true);

    // Digest document upserted on the desk card.
    const documents = await harness.ctx.issues.documents.list(DESK_ISSUE, COMPANY);
    expect(documents.some((doc) => doc.key === CEO_DIGEST_DOCUMENT_KEY)).toBe(true);

    // Shadow rule: no mutations issued.
    expect(harness.activity).toEqual([]);
  });

  it("serves per-kind count and age on the sla-metrics endpoint for Gatus", async () => {
    const harness = await setup({ ceoDeskIssueId: DESK_ISSUE, codeReviewerAgentId: "agent-reviewer" });

    // Before any sweep: a stable sentinel, never null.
    expect(await harness.getData(DATA_KEYS.slaMetrics, { companyId: COMPANY })).toEqual({ error: "no sweep yet" });
    expect(await harness.getData(DATA_KEYS.slaMetrics, {})).toEqual({ error: "companyId param required" });

    await harness.runJob(JOB_KEYS.sweepDecisions);

    const snapshot = (await harness.getData(DATA_KEYS.slaMetrics, { companyId: COMPANY })) as {
      at: string;
      scannedIssues: number;
      itemsTotal: number;
      shadow: boolean;
      byKind: Array<{ kind: string; count: number; medianAgeHours: number | null; maxAgeHours: number | null }>;
    };
    expect(new Set(snapshot.byKind.map((entry) => entry.kind))).toEqual(
      new Set([
        "blocker_attention",
        "recovery_action",
        "review",
        "issue_thread_interaction",
        "failed_run",
        "approval",
      ]),
    );
    const entry = (kind: string) => {
      const found = snapshot.byKind.find((row) => row.kind === kind);
      expect(found).toBeDefined();
      return found as { kind: string; count: number; medianAgeHours: number | null; maxAgeHours: number | null };
    };
    expect(entry("issue_thread_interaction").count).toBe(1);
    expect(entry("approval").count).toBe(1);
    expect(entry("review").count).toBe(0);
    expect(entry("review").medianAgeHours).toBeNull();
    // Single-item kinds carry a real numeric age, not null and not 0-by-default.
    const interaction = entry("issue_thread_interaction");
    expect(typeof interaction.medianAgeHours).toBe("number");
    expect(interaction.medianAgeHours).toBe(interaction.maxAgeHours);
    expect(snapshot.itemsTotal).toBeGreaterThanOrEqual(2);
    expect(snapshot.shadow).toBe(true);

    // Shadow rule: serving the endpoint reads state and mutates nothing.
    expect(harness.activity).toEqual([]);
  });

  it("persists empty retry memory in shadow mode and fires nothing", async () => {
    const harness = await setup({ ceoDeskIssueId: DESK_ISSUE, codeReviewerAgentId: "agent-reviewer" });
    await harness.runJob(JOB_KEYS.sweepDecisions);
    const lastSweep = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.lastSweep,
    }) as { retryAttempts: Record<string, number>; retriedKeys: string[]; retryFired: number } | undefined;
    expect(lastSweep?.retryAttempts).toEqual({});
    expect(lastSweep?.retriedKeys).toEqual([]);
    expect(lastSweep?.retryFired).toBe(0);
    expect(harness.activity).toEqual([]);
  });

  it("issues no wakeups with the flag on when no failed run is due", async () => {
    const harness = await setup({
      ceoDeskIssueId: DESK_ISSUE,
      codeReviewerAgentId: "agent-reviewer",
      applyMutations: true,
    });
    await harness.runJob(JOB_KEYS.sweepDecisions);
    const lastSweep = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.lastSweep,
    }) as { shadow: boolean } | undefined;
    expect(lastSweep?.shadow).toBe(false);
    expect(harness.activity).toEqual([]);
  });

  it("records the digest to state when no desk card is configured", async () => {
    const harness = await setup({});
    await harness.runJob(JOB_KEYS.sweepDecisions);
    const lastSweep = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.lastSweep,
    }) as { digestIssueId: null } | undefined;
    expect(lastSweep?.digestIssueId).toBeNull();
  });
});
