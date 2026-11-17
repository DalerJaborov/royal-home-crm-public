# Команды

> Перенесено дословно из корневого CLAUDE.md 01.11.2026 (сокращение стартового контекста). Короткая выжимка правил осталась в CLAUDE.md; здесь — полный текст.

<!-- CLAUDE.md (до 01.11.2026), строки 166–192 -->
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
npm run test:web            # vitest tests of apps/web; no DB needed (size: see the measurement below)
npm run prisma:generate    # regenerate Prisma client
npm run prisma:migrate     # create/apply a dev migration
npm run prisma:seed        # seed the database
npm run map                # regenerate docs/product-*.{md,json} from current code
npm run map:check          # verify docs/product-* match code (exit 1 if stale) — part of precheck/CI
npm run ship               # the ONLY way to main/prod: sync, precheck, full test:api, mark «проверено», squash-merge
npm run ship -- --dry-run  # plan + blockers, changes nothing (--no-merge: stop before merging)
```

`@royal-home/shared`'s `main`/`types` point at `dist/`, not `src/` — after editing anything in
`packages/shared/src`, re-run `npm run build:shared` (or `npm run dev --workspace=packages/shared`
for a `tsc --watch`) or apps/api and apps/web will keep resolving the stale compiled output.

Per-workspace: `npm run build --workspace=apps/api`, etc. Node 24, npm workspaces (no pnpm/yarn).

