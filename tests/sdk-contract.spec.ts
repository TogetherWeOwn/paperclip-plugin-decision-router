import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Approval, Company, Issue, IssueRecoveryAction, IssueThreadInteraction } from "@paperclipai/shared";
import { pluginManifestV1Schema, upsertPluginConfigSchema } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DATA_KEYS, JOB_KEYS, STATE_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "33333333-3333-4333-8333-333333333333";
const blockerId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-10-03T09:00:00Z");
const company: Company = {
  id: companyId, name: "Fixture", description: null, status: "active", pauseReason: null, pausedAt: null,
  issuePrefix: "TEST", issueCounter: 2, budgetMonthlyCents: 0, spentMonthlyCents: 0,
  defaultResponsibleUserId: null, requireBoardApprovalForNewAgents: true, interactionResolverGovernance: {},
  feedbackDataSharingEnabled: false, feedbackDataSharingConsentAt: null, feedbackDataSharingConsentByUserId: null,
  feedbackDataSharingTermsVersion: null, logoAssetId: null, logoUrl: null, createdAt: now, updatedAt: now,
};
function issue(id: string, status: Issue["status"]): Issue {
  return {
    id, companyId, title: "Contract fixture", description: null, status, workMode: "standard", priority: "medium",
    projectId: null, projectWorkspaceId: null, goalId: null, parentId: null, reviewPolicy: null,
    assigneeAgentId: "fixture-agent", assigneeUserId: null, checkoutRunId: null, executionRunId: null,
    executionAgentNameKey: null, executionLockedAt: null, createdByAgentId: null, createdByUserId: null,
    responsibleUserId: null, issueNumber: 1, identifier: "TEST-1", requestDepth: 0, billingCode: null,
    assigneeAdapterOverrides: null, executionWorkspaceId: null, executionWorkspacePreference: null,
    executionWorkspaceSettings: null, startedAt: null, completedAt: null, cancelledAt: null, hiddenAt: null,
    createdAt: now, updatedAt: now,
  };
}
const interaction: IssueThreadInteraction = {
  id: "55555555-5555-4555-8555-555555555555", companyId, issueId,
  kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
  resolverPolicy: "anyone", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone",
  resolverPolicyProvenance: "explicit", effectiveResolverPolicySource: "requested",
  legacyResolverPolicyAliases: { requested: null, effective: null },
  payload: { version: 1, prompt: "Proceed with the fixture?" }, createdAt: now, updatedAt: now,
};
const approval: Approval = {
  id: "66666666-6666-4666-8666-666666666666", companyId, type: "request_board_approval", status: "pending",
  payload: { issueId }, requestedByAgentId: null, requestedByUserId: null, decisionNote: null,
  decidedByUserId: null, decidedAt: null, createdAt: now, updatedAt: now,
};
const recovery: IssueRecoveryAction = {
  id: "77777777-7777-4777-8777-777777777777", companyId, sourceIssueId: blockerId,
  recoveryIssueId: null, kind: "missing_disposition", status: "active", ownerType: "agent",
  ownerAgentId: "fixture-agent", ownerUserId: null, previousOwnerAgentId: null, returnOwnerAgentId: null,
  cause: "fixture", fingerprint: "fixture", evidence: {}, nextAction: "record disposition", wakePolicy: null,
  monitorPolicy: null, attemptCount: 0, maxAttempts: 1, timeoutAt: null, lastAttemptAt: null, outcome: null,
  resolutionNote: null, resolvedAt: null, createdAt: now, updatedAt: now,
};

describe("selected SDK/shared contract", () => {
  it("validates the manifest/config envelope and benign bounded Zod containers", () => {
    expect(pluginManifestV1Schema.safeParse(manifest).success).toBe(true);
    expect(pluginManifestV1Schema.safeParse({ ...manifest, apiVersion: 99 }).success).toBe(false);
    expect(upsertPluginConfigSchema.safeParse({ companyId, configJson: { applyMutations: false } }).success).toBe(true);
    expect(upsertPluginConfigSchema.safeParse({ companyId, configJson: [] }).success).toBe(false);
    const bounded = z.array(z.string()).max(2);
    expect(bounded.safeParse(["one", "two"]).success).toBe(true);
    expect(bounded.safeParse(["one", "two", "three"]).success).toBe(false);
  });

  it("maps typed host sources and preserves shadow metrics/state/digest with no mutation calls", async () => {
    const harness = createTestHarness({ manifest, config: { ceoDeskIssueId: issueId } });
    harness.seed({ companies: [company], issues: [issue(issueId, "todo"), issue(blockerId, "done")],
      issueInteractions: [interaction], approvals: [approval] });
    vi.spyOn(harness.ctx.issues.relations, "get").mockResolvedValue({
      blockedBy: [{ id: blockerId, identifier: "TEST-2", title: "Done blocker", status: "done",
        priority: "medium", assigneeAgentId: "fixture-agent", assigneeUserId: null,
        activeRecoveryAction: recovery }], blocks: [],
    });
    const original = harness.ctx.issues.summaries.getOrchestration.bind(harness.ctx.issues.summaries);
    vi.spyOn(harness.ctx.issues.summaries, "getOrchestration").mockImplementation(async (input) => ({
      ...await original(input), runs: [{ id: "run-fixture", issueId, agentId: "fixture-agent", status: "failed",
        invocationSource: "assignment", triggerDetail: null, startedAt: now.toISOString(),
        finishedAt: now.toISOString(), createdAt: now.toISOString(), error: "temporary fixture error" }],
    }));
    const mutations = [vi.spyOn(harness.ctx.issues, "respondInteraction"),
      vi.spyOn(harness.ctx.approvals, "decide"), vi.spyOn(harness.ctx.issues, "requestWakeup"),
      vi.spyOn(harness.ctx.issues.relations, "removeBlockers")];
    await createPlugin().definition.setup(harness.ctx);
    await harness.runJob(JOB_KEYS.sweepDecisions);
    const snapshot = await harness.getData<{ byKind: Array<{ kind: string; count: number }>; shadow: boolean }>(
      DATA_KEYS.slaMetrics, { companyId });
    for (const kind of ["issue_thread_interaction", "approval", "blocker_attention", "recovery_action", "failed_run"]) {
      expect(snapshot.byKind.find((row) => row.kind === kind)?.count).toBeGreaterThan(0);
    }
    expect(snapshot.shadow).toBe(true);
    expect(harness.getState({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.lastSweep })).toBeDefined();
    expect(harness.metrics.length).toBeGreaterThan(0);
    expect((await harness.ctx.issues.documents.list(issueId, companyId)).length).toBe(1);
    await harness.emit("issue.updated", {}, { companyId });
    expect(harness.getState({ scopeKind: "company", scopeId: companyId, stateKey: "sweep-hint" }))
      .toMatchObject({ what: "issue.updated" });
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect(harness.activity).toEqual([]);
  });

  it("handles an empty host and invalid data parameters without mutations", async () => {
    const harness = createTestHarness({ manifest });
    await createPlugin().definition.setup(harness.ctx);
    await harness.runJob(JOB_KEYS.sweepDecisions);
    expect(await harness.getData(DATA_KEYS.slaMetrics, { companyId: 12 })).toEqual({ error: "companyId param required" });
    expect(await harness.getData(DATA_KEYS.slaMetrics, { companyId })).toEqual({ error: "no sweep yet" });
    expect(harness.activity).toEqual([]);
  });
});
