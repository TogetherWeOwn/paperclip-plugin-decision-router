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
