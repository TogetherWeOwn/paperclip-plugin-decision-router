/**
 * Triage classifier tests. Each case mirrors a measured host behavior from
 * interaction_triage.sh (cited gates). Assert on verdicts, never on prose.
 */
import { describe, expect, it } from "vitest";

import { triageInteraction, type TriageRow } from "../src/triage.js";

function row(overrides: Partial<TriageRow> & Pick<TriageRow, "identifier">): TriageRow {
  return {
    kind: "request_confirmation",
    effectiveResolverPolicy: "board_or_agents",
    createdByAgentId: "agent-creator",
    continuationPolicy: "wake_assignee",
    issueStatus: "todo",
    ...overrides,
  };
}

describe("triageInteraction", () => {
  it("resolves on an unassigned issue to any agent except the creator", () => {
    const result = triageInteraction(row({ identifier: "TOG-1", assigneeAgentId: null }));
    expect(result.verdict).toBe("AGENT_RESOLVABLE");
    expect(result.resolvers).toEqual(["<any agent except the creator>"]);
    expect(result.continuation).toBe("DEAD_WAKE"); // no assignee: the answer wakes nobody (:1253)
  });

  it("resolves to the assignee with a live wake", () => {
    const result = triageInteraction(
      row({ identifier: "TOG-2", assigneeAgentId: "agent-a", createdByAgentId: "agent-b" }),
    );
    expect(result.verdict).toBe("AGENT_RESOLVABLE");
    expect(result.resolvers).toEqual(["agent-a"]);
    expect(result.continuation).toBe("WAKES");
  });

  it("marks board_only without a review verdict as OWNER_ONLY", () => {
    const result = triageInteraction(
      row({
        identifier: "TOG-3",
        effectiveResolverPolicy: "board_only",
        assigneeAgentId: "agent-a",
        createdByAgentId: "agent-b",
      }),
    );
    expect(result.verdict).toBe("OWNER_ONLY");
  });

  it("marks its own creator as INERT (creator bar :2975)", () => {
    const result = triageInteraction(
      row({ identifier: "TOG-4", assigneeAgentId: "agent-a", createdByAgentId: "agent-a" }),
    );
    expect(result.verdict).toBe("INERT");
  });

  it("marks an ask addressed to a non-assignee as INERT (:2946 fires first)", () => {
    const result = triageInteraction(
      row({
        identifier: "TOG-5",
        assigneeAgentId: "agent-a",
        addresseeAgentId: "agent-b",
        createdByAgentId: "agent-c",
      }),
    );
    expect(result.verdict).toBe("INERT");
  });

  it("routes an addressed ask on an unassigned issue to the addressee", () => {
    const result = triageInteraction(
      row({
        identifier: "TOG-6",
        assigneeAgentId: null,
        addresseeAgentId: "agent-b",
        createdByAgentId: "agent-c",
      }),
    );
    expect(result.verdict).toBe("AGENT_RESOLVABLE");
    expect(result.resolvers).toEqual(["agent-b"]);
  });

  it("marks tool-action confirmations OWNER_ONLY (:2953, no exceptions)", () => {
    const result = triageInteraction(
      row({
        identifier: "TOG-7",
        kind: "request_confirmation",
        hasToolAction: true,
        assigneeAgentId: "agent-a",
        createdByAgentId: "agent-b",
      }),
    );
    expect(result.verdict).toBe("OWNER_ONLY");
  });

  it("applies the review-verdict bypass only when the transition named it (:2956)", () => {
    const named = triageInteraction(
      row({
        identifier: "TOG-8",
        effectiveResolverPolicy: "board_only",
        issueStatus: "in_review",
        namedReviewInteraction: true,
        assigneeAgentId: "agent-a",
        createdByAgentId: "agent-b",
      }),
    );
    expect(named.verdict).toBe("AGENT_REVIEW_VERDICT");
  });

  it("fails review eligibility closed without the named linkage", () => {
    const unnamed = triageInteraction(
      row({
        identifier: "TOG-9",
        effectiveResolverPolicy: "board_only",
        issueStatus: "in_review",
        namedReviewInteraction: false,
        assigneeAgentId: "agent-a",
        createdByAgentId: "agent-b",
      }),
    );
    expect(unnamed.verdict).toBe("OWNER_ONLY");
  });

  it("reports DEAD_WAKE for a closed issue (assignment cannot repair it)", () => {
    const result = triageInteraction(
      row({
        identifier: "TOG-10",
        issueStatus: "done",
        assigneeAgentId: "agent-a",
        createdByAgentId: "agent-b",
      }),
    );
    expect(result.verdict).toBe("AGENT_RESOLVABLE");
    expect(result.continuation).toBe("DEAD_WAKE");
  });

  it("reports WAKES_ON_ACCEPT for wake_assignee_on_accept", () => {
    const result = triageInteraction(
      row({
        identifier: "TOG-11",
        continuationPolicy: "wake_assignee_on_accept",
        assigneeAgentId: "agent-a",
        createdByAgentId: "agent-b",
      }),
    );
    expect(result.continuation).toBe("WAKES_ON_ACCEPT");
  });

  it("reports UNKNOWN when the wake path was never measured", () => {
    const result = triageInteraction(
      row({
        identifier: "TOG-12",
        continuationPolicy: null,
        assigneeAgentId: "agent-a",
        createdByAgentId: "agent-b",
      }),
    );
    expect(result.continuation).toBe("UNKNOWN");
  });

  it("marks rows missing required fields MALFORMED, never clean", () => {
    const result = triageInteraction({
      identifier: "",
      kind: "",
      effectiveResolverPolicy: "",
      createdByAgentId: "",
    });
    expect(result.verdict).toBe("MALFORMED");
    expect(result.continuation).toBe("UNKNOWN");
  });

  it("warns that assigning an unassigned ask narrows its resolver set", () => {
    const result = triageInteraction(row({ identifier: "TOG-13", assigneeAgentId: null }));
    expect(result.warnings.some((warning) => warning.includes("assign_would_kill"))).toBe(true);
  });

  it("warns on in_progress checkout run-locks", () => {
    const result = triageInteraction(
      row({
        identifier: "TOG-14",
        issueStatus: "in_progress",
        assigneeAgentId: "agent-a",
        createdByAgentId: "agent-b",
      }),
    );
    expect(result.warnings.some((warning) => warning.includes("run-lock"))).toBe(true);
  });
});
