# Current public source work

- [~] Бот Direct 01.11 (скриншоты владельца): таджикский язык, повтор цены, «хочу посмотреть», объект рекламы, короткие подборки — ветка `fix/dm-bot-tj-01-11`, журнал `docs/journal/2026-11-01-бот-direct-таджикский-повтор-реклама.md`. Выкат — по «да» владельца. В план: вынести шаблон строки цены (дубль `customerPropertyFacts.ts` / `customerAgentRenderer.ts`).
- [~] Новое ядро бота, аудит Codex 21–22.10 (F01–F17): ветка `fix/customer-core-23-10`
  (пачки A–F, см. `docs/handoff-2026-10-23-core-fixes.md`). Ревизия на проде обновлена
  23.10 (политика 25). Осталось: полный `test:api`, черновик PR, выкат по слову владельца,
  затем «Обновить версию бота» и живая проверка на трафике.
- [?] Решение владельца: канал заземлённого свободного текста для модели (сейчас весь текст
  клиенту — шаблоны рендерера, поэтому бот «не как человек»).

- [ ] Customer workflow parity: bounded queue lanes, accepted name question,
  durable contact-to-CRM follow-through, approved own-word revision continuity.
  Draft source; full CI verification and production adoption pending.
- [ ] Complete API verification and release through the public repository's
  `npm run ship` after the coordinated production repository transition.
- [ ] Customer recruitment parity: distinguish configured vacancy publications,
  collect an owned application and persist it in Vacancies rather than Client
  intake. Existing topic/feature flags alone do not prove this complete path.
