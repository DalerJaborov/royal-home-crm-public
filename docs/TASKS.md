# Current public source work

- [~] Бот «только заявки» (владелец 12–13.11: «Да, делаем»): рубильник и три уточнения в Настройках → Бот, оба маршрута бота (ядро и старый путь), WhatsApp-номер вместо вопроса, горячие слова → агенту, честное время звонка. Ветка `claude/bot-leadonly-mode-13-11` (журнал `2026-11-13-bot-lead-only-mode.md`); ждёт свода с веткой метки рекламы, ревью `architect`, `npm run ship`, включения режима владельцем.
- [~] Вечные ключи Meta (владелец 12.11: «вечный ключ без пароля», «всем, у кого есть маркер, сделай такой же»):
  Instagram и Facebook через Страницу маркером системного пользователя, реклама — его же ключом, сторож мёртвых
  ключей → тревога директору. Ветка `feat/ig-via-page-token-12-11`, черновик PR; ждёт клики владельца в Meta,
  ревью `architect` и `npm run ship` (журнал `2026-11-12-meta-eternal-tokens.md`)

- [~] Экран «Объекты»: плитка по умолчанию, панель одной строкой, ровные карточки (владелец 12.11: «визуально бардак … сделай компактно, красиво») — ветка `claude/funny-engelbart-7df16a` (журнал `2026-11-12-obekty-plitka.md`)
- [~] Озвучка роликов по схеме владельца 10.11 (мастер → агенту на одобрение → монтажёру, авто-перегенерация): ветка `feat/narration-flow-11-11`, черновик PR; ждёт ключ и голоса ElevenLabs, замер моделей, включение «Автоозвучки» (журнал `2026-11-11-narration-flow.md`)
- [~] Озвучка 12.11: монтажёр вклеивает голос сам + ролик без голоса, «Без озвучки», ролики в монтаже (рубильник выключен), ролик от СММщика в Шабнам, напоминания, словарь произношения, стартовые голоса (журнал `2026-11-12-narration-montajer-audio.md`)
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

- [~] Робозвонок, деньги (11.11, владелец: «надо полностью контролировать это», «чтобы … деньги не пошли в минус»):
  замок платных скриптов ElevenLabs и потолок минут робота (30/сутки, 250/месяц, тревога 80/100%) — код и тесты в
  ветке worktree от `claude/elevenlabs-paid-lock-11-11`; ждёт ревью `architect`, подтверждения умолчаний владельцем и
  `npm run ship`. См. `docs/journal/2026-11-11-voice-spend-ceiling.md`.
- [~] Помощник в Telegram (П5, 03.11): личка + общая группа по упоминанию, одна карточка на цепочку, подтверждает автор; код и тесты готовы, ship и живая проверка на боте владельца — следом. См. `docs/journal/2026-11-03-помощник-telegram.md`.
