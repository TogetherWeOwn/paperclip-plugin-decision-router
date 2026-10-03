/**
 * SLA metrics: count + age per attention kind, exposed for Gatus scraping.
 *
 * Two surfaces carry the same per-kind snapshot:
 *   1. Metric points (written via `metrics.write`, tags carry the kind):
 *        decision_router.attention.count{kind}        — pending items
 *        decision_router.attention.age_median_hours{kind}
 *        decision_router.attention.age_max_hours{kind}
 *        decision_router.sweep.items_total             — items seen this sweep
 *        decision_router.sweep.routed_auto             — deterministic routes
 *        decision_router.sweep.routed_ceo              — digest routes
 *   2. The `sla-metrics` data endpoint, which returns the JSON snapshot built
 *      by `slaSnapshot` below (persisted on the last-sweep state record, so
 *      the endpoint stays a read-only `state.get` — shadow-safe, no SDK reads
 *      and no mutation rights).
 */
import { summarizeByKind, type AttentionItem, type KindSummary } from "./attention.js";

export interface MetricPoint {
  name: string;
  value: number;
  tags?: Record<string, string>;
}

/** JSON-safe per-kind SLA snapshot served on the `sla-metrics` data endpoint for Gatus. */
export interface SlaSnapshot {
  at: string;
  scannedIssues: number;
  itemsTotal: number;
  routedAuto: number;
  routedCeo: number;
  /** One entry per attention kind, always all six (zero-counts included). */
  byKind: KindSummary[];
}

export function slaSnapshot(
  items: AttentionItem[],
  now: Date,
  scannedIssues: number,
  routedAuto: number,
  routedCeo: number,
): SlaSnapshot {
  return {
    at: now.toISOString(),
    scannedIssues,
    itemsTotal: items.length,
    routedAuto,
    routedCeo,
    byKind: summarizeByKind(items, now),
  };
}

export function slaMetrics(items: AttentionItem[], now: Date = new Date()): MetricPoint[] {
  const points: MetricPoint[] = [];
  for (const summary of summarizeByKind(items, now)) {
    points.push({ name: "decision_router.attention.count", value: summary.count, tags: { kind: summary.kind } });
    if (summary.medianAgeHours !== null) {
      points.push({
        name: "decision_router.attention.age_median_hours",
        value: summary.medianAgeHours,
        tags: { kind: summary.kind },
      });
    }
    if (summary.maxAgeHours !== null) {
      points.push({
        name: "decision_router.attention.age_max_hours",
        value: summary.maxAgeHours,
        tags: { kind: summary.kind },
      });
    }
  }
  return points;
}

export function sweepCounters(auto: number, ceo: number): MetricPoint[] {
  return [
    { name: "decision_router.sweep.items_total", value: auto + ceo },
    { name: "decision_router.sweep.routed_auto", value: auto },
    { name: "decision_router.sweep.routed_ceo", value: ceo },
  ];
}
