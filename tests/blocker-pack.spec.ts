import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildBlockerPack,
  type BlockerDiagnosticsPack,
  type BlockerEdgeEvidence,
  type BlockerPackInput,
} from "../src/blockerPack.js";

interface BlockerPackFixture {
  now: string;
  inputs: BlockerPackInput[];
  expect: {
    edgeCount: number;
    staleCount: number;
    openCount: number;
    unknownOwnerCount: number;
    unknownAgeCount: number;
    edges: Partial<BlockerEdgeEvidence>[];
  };
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/blocker-pack.json", import.meta.url), "utf8"),
) as BlockerPackFixture;

// Read-only by construction: the pack must serialize to exactly its evidence
// shape — any mutation affordance (apply/fire/remove/unblock-callable) would
// show up as an extra key here.
function assertPackShape(pack: BlockerDiagnosticsPack): void {
  expect(Object.keys(pack).sort()).toEqual(
    ["at", "edgeCount", "edges", "openCount", "staleCount", "unknownAgeCount", "unknownOwnerCount"],
  );
  for (const edge of pack.edges) {
    expect(Object.keys(edge).sort()).toEqual(
      [
        "ageHours",
        "blockedIdentifier",
        "blockedIssueId",
        "blockerIdentifier",
        "blockerIssueId",
        "blockerStatus",
        "ownerAgentId",
        "proposal",
        "stale",
      ],
    );
  }
}

describe("blocker diagnostics pack", () => {
  it("reproduces the fixture pack exactly (proposal payload only, never unblocks)", () => {
    const pack = buildBlockerPack(fixture.inputs, new Date(fixture.now));
    assertPackShape(pack);
    expect(pack.at).toBe(fixture.now);
    expect(pack.edgeCount).toBe(fixture.expect.edgeCount);
    expect(pack.staleCount).toBe(fixture.expect.staleCount);
    expect(pack.openCount).toBe(fixture.expect.openCount);
    expect(pack.unknownOwnerCount).toBe(fixture.expect.unknownOwnerCount);
    expect(pack.unknownAgeCount).toBe(fixture.expect.unknownAgeCount);
    expect(pack.edges).toHaveLength(fixture.expect.edges.length);
    for (const [index, expected] of fixture.expect.edges.entries()) {
      expect(pack.edges[index]).toMatchObject(expected);
    }
  });

  it("returns an empty pack for no inputs", () => {
    const pack = buildBlockerPack([], new Date("2026-10-03T18:00:00Z"));
    assertPackShape(pack);
    expect(pack).toMatchObject({
      edgeCount: 0,
      staleCount: 0,
      openCount: 0,
      unknownOwnerCount: 0,
      unknownAgeCount: 0,
    });
    expect(pack.edges).toEqual([]);
  });

  it("fails closed on unknown blocker statuses (never stale)", () => {
    const pack = buildBlockerPack(
      ["todo", "in_progress", "in_review", "blocked", "backlog", "", "DONE", "archived"].map(
        (blockerStatus, index): BlockerPackInput => ({
          blockedIssueId: `issue-${index}`,
          blockedIdentifier: null,
          blockerIssueId: `blocker-${index}`,
          blockerIdentifier: null,
          blockerStatus,
          ownerAgentId: "agent-a",
          pendingSince: "2026-10-03T17:00:00Z",
        }),
      ),
      new Date("2026-10-03T18:00:00Z"),
    );
    expect(pack.staleCount).toBe(0);
    expect(pack.openCount).toBe(8);
    expect(pack.edges.every((edge) => edge.stale === false)).toBe(true);
    expect(pack.edges.every((edge) => edge.proposal.startsWith("owner route stands:"))).toBe(true);
  });

  it("falls back to id prefixes when identifiers are missing", () => {
    const pack = buildBlockerPack(
      [
        {
          blockedIssueId: "blocked-abcdef",
          blockedIdentifier: null,
          blockerIssueId: "blocker-ghijkl",
          blockerIdentifier: null,
          blockerStatus: "done",
          ownerAgentId: null,
          pendingSince: "2026-10-03T17:00:00Z",
        },
      ],
      new Date("2026-10-03T18:00:00Z"),
    );
    expect(pack.edges[0]).toMatchObject({ stale: true, ageHours: 1 });
    expect(pack.edges[0]?.proposal).toBe(
      "proposes unblock: blocker- (done) blocks blocked- — 1h old, owner unknown",
    );
    expect(pack.unknownOwnerCount).toBe(1);
  });

  it("keeps unknown ages null (absence is not youth)", () => {
    const pack = buildBlockerPack(
      [
        {
          blockedIssueId: "issue-1",
          blockedIdentifier: "TOG-1",
          blockerIssueId: "issue-9",
          blockerIdentifier: "TOG-9",
          blockerStatus: "todo",
          ownerAgentId: "agent-a",
          pendingSince: "not-a-date",
        },
      ],
      new Date("2026-10-03T18:00:00Z"),
    );
    expect(pack.edges[0]).toMatchObject({ stale: false, ageHours: null });
    expect(pack.edges[0]?.proposal).toContain("age unknown");
    expect(pack.unknownAgeCount).toBe(1);
  });
});
