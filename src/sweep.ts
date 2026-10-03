/**
 * Sweep: one pass over every Decisions-page source the SDK can read.
 *
 * Pure orchestration over injected reads/writes so the SDK test harness (and
 * plain unit tests) can drive it without a host. Coverage by source:
 *
 *   issue_thread_interaction — listInteractions per open issue (SDK: full).
 *   blocker_attention        — relations.get per open issue (SDK: raw edges;
 *                              attention classification is gap G-03).
 *   approval                 — approvals.list pending (SDK: full read; decide
 *                              stays shadow until cutover).
 *   failed_run               — orchestration run summaries per issue (SDK:
 *                              read full; retry trigger is gap G-05).
 *   recovery_action          — relation edge `activeRecoveryAction` summaries
 *                              per issue (SDK: partial read; standalone
 *                              list/resolve is gap G-02).
 *   review                   — NO SDK read (gap G-04); routed by kind when a
 *                              review row is supplied by the caller.
 *
 * Shadow rule: this module NEVER mutates. It returns routes + digest +
 * metrics; the worker persists those. Applying a route (respond, resolve,
 * wakeup, decide, park edge) is the cutover slice's job behind
 * `applyMutations`.
 */
import type { AttentionItem } from "./attention.js";
import { planApprovalActions, type ApprovalPlan } from "./approval.js";
import type { DecisionRouterConfig } from "./config.js";
import { renderDigest } from "./digest.js";
import { slaMetrics, sweepCounters, type MetricPoint } from "./metrics.js";
import { planRecoveryActions, type RecoveryPlan } from "./recovery.js";
import { planRetry, type RetryPlan } from "./retry.js";
import { routeAttention, routeInteraction, type RoutedItem, type RoutingContext } from "./routing.js";
import type { TriageRow } from "./triage.js";

export interface SweepIssue {
  id: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
}

export interface SweepInteraction {
  id: string;
  kind: string;
  status: string;
  effectiveResolverPolicy: string;
  createdByAgentId: string | null;
  addresseeAgentId: string | null;
  hasToolAction: boolean;
  continuationPolicy: string;
  createdAt: string;
  title: string | null;
}

export interface SweepApproval {
  id: string;
  /** Linked issue id when the approval payload names one, else null (company scope). */
  issueId: string | null;
  status: string;
  createdAt: string;
}

export interface SweepRun {
  id: string;
  issueId: string | null;
  status: string;
  finishedAt: string | null;
  error: string | null;
}

export interface SweepRecovery {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
}

export interface SweepReads {
  listOpenIssues(companyId: string, limit: number): Promise<SweepIssue[]>;
  listPendingInteractions(issueId: string, companyId: string): Promise<SweepInteraction[]>;
  listRelations(
    issueId: string,
    companyId: string,
  ): Promise<{ blockedByIds: string[]; activeRecovery: SweepRecovery[] }>;
  listPendingApprovals(companyId: string): Promise<SweepApproval[]>;
  listFailedRuns(issueId: string, companyId: string): Promise<SweepRun[]>;
  /** Extra rows from sources the SDK cannot read (review ledger). */
  extraItems(companyId: string): Promise<AttentionItem[]>;
}

export interface SweepResult {
  items: AttentionItem[];
  routed: RoutedItem[];
  /** One plan per `retry` destination: fire/propose/defer/skip. Pure data — the worker applies `fire` plans behind `applyMutations`. */
  retryPlans: RetryPlan[];
  /**
   * recovery_action resolve plans (pure planning — the sweep never mutates).
   * `mode` is `propose` unless `applyMutations` is true; even then no live
   * call fires until the cutover slice lands an SDK resolve capability (G-02).
   */
  recoveryPlans: RecoveryPlan[];
  /**
   * approval approve plans (pure planning — the sweep never mutates).
   * `mode` is `propose` unless `applyMutations` is true; even then no live
   * call fires until the cutover slice lands an SDK decide capability
   * (`approvals.respond`, absent from the manifest until cutover).
   */
  approvalPlans: ApprovalPlan[];
  metrics: MetricPoint[];
  digest: string;
  scannedIssues: number;
}

/** Prior-sweep retry memory, read from the last-sweep state record. Absent on the first sweep. */
export interface SweepPrior {
  /** Attempts already fired per runKey (`failed-run:<runId>`). */
  retryAttempts?: Record<string, number>;
  /** Idempotency keys already fired (crash-window dedup). */
  retriedKeys?: string[];
}

const OPEN_STATUSES = new Set(["todo", "in_progress", "in_review"]);

function iso(value: string | Date | null | undefined, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

export async function sweepDecisions(
  companyId: string,
  config: DecisionRouterConfig,
  reads: SweepReads,
  now: Date = new Date(),
  prior: SweepPrior = {},
): Promise<SweepResult> {
  const nowIso = now.toISOString();
  const issues = (await reads.listOpenIssues(companyId, config.sweepPageSize)).filter((issue) =>
    OPEN_STATUSES.has(issue.status),
  );

  const items: AttentionItem[] = [];
  const routed: RoutedItem[] = [];
  const recoveryInputs: { id: string; kind: string; status: string }[] = [];
  const routingCtx: RoutingContext = {
    codeReviewerAgentId: config.codeReviewerAgentId ?? "<code-reviewer-unset>",
    focusAnchorIssueId: config.focusAnchorIssueId,
    blockerOwners: Object.fromEntries(
      issues.filter((issue) => issue.assigneeAgentId).map((issue) => [issue.id, issue.assigneeAgentId as string]),
    ),
    focusIssueIds: [],
    retryAttempts: prior.retryAttempts ?? {},
    maxRetryAttempts: config.maxRetryAttempts,
  };
  const firedKeys = new Set(prior.retriedKeys ?? []);

  for (const issue of issues) {
    const label = issue.identifier ?? issue.id;
    const [interactions, relations, failedRuns] = await Promise.all([
      reads.listPendingInteractions(issue.id, companyId),
      reads.listRelations(issue.id, companyId),
      reads.listFailedRuns(issue.id, companyId),
    ]);
    const blockedBy = relations.blockedByIds;

    for (const ix of interactions) {
      const item: AttentionItem = {
        kind: "issue_thread_interaction",
        issueId: issue.id,
        identifier: label,
        sourceId: ix.id,
        pendingSince: iso(ix.createdAt, nowIso),
        detail: `${ix.kind} "${ix.title ?? "(untitled)"}"`,
      };
      items.push(item);
      const row: TriageRow = {
        identifier: `${label}/${ix.id.slice(0, 8)}`,
        kind: ix.kind,
        effectiveResolverPolicy: ix.effectiveResolverPolicy,
        createdByAgentId: ix.createdByAgentId ?? "",
        assigneeAgentId: issue.assigneeAgentId,
        addresseeAgentId: ix.addresseeAgentId,
        hasToolAction: ix.hasToolAction,
        issueStatus: issue.status,
        namedReviewInteraction: false,
        continuationPolicy: ix.continuationPolicy,
      };
      routed.push(routeInteraction(item, row, routingCtx));
    }

    for (const recovery of relations.activeRecovery) {
      const item: AttentionItem = {
        kind: "recovery_action",
        issueId: issue.id,
        identifier: label,
        sourceId: recovery.id,
        pendingSince: iso(recovery.createdAt, nowIso),
        detail: `${recovery.kind} (${recovery.status})`,
      };
      items.push(item);
      routed.push({ item, triage: null, destination: routeAttention(item, routingCtx) });
      recoveryInputs.push({ id: recovery.id, kind: recovery.kind, status: recovery.status });
    }

    if (blockedBy.length > 0) {
      const item: AttentionItem = {
        kind: "blocker_attention",
        issueId: issue.id,
        identifier: label,
        sourceId: `blocked-by:${issue.id}`,
        pendingSince: nowIso,
        detail: `blocked by ${blockedBy.join(", ")}`,
      };
      items.push(item);
      routed.push({ item, triage: null, destination: routeAttention(item, routingCtx) });
    }

    for (const run of failedRuns) {
      const item: AttentionItem = {
        kind: "failed_run",
        issueId: issue.id,
        identifier: label,
        sourceId: run.id,
        pendingSince: iso(run.finishedAt, nowIso),
        detail: `failed run ${run.id.slice(0, 8)}${run.error ? `: ${run.error.slice(0, 120)}` : ""}`,
      };
      items.push(item);
      routed.push({ item, triage: null, destination: routeAttention(item, routingCtx) });
    }
  }

  const approvals = await reads.listPendingApprovals(companyId);
  const approvalInputs: { id: string; issueId: string | null; status: string }[] = [];
  for (const approval of approvals) {
    const item: AttentionItem = {
      kind: "approval",
      issueId: approval.issueId ?? companyId,
      sourceId: approval.id,
      pendingSince: iso(approval.createdAt, nowIso),
      detail: approval.issueId
        ? `pending approval ${approval.id.slice(0, 8)}`
        : `pending approval ${approval.id.slice(0, 8)} (company scope, no linked issue)`,
    };
    items.push(item);
    routed.push({ item, triage: null, destination: routeAttention(item, routingCtx) });
    approvalInputs.push({ id: approval.id, issueId: approval.issueId, status: approval.status });
  }

  for (const item of await reads.extraItems(companyId)) {
    items.push(item);
    routed.push({ item, triage: null, destination: routeAttention(item, routingCtx) });
  }

  const retryPlans: RetryPlan[] = routed
    .filter((r) => r.destination.type === "retry")
    .map((r) =>
      planRetry({
        item: r.item,
        attempt: r.destination.type === "retry" ? r.destination.attempt : 1,
        maxAttempts: r.destination.type === "retry" ? r.destination.maxAttempts : config.maxRetryAttempts,
        firedKeys,
        applyMutations: config.applyMutations,
        nowMs: now.getTime(),
      }),
    );
  const auto = routed.filter((r) => r.destination.type !== "ceo-digest").length;
  const metrics = [...slaMetrics(items, now), ...sweepCounters(auto, routed.length - auto)];
  const recoveryPlans = planRecoveryActions(recoveryInputs, { applyMutations: config.applyMutations });
  const approvalPlans = planApprovalActions(approvalInputs, { applyMutations: config.applyMutations });
  return {
    items,
    routed,
    retryPlans,
    recoveryPlans,
    approvalPlans,
    metrics,
    digest: renderDigest(routed, now, !config.applyMutations),
    scannedIssues: issues.length,
  };
}
