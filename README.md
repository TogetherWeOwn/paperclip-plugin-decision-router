# paperclip-plugin-decision-router

Paperclip plugin: no approval request sits unanswered. Every Decisions-page
item — interactions, recovery actions, blockers, reviews, failed runs,
approvals — is routed deterministically first; the rest lands on the CEO desk
as one digest with an applicable decision grammar.

Status: slice 1 (shadow mode). The 5-minute sweep computes routes, writes the
CEO digest document, and records SLA metrics — and mutates nothing. See
`docs/SHADOW.md` for the shadow-run comparison and cutover criterion,
`docs/GRAMMAR.md` for the decision grammar, `docs/GAPS.md` for host
capability gaps filed via the TOG-13346 ledger.

## Develop

```sh
npm install
npm run verify   # typecheck + tests + build
```

## Configure (operator)

```json
{
  "ceoDeskIssueId": "<CEO desk card issue id>",
  "codeReviewerAgentId": "<Code Reviewer agent id>",
  "focusAnchorIssueId": "<focus anchor issue id, optional>",
  "sweepPageSize": 50,
  "maxRetryAttempts": 2,
  "applyMutations": false
}
```

Leave `applyMutations: false` until the cutover slice. Setting it `true`
makes sweeps mutate (respond/resolve/wakeup/decide) — owner approval required.
