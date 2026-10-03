/**
 * CEO digest: the one card that replaces 336 scattered Decisions-page items.
 *
 * Rendered as markdown into the `ceo-decision-digest` document on the CEO desk
 * card (a no-wake record — writing a document wakes nobody). Each item carries
 * its triage verdict (who could answer it TODAY), its deterministic route,
 * and the grammar stub the CEO edits into a command to decide it (slice 2
 * applies commands; slice 1 records only).
 */
import { ATTENTION_KINDS, ageHours, type AttentionItem } from "./attention.js";
import type { RoutedItem } from "./routing.js";

const KIND_VERBS: Record<AttentionItem["kind"], string> = {
  blocker_attention: "unblock",
  recovery_action: "resolve",
  review: "choose review path",
  issue_thread_interaction: "respond/accept",
  failed_run: "retry",
  approval: "approve",
};

function describeDestination(routed: RoutedItem): string {
  const destination = routed.destination;
  switch (destination.type) {
    case "code-reviewer":
      return "auto → Code Reviewer";
    case "blocker-owner":
      return "auto → blocker owner";
    case "park":
      return "auto → parked";
    case "reconciler":
      return "auto → reconciler";
    case "retry":
      return `auto → retry (${destination.attempt}/${destination.maxAttempts})`;
    case "ceo-digest":
      return "needs CEO decision";
  }
}

function grammarStub(routed: RoutedItem): string {
  const { item } = routed;
  switch (item.kind) {
    case "issue_thread_interaction":
      return `ANSWER ${item.sourceId} accept|reject`;
    case "recovery_action":
      return `RESOLVE ${item.sourceId} resolve|park|escalate`;
    case "failed_run":
      return `RETRY ${item.sourceId}`;
    case "approval":
      return `APPROVE ${item.sourceId}`;
    case "blocker_attention":
    case "review":
      return `DECIDE ${item.identifier ?? item.issueId} <option-id>`;
  }
}

export function renderDigest(routed: RoutedItem[], now: Date, shadow: boolean): string {
  const at = now.toISOString();
  const auto = routed.filter((r) => r.destination.type !== "ceo-digest").length;
  const lines = [
    `# CEO decision digest — ${at}`,
    "",
    shadow
      ? "_Shadow mode: routes computed, nothing applied. Grammar stubs below are inert until the cutover slice._"
      : "_Live mode: deterministic routes applied; stubs below decided on reply._",
    "",
    `Items: ${routed.length} (${auto} auto-routed, ${routed.length - auto} need a decision)`,
    "",
  ];
  for (const kind of ATTENTION_KINDS) {
    const group = routed.filter((r) => r.item.kind === kind);
    if (group.length === 0) continue;
    lines.push(`## ${kind} (${group.length} · verb: ${KIND_VERBS[kind]})`, "");
    for (const r of group) {
      const age = ageHours(r.item, now);
      const ageText = age === null ? "age unknown" : `${age}h old`;
      const triage = r.triage
        ? `triage ${r.triage.verdict} (${r.triage.resolvers.join(", ") || "nobody"}; wake: ${r.triage.continuation})`
        : "triage n/a";
      const label = r.item.identifier ?? (r.item.issueId !== "" ? r.item.issueId : r.item.sourceId);
      lines.push(
        `- [${label}] ${r.item.detail ?? r.item.sourceId} — ${ageText}`,
        `  ${triage}; ${describeDestination(r)}; ${r.destination.reason}`,
        `  \`${grammarStub(r)}\``,
      );
    }
    lines.push("");
  }
  if (routed.length === 0) {
    lines.push("No pending attention. The page reflects real decisions only.", "");
  }
  return lines.join("\n");
}
