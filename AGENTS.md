# Repository Guidelines

## Project Structure & Module Organization
- Frontend application code lives under `src/`, including `components/`, `components/ui/`, `hooks/`, `lib/`, and `pages/`.
- Cloudflare Worker code lives under `worker/src/`, with tests colocated as `*.test.ts`.
- Environment and deploy configuration lives in `worker/wrangler.*.toml`, root `wrangler.toml`, and `.env.local` for Vite-only variables. Treat those files as the source of truth for domains and bindings.
- Supporting docs live in `README.md`, `DEPLOYMENT.md`, `CONTEXT.md`, `NIP.md`, and `docs/`.

## Build, Test, and Validation Commands
- `npm run test`: primary repo test command.
- `npx tsc --noEmit`: frontend and shared type-check.
- `npx vite build`: frontend production build.
- `cd worker && npx vitest run`: worker tests when touching worker code.
- `cd worker && npx wrangler dev --config wrangler.local.toml`: local worker development. Never deploy with local config.

## Coding Style & Naming Conventions
- Keep frontend and worker changes scoped. Do not mix unrelated UI, worker, relay-integration, and deployment cleanup in one PR.
- Follow the existing React, TypeScript, Tailwind, TanStack Query, and Cloudflare Worker patterns already established in the repo.
- Verify domains, bindings, and env var names against wrangler config files before introducing or changing URLs. Do not hardcode environment-specific domains in application code.

## Security & Operational Notes
- Never commit secrets, CF Access credentials, API keys, service tokens, or screenshots/logs containing sensitive values.
- Public issues, PRs, branch names, screenshots, and descriptions must not mention corporate partners, customers, brands, campaign names, or other sensitive external identities unless a maintainer explicitly approves it. Use generic descriptors instead.
- If touching moderation workflows, trace side effects carefully and avoid fire-and-forget behavior.

## Pull Request Guardrails
- PR titles must use Conventional Commit format: `type(scope): summary` or `type: summary`.
- Set the correct PR title when opening the PR. Do not rely on fixing it later.
- If a PR title is edited after opening, verify that the semantic PR title check reruns successfully.
- Keep PRs tightly scoped. Do not include unrelated formatting churn, dependency noise, or drive-by refactors.
- Temporary or transitional code must include `TODO(#issue):` with a tracking issue.
- UI or externally visible API changes should include screenshots, sample payloads, or an explicit note that there is no visual change.
- PR descriptions must include a summary, motivation, linked issue, and manual validation plan.
- Before requesting review, run the relevant checks for the files you changed, or note what you could not run.
