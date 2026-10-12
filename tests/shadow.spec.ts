/**
 * Shadow parity harness for docs/SHADOW.md.
 *
 * Live recipe (run from a checkout with live-board rows):
 *   psql -At -f pending.sql | ./interaction_triage.sh classify --json > /tmp/host.json
 *   SHADOW_ROWS=/tmp/host.json npm test -- tests/shadow.spec.ts
 *
 * `host.json` is an array of rows. Each row carries the classifier input
 * plus the host verdict, e.g.:
 *   {
 *     "identifier": "TOG-1",
 *     "kind": "request_confirmation",
 *     "effectiveResolverPolicy": "board_or_agents",
 *     "createdByAgentId": "agent-creator",
 *     "assigneeAgentId": null,
 *     "addresseeAgentId": null,
 *     "hasToolAction": false,
 *     "issueStatus": "todo",
 *     "namedReviewInteraction": false,
 *     "continuationPolicy": "wake_assignee",
 *     "hostVerdict": "AGENT_RESOLVABLE",
 *     "hostResolvers": ["<any agent except the creator>"],
 *     "hostContinuation": "DEAD_WAKE"
 *   }
 *
 * Accepted aliases: `verdict` for `hostVerdict`, `resolvers`/`host_resolvers`
 * for `hostResolvers`, `continuation` for `hostContinuation`. Verdict strings
 * are normalized case-insensitively (`board-only`/`board_only` → OWNER_ONLY,
 * `agent-resolvable` → AGENT_RESOLVABLE, `inert` → INERT, `malformed` →
 * MALFORMED, `agent-review-verdict` → AGENT_REVIEW_VERDICT).
 *
 * Without the file the live test skips (CI stays green with no live data);
 * the mapping/normalization unit tests below always run. Shadow rule holds:
 * this file never mutates — it only reads rows and asserts verdict equality.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { triageInteraction, type TriageRow, type TriageVerdict } from "../src/triage.js";

export interface HostShadowRow extends TriageRow {
  hostVerdict?: string;
  verdict?: string;
  hostResolvers?: string[];
  resolvers?: string[];
  hostContinuation?: string;
  continuation?: string;
}

const VERDICT_ALIASES: Record<string, TriageVerdict> = {
  AGENT_RESOLVABLE: "AGENT_RESOLVABLE",
  "AGENT-RESOLVABLE": "AGENT_RESOLVABLE",
  AGENT_REVIEW_VERDICT: "AGENT_REVIEW_VERDICT",
  "AGENT-REVIEW-VERDICT": "AGENT_REVIEW_VERDICT",
  REVIEW_VERDICT: "AGENT_REVIEW_VERDICT",
  OWNER_ONLY: "OWNER_ONLY",
  "OWNER-ONLY": "OWNER_ONLY",
  OWNERONLY: "OWNER_ONLY",
  BOARD_ONLY: "OWNER_ONLY",
  "BOARD-ONLY": "OWNER_ONLY",
  BOARDONLY: "OWNER_ONLY",
  INERT: "INERT",
  MALFORMED: "MALFORMED",
};

export function normalizeVerdict(raw: unknown): TriageVerdict | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toUpperCase().replace(/[\s_]+/g, "_").replace(/-+/g, "-");
  const dashKey = raw.trim().toUpperCase().replace(/[\s_]+/g, "-");
  return VERDICT_ALIASES[key] ?? VERDICT_ALIASES[dashKey] ?? null;
}

export function toTriageRow(host: HostShadowRow): TriageRow {
  const {
    hostVerdict: _hv,
    verdict: _v,
    hostResolvers: _hr,
    resolvers: _r,
    hostContinuation: _hc,
    continuation: _c,
    ...row
  } = host;
  return row;
}

export function hostExpectation(host: HostShadowRow): {
  verdict: TriageVerdict | null;
  resolvers: string[] | null;
  continuation: string | null;
} {
  const verdict = normalizeVerdict(host.hostVerdict ?? host.verdict ?? null);
  const resolvers = host.hostResolvers ?? host.resolvers ?? null;
  const continuation = host.hostContinuation ?? host.continuation ?? null;
  return {
    verdict,
    resolvers: Array.isArray(resolvers) ? resolvers : null,
    continuation: typeof continuation === "string" ? continuation : null,
  };
}

export function compareRow(host: HostShadowRow): string | null {
  const expected = hostExpectation(host);
  if (expected.verdict === null) {
    return `${host.identifier || "(no identifier)"}: no parsable host verdict`;
  }
  const actual = triageInteraction(toTriageRow(host));
  if (actual.verdict !== expected.verdict) {
    return `${actual.identifier}: plugin ${actual.verdict} != host ${expected.verdict} (${actual.why})`;
  }
  if (expected.resolvers !== null) {
    const a = [...actual.resolvers].sort();
    const e = [...expected.resolvers].sort();
    if (JSON.stringify(a) !== JSON.stringify(e)) {
      return `${actual.identifier}: plugin resolvers ${JSON.stringify(a)} != host ${JSON.stringify(e)}`;
    }
  }
  if (expected.continuation !== null && actual.continuation !== expected.continuation) {
    return `${actual.identifier}: plugin continuation ${actual.continuation} != host ${expected.continuation} (${actual.continuationWhy})`;
  }
  return null;
}

export function rowsPath(): string {
  return process.env.SHADOW_ROWS ?? "/tmp/host.json";
}

function loadHostRows(): HostShadowRow[] | null {
  const path = rowsPath();
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`shadow rows at ${path} must be a JSON array`);
  return parsed as HostShadowRow[];
}

describe("shadow parity harness", () => {
  it("normalizes host verdict aliases to plugin verdicts", () => {
    expect(normalizeVerdict("AGENT_RESOLVABLE")).toBe("AGENT_RESOLVABLE");
    expect(normalizeVerdict("agent-resolvable")).toBe("AGENT_RESOLVABLE");
    expect(normalizeVerdict("board-only")).toBe("OWNER_ONLY");
    expect(normalizeVerdict("board_only")).toBe("OWNER_ONLY");
    expect(normalizeVerdict("OWNER_ONLY")).toBe("OWNER_ONLY");
    expect(normalizeVerdict("inert")).toBe("INERT");
    expect(normalizeVerdict("malformed")).toBe("MALFORMED");
    expect(normalizeVerdict("agent-review-verdict")).toBe("AGENT_REVIEW_VERDICT");
    expect(normalizeVerdict("nonsense")).toBeNull();
    expect(normalizeVerdict(null)).toBeNull();
  });

  it("matches a synthetic host row through the real triage classifier", () => {
    const host: HostShadowRow = {
      identifier: "TOG-synth-1",
      kind: "request_confirmation",
      effectiveResolverPolicy: "board_or_agents",
      createdByAgentId: "agent-creator",
      assigneeAgentId: "agent-a",
      continuationPolicy: "wake_assignee",
      issueStatus: "todo",
      hostVerdict: "AGENT_RESOLVABLE",
      hostResolvers: ["agent-a"],
      hostContinuation: "WAKES",
    };
    expect(compareRow(host)).toBeNull();
  });

  it("reports a verdict mismatch instead of passing silently", () => {
    const host: HostShadowRow = {
      identifier: "TOG-synth-2",
      kind: "request_confirmation",
      effectiveResolverPolicy: "board_or_agents",
      createdByAgentId: "agent-a",
      assigneeAgentId: "agent-a",
      continuationPolicy: "wake_assignee",
      issueStatus: "todo",
      hostVerdict: "AGENT_RESOLVABLE",
    };
    const mismatch = compareRow(host);
    expect(mismatch).toContain("TOG-synth-2");
    expect(mismatch).toContain("INERT");
  });

  it("matches every live-board row when SHADOW_ROWS is present, else skips", () => {
    const rows = loadHostRows();
    if (rows === null) {
      console.log(`shadow parity: no live rows at ${rowsPath()} — skipping (synthetic checks above still ran)`);
      return;
    }
    expect(rows.length).toBeGreaterThan(0);
    const mismatches = rows.map(compareRow).filter((m): m is string => m !== null);
    expect(mismatches).toEqual([]);
  });
});
