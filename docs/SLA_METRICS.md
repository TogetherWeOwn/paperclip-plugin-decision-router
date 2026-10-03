# SLA metrics payload (frozen contract)

Source: `src/metrics.ts` (`slaSnapshot`, `slaMetrics`), served read-only on
the `sla-metrics` data endpoint (`src/worker.ts`, plain `state.get` — no SDK
reads, no mutations, shadow-safe). Pinned example:
`tests/fixtures/sla-metrics.json`. Shape probe:
`tests/sla-metrics-probe.spec.ts` (`npm test -- tests/sla-metrics-probe.spec.ts`).

Source-only: no host install, no Gatus wiring. Fleet deploy stays on the
coverage card; this file owns the plugin-side contract.

## Endpoint

- Key: `sla-metrics` (`DATA_KEYS.slaMetrics`). Param: `companyId` (required).
- Before the first sweep: `{"error": "no sweep yet"}`.
- Missing param: `{"error": "companyId param required"}`.
- After a sweep: the last-sweep state record. Gatus must depend only on the
  contract subset below; sibling state fields (retry memory, per-verb plan
  counts, digest sizes) are informational and may grow without notice.

## Contract subset

| field | type | meaning |
|-------|------|---------|
| `at` | ISO 8601 string | sweep timestamp |
| `scannedIssues` | non-negative integer | open issues scanned this sweep |
| `itemsTotal` | non-negative integer | pending attention items seen |
| `routedAuto` | non-negative integer | items with a deterministic route |
| `routedCeo` | non-negative integer | items falling to the CEO digest |
| `shadow` | boolean | `true` while `applyMutations` is off |
| `byKind` | array, length 6 | one entry per attention kind, always all six |

Invariants: `itemsTotal == routedAuto + routedCeo`,
`itemsTotal == sum(byKind[].count)`.

## `byKind` entry

| field | type | meaning |
|-------|------|---------|
| `kind` | enum string | one of `blocker_attention`, `recovery_action`, `review`, `issue_thread_interaction`, `failed_run`, `approval`, in exactly this order (`ATTENTION_KINDS`) |
| `count` | non-negative integer | pending items of this kind (unknown-age items count) |
| `medianAgeHours` | non-negative integer or `null` | median age in whole hours over items with a known age; `null` when none known |
| `maxAgeHours` | non-negative integer or `null` | max age in whole hours; `null` when none known |

Age semantics (`ageHours`): whole hours, floored, between `pendingSince` and
sweep time. Unparseable or future timestamps yield `null` — never `0`
(absence is not youth). Unknown-age items count toward `count` but never move
the median. `count == 0` implies both ages `null`. When both ages are numbers,
`medianAgeHours <= maxAgeHours`.

## Metric points (same data, `metrics.write` sink)

- `decision_router.attention.count{kind}` — always one point per kind.
- `decision_router.attention.age_median_hours{kind}` — only when median known.
- `decision_router.attention.age_max_hours{kind}` — only when max known.
- `decision_router.sweep.items_total|routed_auto|routed_ceo` — sweep counters.

## Gatus guidance

Scrape `sla-metrics` per company; alert on `byKind` (`count` and
`maxAgeHours` per kind), not on the informational sibling fields. Treat the
`{"error": ...}` sentinels as "no data yet", not as healthy zeros. Changes to
this contract are additive only; removals or reorderings need a new spec
revision and a probe update in the same PR.
