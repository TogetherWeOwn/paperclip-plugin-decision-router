/**
 * SLA metrics: count + age per attention kind, exposed for Gatus (TOG-13367).
 *
 * Metric names (written via `metrics.write`, tags carry the kind):
 *   decision_router.attention.count{kind}        — pending items
 *   decision_router.attention.age_median_hours{kind}
 *   decision_router.attention.age_max_hours{kind}
 *   decision_router.sweep.items_total             — items seen this sweep
 *   decision_router.sweep.routed_auto             — deterministic routes
 *   decision_router.sweep.routed_ceo              — digest routes
 */
import { summarizeByKind, type AttentionItem } from "./attention.js";

export interface MetricPoint {
  name: string;
  value: number;
  tags?: Record<string, string>;
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
