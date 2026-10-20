# AGENTS.md — Royal Home CRM

Guidance for Codex when working in this repository.

## Public repository and cloud releases — 21.10.2026

This repository is `DalerJaborov/royal-home-crm-public` and has fresh cleaned
history. Prior incident evidence and unfinished private branches remain in the
private recovery archive. Port reviewed diffs onto a new branch from this
repository's `origin/main`; do not merge or push the old private history here.

`npm run ship` validates the exact commit on GitHub by default. Backend/shared
changes and API tests use the complete API suite on 20 standard Linux runners;
frontend/docs/scripts use the source workflow. Both run builds, frontend tests,
source guards and release-tool tests in the cloud. The laptop needs Node 24,
Git and authenticated `gh`; a local PostgreSQL or local build is not required
for the default release path. `--local-tests` explicitly uses local checks.

Main is protected by required PR checks. Use `npm run ship` to merge CRM changes.
The production checkout `/opt/royalhome-crm` must track this public repository.
Verify its origin, deployed SHA, API/worker health and release evidence separately:
a verified merge proves source validation, not that production was updated.
Older self-hosted-runner/deployment descriptions below are historical context.

## Project

`royal-home-crm` — a CRM built as an npm-workspaces monorepo. Full-stack TypeScript:
React/Vite web client, Express API, Prisma/PostgreSQL, shared Zod schemas.

## Structure

```
apps/api        @royal-home/api      Express + TypeScript (tsx), Prisma, JWT auth
apps/web        @royal-home/web      React 18 + Vite + Tailwind + PWA
packages/shared @royal-home/shared   Shared Zod schemas/types (imported by api & web)
```

## No secrets, no client phone numbers in the repo (owner rule, 20.10.2026 — mandatory)

- **Never commit** keys, tokens, passwords, `.env`/`.env.*` (only `*.example`), SSH keys,
  certificates, database dumps or client exports. Secrets live in `.env` on the server or in
  CRM Settings (encrypted); code and tests use placeholders only (`change-me…`, `test-…`, `stand-…`).
- **Real phone numbers of clients or staff in `docs/`, `*.md`, reports and journals — masked
  only:** `+992•••••3726`. Refer to a client by card id (e.g. «ПК-000463»), not by name + phone.
- Enforced by `.githooks/pre-commit` and the `audit:secrets` step of `npm run precheck` /
  `npm run ship` (`scripts/audit-secrets.mjs`). Do not bypass with `--no-verify`. False positive:
  add `secret-scan: allow` with a reason on the same line. `npm run audit:secrets -- --mask-docs`
  masks phone numbers in docs automatically.
- If a secret was ever committed or pushed, treat it as leaked: tell the owner and rotate it at
  the provider. Deleting it from the file does not help — git history keeps it.

## Commands (run from repo root)

```bash
docker compose up -d       # start PostgreSQL 16 (service: postgres, port 5432)
npm run build:shared       # build @royal-home/shared to dist/ — REQUIRED once before first dev:api/dev:web
npm run dev:api            # Express dev server (tsx watch src/index.ts)
npm run dev:web            # Vite dev server
npm run build               # build shared -> api -> web, in order
npm run build:api           # build shared -> api only
npm run build:web           # build shared -> web only
npm run test:api            # vitest access-control tests (apps/api/tests), needs DB up
npm run prisma:generate    # regenerate Prisma client
npm run prisma:migrate     # create/apply a dev migration
npm run prisma:seed        # seed the database
```

`@royal-home/shared`'s `main`/`types` point at `dist/`, not `src/` — after editing anything in
`packages/shared/src`, re-run `npm run build:shared` (or `npm run dev --workspace=packages/shared`
for a `tsc --watch`) or apps/api and apps/web will keep resolving the stale compiled output.

Per-workspace: `npm run build --workspace=apps/api`, etc. Node 24, npm workspaces (no pnpm/yarn).

## Stack

- **Frontend**: React, Vite, TypeScript, Tailwind CSS, React Router, TanStack Query
  (server state), Zustand (client state), dnd-kit (drag-drop), lucide-react (icons), PWA.
- **Backend**: Express, TypeScript, Prisma ORM, PostgreSQL, JWT (`jsonwebtoken`) + `bcrypt`,
  `zod` validation, `multer` uploads, `sharp` image processing, `cors`, `dotenv`.
- **Shared**: `@royal-home/shared` holds Zod schemas — define validation/types there once and
  import in both api and web. Do not duplicate types across apps.

## Working standards

Apply these by default whenever writing code or UI — don't wait to be asked:

- **Clean modular code.** Small, single-purpose modules. Reuse `@royal-home/shared` types.
  Match the style of surrounding code.
- **Validation at boundaries.** Every API input (body/params/query) and webhook payload is
  validated with a Zod schema before use. Trust internal code; validate external input.
- **Error handling up front.** API routes return proper status codes + structured errors.
  External calls (DB, AI, third-party) are wrapped and fail gracefully — never swallow errors.
- **Responsive, mobile-first UI.** Tailwind, mobile-first breakpoints, clear visual hierarchy,
  accessible forms and dashboards. Consistent spacing/typography.
- **Security.** No secrets in code (use `.env`). Hash passwords (`bcrypt`), scope JWTs,
  sanitize file uploads and paths.

## Token & cost economy (strict)

- **Minimal output.** Return only new/changed code. No re-dumping unchanged files, no
  restating what wasn't asked. Keep explanations short unless the user requests detail.
- **Prompt caching.** For large, stable instructions or repeated file context, place
  `cache_control: { type: "ephemeral" }` on the stable prefix (system prompt / tool defs).
  Caching is a **prefix match with a token minimum** (~2048–4096 depending on model) — it only
  saves money above that threshold; below it the marker is a no-op. Verify with
  `usage.cache_read_input_tokens`.

## AI model routing

When code calls Claude models, pick the cheapest tier that fits the request. (The standalone
example `router.js` that used to live in the repo root was removed on 28.09.2026 — it never ran:
its SDK was not a project dependency.)

| Tier | Use for | Model | Correct ID |
|---|---|---|---|
| SIMPLE | routine edits, tests, logging, formatting, classification | Haiku 4.5 | `claude-haiku-4-5` |
| MEDIUM | business logic, code, SQL, integrations | Sonnet 5 | `claude-sonnet-5` |
| COMPLEX | deep architecture, hard debugging, system design | Fable 5 | `claude-fable-5` |
| (heavy project work) | complex multi-step project tasks | Opus 4.8 | `claude-opus-4-8` |

Default to the cheapest tier that fits; escalate to expensive models only for complex
architecture or bugs unresolved on the first attempt.

### ⚠️ Model IDs — use only the current strings above

These older IDs are **retired and return HTTP 404** — never use them:

| Retired (do NOT use) | Replacement |
|---|---|
| `claude-3-5-haiku` | `claude-haiku-4-5` |
| `claude-3-5-sonnet` | `claude-sonnet-5` |
| `claude-3-opus` | `claude-opus-4-8` |
| `claude-3-7-sonnet`, `claude-4` | `claude-fable-5` |

### Model-specific API notes

- **Fable 5**: thinking is always on — do **not** send a `thinking` param (`{type:"disabled"}`
  → 400). No `temperature`/`top_p`/`budget_tokens`. Can return `stop_reason:"refusal"` — ship a
  server-side fallback (`betas:["server-side-fallback-2026-06-01"]`, `fallbacks:[{model:"claude-opus-4-8"}]`).
  Requires ≥30-day org data retention.
- **Sonnet 5 / Opus 4.8**: use `thinking:{type:"adaptive"}` + `output_config:{effort:"..."}`;
  `temperature`/`top_p` are rejected (400).
- **Haiku 4.5**: no `thinking`/`effort` params; keep requests simple and fast.
- Non-streaming: cap `max_tokens` ~16000 to avoid HTTP timeouts; stream for larger outputs.
