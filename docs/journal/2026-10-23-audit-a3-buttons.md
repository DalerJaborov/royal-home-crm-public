# 2026-10-23 — аудит A3: кнопки и click-path (статический)

**Что проверено.** Все вызовы `api*/downloadFromApi("/...")` и `fetch("/api/v1/...")` в `apps/web/src` сверены с путями `apps/api/src/routes` (с учётом префиксов `app.ts`, баррелей и под-роутеров): мёртвых путей нет. Все `to=`/`href=`/`navigate("/...")` с литеральным путём сверены с `App.tsx`: мёртвых ссылок нет. `<a>` без `href`, `href="#"`, `onClick={() => {}}` — не найдено.

**Что изменено.** 33 `<button onClick>` без `type` получили `type="button"` (finance/Claude*, Pagination, Topbar, ErrorBoundary, MessageAttachments, LegacyAgentTopbar, ClientDetail). Поведение не меняется; защита от случайной отправки, если кнопка окажется внутри `<form>`.

**Проверено.** `npm run build:web`, `npm run test:web`.

**Осталось.** Пути с динамическим `navigate(variable)` и `api(variable)` статически не сверялись. Кнопки без `onClick` — только в комментариях и dev-песочнице.
BottomNav.tsx не тронут: его разметка закреплена хэшем в BottomNav.test.tsx (поменять type — значит перегенерировать эталон; оставлено сборщику).
