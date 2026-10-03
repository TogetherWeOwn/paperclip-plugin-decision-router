import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AttentionItem } from "../src/attention.js";
import { routeAttention, type RoutingContext } from "../src/routing.js";

interface RoutingFixture {
  name: string;
  item: AttentionItem;
  focus: {
    focusIssueIds: string[];
    focusAnchorIssueId: string | null;
    blockerOwners: Record<string, string>;
    retryAttempts: Record<string, number>;
    maxRetryAttempts: number;
    ownerReserved: boolean;
    needsHuman: boolean;
  };
  expect: Record<string, unknown>;
}

const fixtures: RoutingFixture[] = JSON.parse(
  readFileSync(new URL("./fixtures/routing.json", import.meta.url), "utf8"),
) as RoutingFixture[];

// TOG-14130 slice of TOG-13484 step 2: the deterministic routing table as
// pure functions, pinned by a plain-data fixture table — reviews go to the
// Code Reviewer, blockers to the blocker owner or park with an edge,
// recovery actions to the reconciler policy, failed runs to the bounded
// retry policy, approvals (and anything unowned) to the CEO digest.
// No SDK wiring, no schedule, no cutover in this slice.
describe("routing table fixtures", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const ctx: RoutingContext = {
        codeReviewerAgentId: "agent-reviewer",
        focusAnchorIssueId: fixture.focus.focusAnchorIssueId,
        blockerOwners: fixture.focus.blockerOwners,
        focusIssueIds: fixture.focus.focusIssueIds,
        retryAttempts: fixture.focus.retryAttempts,
        maxRetryAttempts: fixture.focus.maxRetryAttempts,
        needsHumanCapability: fixture.focus.needsHuman ? () => true : undefined,
        isOwnerReserved: fixture.focus.ownerReserved ? () => true : undefined,
      };
      expect(routeAttention(fixture.item, ctx)).toMatchObject(fixture.expect);
    });
  }

  it("covers every attention kind", () => {
    const kinds = new Set(fixtures.map((fixture) => fixture.item.kind));
    expect([...kinds].sort()).toEqual([
      "approval",
      "blocker_attention",
      "failed_run",
      "issue_thread_interaction",
      "recovery_action",
      "review",
    ]);
  });
});
