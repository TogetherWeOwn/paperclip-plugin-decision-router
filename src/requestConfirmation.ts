/**
 * request_confirmation accept-path parity planner: plan an already-answered
 * `request_confirmation` issue-thread interaction as a propose-only
 * accept-effect record — behind the dedicated `requestConfirmationRoute` flag
 * (default off).
 *
 * Pure planning only — this module NEVER mutates and NEVER answers. It reacts
 * to host-recorded answers (status `accepted` / `rejected`): the outcome
 * arrives via the CEO grammar (`ANSWER <id> accept|reject`) once live reads
 * land. `accepted` plans the accept effect (a respond record plus the
 * continuation wake, exactly per the host gates below); `rejected` skips and
 * creates nothing (a rejection is a real answer, not an error — on
 * `wake_assignee_on_accept` a rejection wakes nobody, :1263). Each plan
 * carries a stable idempotency key
 * (`request-confirmation:<interaction-id>`) so a retry, a re-sweep, or a
 * duplicate listInteractions row plans the same interaction at most once.
 * Skip paths fail closed: flag-off, malformed rows, non-`request_confirmation`
 * kinds, non-answer statuses, unroutable verdicts (INERT/MALFORMED), and
 * wakeless continuations (DEAD_WAKE, NO_WAKE_REQUESTED, UNKNOWN) never
 * propose.
 *
 * Host parity (interaction_triage.sh, re-derived for TOG-423 from the
 * deployed server build; the classifier is the shared port in triage.ts, so
 * every plan embeds the exact host verdict and continuation):
 *
 *   :2953  toolAction confirmations are ALWAYS board-only — the verdict rides
 *           on the plan; an accept effect records the board's answer, it never
 *           manufactures one (the planner fires only on recorded `accepted`).
 *   :2946  assignee gate (:2793): unassigned issues admit every agent — but an
 *           accept on an unassigned issue is DEAD_WAKE (:1253), so it skips.
 *   :2956  review-verdict bypass: a named in_review confirmation becomes
 *           agent-resolvable — an accepted one plans like any other accept.
 *   :2962  board_only without the bypass is OWNER_ONLY — an accepted one is
 *           the owner path (the CEO grammar answers as the paired board
 *           user), so it plans the same accept effect.
 *   :2975  creator/addressee bars: rows only the creator could answer are
 *           INERT — withdraw and re-cut, never auto-plan.
 *   :1253  the continuation wake needs an assignee AND an open issue — accepts
 *           on DEAD_WAKE rows skip (the answer would evaporate).
 *   :1263  wake_assignee_on_accept: accept wakes, rejection is silent —
 *           rejected skips with zero writes.
 *   :1265  any other policy requests no wake — an accept would start nothing,
 *           so it skips; UNKNOWN (unmeasured) skips too, mirroring the host
 *           tool's --strict-wake refusal to report green.
 *
 * The manifest requests no new capability for this slice, and there is no
 * sweep/worker wiring: the planner runs on caller-supplied rows (a future
 * accept-path read or a test) until an SDK accept-effect read exists.
 */
import { triageInteraction, type ContinuationState, type TriageRow, type TriageVerdict } from "./triage.js";

/** Caller-supplied request_confirmation interaction row (a future read or a test). */
export interface RequestConfirmationInput {
  /** Stable interaction id (the `ANSWER <id>` target). */
  interactionId: string;
  /** Issue the interaction belongs to (the wake target's issue). */
  issueId: string;
  /** Interaction kind — only `request_confirmation` plans; anything else skips. */
  kind: string;
  /**
   * Interaction status: `accepted` plans the accept effect, `rejected` skips
   * with zero writes, anything else fails closed.
   */
  status: string;
  /** Effective resolver policy from the host row. */
  effectiveResolverPolicy: string;
  /** Agent that created the interaction (the creator bar, :2975). */
  createdByAgentId: string;
  /** Current issue assignee; null on unassigned issues (:2793 / :1253). */
  assigneeAgentId?: string | null;
  /** Addressee when the ask names one (:2975). */
  addresseeAgentId?: string | null;
  /** True when the payload carries a toolAction (:2953). */
  hasToolAction?: boolean;
  /** Current issue status (openness drives :1253). */
  issueStatus?: string | null;
  /** Caller-asserted reviewInteractionId linkage, never inferred (:2956). */
  namedReviewInteraction?: boolean;
  /** Continuation policy from the host row (:1253 / :1263 / :1265). */
  continuationPolicy?: string | null;
}

export type RequestConfirmationDecision = "accept" | "skip";

/**
 * Plan mode: always propose — an accept effect wakes an agent, so even the
 * cutover slice must re-authorize each application; this planner never marks
 * live intent.
 */
export type RequestConfirmationPlanMode = "propose";

/** The planned accept effect: a respond record plus the host-prescribed wake. */
export interface RequestConfirmationAcceptance {
  /** Always `accepted`: the recorded host answer this effect answers for. */
  outcome: "accepted";
  /** Assignee the host would wake on accept (:1253 / :1263). */
  wakeAssignee: string;
  /** CEO grammar line this effect applies (`ANSWER <id> accept`). */
  grammarLine: string;
}

export interface RequestConfirmationPlan {
  interactionId: string;
  issueId: string;
  decision: RequestConfirmationDecision;
  /** The accept effect; null unless accepted under the flag and the gates. */
  acceptance: RequestConfirmationAcceptance | null;
  /** Exact host verdict for this row (gate-for-gate parity evidence). */
  triageVerdict: TriageVerdict;
  /** Exact host continuation for this row (wake parity evidence). */
  triageContinuation: ContinuationState;
  mode: RequestConfirmationPlanMode;
  /** Stable across sweeps: `request-confirmation:<interaction-id>`. */
  idempotencyKey: string;
  reason: string;
}

export interface PlanRequestConfirmationOptions {
  /** From `DecisionRouterConfig.requestConfirmationRoute` (default false → no-op). */
  enabled: boolean;
  /** Keys already planned this process (or a prior sweep page). Duplicates skip. */
  seenKeys?: Set<string> | readonly string[];
}

/** Only the request_confirmation kind routes here — done verbs stay out. */
const REQUEST_CONFIRMATION_KIND = "request_confirmation";

/** Verdicts whose recorded answer the planner turns into an accept effect. */
const ACCEPTABLE_VERDICTS: ReadonlySet<TriageVerdict> = new Set([
  "AGENT_RESOLVABLE",
  "AGENT_REVIEW_VERDICT",
  "OWNER_ONLY",
]);

/** Continuations where an accept starts work (the effect the harness proves). */
const WAKE_CONTINUATIONS: ReadonlySet<ContinuationState> = new Set(["WAKES", "WAKES_ON_ACCEPT"]);

/** Stable idempotency key for one interaction. */
export function requestConfirmationIdempotencyKey(interactionId: string): string {
  return `request-confirmation:${interactionId}`;
}

function seenHas(seen: PlanRequestConfirmationOptions["seenKeys"], key: string): boolean {
  if (!seen) return false;
  if (seen instanceof Set) return seen.has(key);
  return seen.includes(key);
}

/** Plan one request_confirmation interaction: accept the recorded answer or skip with a reason. */
export function planRequestConfirmationAction(
  input: RequestConfirmationInput,
  opts: PlanRequestConfirmationOptions,
): RequestConfirmationPlan {
  const interactionId = input.interactionId ?? "";
  const issueId = input.issueId ?? "";
  const kind = input.kind ?? "";
  const status = input.status ?? "";
  const key = requestConfirmationIdempotencyKey(interactionId);
  const row: TriageRow = {
    identifier: interactionId === "" ? "(no identifier)" : interactionId,
    kind,
    effectiveResolverPolicy: input.effectiveResolverPolicy ?? "",
    createdByAgentId: input.createdByAgentId ?? "",
    assigneeAgentId: input.assigneeAgentId ?? null,
    addresseeAgentId: input.addresseeAgentId ?? null,
    hasToolAction: input.hasToolAction ?? false,
    issueStatus: input.issueStatus ?? null,
    namedReviewInteraction: input.namedReviewInteraction ?? false,
    continuationPolicy: input.continuationPolicy ?? null,
  };
  // The host verdict is computed on every path — including flag-off — so the
  // flag-off tests assert host behavior unchanged AND gate parity at once.
  const triage = triageInteraction(row);
  const skip = (reason: string): RequestConfirmationPlan => ({
    interactionId,
    issueId,
    decision: "skip",
    acceptance: null,
    triageVerdict: triage.verdict,
    triageContinuation: triage.continuation,
    mode: "propose",
    idempotencyKey: key,
    reason,
  });

  if (!opts.enabled) {
    return skip("skip: requestConfirmationRoute flag off — no-op, host behavior unchanged, nothing accepted");
  }
  if (interactionId.trim() === "") {
    return skip("skip: malformed request_confirmation row (missing interaction id) — never proposes");
  }
  if (issueId.trim() === "") {
    return skip("skip: malformed request_confirmation row (missing issue id) — never proposes");
  }
  if (kind !== REQUEST_CONFIRMATION_KIND) {
    return skip(
      `skip: kind "${kind || "(missing)"}" is not request_confirmation — done verbs route elsewhere, never here`,
    );
  }
  if (seenHas(opts.seenKeys, key)) {
    return skip(`skip: duplicate key ${key} already planned — idempotent on the interaction key`);
  }
  // The reject path is a real answer, not an error: rejected confirmations
  // create nothing (on wake_assignee_on_accept a rejection wakes nobody,
  // :1263), and the harness asserts zero writes.
  if (status === "rejected") {
    return skip("skip: interaction rejected — rejected confirmations create nothing, no accept record (:1263)");
  }
  if (status !== "accepted") {
    return skip(
      `skip: status "${status || "(missing)"}" is not an accept-path outcome (accepted) — decided history never re-proposes`,
    );
  }
  if (!ACCEPTABLE_VERDICTS.has(triage.verdict)) {
    return skip(
      `skip: triage ${triage.verdict} — ${
        triage.verdict === "INERT"
          ? "no agent can resolve it; withdraw and re-cut, never auto-plan (:2975)"
          : "the row is MALFORMED; a skipped row must never read as clean"
      }`,
    );
  }
  if (!WAKE_CONTINUATIONS.has(triage.continuation)) {
    return skip(
      `skip: continuation ${triage.continuation} — an accept would start nothing (:1253/:1265), no effect to plan`,
    );
  }
  const wakeAssignee = input.assigneeAgentId ?? "";
  if (wakeAssignee.trim() === "") {
    return skip("skip: wake state with no assignee — unmeasurable wake target, never plans");
  }
  return {
    interactionId,
    issueId,
    decision: "accept",
    acceptance: {
      outcome: "accepted",
      wakeAssignee,
      grammarLine: `ANSWER ${interactionId} accept`,
    },
    triageVerdict: triage.verdict,
    triageContinuation: triage.continuation,
    mode: "propose",
    idempotencyKey: key,
    reason: `accept per the host gates (triage ${triage.verdict}, wake ${triage.continuation}); harness-only, never live-responded by this module`,
  };
}

/**
 * Plan a batch, de-duplicating within the batch as well as against `seenKeys`.
 * Returned in input order; the caller's `seenKeys` set is NOT mutated.
 */
export function planRequestConfirmationActions(
  inputs: readonly RequestConfirmationInput[],
  opts: PlanRequestConfirmationOptions,
): RequestConfirmationPlan[] {
  const batchSeen = new Set<string>();
  const prior = opts.seenKeys;
  return inputs.map((input) => {
    const key = requestConfirmationIdempotencyKey(input.interactionId ?? "");
    const combined: Set<string> =
      prior instanceof Set
        ? new Set<string>([...prior, ...batchSeen])
        : new Set<string>([...(Array.isArray(prior) ? prior : []), ...batchSeen]);
    const plan = planRequestConfirmationAction(input, { enabled: opts.enabled, seenKeys: combined });
    batchSeen.add(key);
    return plan;
  });
}
