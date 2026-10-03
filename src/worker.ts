/**
 * Decision Router worker: scheduled sweep + event nudges, shadow mode first.
 *
 * Slice 1 (TOG-13484) persists three things per sweep and mutates nothing:
 *   1. the CEO digest document (`ceo-decision-digest`) on the configured desk
 *      card — a no-wake record;
 *   2. SLA metric points (count + median/max age per attention kind);
 *   3. the last-sweep record in plugin state (per company).
 *
 * Applying a route (respondInteraction, recovery resolve, wakeup/retry,
 * approval decide, park edge) and applying CEO grammar commands are the
 * cutover slice, behind `applyMutations: true`. Event handlers only record a
 * sweep hint; the scheduled job does the work.
 */
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { IssueThreadInteraction } from "@paperclipai/shared";

import { CEO_DIGEST_DOCUMENT_KEY, DATA_KEYS, JOB_KEYS, PLUGIN_VERSION, STATE_KEYS } from "./constants.js";
import { resolveConfig } from "./config.js";
import { slaSnapshot } from "./metrics.js";
import { applyRetryPlans, RETRY_KEYS_CAP, type RetryFirePlan } from "./retry.js";
import { sweepDecisions, type SweepPrior, type SweepReads } from "./sweep.js";

function isoDate(value: Date | string | null | undefined, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

function hasToolAction(ix: IssueThreadInteraction): boolean {
  const payload = (ix as { payload?: unknown }).payload;
  return (
    !!payload &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).toolAction !== undefined &&
    (payload as Record<string, unknown>).toolAction !== null &&
    (payload as Record<string, unknown>).toolAction !== false
  );
}

function readsFor(ctx: PluginContext): SweepReads {
  return {
    async listOpenIssues(companyId, limit) {
      const issues = await ctx.issues.list({ companyId, limit });
      return issues.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        status: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
      }));
    },
    async listPendingInteractions(issueId, companyId) {
      const nowIso = new Date().toISOString();
      const interactions = await ctx.issues.listInteractions(issueId, companyId);
      return interactions
        .filter((ix) => ix.status === "pending")
        .map((ix) => ({
          id: ix.id,
          kind: ix.kind,
          status: ix.status,
          effectiveResolverPolicy: ix.effectiveResolverPolicy,
          createdByAgentId: ix.createdByAgentId ?? null,
          addresseeAgentId: ix.addresseeAgentId ?? null,
          hasToolAction: hasToolAction(ix),
          continuationPolicy: ix.continuationPolicy,
          createdAt: isoDate(ix.createdAt, nowIso),
          title: ix.title ?? null,
        }));
    },
    async listRelations(issueId, companyId) {
      const nowIso = new Date().toISOString();
      const relations = await ctx.issues.relations.get(issueId, companyId);
      const seen = new Map<string, { id: string; kind: string; status: string; createdAt: string }>();
      for (const edge of [...relations.blockedBy, ...relations.blocks]) {
        const action = edge.activeRecoveryAction;
        // Only unresolved actions attention: resolved/cancelled ones are history.
        if (action && (action.status === "active" || action.status === "escalated") && !seen.has(action.id)) {
          seen.set(action.id, {
            id: action.id,
            kind: action.kind,
            status: action.status,
            createdAt: isoDate(action.createdAt, nowIso),
          });
        }
      }
      return { blockedByIds: relations.blockedBy.map((edge) => edge.id), activeRecovery: [...seen.values()] };
    },
    async listPendingApprovals(companyId) {
      const approvals = await ctx.approvals.list({ companyId, status: "pending" });
      const nowIso = new Date().toISOString();
      return approvals.map((approval) => {
        const payload = approval.payload as Record<string, unknown>;
        const linked = typeof payload.issueId === "string" ? payload.issueId : null;
        return {
          id: approval.id,
          issueId: linked,
          status: approval.status,
          createdAt: isoDate(approval.createdAt, nowIso),
        };
      });
    },
    async listFailedRuns(issueId, companyId) {
      const summary = await ctx.issues.summaries.getOrchestration({ issueId, companyId });
      const nowIso = new Date().toISOString();
      return summary.runs
        .filter((run) => run.status === "failed")
        .map((run) => ({
          id: run.id,
          issueId: run.issueId,
          status: run.status,
          finishedAt: run.finishedAt ? isoDate(new Date(run.finishedAt), nowIso) : null,
          error: run.error,
        }));
    },
    // No SDK source for recovery actions or review state (gaps G-02/G-04).
    async extraItems() {
      return [];
    },
  };
}

interface PriorRetryMemory {
  retryAttempts?: Record<string, number>;
  retriedKeys?: string[];
}

async function runSweep(ctx: PluginContext, companyId: string): Promise<void> {
  const config = resolveConfig(await ctx.config.get(companyId));
  const now = new Date();
  const priorRecord = (await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: STATE_KEYS.lastSweep,
  })) as PriorRetryMemory | undefined;
  const prior: SweepPrior = {
    retryAttempts: priorRecord?.retryAttempts ?? {},
    retriedKeys: priorRecord?.retriedKeys ?? [],
  };
  const result = await sweepDecisions(companyId, config, readsFor(ctx), now, prior);

  // Failed-run retry verb: fire only behind `applyMutations`. In shadow mode
  // every plan comes back unapplied (proposals live in the digest + state).
  // Note the manifest still lacks `issues.wakeup` (gap G-05): that capability
  // lands at the cutover slice, so the host denies any premature fire too.
  const fireRetry = async (plan: RetryFirePlan): Promise<void> => {
    await ctx.issues.requestWakeup(plan.issueId, companyId, {
      reason: `Decision Router retry: ${plan.reason}`,
      idempotencyKey: plan.idempotencyKey,
    });
  };
  const retryOutcomes = await applyRetryPlans(result.retryPlans, {
    applyMutations: config.applyMutations,
    fire: fireRetry,
  });
  const retryAttempts: Record<string, number> = { ...(prior.retryAttempts ?? {}) };
  const retriedKeys: string[] = [...(prior.retriedKeys ?? [])];
  for (const outcome of retryOutcomes) {
    if (outcome.plan.action !== "fire") continue;
    if (!outcome.applied) {
      ctx.logger.error("Decision retry failed", {
        companyId,
        runKey: outcome.plan.runKey,
        error: outcome.error ?? "unknown error",
      });
      continue;
    }
    retryAttempts[outcome.plan.runKey] = outcome.plan.attempt;
    retriedKeys.push(outcome.plan.idempotencyKey);
  }

  for (const point of result.metrics) {
    await ctx.metrics.write(point.name, point.value, { ...point.tags, companyId });
  }

  if (config.ceoDeskIssueId) {
    await ctx.issues.documents.upsert({
      issueId: config.ceoDeskIssueId,
      key: CEO_DIGEST_DOCUMENT_KEY,
      companyId,
      title: `CEO decision digest — ${now.toISOString()}`,
      format: "markdown",
      body: result.digest,
      changeSummary: `sweep: ${result.items.length} items, ${result.scannedIssues} issues scanned`,
    });
  }

  const routedAuto = result.routed.filter((r) => r.destination.type !== "ceo-digest").length;
  const snapshot = slaSnapshot(result.items, now, result.scannedIssues, routedAuto, result.routed.length - routedAuto);

  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.lastSweep },
    {
      at: now.toISOString(),
      scannedIssues: result.scannedIssues,
      items: result.items.length,
      digestChars: result.digest.length,
      digestIssueId: config.ceoDeskIssueId,
      shadow: !config.applyMutations,
      // Per-kind SLA snapshot for the `sla-metrics` data endpoint (Gatus).
      // Kept beside the legacy fields so existing readers keep working.
      itemsTotal: snapshot.itemsTotal,
      routedAuto: snapshot.routedAuto,
      routedCeo: snapshot.routedCeo,
      byKind: snapshot.byKind,
      // Retry memory for the next sweep: attempts fired per runKey plus the
      // idempotency keys already fired (capped; crash-window dedup).
      retryAttempts,
      retriedKeys: retriedKeys.slice(-RETRY_KEYS_CAP),
      retryFired: retryOutcomes.filter((outcome) => outcome.applied).length,
      retryFailed: retryOutcomes.filter((outcome) => !outcome.applied && outcome.error).length,
    },
  );

  ctx.logger.info("Decision sweep complete", {
    companyId,
    scannedIssues: result.scannedIssues,
    items: result.items.length,
    retryPlans: result.retryPlans.length,
    shadow: !config.applyMutations,
  });
}

export function createPlugin() {
  return definePlugin({
  async setup(ctx) {
    ctx.logger.info("Decision Router worker starting", { version: PLUGIN_VERSION });

    ctx.jobs.register(JOB_KEYS.sweepDecisions, async () => {
      for (const company of await ctx.companies.list({})) {
        try {
          await runSweep(ctx, company.id);
        } catch (error) {
          ctx.logger.error("Decision sweep failed", {
            companyId: company.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    // Event nudges: record a hint for the next scheduled sweep. The sweep
    // itself stays on the 5-minute schedule so bursts of events never fan out
    // into bursts of company-wide scans.
    for (const event of [
      "issue.created",
      "issue.updated",
      "issue.comment.created",
      "issue.relations.updated",
      "approval.created",
      "agent.run.failed",
    ] as const) {
      ctx.events.on(event, async (evt) => {
        await ctx.state.set(
          { scopeKind: "company", scopeId: evt.companyId, stateKey: "sweep-hint" },
          { at: new Date().toISOString(), what: evt.eventType },
        );
      });
    }

    // Read-only Gatus surface: returns the last sweep's SLA snapshot
    // ({ at, scannedIssues, items/Total, routedAuto/Ceo, shadow, byKind[] })
    // where each byKind entry is { kind, count, medianAgeHours, maxAgeHours }.
    // No SDK reads, no mutations — a plain `state.get`.
    ctx.data.register(DATA_KEYS.slaMetrics, async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : undefined;
      if (!companyId) return { error: "companyId param required" };
      const record = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.lastSweep });
      if (!record) return { error: "no sweep yet" };
      return record;
    });

    ctx.logger.info("Decision Router worker ready", { version: PLUGIN_VERSION });
  },

  async onHealth() {
    return { status: "ok", message: `Decision Router ${PLUGIN_VERSION}` };
  },

  async onValidateConfig(raw: Record<string, unknown>) {
    const config = resolveConfig(raw);
    const warnings: string[] = [];
    if (!config.ceoDeskIssueId) warnings.push("ceoDeskIssueId is unset — digests record to plugin state only");
    if (!config.codeReviewerAgentId) warnings.push("codeReviewerAgentId is unset — review routes name no owner");
    if (config.applyMutations) warnings.push("applyMutations is true — sweeps MUTATE (cutover mode)");
    return { ok: true, warnings };
  },
  });
}

const plugin = createPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
