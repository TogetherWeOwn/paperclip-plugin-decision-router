# AGENTS.md — paperclip-plugin-decision-router

Upstream-shaped public Paperclip plugin (MIT). SDK: `@paperclipai/plugin-sdk`.
Scaffold mirrors `paperclip-model-router`: `src/manifest.ts` + `src/worker.ts`
bundled by esbuild to `dist/`, per `package.json` `paperclipPlugin` paths.

## Contracts

- PRs follow `.github/pull_request_template.md` (seven sections) with a
  Conventional Commits title (`type(scope): summary`, ≤100 chars). Merging is
  squash only. Done means merged. Public repo: never put `TOG-`/`PAP-` IDs,
  private URLs, or secrets in titles, bodies, commits, or branch names.
- `npm run verify` (typecheck + tests + build) is green before every push.
- Pure domain logic lives in `src/` (`triage`, `grammar`, `routing`,
  `metrics`, `sweep`) with unit tests; `src/worker.ts` only wires the SDK.
- Shadow rule: the sweep never mutates. Mutation rights
  (`issue.interactions.respond`, `approvals.respond`, `issues.wakeup`,
  `issue.relations.write`) enter the manifest only at the cutover slice with
  owner approval.
- Review economy: one review per PR; the approving reviewer squash-merges.
