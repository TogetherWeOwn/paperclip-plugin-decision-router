/**
 * Attention taxonomy: the six Decisions-page (/TOG/decisions) item kinds from
 * TOG-13484 (operator read 2026-10-03 17:35Z, 336 items).
 *
 * Each kind names the verb that clears it:
 * blocker_attention → unblock · recovery_action → resolve · review → choose
 * review path · issue_thread_interaction → respond/accept · failed_run → retry
 * · approval → approve.
 */
export const ATTENTION_KINDS = [
  "blocker_attention",
  "recovery_action",
  "review",
  "issue_thread_interaction",
  "failed_run",
  "approval",
] as const;

export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export interface AttentionItem {
  kind: AttentionKind;
  /** Company issue id the item belongs to. */
  issueId: string;
  /** Human-readable board identifier (e.g. TOG-1234) when known. */
  identifier?: string;
  /** Stable source id: interaction id, recovery-action id, run id, approval id. */
  sourceId: string;
  /** ISO 8601 timestamp when the item became pending. */
  pendingSince: string;
  /** Free-form source detail (policy, addressee, error) for the digest. */
  detail?: string;
}

/** Whole hours between `pendingSince` and `now`. Unknown/unparseable → null (never 0: absence is not youth). */
export function ageHours(item: Pick<AttentionItem, "pendingSince">, now: Date = new Date()): number | null {
  const since = Date.parse(item.pendingSince);
  if (!Number.isFinite(since)) return null;
  const diff = now.getTime() - since;
  if (diff < 0) return null;
  return Math.floor(diff / 3_600_000);
}

export interface KindSummary {
  kind: AttentionKind;
  count: number;
  /** Median age in hours over items with a known age; null when none known. */
  medianAgeHours: number | null;
  maxAgeHours: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.floor(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** SLA snapshot: count + median/max age per kind. Items with unknown age count but never move the median. */
export function summarizeByKind(items: AttentionItem[], now: Date = new Date()): KindSummary[] {
  return ATTENTION_KINDS.map((kind) => {
    const ages = items
      .filter((item) => item.kind === kind)
      .map((item) => ageHours(item, now))
      .filter((age): age is number => age !== null);
    const count = items.filter((item) => item.kind === kind).length;
    return {
      kind,
      count,
      medianAgeHours: median(ages),
      maxAgeHours: ages.length > 0 ? Math.max(...ages) : null,
    };
  });
}
