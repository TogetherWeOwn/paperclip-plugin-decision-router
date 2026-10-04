/**
 * Blocker diagnostics evidence pack (read-only).
 *
 * The Decisions page lights `blocker_attention` items from raw relation edges
 * plus board-only attention classification the SDK cannot read (gap G-03). This
 * module closes the evidence half of that gap without touching the mutation
 * half: given fixture-grade rows (blocker edge + age source + owner), it builds
 * a proposal payload — per-edge evidence with the stale-edge flag — and stops
 * there. The output is plain data: there is no `apply` function, no injected
 * mutator, and no code path that reaches `removeBlockers`. Clearing a stale
 * edge stays the unblock verb's job (`src/unblock.ts`, behind
 * `applyMutations`); this pack only says what the evidence supports.
 *
 * Age reuses `ageHours` (unknown/unparseable timestamps stay null — absence is
 * not youth) and staleness reuses `isStaleBlockerStatus` (unknown statuses
 * fail closed, never stale).
 */
import { ageHours } from "./attention.js";
import { isStaleBlockerStatus } from "./unblock.js";

/** One blocked-issue/blocker pair as read off the relations feed. */
export interface BlockerPackInput {
  blockedIssueId: string;
  blockedIdentifier: string | null;
  blockerIssueId: string;
  blockerIdentifier: string | null;
  blockerStatus: string;
  /** Agent id owning the blocked issue; null when unknown (owner route undecided). */
  ownerAgentId: string | null;
  /** ISO 8601 timestamp when the blocked item became pending. */
  pendingSince: string;
}

/** Proposal-only evidence for one blocker edge. Carries no mutation affordance. */
export interface BlockerEdgeEvidence {
  blockedIssueId: string;
  blockedIdentifier: string | null;
  blockerIssueId: string;
  blockerIdentifier: string | null;
  blockerStatus: string;
  /** Whole hours pending; null when the timestamp is unknown or unparseable. */
  ageHours: number | null;
  ownerAgentId: string | null;
  /** True only when the blocker status proves the edge stale (done/cancelled). */
  stale: boolean;
  /** One-line human-readable proposal: unblock proposal vs owner-route-stands. */
  proposal: string;
}

export interface BlockerDiagnosticsPack {
  /** ISO 8601 timestamp the pack was built (`now`). */
  at: string;
  edges: BlockerEdgeEvidence[];
  edgeCount: number;
  staleCount: number;
  openCount: number;
  unknownOwnerCount: number;
  unknownAgeCount: number;
}

function shortLabel(identifier: string | null, id: string): string {
  return identifier ?? id.slice(0, 8);
}

function proposalLine(evidence: Omit<BlockerEdgeEvidence, "proposal">): string {
  const blocker = shortLabel(evidence.blockerIdentifier, evidence.blockerIssueId);
  const blocked = shortLabel(evidence.blockedIdentifier, evidence.blockedIssueId);
  const age = evidence.ageHours === null ? "age unknown" : `${evidence.ageHours}h old`;
  const owner = evidence.ownerAgentId ?? "owner unknown";
  const edge = `${blocker} (${evidence.blockerStatus}) blocks ${blocked}`;
  return evidence.stale ? `proposes unblock: ${edge} — ${age}, ${owner}` : `owner route stands: ${edge} — ${age}, ${owner}`;
}

/** Pure: turn fixture-grade blocker rows into a proposal-only evidence pack. */
export function buildBlockerPack(inputs: BlockerPackInput[], now: Date = new Date()): BlockerDiagnosticsPack {
  const edges: BlockerEdgeEvidence[] = inputs.map((input) => {
    const base = {
      blockedIssueId: input.blockedIssueId,
      blockedIdentifier: input.blockedIdentifier,
      blockerIssueId: input.blockerIssueId,
      blockerIdentifier: input.blockerIdentifier,
      blockerStatus: input.blockerStatus,
      ageHours: ageHours({ pendingSince: input.pendingSince }, now),
      ownerAgentId: input.ownerAgentId,
      stale: isStaleBlockerStatus(input.blockerStatus),
    };
    return { ...base, proposal: proposalLine(base) };
  });
  return {
    at: now.toISOString(),
    edges,
    edgeCount: edges.length,
    staleCount: edges.filter((edge) => edge.stale).length,
    openCount: edges.filter((edge) => !edge.stale).length,
    unknownOwnerCount: edges.filter((edge) => edge.ownerAgentId === null).length,
    unknownAgeCount: edges.filter((edge) => edge.ageHours === null).length,
  };
}
