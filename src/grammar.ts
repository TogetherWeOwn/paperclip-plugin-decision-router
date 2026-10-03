/**
 * CEO decision grammar: the lines the plugin applies from the CEO digest.
 *
 * Provenance note (TOG-13484): the issue asks to "port the grammar from the
 * host router: DECIDE / ANSWER". No such grammar exists in the host — the
 * host scripts (`interaction_route.sh`, `interaction_triage.sh`) decide and
 * explain but deliberately mutate nothing ("A router that could also send
 * would be a way to manufacture approvals"). So DECIDE / ANSWER are defined
 * here, fresh, with RESOLVE / RETRY / APPROVE added per the issue. See
 * docs/GAPS.md gap G-01. Every applied line is recorded in the no-wake CEO
 * digest document; application itself requires `applyMutations: true`
 * (default false — shadow mode).
 *
 * One command per line, `#` starts a comment, blank lines are ignored:
 *
 *   DECIDE <issue-ref> <option-id> [reason...]
 *     Record the CEO's choice for a digest item (option ids are listed in the
 *     digest). Applied via the item's own channel: respondInteraction for
 *     interactions, recovery resolve, approval decide, or a digest comment.
 *   ANSWER <interaction-id> accept|reject [note...]
 *     Respond to an issue-thread interaction as the paired board user
 *     (requires `issue.interactions.respond`; the host re-verifies a live
 *     human member at apply time).
 *   RESOLVE <recovery-action-id> <outcome> [note...]
 *     Resolve a recovery action. Outcome is one of the reconciler outcomes
 *     (see routing.ts RECOVERY_OUTCOMES).
 *   RETRY <run-id | issue-ref> [note...]
 *     Retry a failed run per the retry policy (bounded attempts, backoff).
 *   APPROVE <approval-id> [note...]
 *     Approve a company approval as the paired board user
 *     (requires `approvals.respond`).
 */
export const GRAMMAR_VERBS = ["DECIDE", "ANSWER", "RESOLVE", "RETRY", "APPROVE"] as const;

export type GrammarVerb = (typeof GRAMMAR_VERBS)[number];

export interface GrammarCommand {
  verb: GrammarVerb;
  target: string;
  arg: string | null;
  note: string | null;
  line: number;
}

export interface GrammarError {
  line: number;
  message: string;
}

export interface GrammarParse {
  commands: GrammarCommand[];
  errors: GrammarError[];
}

const MAX_LINE_LENGTH = 1000;

export function parseGrammar(text: string): GrammarParse {
  const commands: GrammarCommand[] = [];
  const errors: GrammarError[] = [];
  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    const line = index + 1;
    const stripped = raw.split("#", 1)[0]?.trim() ?? "";
    if (stripped === "") return;
    if (stripped.length > MAX_LINE_LENGTH) {
      errors.push({ line, message: `line exceeds ${MAX_LINE_LENGTH} characters` });
      return;
    }
    const parts = stripped.split(/\s+/);
    const verb = (parts[0] as string).toUpperCase();
    if (!(GRAMMAR_VERBS as readonly string[]).includes(verb)) {
      errors.push({
        line,
        message: `unknown verb "${parts[0]}" (expected one of ${GRAMMAR_VERBS.join(", ")})`,
      });
      return;
    }
    const target = parts[1];
    if (!target) {
      errors.push({ line, message: `${verb} requires a target (see docs/GRAMMAR.md)` });
      return;
    }
    if (verb === "ANSWER" || verb === "RESOLVE") {
      const arg = parts[2];
      if (!arg) {
        errors.push({ line, message: `${verb} requires an outcome argument (see docs/GRAMMAR.md)` });
        return;
      }
      if (verb === "ANSWER" && arg !== "accept" && arg !== "reject") {
        errors.push({ line, message: `ANSWER outcome must be accept or reject (got "${arg}")` });
        return;
      }
      commands.push({
        verb: verb as GrammarVerb,
        target,
        arg,
        note: parts.slice(3).join(" ") || null,
        line,
      });
      return;
    }
    if (verb === "DECIDE") {
      const arg = parts[2];
      if (!arg) {
        errors.push({ line, message: "DECIDE requires an option-id (see the digest item)" });
        return;
      }
      commands.push({ verb, target, arg, note: parts.slice(3).join(" ") || null, line });
      return;
    }
    // RETRY and APPROVE: target only, rest is a note.
    commands.push({ verb: verb as GrammarVerb, target, arg: null, note: parts.slice(2).join(" ") || null, line });
  });
  return { commands, errors };
}
