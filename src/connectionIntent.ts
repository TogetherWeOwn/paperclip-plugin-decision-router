/**
 * `connection_intent` requesting-path guard: skip opening an AI-provider
 * (`purpose="ai"`) `connection_intent` when the requesting agent already has
 * an assigned model lane.
 *
 * Plugin-boundary guard for the host requesting path
 * (`ops/paperclip/interaction_router.py` — the host helper that opens a
 * `connection_intent` interaction for the AI provider). The requesting tool
 * itself lives in host code; this module forks nothing beyond the guard: the
 * host call-site checks `shouldOpenConnectionIntent` (or plans via
 * `planConnectionIntentAction`) before opening, and opens exactly as before
 * whenever the plan says `open`.
 *
 * Pure planning only — this module NEVER mutates. It never connects a
 * provider (no new spend), never changes `adapterConfig.model`, never touches
 * the quota governor, and never reclassifies or cancels existing `human_only`
 * rows (already-pending rows expire/are owner-handled, not agent-cleared).
 * `mode` is always `"propose"`: the plan records the guard verdict; there is
 * no live intent on this path and the manifest requests no new capability.
 *
 * Guard truth table (exact match only):
 *   purpose != "ai"              → open (non-AI intents untouched)
 *   purpose == "ai" + lane       → skip (agent already has a model lane)
 *   purpose == "ai" + no lane    → open (agent still needs a lane)
 *   malformed (missing purpose or requesting agent) → skip (fail closed:
 *     never open a junk intent)
 *
 * Lane presence is `hasModelLane === true` OR a non-empty `modelLane` id.
 * Absent/unknown lane info reads as "no lane" (fail open) — only the
 * proven-lane case is subtracted.
 */

export interface ConnectionIntentRequest {
  /** Provider slug when known (e.g. "anthropic"). Carried for the reason only. */
  provider?: string | null;
  /** Connection purpose (e.g. "ai", "tool", "channel"). Only "ai" is guarded. */
  purpose: string;
  /** Agent requesting the connection. */
  requestingAgentId: string;
  /** Assigned model-lane id/name when the caller carries it. */
  modelLane?: string | null;
  /** Explicit lane flag when the lane id itself is not carried. */
  hasModelLane?: boolean | null;
}

export type ConnectionIntentDecision = "open" | "skip";

/**
 * Plan mode: always propose — the guard records a verdict, never live intent.
 */
export type ConnectionIntentPlanMode = "propose";

export interface ConnectionIntentPlan {
  provider: string | null;
  purpose: string;
  requestingAgentId: string;
  decision: ConnectionIntentDecision;
  mode: ConnectionIntentPlanMode;
  /** Stable across sweeps: `connection-intent:<agent>:<purpose>:<provider>`. */
  idempotencyKey: string;
  reason: string;
}

export interface PlanConnectionIntentOptions {
  /** Keys already planned this process (or a prior sweep page). Duplicates skip. */
  seenKeys?: Set<string> | readonly string[];
}

/** AI-provider purpose the guard covers. Exact match only. */
const AI_PURPOSE = "ai";

/** Stable idempotency key for one requesting-agent/purpose/provider triple. */
export function connectionIntentIdempotencyKey(
  requestingAgentId: string,
  purpose: string,
  provider: string | null | undefined,
): string {
  const agent = (requestingAgentId ?? "").trim() || "(missing-agent)";
  const purp = (purpose ?? "").trim() || "(missing-purpose)";
  const prov = (provider ?? "").trim() || "unknown";
  return `connection-intent:${agent}:${purp}:${prov}`;
}

function seenHas(seen: PlanConnectionIntentOptions["seenKeys"], key: string): boolean {
  if (!seen) return false;
  if (seen instanceof Set) return seen.has(key);
  return seen.includes(key);
}

/** True when the request proves an assigned model lane (explicit flag or non-empty lane id). */
export function hasAssignedModelLane(request: Pick<ConnectionIntentRequest, "modelLane" | "hasModelLane">): boolean {
  if (request.hasModelLane === true) return true;
  return typeof request.modelLane === "string" && request.modelLane.trim() !== "";
}

/**
 * Core guard predicate. Returns false only for the proven-lane AI case (or a
 * malformed row, which also never opens). Everything else opens as before.
 */
export function shouldOpenConnectionIntent(request: ConnectionIntentRequest): boolean {
  const purpose = (request.purpose ?? "").trim();
  const agent = (request.requestingAgentId ?? "").trim();
  if (purpose === "" || agent === "") return false;
  if (purpose !== AI_PURPOSE) return true;
  return !hasAssignedModelLane(request);
}

/** Plan one requesting-path guard check: open the intent or skip with a reason. */
export function planConnectionIntentAction(
  request: ConnectionIntentRequest,
  opts: PlanConnectionIntentOptions = {},
): ConnectionIntentPlan {
  const purpose = request.purpose ?? "";
  const requestingAgentId = request.requestingAgentId ?? "";
  const provider = request.provider ?? null;
  const key = connectionIntentIdempotencyKey(requestingAgentId, purpose, provider);
  const skip = (reason: string): ConnectionIntentPlan => ({
    provider,
    purpose,
    requestingAgentId,
    decision: "skip",
    mode: "propose",
    idempotencyKey: key,
    reason,
  });

  if (purpose.trim() === "" || requestingAgentId.trim() === "") {
    return skip(
      "skip: malformed connection_intent request (missing purpose or requesting agent) — never opens a junk intent",
    );
  }
  if (seenHas(opts.seenKeys, key)) {
    return skip(`skip: duplicate key ${key} already planned — idempotent on the agent/purpose/provider key`);
  }
  if (purpose.trim() !== AI_PURPOSE) {
    return {
      provider,
      purpose,
      requestingAgentId,
      decision: "open",
      mode: "propose",
      idempotencyKey: key,
      reason: `open: purpose is "${purpose.trim()}" (not "ai") — the lane guard covers AI-provider intents only`,
    };
  }
  if (hasAssignedModelLane(request)) {
    const lane = typeof request.modelLane === "string" && request.modelLane.trim() !== "" ? request.modelLane.trim() : "assigned";
    return skip(
      `skip: purpose is "ai" and agent ${requestingAgentId.trim()} already has a model lane (${lane}) — no duplicate AI-provider intent`,
    );
  }
  return {
    provider,
    purpose,
    requestingAgentId,
    decision: "open",
    mode: "propose",
    idempotencyKey: key,
    reason: `open: purpose is "ai" and agent ${requestingAgentId.trim()} has no model lane — intent still opens`,
  };
}

/**
 * Plan a batch, de-duplicating within the batch as well as against `seenKeys`.
 * Returned in input order; the caller's `seenKeys` set is NOT mutated.
 */
export function planConnectionIntentActions(
  requests: readonly ConnectionIntentRequest[],
  opts: PlanConnectionIntentOptions = {},
): ConnectionIntentPlan[] {
  const batchSeen = new Set<string>();
  const prior = opts.seenKeys;
  return requests.map((request) => {
    const key = connectionIntentIdempotencyKey(
      request.requestingAgentId ?? "",
      request.purpose ?? "",
      request.provider ?? null,
    );
    const combined: Set<string> =
      prior instanceof Set
        ? new Set<string>([...prior, ...batchSeen])
        : new Set<string>([...(Array.isArray(prior) ? prior : []), ...batchSeen]);
    const plan = planConnectionIntentAction(request, { seenKeys: combined });
    batchSeen.add(key);
    return plan;
  });
}
