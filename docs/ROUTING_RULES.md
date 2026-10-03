# Decisions-page routing rule pack (prompt side)

Prompt-side companion to the deterministic router in `src/routing.ts`.
No code, no behavior change: this pack maps each Decisions-page item type
to its route and resolution so prompt authors, evaluators, and the CEO-digest
reader share one vocabulary. Normative routing stays in `src/routing.ts` +
unit tests; on any conflict the code wins and this doc gets a follow-up fix.

Source taxonomy: the six attention kinds in `src/attention.ts`. Each kind
names the verb that clears it.

| kind | verb | deterministic route | resolution channel |
|------|------|---------------------|--------------------|
| `review` | choose review path | auto → Code Reviewer | review handoff; exact-head review path stays intact |
| `blocker_attention` | unblock | auto → blocker owner, else auto → park, else CEO digest | owner wakeup; park edge to the focus anchor; digest `DECIDE` |
| `recovery_action` | resolve | auto → reconciler (`resolve`) | reconciler policy; `RESOLVE <id> resolve\|park\|escalate` |
| `failed_run` | retry | auto → retry (`attempt/max`), else CEO digest | bounded retry (default max 2); `RETRY <run-id>` |
| `issue_thread_interaction` | respond/accept | CEO digest | digest `ANSWER <interaction-id> accept\|reject`; triage verdict rides along |
| `approval` | approve | CEO digest | digest `APPROVE <approval-id>` |

## Precedence (first match wins)

Mirror of `routeAttention` gate order:

- **R-00 owner-reserved.** Spend, credentials, org structure, reversals of
  stated owner preference, public commitments: NEVER auto-routed to an
  agent. Goes to the CEO digest as a decision brief.
- **R-01 human capability.** Items needing a human capability, not a
  decision, go to the CEO digest as a work order.
- **R-02 kind rules R-10…R-60 below.**

## Kind rules

### R-10 review → Code Reviewer

All `review` items route auto to the configured Code Reviewer agent id.
No triage, no retry, no park. Rationale: the exact-head review path
(reviewer ≠ author, green CI on the head SHA) must stay intact, so reviews
never wait on the digest.

- Route: `{ "type": "code-reviewer" }`.
- Grammar: none (review completes through the review handoff).
- Digest line: `auto → Code Reviewer; reviews go to the Code Reviewer`.
- Fixture: `fixtures/routing-rules/review.json`.

### R-20 blocker_attention → owner, park, or digest

- In focus + known owner → `{ "type": "blocker-owner", "agentId": "<owner>" }`.
  Owner is the blocked issue's assignee.
- Out of focus + focus anchor configured →
  `{ "type": "park", "focusAnchorIssueId": "<anchor>" }` with a relation edge
  to the anchor.
- Out of focus + no anchor → CEO digest
  (`out-of-focus blocker with no focus anchor configured`).
- In focus + no known owner → CEO digest
  (`in-focus blocker with no known owner`).
- Grammar on digest: `DECIDE <issue-ref> <option-id>`.
- Fixtures: `blocker-attention.in-focus.json`,
  `blocker-attention.out-of-focus-park.json`,
  `blocker-attention.no-owner.json`.

### R-30 recovery_action → reconciler

Default outcome is `resolve` per the reconciler policy. `park` / `escalate`
arrive via the CEO grammar once live reads land; the prompt side never
invents a new outcome.

- Route: `{ "type": "reconciler", "outcome": "resolve" }`.
- Grammar: `RESOLVE <recovery-action-id> resolve|park|escalate [note]`.
- Fixture: `recovery-action.json`.

### R-40 failed_run → bounded retry, then digest

Attempt = recorded attempts for the run id + 1. While attempt ≤ max
(default 2) the route is `{ "type": "retry", "attempt": n,
"maxAttempts": max }`. Past the bound the item goes to the CEO digest
(`failed run exhausted N retries — needs a decision`).

- Grammar: `RETRY <run-id> [note]`.
- Fixtures: `failed-run.retry.json`, `failed-run.exhausted.json`.

### R-50 issue_thread_interaction → CEO digest with triage

Interactions are never auto-answered. Every digest line carries the triage
verdict so the reader knows WHO could answer it today:

- `AGENT_RESOLVABLE` — an agent (named resolvers) may answer; digest still
  decides via `ANSWER`.
- `AGENT_REVIEW_VERDICT` — in-review item named as the review interaction;
  policy check bypassed.
- `OWNER_ONLY` — board-only (tool-action confirmations always; other
  policies without a review bypass).
- `INERT` — no agent can resolve (assignee/creator bar); a board user can.
- `MALFORMED` — row missing required fields; never reads as "nothing wrong".
- Continuation (`WAKES` / `WAKES_ON_ACCEPT` / `DEAD_WAKE` /
  `NO_WAKE_REQUESTED` / `UNKNOWN`) tells whether an answer starts any work.
- Grammar: `ANSWER <interaction-id> accept|reject [note]`.
- Fixture: `issue-thread-interaction.json`.

### R-60 approval → CEO digest

Approvals are never auto-decided. Company-scope approvals (no linked issue)
are still swept and digested.

- Route: `{ "type": "ceo-digest" }`.
- Grammar: `APPROVE <approval-id> [note]`.
- Fixture: `approval.json`.

### R-70 edge: owner-reserved override

Any kind with the owner-reserved predicate true → CEO digest as a decision
brief, even `review`. Fixture: `edge.owner-reserved.json`.

## Coverage gaps vs the Decisions page

Full ledger: `docs/GAPS.md` (ids G-01…G-06). Prompt-side impact:

- **G-01 decision grammar.** The grammar here (`DECIDE`/`ANSWER`/`RESOLVE`/
  `RETRY`/`APPROVE`, `docs/GRAMMAR.md`) is defined fresh in this repo. No
  host grammar to port; host scripts decide and explain but mutate nothing.
- **G-02 recovery reads.** No standalone list/resolve capability; sweep
  reads relation-edge summaries. Pack assumes seeded rows; `park`/`escalate`
  only via grammar.
- **G-03 blocker diagnostics.** No stalled-vs-attention split; rule uses raw
  edges + focus-set membership (owner vs park). No age-based escalation in
  the pack.
- **G-04 review state.** No review-state read; reviews route by kind and the
  review-verdict bypass fails closed. Pack cannot express "awaiting review
  path choice" beyond kind = `review`.
- **G-05 failed-run retry.** Retry destinations computed and recorded; no
  trigger fires in shadow mode. Pack records intent only.
- **G-06 feed ranking.** The board ranking is board-only; the sweep rebuilds
  the feed per issue without ranking. Pack order (code review → blocker →
  recovery → retry → digest) is sweep order, not board priority.

## Fixtures

Machine-readable examples under `fixtures/routing-rules/`, one per rule
above. Each fixture: `{ "kind", "rule", "item", "context", "expect",
"grammar" }`. `context` uses the `RoutingContext` shape from
`src/routing.ts` with placeholder ids (`agent-reviewer`, `agent-owner`,
`issue-focus`); `expect` is the exact `RouteDestination` the router returns.
Prompt/eval harnesses may load these as golden rows.

## Use

- Prompt authors: quote the R-10…R-70 line for the kind at hand; never
  restate routes in own words.
- Evaluators: before/after on the fixtures after any bundle or model change.
- Digest readers: the backticked stub on each digest line is the command to
  edit into a decision; stubs are inert until the cutover slice
  (`applyMutations: true`, owner-approved).

## Status

Shadow slice: routes computed, digest recorded, nothing applied. Application
(respond / resolve / wakeup / decide / park edge) is the cutover slice.
