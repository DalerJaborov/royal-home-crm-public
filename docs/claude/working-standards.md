# Стек и стандарты кода/UI

> Перенесено дословно из корневого CLAUDE.md 01.11.2026 (сокращение стартового контекста). Короткая выжимка правил осталась в CLAUDE.md; здесь — полный текст.

<!-- CLAUDE.md (до 01.11.2026), строки 308–349 -->
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
- **Desktop and mobile ship together, same task.** Historically many screens rendered through a
  separate `components/mobile/Mobile*.tsx` component, and a feature added only to the desktop page
  was **invisible on mobile even though the code "works"** — nothing fails, nothing warns. It
  happened twice on `Oversight.tsx`/`MobileOversight.tsx`: three antifraud red flags (22.08) and a
  fourth (30.08) shipped to desktop only, unnoticed until the owner asked why he wasn't seeing them.

  **Since the 09.09.2026 port to the «Royal Home 2026» prototype the rule is stronger: a mobile
  file that carries no logic of its own is deleted, and one responsive screen stays.** The
  prototype's own media queries (820 and 640 px) do the narrow layout, so the two copies have
  nothing left to diverge over. Already done this way for `Profile`, `Finance`, `Reports`,
  `Sources`, `Archive`, `Oversight`, `Activity`, `Notifications`.

  **Before calling a screen-facing feature done:** grep for a `Mobile*.tsx` counterpart. If one
  still exists AND carries its own logic (gestures, its own lists), add the same data there too,
  in the prototype's idiom — `.pg-h`, `.sec-t`, `.card`, `.list` + `.row`, `.chip`, `.quiet` (see
  `apps/web/src/theme-2026-proto.css` and `docs/handoff-2026-09-09-theme-port.md`). If it exists
  and merely duplicates markup, delete it instead of maintaining two copies. If the page has no
  separate mobile component, keep both breakpoints in the same edit.
- **Security.** No secrets in code (use `.env`). Hash passwords (`bcrypt`), scope JWTs,
  sanitize file uploads and paths.

