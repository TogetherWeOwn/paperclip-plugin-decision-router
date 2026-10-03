export const PLUGIN_ID = "togetherweown.paperclip-decision-router";

/** Kept in sync with package.json by `npm run verify`. */
export const PLUGIN_VERSION = "0.1.0";

export const PLUGIN_API_VERSION = 1 as const;

export const JOB_KEYS = {
  /** Sweep every Decisions-page source, route deterministically, digest the rest. */
  sweepDecisions: "sweep-decisions",
} as const;

/** Cron: every 5 minutes. Matches the 5–10 min cadence in TOG-13484. */
export const SWEEP_SCHEDULE = "*/5 * * * *";

export const DATA_KEYS = {
  /** Latest SLA snapshot (count + age per attention kind) for Gatus/dashboards. */
  slaMetrics: "sla-metrics",
} as const;

export const STATE_KEYS = {
  /** Last completed sweep record (at, counts, digest document revision). */
  lastSweep: "last-sweep",
} as const;

/** Issue-document key for the CEO digest on the CEO desk card. No-wake record. */
export const CEO_DIGEST_DOCUMENT_KEY = "ceo-decision-digest";

/** Default cap: issues scanned per sweep before paginating to the next run. */
export const DEFAULT_SWEEP_PAGE_SIZE = 50;
