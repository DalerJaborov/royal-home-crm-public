# Current public source work

- [~] Новое ядро бота, аудит Codex 21–22.10 (F01–F17): ветка `fix/customer-core-23-10`
  (пачки A–F, см. `docs/handoff-2026-10-23-core-fixes.md`). Ревизия на проде обновлена
  23.10 (политика 25). Осталось: полный `test:api`, черновик PR, выкат по слову владельца,
  затем «Обновить версию бота» и живая проверка на трафике.
- [?] Решение владельца: канал заземлённого свободного текста для модели (сейчас весь текст
  клиенту — шаблоны рендерера, поэтому бот «не как человек»).

- [~] Бот «грубый и резкий» (владелец 08.11): тон шаблонов ru/tg, без петли адреса и «Бори дигар такрор мекунам»,
  приветствие, таджикский `say` включён (клиенту — только при `CUSTOMER_AGENT_SAY_MODE=live`). Ветка
  `claude/bot-warm-tone-tg-08-11`, запись `docs/journal/2026-11-08-bot-warm-tone-tajik.md`. Осталось: ревью, ship,
  живой прогон на отдельном ключе, просмотр 50 таджикских образцов владельцем.

- [ ] Customer workflow parity: bounded queue lanes, accepted name question,
  durable contact-to-CRM follow-through, approved own-word revision continuity.
  Draft source; full CI verification and production adoption pending.
- [ ] Complete API verification and release through the public repository's
  `npm run ship` after the coordinated production repository transition.
- [ ] Customer recruitment parity: distinguish configured vacancy publications,
  collect an owned application and persist it in Vacancies rather than Client
  intake. Existing topic/feature flags alone do not prove this complete path.

- [~] Помощник в Telegram (П5, 03.11): личка + общая группа по упоминанию, одна карточка на цепочку, подтверждает автор; код и тесты готовы, ship и живая проверка на боте владельца — следом. См. `docs/journal/2026-11-03-помощник-telegram.md`.
