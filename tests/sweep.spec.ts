import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import { sweepDecisions, type SweepReads } from "../src/sweep.js";

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
          activeRecovery: [
            { id: "ra-1", kind: "missing_disposition", status: "active", createdAt: "2026-10-03T10:00:00Z" },
          ],
        };
      }
      return { blockedByIds: [], activeRecovery: [] };
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
});
