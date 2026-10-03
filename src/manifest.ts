import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import { INSTANCE_CONFIG_SCHEMA } from "./config.js";
import { JOB_KEYS, PLUGIN_API_VERSION, PLUGIN_ID, PLUGIN_VERSION, SWEEP_SCHEDULE } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: PLUGIN_API_VERSION,
  version: PLUGIN_VERSION,
  displayName: "Decision Router",
  description:
    "Sweeps every Decisions-page source (interactions, recovery, blockers, reviews, failed runs, approvals), routes deterministically first, and digests the rest to the CEO desk with an applicable decision grammar.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issue.relations.read",
    "issue.subtree.read",
    "issues.orchestration.read",
    "issue.comments.read",
    "issue.comments.create",
    "issue.interactions.read",
    "issue.interactions.create",
    "issue.documents.read",
    "issue.documents.write",
    "approvals.read",
    "metrics.write",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "jobs.schedule",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  jobs: [
    {
      jobKey: JOB_KEYS.sweepDecisions,
      displayName: "Sweep Decisions-page sources",
      description:
        "Reads pending interactions, blocker edges, run summaries and approvals per open issue, routes deterministically, refreshes the CEO digest document, and writes SLA metrics. Shadow mode until cutover (no mutations).",
      schedule: SWEEP_SCHEDULE,
    },
  ],
  instanceConfigSchema: INSTANCE_CONFIG_SCHEMA as unknown as Record<string, unknown>,
};

export default manifest;
