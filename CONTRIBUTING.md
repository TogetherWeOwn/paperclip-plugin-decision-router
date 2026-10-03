# Contributing

## Workflow

1. Branch from `main` (`type/short-slug`).
2. Keep each PR to one logical change. Assert on exit status / verdicts, not
   on printed output.
3. Run `npm run verify` before pushing. Say what you did not run.
4. Fill in all seven PR template sections. Model Used names the provider plus
   the exact model ID.

## Tests

Vitest (`tests/**/*.spec.ts`). Cover the verdict, the route, and the grammar
line — not the prose around them. The SDK harness (`worker.spec.ts`) seeds
host entities; the shadow comparison recipe lives in `docs/SHADOW.md`.
