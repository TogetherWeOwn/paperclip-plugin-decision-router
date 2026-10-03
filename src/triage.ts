/**
 * Triage classifier: who can actually answer a pending issue-thread
 * interaction, and will the answer start any work?
 *
 * TypeScript port of `interaction_triage.sh classify` from
 * paperclip-ops-tooling (TOG-423 + TOG-492). The gate order is transcribed
 * from the deployed server build cited there:
 *
 *   :2953  request_confirmation with payload.toolAction → ALWAYS board-only.
 *   :2946  assignee gate (via :2793): unassigned issues admit EVERY agent;
 *           assigned issues admit the assignee alone. Assigning NARROWS.
 *   :2956  review-verdict bypass: in_review + named reviewInteractionId +
 *           same-author requester skips the policy check entirely.
 *   :2962  effectiveResolverPolicy must be "board_or_agents".
 *   :2975  addressee must match if set; the creator may NEVER resolve their
 *           own; the same run may never resolve one it created.
 *
 * Second gate (TOG-492, routes/issues.js:1253): the continuation wake fires
 * only when the issue has an assignee AND is open. An answer on an unassigned
 * or closed issue is swallowed silently.
 *
 * INERT means "no agent can resolve it" — a board user still can. DEAD_WAKE
 * means "answerable, but the answer starts nothing". Never fold one into the
 * other.
 */
export type TriageVerdict =
  | "AGENT_RESOLVABLE"
  | "AGENT_REVIEW_VERDICT"
  | "OWNER_ONLY"
  | "INERT"
  | "MALFORMED";

export type ContinuationState =
  | "WAKES"
  | "WAKES_ON_ACCEPT"
  | "DEAD_WAKE"
  | "NO_WAKE_REQUESTED"
  | "UNKNOWN";

export interface TriageRow {
  identifier: string;
  kind: string;
  effectiveResolverPolicy: string;
  createdByAgentId: string;
  assigneeAgentId?: string | null;
  addresseeAgentId?: string | null;
  hasToolAction?: boolean;
  issueStatus?: string | null;
  /** True when the in_review transition named this interaction as reviewInteractionId (caller-asserted, never inferred). */
  namedReviewInteraction?: boolean;
  continuationPolicy?: string | null;
}

export interface TriageResult {
  identifier: string;
  verdict: TriageVerdict;
  why: string;
  resolvers: string[];
  warnings: string[];
  continuation: ContinuationState;
  continuationWhy: string;
}

const CLOSED_STATUSES = new Set(["done", "cancelled"]);

function classifyContinuation(row: TriageRow): {
  state: ContinuationState;
  why: string;
  deadWakeFix?: string;
} {
  const cp = row.continuationPolicy ?? null;
  const issueStatus = row.issueStatus ?? null;
  const noAssignee = (row.assigneeAgentId ?? null) === null;
  const closedIssue = issueStatus !== null && CLOSED_STATUSES.has(issueStatus);
  if (cp === null || cp === "") {
    return {
      state: "UNKNOWN",
      why: "row carried no continuationPolicy — the wake path was NOT measured",
    };
  }
  if (issueStatus === null || issueStatus === "") {
    return {
      state: "UNKNOWN",
      why: "row carried no issueStatus — issue openness was NOT measured",
    };
  }
  if (cp === "wake_assignee" || cp === "wake_assignee_on_accept") {
    if (closedIssue) {
      return {
        state: "DEAD_WAKE",
        why:
          `policy is ${cp} but the issue is ${issueStatus} — :1253 returns on ` +
          `isClosedIssueStatus.` +
          (noAssignee ? " It also has NO ASSIGNEE." : ""),
        deadWakeFix:
          "Move the issue to an open status through the normal resume path before " +
          "answering; if it is also unassigned, assign it only after reopening. " +
          "Assignment alone cannot repair a closed-issue wake.",
      };
    }
    if (noAssignee) {
      return {
        state: "DEAD_WAKE",
        why:
          `policy is ${cp} but the issue has NO ASSIGNEE — :1253 returns ` +
          "before waking anyone. The answer lands and nothing starts.",
        deadWakeFix: "Assign the issue; for a board_only card assign it to the creator.",
      };
    }
    if (cp === "wake_assignee_on_accept") {
      return {
        state: "WAKES_ON_ACCEPT",
        why: "accept wakes the assignee; a REJECTION wakes nobody (:1263).",
      };
    }
    return {
      state: "WAKES",
      why: "assignee present and issue open — an answer wakes them (:1253).",
    };
  }
  return {
    state: "NO_WAKE_REQUESTED",
    why:
      `continuationPolicy is ${cp} — no wake requested (:1265). An answer ` +
      "starts nothing unless the in_review reviewPathLost branch fires, which " +
      "also needs an assignee.",
  };
}

export function triageInteraction(row: TriageRow): TriageResult {
  const continuation = classifyContinuation(row);

  const missing: string[] = [];
  if (!row.identifier) missing.push("identifier");
  if (!row.kind) missing.push("kind");
  if (!row.effectiveResolverPolicy) missing.push("effectiveResolverPolicy");
  if (!row.createdByAgentId) missing.push("createdByAgentId");
  if (missing.length > 0) {
    // A row the classifier skips must never read as "nothing wrong here".
    return {
      identifier: row.identifier || "(no identifier)",
      verdict: "MALFORMED",
      why: `input row is missing required field(s): ${missing.join(", ")}`,
      resolvers: [],
      warnings: [],
      continuation: "UNKNOWN",
      continuationWhy: "not measured — the row is MALFORMED",
    };
  }

  const assignee = row.assigneeAgentId ?? null;
  const addressee = row.addresseeAgentId ?? null;
  const creator = row.createdByAgentId;
  const toolAction = (row.hasToolAction ?? false) && row.kind === "request_confirmation";
  // Review eligibility FAILS CLOSED: "in_review + a confirmation" is NOT
  // sufficient — the caller must assert this exact interaction was named as
  // reviewInteractionId. Defaulting true once mis-reported a spend approval,
  // a credential placement and a brand decision as agent-resolvable.
  const reviewVerdict =
    (row.issueStatus ?? "") === "in_review" &&
    (row.namedReviewInteraction ?? false) &&
    (row.kind === "request_confirmation" || row.kind === "request_checkbox_confirmation");
  const policyOk = row.effectiveResolverPolicy === "board_or_agents";
  const unassigned = assignee === null;

  const warnings: string[] = [];
  if (unassigned && addressee === null && creator !== "") {
    warnings.push(
      "assigning this issue NARROWS who may answer it (:2793). Assigning it to the " +
        "creator makes it permanently INERT (:2975) — assign_would_kill.",
    );
  }
  if ((row.issueStatus ?? "") === "in_progress" && !unassigned) {
    warnings.push(
      "issue is in_progress: the assignee holds a checkout run-lock (:2799), so only " +
        "their live run can resolve this.",
    );
  }
  if (continuation.state === "DEAD_WAKE" && continuation.deadWakeFix) {
    warnings.push(`the wake path is DEAD (:1253): ${continuation.why} Remediation: ${continuation.deadWakeFix}`);
  }

  // :2953 tool-action confirmations are always board-only. No exceptions.
  if (toolAction) {
    return {
      identifier: row.identifier,
      verdict: "OWNER_ONLY",
      why: "request_confirmation carries payload.toolAction — always board-only (:2953)",
      resolvers: [],
      warnings,
      continuation: continuation.state,
      continuationWhy: continuation.why,
    };
  }
  if (!reviewVerdict && !policyOk) {
    return {
      identifier: row.identifier,
      verdict: "OWNER_ONLY",
      why:
        `effectiveResolverPolicy is ${row.effectiveResolverPolicy} and no in_review ` +
        "transition named it as reviewInteractionId (:2962)",
      resolvers: [],
      warnings,
      continuation: continuation.state,
      continuationWhy: continuation.why,
    };
  }

  // :2946 → :2793. Unassigned admits everyone; assigned admits the assignee alone.
  const passers: string[] | "*" = unassigned ? "*" : [assignee as string];
  // :2975 addressee match, then the creator bar. The creator can never be eligible.
  let eligible: string[] | "*";
  if (addressee === null) {
    eligible = passers;
  } else if (passers === "*") {
    eligible = [addressee];
  } else {
    eligible = passers.filter((id) => id === addressee);
  }
  if (eligible !== "*") {
    eligible = eligible.filter((id) => id !== creator);
  }

  if (eligible !== "*" && eligible.length === 0) {
    let why: string;
    if (addressee !== null && !unassigned && addressee !== assignee) {
      why = "addressed to an agent who cannot pass the assignee gate (:2946)";
    } else if (addressee !== null && addressee === creator) {
      why = "addressed to its own creator — creator bar (:2975)";
    } else {
      why = "the only agent who can pass the assignee gate IS the creator — creator bar (:2975)";
    }
    return {
      identifier: row.identifier,
      verdict: "INERT",
      why,
      resolvers: [],
      warnings,
      continuation: continuation.state,
      continuationWhy: continuation.why,
    };
  }

  if (reviewVerdict && !policyOk) {
    return {
      identifier: row.identifier,
      verdict: "AGENT_REVIEW_VERDICT",
      why: "in_review and named as reviewInteractionId — policy check bypassed (:2956)",
      resolvers: eligible === "*" ? ["<any agent except the creator>"] : eligible,
      warnings,
      continuation: continuation.state,
      continuationWhy: continuation.why,
    };
  }
  return {
    identifier: row.identifier,
    verdict: "AGENT_RESOLVABLE",
    why:
      unassigned && addressee === null
        ? "unassigned issue: any agent except the creator (:2793 + :2975)"
        : "resolvable by the named agent(s) below",
    resolvers: eligible === "*" ? ["<any agent except the creator>"] : eligible,
    warnings,
    continuation: continuation.state,
    continuationWhy: continuation.why,
  };
}
