import { describe, expect, it } from "vitest";

import {
  decisionLogKey,
  decisionLogMetrics,
  formatDecisionRecord,
  planDecisionLogAction,
  planDecisionLogActions,
} from "../src/decisionLog.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { sweepDecisions, type SweepReads } from "../src/sweep.js";

const NOW = new Date("2026-10-03T18:00:00Z");

const INTERACTION = {
  kind: "issue_thread_interaction",
  issueId: "issue-1",
  identifier: "TOG-1",
  sourceId: "ix-1",
  destination: "ceo-digest",
  triageVerdict: "BOARD_ONLY",
};

describe("planDecisionLogAction", () => {
  it("is a flag-off no-op: skips without formatting when disabled", () => {
    const plan = planDecisionLogAction(INTERACTION, { enabled: false, now: NOW });
    expect(plan).toMatchObject({
      key: "decision-log:issue_thread_interaction:ix-1",
      decision: "skip",
      record: null,
      mode: "dry-run",
      channel: "metrics",
    });
    expect(plan.reason).toContain("flag off");
  });

  it("emits a dry-run record when the flag is on, on a stable key", () => {
    const plan = planDecisionLogAction(INTERACTION, { enabled: true, now: NOW });
    expect(plan.decision).toBe("emit");
    expect(plan.mode).toBe("dry-run");
    expect(plan.channel).toBe("metrics");
    expect(plan.key).toBe(decisionLogKey("issue_thread_interaction", "ix-1"));
    expect(plan.record).toMatchObject({
      key: plan.key,
      kind: "issue_thread_interaction",
      issueId: "issue-1",
      sourceId: "ix-1",
      destination: "ceo-digest",
      triage: "BOARD_ONLY",
      at: NOW.toISOString(),
      dryRun: true,
    });
  });

  it("never auto-responds: the channel is metrics, never an interaction respond", () => {
    const plan = planDecisionLogAction(INTERACTION, { enabled: true, now: NOW });
    expect(plan.channel).toBe("metrics");
    expect(plan.channel).not.toBe("interactions.respond");
    expect(plan.record).not.toHaveProperty("respond");
    expect(plan).not.toHaveProperty("interactionId");
  });

  it("skips a duplicate key already planned", () => {
    const seen = new Set([decisionLogKey("issue_thread_interaction", "ix-1")]);
    const plan = planDecisionLogAction(INTERACTION, { enabled: true, now: NOW, seenKeys: seen });
    expect(plan.decision).toBe("skip");
    expect(plan.record).toBeNull();
    expect(plan.reason).toContain("duplicate");
  });

  it("skips malformed rows with no source id", () => {
    const plan = planDecisionLogAction({ ...INTERACTION, sourceId: "" }, { enabled: true, now: NOW });
    expect(plan.decision).toBe("skip");
    expect(plan.record).toBeNull();
    expect(plan.reason).toContain("malformed");
  });
});

describe("planDecisionLogActions", () => {
  it("de-duplicates within the batch on the decision key", () => {
    const plans = planDecisionLogActions([INTERACTION, INTERACTION], { enabled: true, now: NOW });
    expect(plans.map((plan) => plan.decision)).toEqual(["emit", "skip"]);
    expect(plans[1]?.reason).toContain("duplicate");
  });

  it("keeps keys stable across flag states (idempotent retry)", () => {
    const off = planDecisionLogActions([INTERACTION], { enabled: false, now: NOW });
    const on = planDecisionLogActions([INTERACTION], { enabled: true, now: NOW, seenKeys: [] });
    expect(off[0]?.key).toBe(on[0]?.key);
  });
});

describe("formatDecisionRecord", () => {
  it("is JSON-safe and dry-run marked", () => {
    const record = formatDecisionRecord(INTERACTION, NOW);
    expect(() => JSON.stringify(record)).not.toThrow();
    expect(JSON.parse(JSON.stringify(record))).toMatchObject({ dryRun: true, at: NOW.toISOString() });
  });
});

describe("decisionLogMetrics", () => {
  it("emits zero points when the flag is off (all plans skipped)", () => {
    const plans = planDecisionLogActions([INTERACTION], { enabled: false, now: NOW });
    expect(decisionLogMetrics(plans)).toEqual([]);
  });

  it("aggregates per kind + destination", () => {
    const plans = planDecisionLogActions(
      [
        INTERACTION,
        INTERACTION,
        { ...INTERACTION, kind: "failed_run", sourceId: "run-1", destination: "retry", triageVerdict: null },
      ],
      { enabled: true, now: NOW },
    );
    expect(decisionLogMetrics(plans)).toEqual([
      {
        name: "decision_router.decision_log.emitted",
        value: 1,
        tags: { kind: "issue_thread_interaction", destination: "ceo-digest" },
      },
      {
        name: "decision_router.decision_log.emitted",
        value: 1,
        tags: { kind: "failed_run", destination: "retry" },
      },
    ]);
  });
});

describe("sweep decision-log plans", () => {
  function reads(): SweepReads {
    return {
      async listOpenIssues() {
        return [{ id: "issue-1", identifier: "TOG-1", status: "todo", assigneeAgentId: "agent-a" }];
      },
      async listPendingInteractions() {
        return [
          {
            id: "ix-1",
            kind: "ask_user_questions",
            status: "pending",
            effectiveResolverPolicy: "human_only",
            createdByAgentId: "agent-a",
            addresseeAgentId: null,
            hasToolAction: false,
            continuationPolicy: "wake_assignee",
            createdAt: "2026-10-03T15:24:00Z",
            title: "Should we cut over?",
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

  it("plans nothing when the flag is off (default)", async () => {
    expect(DEFAULT_CONFIG.decisionLogEmit).toBe(false);
    const result = await sweepDecisions("company-1", DEFAULT_CONFIG, reads(), NOW);
    expect(result.decisionLogPlans.every((plan) => plan.decision === "skip")).toBe(true);
    expect(result.decisionLogPlans.every((plan) => plan.record === null)).toBe(true);
    expect(result.metrics.filter((point) => point.name === "decision_router.decision_log.emitted")).toEqual([]);
  });

  it("emits one dry-run record per routed item when the flag is on", async () => {
    const result = await sweepDecisions(
      "company-1",
      { ...DEFAULT_CONFIG, decisionLogEmit: true },
      reads(),
      NOW,
    );
    expect(result.decisionLogPlans).toHaveLength(result.routed.length);
    expect(result.decisionLogPlans.every((plan) => plan.decision === "emit")).toBe(true);
    expect(result.decisionLogPlans.every((plan) => plan.mode === "dry-run")).toBe(true);
    expect(result.decisionLogPlans.every((plan) => plan.channel === "metrics")).toBe(true);
    const emitted = result.metrics.filter((point) => point.name === "decision_router.decision_log.emitted");
    expect(emitted.reduce((sum, point) => sum + point.value, 0)).toBe(result.routed.length);
  });

  it("leaves flag-off routing untouched when the flag is on", async () => {
    const result = await sweepDecisions(
      "company-1",
      { ...DEFAULT_CONFIG, decisionLogEmit: true },
      reads(),
      NOW,
    );
    const interaction = result.routed.find((r) => r.item.kind === "issue_thread_interaction");
    expect(interaction?.destination.type).toBe("ceo-digest");
  });
});
