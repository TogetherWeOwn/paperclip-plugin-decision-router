/**
 * Shadow parity harness for docs/SHADOW.md.
 *
 * Live recipe (run from a checkout with live-board rows):
 *   psql -At -f pending.sql > /tmp/pending.json
 *   ./interaction_triage.sh classify --json < /tmp/pending.json > /tmp/host.json
 *   SHADOW_INPUT=/tmp/pending.json SHADOW_ROWS=/tmp/host.json npm test -- tests/shadow.spec.ts
 *
 * Two files, joined by `identifier`:
 * - `SHADOW_INPUT` (default `/tmp/pending.json`): the classifier input array
 *   (the `pending.sql` output). Each row carries the classifier inputs
 *   (`kind`, `effectiveResolverPolicy`, `createdByAgentId`, ...), e.g.:
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
 *     "continuationPolicy": "wake_assignee"
 *   }
 * - `SHADOW_ROWS` (default `/tmp/host.json`): the host `classify --json`
 *   output, which is NDJSON (one object per row), each object holding only
 *   the verdict fields (`identifier`, `verdict`, `why`, `resolvers`,
 *   `warnings`, `continuation`, `continuationWhy`), e.g.:
 *   {"identifier":"TOG-1","verdict":"AGENT_RESOLVABLE","why":"...","resolvers":["agent-a"],"warnings":[],"continuation":"WAKES","continuationWhy":"..."}
 *
 * The host output never repeats the classifier inputs, so the loader joins
 * the two files by `identifier` and fails loudly on a missing or duplicate
 * identifier or a row-count mismatch. A single-file `host.json` array in the
 * old combined input+verdict shape is NOT accepted: it is a shape the host
 * never emits.
 *
 * Accepted aliases for the joined expectation: `verdict` for `hostVerdict`,
 * `resolvers`/`host_resolvers` for `hostResolvers`, `continuation` for
 * `hostContinuation`. Verdict strings are normalized case-insensitively
 * (`board-only`/`board_only` → OWNER_ONLY, `agent-resolvable` →
 * AGENT_RESOLVABLE, `inert` → INERT, `malformed` → MALFORMED,
 * `agent-review-verdict` → AGENT_REVIEW_VERDICT).
 *
 * Without live inputs the live test skips (CI stays green with no live
 * data); an explicitly set `SHADOW_INPUT`/`SHADOW_ROWS` pointing at a
 * missing file throws instead of passing silently. The
 * mapping/normalization unit tests below always run. Shadow rule holds:
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

/** A single host `classify --json` NDJSON line: verdict fields only. */
export interface HostVerdictRow {
  identifier: string;
  verdict?: string;
  hostVerdict?: string;
  why?: string;
  resolvers?: string[];
  hostResolvers?: string[];
  warnings?: string[];
  continuation?: string;
  hostContinuation?: string;
  continuationWhy?: string;
  [key: string]: unknown;
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

export function inputPath(): string {
  return process.env.SHADOW_INPUT ?? "/tmp/pending.json";
}

export function rowsPath(): string {
  return process.env.SHADOW_ROWS ?? "/tmp/host.json";
}

/**
 * Parse host `classify --json` output: NDJSON, one object per row.
 * Blank lines are ignored so a trailing newline is fine. An empty file
 * (empty board) yields zero rows — the live test then fails on the
 * `rows.length > 0` assertion rather than passing silently.
 */
export function parseHostNdjson(text: string, path: string): HostVerdictRow[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as HostVerdictRow;
    } catch {
      throw new Error(
        `shadow host rows at ${path} line ${index + 1} must be JSON (NDJSON, one object per row)`,
      );
    }
  });
}

/**
 * Parse the classifier input file: a JSON array of rows (the `pending.sql`
 * output). A single JSON object is accepted as a one-row board; an empty
 * file yields zero rows.
 */
export function parseInputArray(text: string, path: string): TriageRow[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`shadow inputs at ${path} must be a JSON array`);
  }
  if (Array.isArray(parsed)) return parsed as TriageRow[];
  if (typeof parsed === "object" && parsed !== null) return [parsed as TriageRow];
  throw new Error(`shadow inputs at ${path} must be a JSON array`);
}

/**
 * Join classifier inputs with host verdicts by `identifier`. Fails loudly
 * on a missing or duplicate identifier on either side, or on a row-count
 * mismatch (an input row with no host verdict, or a host verdict with no
 * input row).
 */
export function joinRows(
  inputs: TriageRow[],
  verdicts: HostVerdictRow[],
  opts?: { inputPath?: string; rowsPath?: string },
): HostShadowRow[] {
  const inLabel = opts?.inputPath ?? inputPath();
  const rowsLabel = opts?.rowsPath ?? rowsPath();
  const byInput = new Map<string, TriageRow>();
  for (const row of inputs) {
    const id = (row as { identifier?: unknown }).identifier;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`shadow inputs at ${inLabel} contain a row with no identifier`);
    }
    if (byInput.has(id)) {
      throw new Error(`shadow inputs at ${inLabel} contain duplicate identifier ${id}`);
    }
    byInput.set(id, row);
  }
  const byVerdict = new Map<string, HostVerdictRow>();
  for (const row of verdicts) {
    const id = row.identifier;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`shadow host rows at ${rowsLabel} contain a row with no identifier`);
    }
    if (byVerdict.has(id)) {
      throw new Error(`shadow host rows at ${rowsLabel} contain duplicate identifier ${id}`);
    }
    byVerdict.set(id, row);
  }
  const missing = [...byInput.keys()].filter((id) => !byVerdict.has(id));
  const extra = [...byVerdict.keys()].filter((id) => !byInput.has(id));
  if (missing.length > 0 || extra.length > 0 || byInput.size !== byVerdict.size) {
    const detail = [
      `inputs=${byInput.size} host=${byVerdict.size}`,
      missing.length > 0 ? `no host verdict for: ${missing.slice(0, 5).join(", ")}` : "",
      extra.length > 0 ? `no classifier input for: ${extra.slice(0, 5).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(`shadow row-count mismatch (${detail})`);
  }
  return [...byInput.entries()].map(([id, row]) => {
    const verdict = byVerdict.get(id) as HostVerdictRow;
    return {
      ...row,
      hostVerdict: verdict.verdict ?? verdict.hostVerdict,
      hostResolvers: verdict.resolvers ?? verdict.hostResolvers,
      hostContinuation: verdict.continuation ?? verdict.hostContinuation,
    };
  });
}

function loadHostRows(): HostShadowRow[] | null {
  const inP = inputPath();
  const rowsP = rowsPath();
  const explicit = process.env.SHADOW_INPUT !== undefined || process.env.SHADOW_ROWS !== undefined;
  const inExists = existsSync(inP);
  const rowsExists = existsSync(rowsP);
  if (!inExists || !rowsExists) {
    const missing = [!inExists ? inP : "", !rowsExists ? rowsP : ""].filter(Boolean);
    if (explicit) {
      throw new Error(
        `shadow live inputs missing: ${missing.join(", ")} ` +
          `(SHADOW_INPUT=${inP} SHADOW_ROWS=${rowsP}) — refusing to pass silently`,
      );
    }
    return null;
  }
  const inputs = parseInputArray(readFileSync(inP, "utf8"), inP);
  const verdicts = parseHostNdjson(readFileSync(rowsP, "utf8"), rowsP);
  return joinRows(inputs, verdicts, { inputPath: inP, rowsPath: rowsP });
}

/**
 * Skip the live test only when the operator never set live inputs and the
 * defaults are absent. An explicitly set path is never a skip: the loader
 * throws on it, so a typo'd path fails instead of reading as green.
 */
function shouldSkipLive(): boolean {
  if (process.env.SHADOW_INPUT !== undefined || process.env.SHADOW_ROWS !== undefined) return false;
  return !existsSync(inputPath()) || !existsSync(rowsPath());
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

  it("joins classifier inputs with NDJSON host verdicts by identifier", () => {
    const inputs: TriageRow[] = [
      {
        identifier: "TOG-join-1",
        kind: "request_confirmation",
        effectiveResolverPolicy: "board_or_agents",
        createdByAgentId: "agent-creator",
        assigneeAgentId: "agent-a",
        continuationPolicy: "wake_assignee",
        issueStatus: "todo",
      },
    ];
    // Actual host output shape: verdict fields only, no classifier inputs.
    const hostNdjson = [
      '{"identifier":"TOG-join-1","verdict":"AGENT_RESOLVABLE","why":"assignee can answer","resolvers":["agent-a"],"warnings":[],"continuation":"WAKES","continuationWhy":"assignee present and issue open"}',
    ].join("\n");
    const verdicts = parseHostNdjson(hostNdjson, "<fixture>");
    const joined = joinRows(inputs, verdicts, { inputPath: "<fixture-in>", rowsPath: "<fixture-host>" });
    expect(joined).toHaveLength(1);
    const first = joined[0] as HostShadowRow;
    expect(first.kind).toBe("request_confirmation");
    expect(first.hostVerdict).toBe("AGENT_RESOLVABLE");
    expect(compareRow(first)).toBeNull();
  });

  it("parses multi-row NDJSON that JSON.parse alone rejects", () => {
    const hostNdjson = [
      '{"identifier":"TOG-nd-1","verdict":"INERT","why":"a","resolvers":[],"warnings":[],"continuation":"DEAD_WAKE","continuationWhy":"b"}',
      '{"identifier":"TOG-nd-2","verdict":"INERT","why":"a","resolvers":[],"warnings":[],"continuation":"DEAD_WAKE","continuationWhy":"b"}',
      "",
    ].join("\n");
    // Proves the old failure mode is gone: JSON.parse throws on this input.
    expect(() => JSON.parse(hostNdjson)).toThrow(SyntaxError);
    expect(parseHostNdjson(hostNdjson, "<fixture>")).toHaveLength(2);
  });

  it("fails the join on duplicate, missing, or mismatched identifiers", () => {
    const input: TriageRow = {
      identifier: "TOG-join-x",
      kind: "request_confirmation",
      effectiveResolverPolicy: "board_or_agents",
      createdByAgentId: "agent-creator",
      assigneeAgentId: "agent-a",
      continuationPolicy: "wake_assignee",
      issueStatus: "todo",
    };
    const verdict: HostVerdictRow = { identifier: "TOG-join-x", verdict: "AGENT_RESOLVABLE" };
    expect(() => joinRows([input, input], [verdict])).toThrow(/duplicate identifier/);
    expect(() => joinRows([input], [verdict, { identifier: "TOG-other", verdict: "INERT" }])).toThrow(
      /row-count mismatch/,
    );
    expect(() => joinRows([input], [{ identifier: "TOG-other", verdict: "INERT" }])).toThrow(
      /row-count mismatch/,
    );
  });

  it("throws when SHADOW_ROWS is set explicitly and the file is missing", () => {
    const prev = process.env.SHADOW_ROWS;
    const prevInput = process.env.SHADOW_INPUT;
    try {
      process.env.SHADOW_INPUT = "/tmp/pending.json";
      process.env.SHADOW_ROWS = "/tmp/does-not-exist-shadow-harness.json";
      expect(() => loadHostRows()).toThrow(/refusing to pass silently/);
    } finally {
      if (prev === undefined) delete process.env.SHADOW_ROWS;
      else process.env.SHADOW_ROWS = prev;
      if (prevInput === undefined) delete process.env.SHADOW_INPUT;
      else process.env.SHADOW_INPUT = prevInput;
    }
  });

  it.skipIf(shouldSkipLive())("matches every live-board row from the joined inputs", () => {
    const rows = loadHostRows();
    // shouldSkipLive() is false here, so both files exist; a null return
    // would mean the loader changed contract — fail, never skip.
    expect(rows).not.toBeNull();
    expect(rows?.length).toBeGreaterThan(0);
    const mismatches = (rows ?? []).map(compareRow).filter((m): m is string => m !== null);
    expect(mismatches).toEqual([]);
  });
});
