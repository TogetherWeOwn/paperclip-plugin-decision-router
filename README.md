# paperclip-plugin-decision-router

Paperclip plugin: no approval request sits unanswered. Every Decisions-page
item — interactions, recovery actions, blockers, reviews, failed runs,
approvals — is routed deterministically first; the rest lands on the CEO desk
as one digest with an applicable decision grammar.

Status: slice 1 (shadow mode). The 5-minute sweep computes routes, writes the
CEO digest document, and records SLA metrics — and mutates nothing. See
`docs/SHADOW.md` for the shadow-run comparison and cutover criterion,
`docs/GRAMMAR.md` for the decision grammar, `docs/GAPS.md` for host
capability gaps filed via the TOG-13346 ledger.

## Develop

```sh
npm install
npm run verify   # typecheck + tests + build
```

## Configure (operator)

```json
{
  "ceoDeskIssueId": "<CEO desk card issue id>",
  "codeReviewerAgentId": "<Code Reviewer agent id>",
  "focusAnchorIssueId": "<focus anchor issue id, optional>",
  "sweepPageSize": 50,
  "maxRetryAttempts": 2,
  "applyMutations": false
}
```

Leave `applyMutations: false` until the cutover slice. Setting it `true`
makes sweeps mutate (respond/resolve/wakeup/decide) — owner approval required.

## Scrape (Gatus)

Each sweep writes `decision_router.attention.count{kind}`,
`decision_router.attention.age_median_hours{kind}` and
`decision_router.attention.age_max_hours{kind}` via `metrics.write`, and stores
the same snapshot on the `sla-metrics` data endpoint (read-only `state.get`,
no new capabilities). Gatus scrapes the endpoint per company and alerts on
`byKind`:

```json
{ "at": "2026-10-03T18:00:00.000Z", "shadow": true, "byKind": [
  { "kind": "blocker_attention", "count": 2, "medianAgeHours": 8, "maxAgeHours": 10 }
]}
```

All six kinds are always present (zero-counts included); ages are `null` when
no item has a known age. Before the first sweep the endpoint returns
`{"error": "no sweep yet"}`. Frozen payload contract: `docs/SLA_METRICS.md`,
pinned example `tests/fixtures/sla-metrics.json`, shape probe
`tests/sla-metrics-probe.spec.ts`.

Sweep-output freshness (the digest timestamp itself) has its own source-only
probe: `src/sweepSilence.ts` reads DOWN when the last-sweep `at` age exceeds
its threshold (default 15 minutes), UP otherwise; it pages nothing and
changes no alert route. Frozen contract: `docs/SWEEP_SILENCE_PROBE.md`,
pinned fixtures `tests/fixtures/sweep-silence.json`, probe spec
`tests/sweep-silence-probe.spec.ts`.
