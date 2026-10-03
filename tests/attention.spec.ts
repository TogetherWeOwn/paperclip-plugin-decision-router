import { describe, expect, it } from "vitest";

import { ageHours, summarizeByKind, type AttentionItem } from "../src/attention.js";
import { slaMetrics, sweepCounters } from "../src/metrics.js";
import { renderDigest } from "../src/digest.js";
import type { RoutedItem } from "../src/routing.js";

const NOW = new Date("2026-10-03T18:00:00Z");

function item(kind: AttentionItem["kind"], pendingSince: string): AttentionItem {
  return { kind, issueId: "issue-1", identifier: "TOG-1", sourceId: "src-1", pendingSince };
}

describe("ageHours", () => {
  it("counts whole hours", () => {
    expect(ageHours(item("review", "2026-10-03T15:30:00Z"), NOW)).toBe(2);
  });

  it("returns null for unparseable or future timestamps (never 0)", () => {
    expect(ageHours(item("review", "not-a-date"), NOW)).toBeNull();
    expect(ageHours(item("review", "2026-10-04T00:00:00Z"), NOW)).toBeNull();
  });
});

describe("summarizeByKind", () => {
  it("counts every kind and medians only known ages", () => {
    const summaries = summarizeByKind(
      [
        item("blocker_attention", "2026-10-03T08:00:00Z"), // 10h
        item("blocker_attention", "2026-10-03T12:00:00Z"), // 6h
        item("blocker_attention", "garbage"), // counts, never moves the median
        item("approval", "2026-10-03T09:00:00Z"), // 9h
      ],
      NOW,
    );
    const blocker = summaries.find((summary) => summary.kind === "blocker_attention");
    expect(blocker).toMatchObject({ count: 3, medianAgeHours: 8, maxAgeHours: 10 });
    const approval = summaries.find((summary) => summary.kind === "approval");
    expect(approval).toMatchObject({ count: 1, medianAgeHours: 9, maxAgeHours: 9 });
    const review = summaries.find((summary) => summary.kind === "review");
    expect(review).toMatchObject({ count: 0, medianAgeHours: null, maxAgeHours: null });
  });
});

describe("slaMetrics", () => {
  it("emits count always and ages only when known", () => {
    const points = slaMetrics([item("review", "garbage")], NOW);
    expect(points).toContainEqual({
      name: "decision_router.attention.count",
      value: 0,
      tags: { kind: "approval" },
    });
    const reviewCount = points.find(
      (point) => point.name === "decision_router.attention.count" && point.tags?.kind === "review",
    );
    expect(reviewCount?.value).toBe(1);
    expect(
      points.some((point) => point.name === "decision_router.attention.age_median_hours" && point.tags?.kind === "review"),
    ).toBe(false);
  });

  it("emits sweep counters that add up", () => {
    expect(sweepCounters(3, 2)).toContainEqual({ name: "decision_router.sweep.items_total", value: 5 });
  });
});

describe("renderDigest", () => {
  it("renders sections with triage, route and grammar stub", () => {
    const routed: RoutedItem[] = [
      {
        item: { ...item("issue_thread_interaction", "2026-10-03T15:00:00Z"), sourceId: "ix-1", detail: "request_confirmation" },
        triage: {
          identifier: "TOG-1/ix-1",
          verdict: "AGENT_RESOLVABLE",
          why: "ok",
          resolvers: ["agent-a"],
          warnings: [],
          continuation: "WAKES",
          continuationWhy: "wakes",
        },
        destination: { type: "ceo-digest", reason: "needs a decision" },
      },
    ];
    const digest = renderDigest(routed, NOW, true);
    expect(digest).toContain("## issue_thread_interaction");
    expect(digest).toContain("AGENT_RESOLVABLE");
    expect(digest).toContain("`ANSWER ix-1 accept|reject`");
    expect(digest).toContain("Shadow mode");
  });

  it("says plainly when there is nothing pending", () => {
    expect(renderDigest([], NOW, true)).toContain("No pending attention");
  });
});
