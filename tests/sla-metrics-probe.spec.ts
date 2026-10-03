import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ATTENTION_KINDS, type AttentionItem } from "../src/attention.js";
import { slaSnapshot } from "../src/metrics.js";

// Local probe for the frozen `sla-metrics` contract (docs/SLA_METRICS.md):
// the JSON fixture is the endpoint shape Gatus may depend on, and the live
// `slaSnapshot` builder must reproduce it exactly. Source-only; no host
// install, no Gatus wiring.
const NOW = new Date("2026-10-03T18:00:00.000Z");

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/sla-metrics.json", import.meta.url), "utf8"),
) as unknown;

interface ByKindEntry {
  kind: string;
  count: number;
  medianAgeHours: number | null;
  maxAgeHours: number | null;
}

interface SlaPayload {
  at: string;
  scannedIssues: number;
  itemsTotal: number;
  routedAuto: number;
  routedCeo: number;
  shadow: boolean;
  byKind: ByKindEntry[];
}

function assertSlaShape(payload: unknown): asserts payload is SlaPayload {
  expect(payload).toBeTypeOf("object");
  const snapshot = payload as Record<string, unknown>;
  expect(typeof snapshot.at).toBe("string");
  expect(Number.isNaN(Date.parse(snapshot.at as string))).toBe(false);
  for (const field of ["scannedIssues", "itemsTotal", "routedAuto", "routedCeo"] as const) {
    expect(snapshot[field]).toBeTypeOf("number");
    expect(Number.isInteger(snapshot[field])).toBe(true);
    expect((snapshot[field] as number) >= 0).toBe(true);
  }
  expect(snapshot.shadow).toBeTypeOf("boolean");
  expect(Array.isArray(snapshot.byKind)).toBe(true);
  const byKind = snapshot.byKind as ByKindEntry[];
  expect(byKind).toHaveLength(6);
  expect(byKind.map((entry) => entry.kind)).toEqual([...ATTENTION_KINDS]);
  for (const entry of byKind) {
    expect(entry.count).toBeTypeOf("number");
    expect(Number.isInteger(entry.count)).toBe(true);
    expect(entry.count >= 0).toBe(true);
    for (const age of [entry.medianAgeHours, entry.maxAgeHours] as const) {
      expect(age === null || (Number.isInteger(age) && (age as number) >= 0)).toBe(true);
    }
    if (entry.count === 0) {
      expect(entry.medianAgeHours).toBeNull();
      expect(entry.maxAgeHours).toBeNull();
    }
    if (entry.medianAgeHours !== null && entry.maxAgeHours !== null) {
      expect(entry.medianAgeHours <= entry.maxAgeHours).toBe(true);
    }
  }
  const total = snapshot.itemsTotal as number;
  expect(total).toBe((snapshot.routedAuto as number) + (snapshot.routedCeo as number));
  expect(total).toBe(byKind.reduce((sum, entry) => sum + entry.count, 0));
}

function item(kind: AttentionItem["kind"], pendingSince: string): AttentionItem {
  return { kind, issueId: "issue-1", identifier: "TOG-1", sourceId: `src-${kind}-${pendingSince}`, pendingSince };
}

describe("sla-metrics shape probe", () => {
  it("fixture matches the frozen endpoint contract", () => {
    assertSlaShape(fixture);
  });

  it("live slaSnapshot reproduces the fixture exactly (plus shadow flag)", () => {
    const items: AttentionItem[] = [
      item("blocker_attention", "2026-10-03T08:00:00Z"), // 10h
      item("blocker_attention", "2026-10-03T12:00:00Z"), // 6h
      item("blocker_attention", "garbage"), // counts, never moves the median
      item("recovery_action", "2026-10-03T10:00:00Z"), // 8h
      item("review", "garbage"), // unknown age: null/null
      item("issue_thread_interaction", "2026-10-03T15:00:00Z"), // 3h
      item("issue_thread_interaction", "2026-10-03T16:00:00Z"), // 2h
      item("failed_run", "2026-10-03T17:00:00Z"), // 1h
      item("approval", "2026-10-03T09:00:00Z"), // 9h
    ];
    const snapshot = slaSnapshot(items, NOW, 2, 6, 3);
    assertSlaShape({ ...snapshot, shadow: true });
    expect({ ...snapshot, shadow: true }).toEqual(fixture);
  });
});
