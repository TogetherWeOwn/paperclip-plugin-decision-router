/**
 * join_request route verb: validate a join-request attention row and route it
 * to a propose-only CEO-digest proposal — behind the dedicated
 * `joinRequestRoute` flag (default off).
 *
 * Pure planning only — this module NEVER mutates and NEVER approves. Join
 * approval (`joins:approve`) is a President/COO authority, so the only routed
 * destination is the CEO digest; there is no `apply` intent on this path at
 * all, only `mode: "propose"` records a future read slice may surface. Each
 * plan carries a stable idempotency key (`join-request:<request-id>`) so a
 * retry, a re-sweep, or a duplicate source row proposes the same request at
 * most once. Skip paths fail closed: flag-off, malformed rows,
 * unrecognized requester kinds, non-pending statuses, and duplicate keys
 * never propose.
 *
 * The manifest requests no new capability for this verb: proposals are pure
 * data returned to the caller. Sweep wiring waits on a join-request read
 * path (no SDK list exists today); until then the planner runs on
 * caller-supplied rows. There is no live call on this path: no issue
 * mutation, no interaction respond, no approval decide, no join approve.
 */

/** Join-request row, as supplied by the caller (a future read or a test). */
export interface JoinRequestInput {
  /** Stable join-request id. */
  requestId: string;
  /**
   * Who asks to join: `human` or `agent` — the two kinds the `joins:approve`
   * authority covers. Anything else fails validation (skip).
   */
  requesterKind: string;
  /** Human handle or agent name making the request. */
  requesterRef: string;
  /** Request status; only pending attention routes. */
  status: string;
  /** Free-form source detail carried onto the proposal. */
  detail?: string;
}

export type JoinRequestDecision = "propose" | "skip";

/**
 * Plan mode: always propose — join approval stays a human President/COO
 * decision, so this verb never marks live intent.
 */
export type JoinRequestPlanMode = "propose";

/** The routed proposal: JSON-safe, digest-bound, approval-free. */
export interface JoinRequestProposal {
  requestId: string;
  requesterKind: "human" | "agent";
  requesterRef: string;
  /** Always `ceo-digest`: joins route to a human owner, never to an agent. */
  destination: "ceo-digest";
  /** CEO grammar stub (`DECIDE` — joins have no dedicated verb). */
  grammarStub: string;
  detail: string | null;
}

export interface JoinRequestPlan {
  requestId: string;
  decision: JoinRequestDecision;
  /** The proposal; null when skipped (flag off / invalid / duplicate). */
  proposal: JoinRequestProposal | null;
  mode: JoinRequestPlanMode;
  /** Stable across sweeps: `join-request:<request-id>`. */
  idempotencyKey: string;
  reason: string;
}

export interface PlanJoinRequestOptions {
  /** From `DecisionRouterConfig.joinRequestRoute` (default false → no-op). */
  enabled: boolean;
  /** Keys already planned this process (or a prior sweep page). Duplicates skip. */
  seenKeys?: Set<string> | readonly string[];
}

/** Attentional statuses: only pending requests need a human decision. */
const JOINABLE_STATUSES = new Set(["pending"]);

/** Requester kinds the `joins:approve` authority covers. */
const KNOWN_REQUESTER_KINDS = new Set(["human", "agent"]);

/** Stable idempotency key for one join request. */
export function joinRequestIdempotencyKey(requestId: string): string {
  return `join-request:${requestId}`;
}

function seenHas(seen: PlanJoinRequestOptions["seenKeys"], key: string): boolean {
  if (!seen) return false;
  if (seen instanceof Set) return seen.has(key);
  return seen.includes(key);
}

/** Plan one join request: validate, then route to a propose-only digest proposal. */
export function planJoinRequestAction(
  input: JoinRequestInput,
  opts: PlanJoinRequestOptions,
): JoinRequestPlan {
  const requestId = input.requestId ?? "";
  const requesterKind = input.requesterKind ?? "";
  const requesterRef = input.requesterRef ?? "";
  const status = input.status ?? "";
  const key = joinRequestIdempotencyKey(requestId);
  const skip = (reason: string): JoinRequestPlan => ({
    requestId,
    decision: "skip",
    proposal: null,
    mode: "propose",
    idempotencyKey: key,
    reason,
  });

  if (!opts.enabled) {
    return skip("skip: joinRequestRoute flag off — no-op, nothing validated or proposed");
  }
  if (requestId.trim() === "") {
    return skip("skip: malformed join-request row (missing request id) — never proposes");
  }
  if (seenHas(opts.seenKeys, key)) {
    return skip(`skip: duplicate key ${key} already planned — idempotent on the request key`);
  }
  if (!KNOWN_REQUESTER_KINDS.has(requesterKind)) {
    return skip(
      `skip: unrecognized requester kind "${requesterKind || "(missing)"}" (expected human|agent) — never proposes`,
    );
  }
  if (requesterRef.trim() === "") {
    return skip("skip: malformed join-request row (missing requester ref) — never proposes");
  }
  if (!JOINABLE_STATUSES.has(status)) {
    return skip(
      `skip: status "${status || "(missing)"}" is not attention (pending) — decided history never re-proposes`,
    );
  }
  return {
    requestId,
    decision: "propose",
    proposal: {
      requestId,
      requesterKind: requesterKind as "human" | "agent",
      requesterRef,
      destination: "ceo-digest",
      grammarStub: `DECIDE joins:${requestId} approve|reject`,
      detail: input.detail ?? null,
    },
    mode: "propose",
    idempotencyKey: key,
    reason: `propose per the digest route (${requesterKind} request by ${requesterRef}); approval stays a President/COO decision`,
  };
}

/**
 * Plan a batch, de-duplicating within the batch as well as against `seenKeys`.
 * Returned in input order; the caller's `seenKeys` set is NOT mutated.
 */
export function planJoinRequestActions(
  inputs: readonly JoinRequestInput[],
  opts: PlanJoinRequestOptions,
): JoinRequestPlan[] {
  const batchSeen = new Set<string>();
  const prior = opts.seenKeys;
  return inputs.map((input) => {
    const key = joinRequestIdempotencyKey(input.requestId ?? "");
    const combined: Set<string> =
      prior instanceof Set
        ? new Set<string>([...prior, ...batchSeen])
        : new Set<string>([...(Array.isArray(prior) ? prior : []), ...batchSeen]);
    const plan = planJoinRequestAction(input, { enabled: opts.enabled, seenKeys: combined });
    batchSeen.add(key);
    return plan;
  });
}
