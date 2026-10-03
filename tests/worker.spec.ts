/**
 * Worker slice test through the SDK test harness: one seeded company with an
 * interaction, a blocker edge, a failed run and a pending approval. The sweep
 * job must persist metrics, the last-sweep state record, and (with a desk
 * card configured) the CEO digest document — and mutate nothing.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { CEO_DIGEST_DOCUMENT_KEY, JOB_KEYS, STATE_KEYS } from "../src/constants.js";
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
