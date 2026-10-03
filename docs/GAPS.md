# Host capability gaps (TOG-13484 step 1)

If a host capability is missing for any Decisions-page source, the issue
requires: list the exact gap and file an upstream-shaped issue via the
TOG-13346 ledger. Don't fork. Machine-readable list: `src/gaps.ts`
(`HOST_CAPABILITY_GAPS`, ids G-01…G-06).

| id | source | workaround in slice 1 |
|----|--------|------------------------|
| G-01 | host decision grammar (DECIDE / ANSWER) | defined fresh in `src/grammar.ts`; see GRAMMAR.md provenance |
| G-02 | recovery actions list/resolve | read via relation-edge `activeRecoveryAction` summaries; standalone list/resolve missing |
| G-03 | blocker diagnostics (attention classification) | raw edges + focus-set membership drive owner-vs-park |
| G-04 | review state read | reviews route to the Code Reviewer by kind; review-verdict bypass fails closed |
| G-05 | failed-run retry trigger | retry plans (fire/propose/defer/skip) with backoff + idempotent keys; handler fires only behind applyMutations, capability still absent |
| G-06 | Decisions-page feed itself (board-only) | per-issue sweep rebuilds the feed without the board ranking |

## Ledger

Upstream-shaped issues to file via the TOG-13346 ledger (one per gap):
decision-grammar record/replay; recovery-actions read/resolve for plugins;
blocker diagnostics for plugins; review-state read for plugins; failed-run
retry for plugins; attention-feed read for the CEO desk.

Status slice 1: gaps listed here and in `src/gaps.ts`; ledger filing is a
follow-up slice once the shadow sweep has real comparison data to attach.
