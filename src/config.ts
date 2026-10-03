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
}

export const DEFAULT_CONFIG: DecisionRouterConfig = {
  ceoDeskIssueId: null,
  codeReviewerAgentId: null,
  focusAnchorIssueId: null,
  sweepPageSize: DEFAULT_SWEEP_PAGE_SIZE,
  maxRetryAttempts: 2,
  applyMutations: false,
  decisionLogEmit: false,
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
  },
} as const;
