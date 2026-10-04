import { DEFAULT_SWEEP_PAGE_SIZE } from "./constants.js";

export interface DecisionRouterConfig {
  /** CEO desk card: the issue whose `ceo-decision-digest` document receives the digest. Null = record digest in plugin state only. */
  ceoDeskIssueId: string | null;
  /** Agent id of the Code Reviewer. Reviews route here. */
  codeReviewerAgentId: string | null;
  /** Issue id of the focus anchor. Out-of-focus blockers park against it. */
  focusAnchorIssueId: string | null;
  /** Issues per sweep before stopping (pagination continues next run). */
  sweepPageSize: number;
  /** Failed-run retry bound. */
  maxRetryAttempts: number;
  /**
   * Shadow mode (default true): compute routes, write the digest and metrics,
   * but perform NO mutations (no respondInteraction, no resolve, no wakeup,
   * no approval decide). Cut over by setting false with owner approval.
   */
  applyMutations: boolean;
  /**
   * Decision-log emit (default false): format one dry-run decision record per
   * routed attention item and emit it toward the Decisions-page pipeline via
   * the metrics counters only. Never mutates, never responds — the only sinks
   * are `metrics.write` and the last-sweep state record, both already in the
   * manifest. Independent of `applyMutations`.
   */
  decisionLogEmit: boolean;
  /**
   * Join-request route (default false): validate join-request rows and route
   * them to propose-only CEO-digest proposals. Never approves, never mutates
   * — join approval stays a President/COO decision. Sweep wiring waits on a
   * join-request read path (no SDK list exists today); until then the planner
   * runs on caller-supplied rows only.
   */
  joinRequestRoute: boolean;
  /**
   * Decision-bundle route (default false): plan cross-issue decision bundles
   * (comment_on_issue, assign_issue, update_issue_status) as ordered,
   * idempotent effect lists for the test harness. Never mutates — plans are
   * propose-only; the harness applies them to a fake store. Sweep wiring
   * waits on a decision-bundle read path (no SDK list exists today); until
   * then the planner runs on caller-supplied rows only.
   */
  decisionBundleRoute: boolean;
  /**
   * Request-confirmation route (default false): plan already-answered
   * request_confirmation interactions as propose-only accept-effect records
   * for the test harness. Never answers, never wakes — plans are
   * propose-only; the harness applies them to a fake store. Sweep wiring
   * waits on an accept-effect read path (no SDK list exists today); until
   * then the planner runs on caller-supplied rows only.
   */
  requestConfirmationRoute: boolean;
}

export const DEFAULT_CONFIG: DecisionRouterConfig = {
  ceoDeskIssueId: null,
  codeReviewerAgentId: null,
  focusAnchorIssueId: null,
  sweepPageSize: DEFAULT_SWEEP_PAGE_SIZE,
  maxRetryAttempts: 2,
  applyMutations: false,
  decisionLogEmit: false,
  joinRequestRoute: false,
  decisionBundleRoute: false,
  requestConfirmationRoute: false,
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Resolve raw operator config over the defaults. Never throws. */
export function resolveConfig(raw: unknown): DecisionRouterConfig {
  const row =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    ceoDeskIssueId: asNonEmptyString(row.ceoDeskIssueId),
    codeReviewerAgentId: asNonEmptyString(row.codeReviewerAgentId),
    focusAnchorIssueId: asNonEmptyString(row.focusAnchorIssueId),
    sweepPageSize: asPositiveInt(row.sweepPageSize, DEFAULT_SWEEP_PAGE_SIZE),
    maxRetryAttempts: asPositiveInt(row.maxRetryAttempts, DEFAULT_CONFIG.maxRetryAttempts),
    applyMutations: row.applyMutations === true,
    decisionLogEmit: row.decisionLogEmit === true,
    joinRequestRoute: row.joinRequestRoute === true,
    decisionBundleRoute: row.decisionBundleRoute === true,
    requestConfirmationRoute: row.requestConfirmationRoute === true,
  };
}

export const INSTANCE_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ceoDeskIssueId: {
      type: ["string", "null"],
      description: "CEO desk card issue id for the decision digest document. Null records the digest in plugin state only.",
    },
    codeReviewerAgentId: {
      type: ["string", "null"],
      description: "Agent id of the Code Reviewer; reviews route here.",
    },
    focusAnchorIssueId: {
      type: ["string", "null"],
      description: "Focus anchor issue id; out-of-focus blockers park against it.",
    },
    sweepPageSize: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      description: "Issues scanned per sweep run.",
    },
    maxRetryAttempts: {
      type: "integer",
      minimum: 0,
      maximum: 5,
      description: "Failed-run retry bound before the item goes to the CEO digest.",
    },
    applyMutations: {
      type: "boolean",
      description: "Leave false (shadow mode) until the cutover slice. True performs respond/resolve/wakeup/decide.",
    },
    decisionLogEmit: {
      type: "boolean",
      description: "Leave false until the Decisions-page pipeline can consume the dry-run records. True emits one dry-run decision record per routed item via metrics counters only (never mutates, never responds).",
    },
    joinRequestRoute: {
      type: "boolean",
      description: "Leave false until a join-request read path lands. True validates join-request rows and routes them to propose-only CEO-digest proposals (never approves, never mutates).",
    },
    decisionBundleRoute: {
      type: "boolean",
      description: "Leave false until a decision-bundle read path lands. True plans cross-issue decision bundles as ordered idempotent effect lists for the test harness only (never mutates, propose-only).",
    },
    requestConfirmationRoute: {
      type: "boolean",
      description: "Leave false until an accept-effect read path lands. True plans already-answered request_confirmation interactions as propose-only accept-effect records for the test harness only (never answers, never wakes, propose-only).",
    },
  },
} as const;
