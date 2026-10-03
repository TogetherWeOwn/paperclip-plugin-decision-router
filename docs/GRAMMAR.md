# CEO decision grammar

One command per line. `#` starts a comment, blank lines are ignored, max 1000
characters per line (mirrors the interaction `prompt` cap).

```text
DECIDE <issue-ref> <option-id> [reason...]
ANSWER <interaction-id> accept|reject [note...]
RESOLVE <recovery-action-id> <outcome> [note...]
RETRY <run-id | issue-ref> [note...]
APPROVE <approval-id> [note...]
```

- `DECIDE` records the CEO's choice for a digest item. Option ids come from the
  digest. Applied through the item's own channel (respondInteraction, recovery
  resolve, approval decide, digest comment).
- `ANSWER` responds to an issue-thread interaction as the paired board user.
  Requires `issue.interactions.respond`; the host re-verifies a live human
  member at apply time.
- `RESOLVE` resolves a recovery action. Outcome is one of the reconciler
  outcomes: `resolve`, `park`, `escalate`.
- `RETRY` retries a failed run under the bounded retry policy (default max 2).
- `APPROVE` approves a company approval as the paired board user. Requires
  `approvals.respond`.

## Provenance

TOG-13484 asks to "port the grammar from the host router: DECIDE / ANSWER".
No such grammar exists in the host: `interaction_route.sh` and
`interaction_triage.sh` decide and explain but deliberately mutate nothing.
The verbs above are defined here, fresh (see gap G-01 in GAPS.md). Every
applied line is recorded in the no-wake `ceo-decision-digest` document.

## Status

Slice 1: parsing only (`src/grammar.ts`, unit-tested). Application is the
cutover slice, behind `applyMutations: true`.
