/**
 * Host capability gaps: attention sources the plugin SDK cannot read today.
 *
 * Per TOG-13484: "If a host capability is missing for any source, list the
 * exact gap and file an upstream-shaped issue (via the TOG-13346 ledger).
 * Don't fork." Each gap below names the Decisions-page source, what the SDK
 * offers instead, the slice-1 workaround, and the ledger reference. The full
 * ledger lives in docs/GAPS.md.
 */
export interface HostCapabilityGap {
  id: string;
  source: string;
  needed: string;
  sdkToday: string;
  slice1Workaround: string;
  ledgerRef: string;
}

export const HOST_CAPABILITY_GAPS: HostCapabilityGap[] = [
  {
    id: "G-01",
    source: "host decision grammar (DECIDE / ANSWER)",
    needed: "A recorded, replayable decision grammar the plugin applies.",
    sdkToday: "No host grammar exists: interaction_route.sh / interaction_triage.sh decide and explain but deliberately mutate nothing.",
    slice1Workaround: "Grammar defined fresh in src/grammar.ts + docs/GRAMMAR.md; applications recorded in the CEO digest document.",
    ledgerRef: "TOG-13346 (upstream-shaped: decision-grammar record/replay)",
  },
  {
    id: "G-02",
    source: "recovery actions (GET /issues/:id/recovery-actions)",
    needed: "List + resolve recovery actions (missing_disposition, stranded_assigned_issue, watchdog, liveness).",
    sdkToday: "No SDK method. issues.orchestration.read covers runs/approvals/relations/costs, not recovery actions.",
    slice1Workaround: "Recovery items enter the sweep only via seeded/board-supplied rows; deterministic route defaults to the reconciler outcome until a read path exists.",
    ledgerRef: "TOG-13346 (upstream-shaped: recovery-actions read/resolve for plugins)",
  },
  {
    id: "G-03",
    source: "blocker diagnostics (attention feed classification)",
    needed: "Stalled/unresolved/attention blocker classification per issue.",
    sdkToday: "issue.relations.read gives raw edges; the attention classification is board-only.",
    slice1Workaround: "Raw edges + focus-set membership drive the blocker rule (owner vs park); no stalled-vs-attention split yet.",
    ledgerRef: "TOG-13346 (upstream-shaped: blocker diagnostics for plugins)",
  },
  {
    id: "G-04",
    source: "review state (which issues await a review path choice)",
    needed: "Read review attention: pending review verdicts + reviewInteractionId linkage.",
    sdkToday: "No review-state read capability; listInteractions rows do not carry the named-review linkage (caller-asserted in triage).",
    slice1Workaround: "Reviews route to the Code Reviewer by kind; review-verdict bypass stays fail-closed (namedReviewInteraction defaults false).",
    ledgerRef: "TOG-13346 (upstream-shaped: review-state read for plugins)",
  },
  {
    id: "G-05",
    source: "failed runs (retry)",
    needed: "List failed heartbeat runs + bounded retry trigger.",
    sdkToday: "issues.orchestration.read exposes run summaries; retry needs issues.wakeup/issues.update, which the manifest deliberately does not yet request.",
    slice1Workaround: "Retry destinations are computed (attempt n of max) and recorded in shadow mode; no wakeup is fired until the cutover slice.",
    ledgerRef: "TOG-13346 (upstream-shaped: failed-run retry for plugins)",
  },
  {
    id: "G-06",
    source: "Decisions-page feed itself (board attention feed)",
    needed: "Read the ranked board attention feed agents cannot see.",
    sdkToday: "Board-only. No plugin capability exposes it; the plugin rebuilds it per-issue from SDK reads.",
    slice1Workaround: "Per-issue sweep (listInteractions + relations + orchestration) reconstructs the feed without the board ranking.",
    ledgerRef: "TOG-13346 (upstream-shaped: attention-feed read for the CEO desk)",
  },
];
