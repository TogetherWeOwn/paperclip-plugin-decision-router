/**
 * `budget_alert` route verb: validate a budget-alert attention row and plan it
 * as a digest proposal — behind the existing `applyMutations` flag (default
 * off).
 *
 * Pure planning only — this module NEVER mutates. Budget alerts have no SDK
 * read path (gap G-07): rows arrive caller-supplied via `extraItems`, the same
 * ingress as `review` rows (gap G-04). Each plan carries a stable idempotency
 * key (`budget-alert:<alert-id>`) so a retry, a re-sweep, or a duplicate
 * caller row proposes the same alert at most once. When `applyMutations` is
 * false (shadow default) plans come back as `mode: "propose"` — recorded in
 * the sweep result and the last-sweep state, nothing applied. `mode: "apply"`
 * only marks the live intent the cutover slice may act on once a budget
 * decision capability exists; there is still no live call on this path, and
 * the manifest deliberately requests no mutation capability until cutover.
 *
 * Budget alerts route to the CEO digest (`routing.ts`): spend-adjacent items
 * are never auto-routed to an agent. The proposal carries the validated
 * severity so the digest can say HOW URGENT the alert is. Skip paths fail
 * closed: malformed rows, ungraded severities, non-attention statuses,
 * resolved history, and duplicate keys never propose.
 */
export interface BudgetAlertRouteInput {
  /** Stable budget-alert row id (the attention item `sourceId`). */
  id: string;
  /** Issue the alert belongs to. */
  issueId: string;
  /** Graded severity; null/unknown never proposes (fail closed). */
  severity: string | null;
  /** Alert status; only attention statuses propose (see ATTENTION_STATUSES). */
  status: string;
}

export type BudgetAlertDecision = "propose" | "skip";

/** Plan mode: propose-only in shadow, live intent behind `applyMutations`. */
export type BudgetAlertPlanMode = "propose" | "apply";

export interface BudgetAlertPlan {
  alertId: string;
  issueId: string;
  decision: BudgetAlertDecision;
  /** Validated severity for `propose`, null for `skip`. */
  severity: string | null;
  mode: BudgetAlertPlanMode;
  /** Stable across sweeps: `budget-alert:<alert-id>`. */
  idempotencyKey: string;
  reason: string;
}

export interface PlanBudgetAlertOptions {
  /** From `DecisionRouterConfig.applyMutations` (default false → propose). */
  applyMutations: boolean;
  /** Keys already planned this process (or a prior sweep page). Duplicates skip. */
  seenKeys?: Set<string> | readonly string[];
}

/** Severities worth waking the digest over. Anything else is ungraded. */
const KNOWN_SEVERITIES = new Set(["info", "warning", "critical"]);

/**
 * Alert statuses that still need attention. Resolved-family statuses are
 * history and never re-propose; anything unrecognized fails closed.
 */
const ATTENTION_STATUSES = new Set(["triggered", "active", "acknowledged"]);

/** Stable idempotency key for one budget-alert row. */
export function budgetAlertIdempotencyKey(alertId: string): string {
  return `budget-alert:${alertId}`;
}

function seenHas(seen: PlanBudgetAlertOptions["seenKeys"], key: string): boolean {
  if (!seen) return false;
  if (seen instanceof Set) return seen.has(key);
  return seen.includes(key);
}

/** Plan one budget-alert row: propose it for the digest or skip with a reason. */
export function planBudgetAlertAction(
  action: BudgetAlertRouteInput,
  opts: PlanBudgetAlertOptions,
): BudgetAlertPlan {
  const id = action.id ?? "";
  const key = budgetAlertIdempotencyKey(id);
  const mode: BudgetAlertPlanMode = opts.applyMutations ? "apply" : "propose";
  const skip = (reason: string): BudgetAlertPlan => ({
    alertId: id,
    issueId: action.issueId,
    decision: "skip",
    severity: null,
    mode,
    idempotencyKey: key,
    reason,
  });

  if (id.trim() === "") {
    return skip("skip: malformed budget-alert row (missing alert id) — never proposes");
  }
  if (seenHas(opts.seenKeys, key)) {
    return skip(`skip: duplicate key ${key} already planned — idempotent on the alert key`);
  }
  const status = (action.status ?? "").trim();
  if (!ATTENTION_STATUSES.has(status)) {
    return skip(
      `skip: status "${status || "(missing)"}" is not attention — resolved history never re-proposes`,
    );
  }
  const severity = (action.severity ?? "").trim();
  if (!KNOWN_SEVERITIES.has(severity)) {
    return skip(
      `skip: severity "${action.severity ?? "(missing)"}" is ungraded — an ungraded alert never proposes`,
    );
  }
  return {
    alertId: id,
    issueId: action.issueId,
    decision: "propose",
    severity,
    mode,
    idempotencyKey: key,
    reason: `${severity} budget alert — proposal for the CEO digest (spend-adjacent, never auto-routed)`,
  };
}

/**
 * Plan a batch, de-duplicating within the batch as well as against `seenKeys`.
 * Returned in input order; the caller's `seenKeys` set is NOT mutated.
 */
export function planBudgetAlertActions(
  actions: readonly BudgetAlertRouteInput[],
  opts: PlanBudgetAlertOptions,
): BudgetAlertPlan[] {
  const batchSeen = new Set<string>();
  const prior = opts.seenKeys;
  return actions.map((action) => {
    const key = budgetAlertIdempotencyKey(action.id ?? "");
    const combined: Set<string> =
      prior instanceof Set
        ? new Set<string>([...prior, ...batchSeen])
        : new Set<string>([...(Array.isArray(prior) ? prior : []), ...batchSeen]);
    const plan = planBudgetAlertAction(action, { applyMutations: opts.applyMutations, seenKeys: combined });
    batchSeen.add(key);
    return plan;
  });
}
