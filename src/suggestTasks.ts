/**
 * suggest_tasks accept-path parity planner: plan a `suggest_tasks`
 * issue-thread interaction as a propose-only subtask-creation record — behind
 * the dedicated `suggestTasksRoute` flag (default off).
 *
 * Pure planning only — this module NEVER mutates. Suggested-task creation
 * touches issues, so even the cutover slice must re-authorize each creation;
 * this planner never marks live intent (`mode` is always `"propose"`). The
 * only consumer is the test harness, which applies an accepted plan to an
 * in-memory fake issue store to prove accept-path parity (accepted tasks
 * become real subtasks; rejected tasks create nothing) with zero live
 * mutation. Sweep/worker wiring waits on a suggest-tasks read path (no SDK
 * list exists today); until then the planner runs on caller-supplied rows.
 * The manifest requests no new capability for this slice.
 *
 * Accept path vs reject path: the outcome arrives as the interaction status.
 * `accepted` plans each suggested task; `rejected` skips and creates nothing
 * (a rejection is a real answer, not an error — the harness asserts zero
 * writes). Skip paths fail closed: flag-off, malformed rows, non-`suggest_tasks`
 * kinds, non-attention statuses, empty task lists, and duplicate keys never
 * propose. Each plan carries a stable idempotency key
 * (`suggest-tasks:<interaction-id>:<client-key>`) so a retry, a re-sweep, or
 * a duplicate listInteractions row proposes the same task at most once.
 */

export type SuggestTasksDecision = "accept" | "skip";

/**
 * Plan mode: always propose — subtask creation touches issues, so even the
 * cutover slice must re-authorize each creation; this planner never marks
 * live intent.
 */
export type SuggestTasksPlanMode = "propose";

/** One caller-supplied suggested task (the interaction payload's task list). */
export interface SuggestedTaskInput {
  /** Stable client key for the suggested task. */
  clientKey: string;
  /** Task title; empty never proposes. */
  title: string;
  /** Task detail carried onto the record. */
  description?: string;
}

/** Caller-supplied suggest_tasks interaction row (a future read or a test). */
export interface SuggestTasksInput {
  /** Stable interaction id (the `ANSWER <id>` target). */
  interactionId: string;
  /** Issue the interaction belongs to (the subtask parent). */
  issueId: string;
  /** Interaction kind — only `suggest_tasks` plans; anything else skips. */
  kind: string;
  /**
   * Interaction status: `accepted` plans the tasks, `rejected` skips with
   * zero writes, anything else fails closed.
   */
  status: string;
  /** Suggested tasks from the interaction payload. */
  tasks: readonly SuggestedTaskInput[];
}

/** One planned subtask creation (propose-only record). */
export interface SuggestTasksSubtaskPlan {
  /** Stable client key of the suggested task. */
  clientKey: string;
  /** Subtask title. */
  title: string;
  /** Subtask detail; null when the suggestion carried none. */
  description: string | null;
  /** Stable across sweeps: `suggest-tasks:<interaction-id>:<client-key>`. */
  idempotencyKey: string;
}

export interface SuggestTasksPlan {
  interactionId: string;
  issueId: string;
  decision: SuggestTasksDecision;
  /** Planned subtask creations; empty unless accepted under the flag. */
  subtasks: SuggestTasksSubtaskPlan[];
  mode: SuggestTasksPlanMode;
  /** Stable across sweeps: `suggest-tasks:<interaction-id>`. */
  idempotencyKey: string;
  reason: string;
}

export interface PlanSuggestTasksOptions {
  /** From `DecisionRouterConfig.suggestTasksRoute` (default false → no-op). */
  enabled: boolean;
  /** Keys already planned this process (or a prior sweep page). Duplicates skip. */
  seenKeys?: Set<string> | readonly string[];
}

/** Only the suggest_tasks kind routes here — done verbs stay out. */
const SUGGEST_TASKS_KIND = "suggest_tasks";

/** Stable plan-level idempotency key for one interaction. */
export function suggestTasksIdempotencyKey(interactionId: string): string {
  return `suggest-tasks:${interactionId}`;
}

/** Stable per-subtask idempotency key (interaction scope + client key). */
export function suggestSubtaskIdempotencyKey(interactionId: string, clientKey: string): string {
  return `suggest-tasks:${interactionId}:${clientKey}`;
}

function seenHas(seen: PlanSuggestTasksOptions["seenKeys"], key: string): boolean {
  if (!seen) return false;
  if (seen instanceof Set) return seen.has(key);
  return seen.includes(key);
}

/** Plan one suggest_tasks interaction: accept into subtask records or skip with a reason. */
export function planSuggestTasksAction(
  input: SuggestTasksInput,
  opts: PlanSuggestTasksOptions,
): SuggestTasksPlan {
  const interactionId = input.interactionId ?? "";
  const issueId = input.issueId ?? "";
  const kind = input.kind ?? "";
  const status = input.status ?? "";
  const tasks = input.tasks ?? [];
  const key = suggestTasksIdempotencyKey(interactionId);
  const skip = (reason: string): SuggestTasksPlan => ({
    interactionId,
    issueId,
    decision: "skip",
    subtasks: [],
    mode: "propose",
    idempotencyKey: key,
    reason,
  });

  if (!opts.enabled) {
    return skip("skip: suggestTasksRoute flag off — no-op, nothing accepted or created");
  }
  if (interactionId.trim() === "") {
    return skip("skip: malformed suggest_tasks row (missing interaction id) — never proposes");
  }
  if (issueId.trim() === "") {
    return skip("skip: malformed suggest_tasks row (missing parent issue id) — never proposes");
  }
  if (kind !== SUGGEST_TASKS_KIND) {
    return skip(
      `skip: kind "${kind || "(missing)"}" is not suggest_tasks — done verbs route elsewhere, never here`,
    );
  }
  if (seenHas(opts.seenKeys, key)) {
    return skip(`skip: duplicate key ${key} already planned — idempotent on the interaction key`);
  }
  // The reject path is a real answer, not an error: rejected tasks create
  // nothing, and the harness asserts zero writes.
  if (status === "rejected") {
    return skip("skip: interaction rejected — rejected tasks create nothing, no subtask fixtures");
  }
  if (status !== "accepted") {
    return skip(
      `skip: status "${status || "(missing)"}" is not an accept-path outcome (accepted) — decided history never re-proposes`,
    );
  }
  if (tasks.length === 0) {
    return skip("skip: accepted interaction carries no suggested tasks — nothing to create");
  }
  const subtasks: SuggestTasksSubtaskPlan[] = [];
  for (const task of tasks) {
    const clientKey = task.clientKey ?? "";
    const title = task.title ?? "";
    if (clientKey.trim() === "") {
      return skip("skip: suggested task has no client key — the interaction fails closed, never partially proposes");
    }
    if (title.trim() === "") {
      return skip("skip: suggested task has an empty title — the interaction fails closed, never partially proposes");
    }
    const subtaskKey = suggestSubtaskIdempotencyKey(interactionId, clientKey);
    if (seenHas(opts.seenKeys, subtaskKey)) {
      return skip(`skip: duplicate key ${subtaskKey} already planned — idempotent on the subtask key`);
    }
    subtasks.push({
      clientKey,
      title,
      description: task.description ?? null,
      idempotencyKey: subtaskKey,
    });
  }
  return {
    interactionId,
    issueId,
    decision: "accept",
    subtasks,
    mode: "propose",
    idempotencyKey: key,
    reason: `accept ${subtasks.length} suggested task(s) as propose-only subtask records; harness-only, never live-created by this module`,
  };
}

/**
 * Plan a batch, de-duplicating within the batch as well as against `seenKeys`.
 * Returned in input order; the caller's `seenKeys` set is NOT mutated.
 */
export function planSuggestTasksActions(
  inputs: readonly SuggestTasksInput[],
  opts: PlanSuggestTasksOptions,
): SuggestTasksPlan[] {
  const batchSeen = new Set<string>();
  const prior = opts.seenKeys;
  return inputs.map((input) => {
    const key = suggestTasksIdempotencyKey(input.interactionId ?? "");
    const subtaskKeys = (input.tasks ?? []).map((task) =>
      suggestSubtaskIdempotencyKey(input.interactionId ?? "", task.clientKey ?? ""),
    );
    const combined: Set<string> =
      prior instanceof Set
        ? new Set<string>([...prior, ...batchSeen])
        : new Set<string>([...(Array.isArray(prior) ? prior : []), ...batchSeen]);
    const plan = planSuggestTasksAction(input, { enabled: opts.enabled, seenKeys: combined });
    batchSeen.add(key);
    for (const subtaskKey of subtaskKeys) batchSeen.add(subtaskKey);
    return plan;
  });
}
