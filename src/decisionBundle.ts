/**
 * decision-bundle effect planner: plan one cross-issue decision bundle
 * (`comment_on_issue`, `assign_issue`, `update_issue_status`) as an ordered,
 * idempotent effect list — behind the dedicated `decisionBundleRoute` flag
 * (default off).
 *
 * Pure planning only — this module NEVER mutates. There is no live call on
 * this path: no comment create, no assignee write, no status write. Plans are
 * always `mode: "propose"`; the only consumer is the test harness, which
 * applies a proposed plan to an in-memory fake issue store to prove ordering
 * and idempotency parity (planned order == applied order, duplicate keys
 * apply once). Sweep/worker wiring waits on a decision-bundle read path (no
 * SDK list exists today); until then the planner runs on caller-supplied rows.
 * The manifest requests no new capability for this slice.
 *
 * Canonical application order is fixed, not input order: `comment_on_issue`
 * first (the audit trail survives a later effect failing), then
 * `assign_issue` (the owner is set while the issue is still open), then
 * `update_issue_status` last (a terminal status could freeze later writes).
 * Skip paths fail closed: flag-off, malformed bundles, unknown effect types,
 * invalid effect fields, and duplicate keys never propose.
 */

/** Cross-issue effect types one bundle may carry. */
export type DecisionBundleEffectType = "comment_on_issue" | "assign_issue" | "update_issue_status";

/** One caller-supplied effect row (a future bundle read or a test). */
export interface DecisionBundleEffectInput {
  /** Effect type; anything outside {@link DecisionBundleEffectType} fails the bundle. */
  type: string;
  /** Comment body (`comment_on_issue`). */
  body?: string;
  /** Agent id to assign (`assign_issue`). */
  assigneeAgentId?: string;
  /** Target status (`update_issue_status`). */
  status?: string;
}

/** Caller-supplied bundle row. */
export interface DecisionBundleInput {
  /** Stable bundle id (the decision idempotency scope). */
  bundleId: string;
  /** Issue the effects target. */
  targetIssueId: string;
  /** Effects to apply, in any input order (planning normalizes to canonical order). */
  effects: readonly DecisionBundleEffectInput[];
}

export type DecisionBundleDecision = "propose" | "skip";

/**
 * Plan mode: always propose — bundle effects touch other issues, so even the
 * cutover slice must re-authorize each effect; this planner never marks live
 * intent.
 */
export type DecisionBundlePlanMode = "propose";

/** One validated effect in canonical application order. */
export interface DecisionBundleEffectPlan {
  type: DecisionBundleEffectType;
  /** Canonical application order (0 = first). */
  order: number;
  /** Validated payload for the effect. */
  detail: {
    body?: string;
    assigneeAgentId?: string;
    status?: string;
  };
  /** Stable across sweeps: `decision-bundle:<bundle-id>:<order>:<type>`. */
  idempotencyKey: string;
}

export interface DecisionBundlePlan {
  bundleId: string;
  targetIssueId: string;
  decision: DecisionBundleDecision;
  /** Ordered effects; empty when skipped (flag off / invalid / duplicate). */
  effects: DecisionBundleEffectPlan[];
  mode: DecisionBundlePlanMode;
  /** Stable across sweeps: `decision-bundle:<bundle-id>`. */
  idempotencyKey: string;
  reason: string;
}

export interface PlanDecisionBundleOptions {
  /** From `DecisionRouterConfig.decisionBundleRoute` (default false → no-op). */
  enabled: boolean;
  /** Keys already planned this process (or a prior sweep page). Duplicates skip. */
  seenKeys?: Set<string> | readonly string[];
}

/** Canonical application order: comment, then assign, then status. */
const EFFECT_ORDER: Record<DecisionBundleEffectType, number> = {
  comment_on_issue: 0,
  assign_issue: 1,
  update_issue_status: 2,
};

const KNOWN_EFFECT_TYPES = new Set<string>(Object.keys(EFFECT_ORDER));

/** Statuses the status effect may set (fail closed on anything else). */
const KNOWN_STATUSES = new Set([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
]);

/** Stable bundle-level idempotency key. */
export function decisionBundleIdempotencyKey(bundleId: string): string {
  return `decision-bundle:${bundleId}`;
}

/** Stable per-effect idempotency key (bundle scope + canonical order + type). */
export function decisionBundleEffectIdempotencyKey(
  bundleId: string,
  order: number,
  type: DecisionBundleEffectType,
): string {
  return `decision-bundle:${bundleId}:${order}:${type}`;
}

function seenHas(seen: PlanDecisionBundleOptions["seenKeys"], key: string): boolean {
  if (!seen) return false;
  if (seen instanceof Set) return seen.has(key);
  return seen.includes(key);
}

/** Plan one decision bundle: validate, order, or skip with a reason. */
export function planDecisionBundleAction(
  input: DecisionBundleInput,
  opts: PlanDecisionBundleOptions,
): DecisionBundlePlan {
  const bundleId = input.bundleId ?? "";
  const targetIssueId = input.targetIssueId ?? "";
  const key = decisionBundleIdempotencyKey(bundleId);
  const skip = (reason: string): DecisionBundlePlan => ({
    bundleId,
    targetIssueId,
    decision: "skip",
    effects: [],
    mode: "propose",
    idempotencyKey: key,
    reason,
  });

  if (!opts.enabled) {
    return skip("skip: decisionBundleRoute flag off — no-op, nothing validated or proposed");
  }
  if (bundleId.trim() === "") {
    return skip("skip: malformed decision bundle (missing bundle id) — never proposes");
  }
  if (targetIssueId.trim() === "") {
    return skip("skip: malformed decision bundle (missing target issue id) — never proposes");
  }
  if (seenHas(opts.seenKeys, key)) {
    return skip(`skip: duplicate key ${key} already planned — idempotent on the bundle key`);
  }
  const effects = input.effects ?? [];
  if (effects.length === 0) {
    return skip("skip: decision bundle carries no effects — nothing to propose");
  }
  const planned: DecisionBundleEffectPlan[] = [];
  for (const effect of effects) {
    const type = effect.type ?? "";
    if (!KNOWN_EFFECT_TYPES.has(type)) {
      return skip(
        `skip: unknown effect type "${type || "(missing)"}" — the bundle fails closed, never partially proposes`,
      );
    }
    const effectType = type as DecisionBundleEffectType;
    const ordered = EFFECT_ORDER[effectType];
    if (effectType === "comment_on_issue") {
      const body = effect.body ?? "";
      if (body.trim() === "") {
        return skip("skip: comment_on_issue effect has an empty body — the bundle fails closed");
      }
      planned.push({
        type: effectType,
        order: ordered,
        detail: { body },
        idempotencyKey: decisionBundleEffectIdempotencyKey(bundleId, ordered, effectType),
      });
    } else if (effectType === "assign_issue") {
      const assigneeAgentId = effect.assigneeAgentId ?? "";
      if (assigneeAgentId.trim() === "") {
        return skip("skip: assign_issue effect has no assignee — the bundle fails closed");
      }
      planned.push({
        type: effectType,
        order: ordered,
        detail: { assigneeAgentId },
        idempotencyKey: decisionBundleEffectIdempotencyKey(bundleId, ordered, effectType),
      });
    } else {
      const status = effect.status ?? "";
      if (!KNOWN_STATUSES.has(status)) {
        return skip(
          `skip: update_issue_status effect targets unknown status "${status || "(missing)"}" — the bundle fails closed`,
        );
      }
      planned.push({
        type: effectType,
        order: ordered,
        detail: { status },
        idempotencyKey: decisionBundleEffectIdempotencyKey(bundleId, ordered, effectType),
      });
    }
  }
  planned.sort((a, b) => a.order - b.order);
  return {
    bundleId,
    targetIssueId,
    decision: "propose",
    effects: planned,
    mode: "propose",
    idempotencyKey: key,
    reason: `propose ${planned.map((effect) => effect.type).join(" → ")} in canonical order; harness-only, never live-applied by this module`,
  };
}
