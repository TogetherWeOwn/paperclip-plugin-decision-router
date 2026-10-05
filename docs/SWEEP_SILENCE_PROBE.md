# Sweep-silence probe (frozen contract)

Source: `src/sweepSilence.ts` (`checkSweepSilence`). Pinned fixtures:
`tests/fixtures/sweep-silence.json`. Probe spec:
`tests/sweep-silence-probe.spec.ts` (`npm test -- tests/sweep-silence-probe.spec.ts`).

Source-only: no host install, no Gatus wiring, no alert-route or paging
change. Fleet deploy stays on the coverage card; this file owns the
plugin-side contract. Distinct from roster-staleness and merge-queue probes:
this one watches decision-router sweep-output freshness only.

## Definition

Evaluate the last-sweep record's `at` field (ISO 8601, served read-only on
the `sla-metrics` data endpoint) against `now`:

| input | result |
|-------|--------|
| age (`now - at`) over threshold | `DOWN` — `sweep silence: last sweep {age}s ago exceeds threshold {threshold}s` |
| age within threshold | `UP` — `last sweep {age}s ago within threshold {threshold}s` |
| missing, empty, or unparseable `at` | `DOWN` (`ageSeconds: null`) — absence is not youth |
| future `at` | `UP` with `ageSeconds: 0` — clock skew is not silence |

Result shape: `{ status: "UP" | "DOWN", ageSeconds: number | null, thresholdSeconds: number, reason: string }`.

## Threshold

Default `900`s (15 minutes = 3 missed 5-minute sweeps per
`SWEEP_SCHEDULE`). One missed run stays UP; a dead scheduler trips DOWN
without flapping on a single slow tick. Callers may override per check; the
override is echoed back in `thresholdSeconds`.

## Gatus guidance

Scrape the `sla-metrics` endpoint per company, compute `now - at`, and page
nothing: assert freshness only. Suggested condition on the evaluated result:

```yaml
conditions:
  - "[STATUS] == 200"
  - "[BODY].status == UP"
```

Treat the `{"error": "no sweep yet"}` sentinel as DOWN (no output yet), not
as healthy. Changes to this contract are additive only; threshold changes
need a probe update in the same PR.
