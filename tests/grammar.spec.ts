import { describe, expect, it } from "vitest";

import { parseGrammar } from "../src/grammar.js";

describe("parseGrammar", () => {
  it("parses one command per line with notes and comments", () => {
    const parsed = parseGrammar(
      [
        "# CEO decisions 2026-10-03",
        "DECIDE TOG-104 plan-a take the cheap path",
        "",
        "ANSWER ix-1 accept ship it",
        "RESOLVE ra-9 escalate needs owner money",
        "RETRY run-3",
        "APPROVE ap-7",
      ].join("\n"),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.commands.map((command) => command.verb)).toEqual([
      "DECIDE",
      "ANSWER",
      "RESOLVE",
      "RETRY",
      "APPROVE",
    ]);
    expect(parsed.commands[0]).toMatchObject({ target: "TOG-104", arg: "plan-a", note: "take the cheap path" });
    expect(parsed.commands[3]).toMatchObject({ target: "run-3", arg: null, note: null });
  });

  it("rejects unknown verbs", () => {
    const parsed = parseGrammar("DELETE TOG-1");
    expect(parsed.commands).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.message).toContain("unknown verb");
  });

  it("requires a target", () => {
    const parsed = parseGrammar("APPROVE");
    expect(parsed.commands).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
  });

  it("requires ANSWER outcomes to be accept or reject", () => {
    const bad = parseGrammar("ANSWER ix-1 maybe");
    expect(bad.commands).toEqual([]);
    expect(bad.errors).toHaveLength(1);
    const missing = parseGrammar("ANSWER ix-1");
    expect(missing.errors).toHaveLength(1);
  });

  it("requires DECIDE and RESOLVE arguments", () => {
    expect(parseGrammar("DECIDE TOG-1").errors).toHaveLength(1);
    expect(parseGrammar("RESOLVE ra-1").errors).toHaveLength(1);
  });

  it("rejects over-long lines (mirrors the prompt cap)", () => {
    const parsed = parseGrammar(`APPROVE ${"x".repeat(1001)}`);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.message).toContain("exceeds 1000");
  });

  it("records line numbers for every command and error", () => {
    const parsed = parseGrammar("BOGUS x\nAPPROVE ap-1");
    expect(parsed.errors[0]?.line).toBe(1);
    expect(parsed.commands[0]?.line).toBe(2);
  });
});

describe("DECIDE/ANSWER replay fixtures", () => {
  const DECIDE_BLOCK = [
    "# CEO digest decisions 2026-10-05",
    "DECIDE TOG-104 plan-a take the cheap path",
    "DECIDE TOG-207 plan-b needs owner money",
    "",
    "# parked review resolved after the freeze",
    "DECIDE TOG-311 plan-c ship after freeze",
  ].join("\n");

  const ANSWER_BLOCK = [
    "# interaction answers",
    "ANSWER ix-1 accept ship it",
    "ANSWER ix-2 reject needs a human decision",
    "ANSWER ix-3 accept",
  ].join("\n");

  it("replays a digest DECIDE block deterministically", () => {
    const first = parseGrammar(DECIDE_BLOCK);
    expect(first.errors).toEqual([]);
    expect(first.commands.map((command) => command.verb)).toEqual(["DECIDE", "DECIDE", "DECIDE"]);
    expect(first.commands.map((command) => command.target)).toEqual(["TOG-104", "TOG-207", "TOG-311"]);
    expect(first.commands.map((command) => command.arg)).toEqual(["plan-a", "plan-b", "plan-c"]);
    expect(first.commands[0]).toMatchObject({ line: 2, note: "take the cheap path" });
    expect(first.commands[2]).toMatchObject({ line: 6, note: "ship after freeze" });
    // Replay stability: the same digest text parses identically every time.
    expect(parseGrammar(DECIDE_BLOCK)).toEqual(first);
  });

  it("replays a digest ANSWER block (accept + reject) deterministically", () => {
    const first = parseGrammar(ANSWER_BLOCK);
    expect(first.errors).toEqual([]);
    expect(first.commands.map((command) => command.arg)).toEqual(["accept", "reject", "accept"]);
    expect(first.commands[0]).toMatchObject({ target: "ix-1", note: "ship it", line: 2 });
    expect(first.commands[1]).toMatchObject({ target: "ix-2", note: "needs a human decision", line: 3 });
    expect(first.commands[2]).toMatchObject({ target: "ix-3", note: null, line: 4 });
    expect(parseGrammar(ANSWER_BLOCK)).toEqual(first);
  });

  it("replays a mixed DECIDE/ANSWER digest snippet end to end", () => {
    const snippet = [
      "# CEO digest reply 2026-10-05",
      "DECIDE TOG-104 plan-a take the cheap path",
      "",
      "ANSWER ix-1 accept ship it",
      "ANSWER ix-2 reject needs a human decision",
    ].join("\n");
    const parsed = parseGrammar(snippet);
    expect(parsed.errors).toEqual([]);
    expect(parsed.commands.map((command) => command.verb)).toEqual(["DECIDE", "ANSWER", "ANSWER"]);
    expect(parsed.commands.map((command) => command.line)).toEqual([2, 4, 5]);
    // Re-serializing the parsed commands replays to the same verbs/targets/args.
    const replayed = parseGrammar(
      parsed.commands
        .map((command) => `${command.verb} ${command.target}${command.arg ? ` ${command.arg}` : ""}${command.note ? ` ${command.note}` : ""}`)
        .join("\n"),
    );
    expect(replayed.errors).toEqual([]);
    expect(replayed.commands.map((command) => [command.verb, command.target, command.arg, command.note])).toEqual(
      parsed.commands.map((command) => [command.verb, command.target, command.arg, command.note]),
    );
  });
});

describe("malformed-input battery", () => {
  const TRUNCATED_VERBS = [
    "DECI TOG-1 plan-a",
    "DECID TOG-1 plan-a",
    "ANSW ix-1 accept",
    "ANSWE ix-1 accept",
    "RESOL ra-1 resolve",
    "RESOLV ra-1 resolve",
    "APPROV ap-1",
    "RETR run-3",
    "RET run-3",
  ];

  const UNKNOWN_VERBS = [
    "DELETE TOG-1",
    "VOTE ix-1 yes",
    "MERGE TOG-1 plan-a",
    "DECIDE-2 TOG-1 plan-a",
    "ANSWER2 ix-1 accept",
    "decide2 TOG-1 plan-a",
  ];

  it.each(TRUNCATED_VERBS)("truncated verb never yields a command: %s", (input) => {
    const parsed = parseGrammar(input);
    expect(parsed.commands).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.message).toContain("unknown verb");
  });

  it.each(UNKNOWN_VERBS)("unknown verb never yields a command: %s", (input) => {
    const parsed = parseGrammar(input);
    expect(parsed.commands).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.message).toContain("unknown verb");
  });

  it.each(["", "   ", "\n\n", "# only a comment"])("empty payload is a pure skip: %s", (input) => {
    const parsed = parseGrammar(input);
    expect(parsed.commands).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });

  it.each([
    ["DECIDE", "requires a target"],
    ["ANSWER", "requires a target"],
    ["ANSWER ix-1", "requires an outcome"],
    ["ANSWER ix-1 maybe", "must be accept or reject"],
    ["ANSWER ix-1 ACCEPT", "must be accept or reject"],
    ["DECIDE TOG-1", "requires an option-id"],
    ["RESOLVE ra-1", "requires an outcome"],
  ])("incomplete line never yields a command: %s", (input, message) => {
    const parsed = parseGrammar(input as string);
    expect(parsed.commands).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.message).toContain(message as string);
  });

  it("every malformed fixture parses identically twice (deterministic skip)", () => {
    const fixtures = [
      ...TRUNCATED_VERBS,
      ...UNKNOWN_VERBS,
      "",
      "   ",
      "DECIDE",
      "ANSWER ix-1",
      "ANSWER ix-1 maybe",
      "DECIDE TOG-1",
    ];
    for (const fixture of fixtures) {
      expect(parseGrammar(fixture)).toEqual(parseGrammar(fixture));
    }
  });

  it("parsing alone never auto-responds: commands are inert data with no apply intent", () => {
    const parsed = parseGrammar("ANSWER ix-1 accept ship it");
    expect(parsed.errors).toEqual([]);
    expect(parsed.commands).toHaveLength(1);
    expect(Object.keys(parsed.commands[0] ?? {}).sort()).toEqual(["arg", "line", "note", "target", "verb"]);
  });

  it("keeps human_only enforcement downstream: the note changes nothing at parse time", () => {
    const parsed = parseGrammar("ANSWER ix-human accept only a human may answer");
    expect(parsed.errors).toEqual([]);
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.commands[0]).toMatchObject({ verb: "ANSWER", target: "ix-human", arg: "accept" });
    // The parser records the line; the skip lives in the respond planner
    // (human_only never drafts — see human-only-skip.spec.ts).
    expect(Object.keys(parsed.commands[0] ?? {}).sort()).toEqual(["arg", "line", "note", "target", "verb"]);
  });
});
