# Shadow run + cutover (TOG-13484 step 5)

## Shadow (this slice)

The plugin runs beside the host timer with `applyMutations: false` (the
default). Each 5-minute sweep persists routes, the CEO digest document, SLA
metrics, and the last-sweep state record — and mutates nothing. No
`interaction-router.timer` change is needed: there is no host
`ops/paperclip/interaction_router.py` in paperclip-ops-tooling today (only
`interaction_route.sh` / `interaction_triage.sh`, which are read-only
classifiers). The shadow compares against those scripts' verdicts.

Comparison command (run from a checkout with live-board rows):

```sh
# 1. host verdicts (CSV-ish table)
psql -At -f pending.sql | ./interaction_triage.sh classify --json > /tmp/host.json
# 2. plugin verdicts (vitest harness over the same rows)
npm test -- tests/shadow.spec.ts  # reads /tmp/host.json, asserts verdict equality
```

Cutover criterion: plugin triage verdicts match the host scripts on every
row, and the sweep's digest covers all six kinds for two consecutive days.
Then, with owner approval: set `applyMutations: true`, and the operator
retires whatever host timer covers interactions.

## Cutover slice (follow-up)

- Apply deterministic routes (respond/resolve/wakeup/decide/park edge).
- Apply CEO grammar commands from the desk card.
- Backlog clean-up: legacy/parked items get the bulk park-or-resolve policy
  the CEO decides on the first digest.
