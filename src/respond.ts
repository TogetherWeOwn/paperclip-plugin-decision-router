/**
 * issue_thread_interaction respond verb: draft the `ANSWER <interaction-id>`
 * decision behind the existing `applyMutations` flag (default off).
 *
 * Pure planning only — this module NEVER mutates. Each plan carries a stable
 * idempotency key (`interaction-respond:<interaction-id>`) so a retry, a
 * re-sweep, or a duplicate listInteractions row drafts the same interaction
 * at most once. When `applyMutations` is false (shadow default) plans come
 * back as `mode: "propose"` — recorded in the sweep result and the
 * last-sweep state, nothing applied. `mode: "apply"` only marks the live
 * intent the cutover slice may act on once an SDK respond capability exists
 * (`issue.interactions.respond`, deliberately absent from the manifest until
 * cutover); there is still no live call on this path.
 *
 * The only planned outcome is `respond` (the digest verb for interactions,
 * `digest.ts` KIND_VERBS). The accept/reject outcome arrives via the CEO
 * grammar (`ANSWER <id> accept|reject`) once live reads land. Skip paths fail
 * closed: malformed rows, non-pending statuses, duplicate keys, and
 * `human_only` rows never draft a respond — a row only a human may answer is
 * never auto-answered (parity with the triage OWNER_ONLY verdict).
 */

export interface RespondActionInput {
  /** Stable interaction id (the `ANSWER <id>` target). */
  id: string;
  /** Issue the interaction belongs to. */
  issueId: string;
  /** Interaction kind (e.g. ask_user_questions) — carried for the future draft. */
  kind: string;
  /** Interaction status; only pending attention drafts a respond. */
  status: string;
  /**
   * Resolver policy from listInteractions. A `human_only` row never drafts —
   * only a human may answer it. Absent/unknown policies keep the legacy draft
   * path; only the proven-human case is subtracted.
   */
  effectiveResolverPolicy?: string | null;
}

export type RespondDecision = "respond" | "skip";

/** Plan mode: propose-only in shadow, live intent behind `applyMutations`. */
export type RespondPlanMode = "propose" | "apply";

export interface RespondPlan {
  interactionId: string;
  issueId: string;
  kind: string;
  decision: RespondDecision;
  /** Always `respond` when the decision is `respond` (the digest verb). */
  outcome: "respond";
  mode: RespondPlanMode;
  /** Stable across sweeps: `interaction-respond:<interaction-id>`. */
  idempotencyKey: string;
  reason: string;
}

export interface PlanRespondOptions {
  /** From `DecisionRouterConfig.applyMutations` (default false → propose). */
  applyMutations: boolean;
  /** Keys already planned this process (or a prior sweep page). Duplicates skip. */
  seenKeys?: Set<string> | readonly string[];
}

/** Attentional statuses the worker sweep surfaces (see worker listPendingInteractions). */
const RESPONDABLE_STATUSES = new Set(["pending"]);

/** Stable idempotency key for one interaction. */
export function respondIdempotencyKey(interactionId: string): string {
  return `interaction-respond:${interactionId}`;
}

function seenHas(seen: PlanRespondOptions["seenKeys"], key: string): boolean {
  if (!seen) return false;
  if (seen instanceof Set) return seen.has(key);
  return seen.includes(key);
}

/** Plan one interaction: draft a respond per the digest verb or skip with a reason. */
export function planRespondAction(action: RespondActionInput, opts: PlanRespondOptions): RespondPlan {
  const id = action.id ?? "";
  const issueId = action.issueId ?? "";
  const kind = action.kind ?? "";
  const status = action.status ?? "";
  const key = respondIdempotencyKey(id);
  const mode: RespondPlanMode = opts.applyMutations ? "apply" : "propose";

  if (id.trim() === "") {
    return {
      interactionId: id,
      issueId,
      kind,
      decision: "skip",
      outcome: "respond",
      mode,
      idempotencyKey: key,
      reason: "skip: malformed interaction row (missing interaction id) — never drafts a respond",
    };
  }
  if (seenHas(opts.seenKeys, key)) {
    return {
      interactionId: id,
      issueId,
      kind,
      decision: "skip",
      outcome: "respond",
      mode,
      idempotencyKey: key,
      reason: `skip: duplicate key ${key} already planned — idempotent on the interaction key`,
    };
  }
  if (!RESPONDABLE_STATUSES.has(status)) {
    return {
      interactionId: id,
      issueId,
      kind,
      decision: "skip",
      outcome: "respond",
      mode,
      idempotencyKey: key,
      reason: `skip: status "${status || "(missing)"}" is not attention (pending) — decided history never re-responds`,
    };
  }
  // human_only rows never draft a respond: only a human may answer them
  // (triage marks the same rows OWNER_ONLY). Exact match only — absent or
  // unknown policies keep the legacy draft path.
  if (action.effectiveResolverPolicy === "human_only") {
    return {
      interactionId: id,
      issueId,
      kind,
      decision: "skip",
      outcome: "respond",
      mode,
      idempotencyKey: key,
      reason: 'skip: effectiveResolverPolicy is "human_only" — only a human may answer; never auto-responds',
    };
  }
  return {
    interactionId: id,
    issueId,
    kind,
    decision: "respond",
    outcome: "respond",
    mode,
    idempotencyKey: key,
    reason: "respond per the digest verb; the accept/reject outcome arrives via a CEO ANSWER line",
  };
}

/**
 * Plan a batch, de-duplicating within the batch as well as against `seenKeys`.
 * Returned in input order; the caller's `seenKeys` set is NOT mutated.
 */
export function planRespondActions(
  actions: readonly RespondActionInput[],
  opts: PlanRespondOptions,
): RespondPlan[] {
  const batchSeen = new Set<string>();
  const prior = opts.seenKeys;
  return actions.map((action) => {
    const key = respondIdempotencyKey(action.id ?? "");
    const combined: Set<string> =
      prior instanceof Set
        ? new Set<string>([...prior, ...batchSeen])
        : new Set<string>([...(Array.isArray(prior) ? prior : []), ...batchSeen]);
    const plan = planRespondAction(action, { applyMutations: opts.applyMutations, seenKeys: combined });
    batchSeen.add(key);
    return plan;
  });
}
