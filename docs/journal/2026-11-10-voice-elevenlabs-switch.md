# 10.11.2026 — Голос робота: подготовка перехода с Gemini Live на ElevenLabs

- Что изменилось:
  - `apps/api/src/ai/elevenLabsAgentSync.ts`: константа `ELEVENLABS_PHONE_AGENT_TUNING` —
    один источник настроек телефонного разговора из передачи 24.10
    (`docs/handoff-2026-10-24-elevenlabs-voice-agents.md` в ветке
    `feat/elevenlabs-voice-agents-24-10`): голос `eleven_v4_turbo`, speed 1.15,
    stability 0.45, expressive выкл, ulaw_8000 в обе стороны, нормализация текста
    elevenlabs; очередь реплик turn_v3 + speculative_turn, eager, turn_timeout 5;
    заполнители выкл (soft_timeout -1); слова-поддакивания ru/tg
    (`interruption_ignore_terms`, объединяются со словами владельца); max_tokens 120;
    timezone Asia/Dushanbe; встроенный `language_detection` и пресет второго языка
    `tg` (с таджикским голосом из Настроек, если он задан). `buildAgentSyncPatch`
    отправляет их агенту вместе с нашими функциями; модель разговора (llm), голос и
    основной язык агента, выбранные владельцем, не трогаются.
  - Подготовка агента теперь идёт и у звонка без функций (раньше ранний выход
    пропускал её), и заново, если сменился таджикский голос.
  - `elevenLabsVoiceClient.ts` и кнопка проверки агента в Настройках
    (`routes/settings.ts`) передают таджикский голос в подготовку.
  - `liveVoiceBridge.ts`: пауза робота после отказов подключения называет
    настоящего поставщика («Проверьте ключ ElevenLabs», а не «Gemini»); ответ
    сценарию — «Голос робота не подключается».
- Разведка:
  - Исходящий робозвонок (приглашение кандидата, опрос после показа, проверка
    собственника, звонок клиенту, тестовый звонок) идёт через
    `originateLiveVoice*` → `pendingOutboundCalls` → тот же `startLiveVoiceSession`
    → `prepareModelPart` → `loadLiveVoiceProviderConfig`, то есть через
    переключатель `Settings.liveVoiceProvider`. Обхода нет; чинить было нечего.
  - Мимо переключателя — только превью приветствия в Настройках
    (`previewLiveVoiceGreeting`, всегда Gemini). Это не звонок; оставлено.
  - Таджикский у ElevenLabs по документации: `eleven_v4`/`eleven_v4_turbo`
    (вышли 28.09.2026) и `eleven_v3_conversational` перечисляют «Tajik (tg)»;
    распознавание Scribe v2 — Tajik в группе «Good» (WER 10–20 %); отдельной
    таджикской модели или распознавания для агентов в документации нет.
- Почему: решение владельца 07.11.2026 — голос на ElevenLabs, таджикский у Gemini
  звучит как персидский. Gemini остаётся запасным путём, по умолчанию `google`.
- Чем проверено: `npm run build:shared && npm run build:api` — код 0;
  `tests/live-voice-elevenlabs-agent-tuning.test.ts` (тело правки агента, без
  сети), `tests/live-voice-outbound-provider-switch.test.ts` (сценарный исходящий
  звонок идёт через выбранного поставщика + сторож: клиента голоса создаёт только
  `ai/liveVoiceProvider.ts`; оба красные при нарочной поломке), обновлён
  `tests/live-voice-elevenlabs.test.ts`; точечный прогон live-voice-набора.
- Что осталось:
  - НЕ ПРОВЕРЕНО на настоящем агенте: принимает ли PATCH все поля (особенно
    `built_in_tools.language_detection` и `language_presets.tg`) — первой проверкой
    нажать «Проверить агента ElevenLabs» в Настройках и посмотреть агента в кабинете.
  - Доступ к api.elevenlabs.io с нового сервера (Германия) не проверен.
  - Встроенное определение языка нельзя выключить на один звонок: при замке
    «только русский» агент всё равно может перейти на таджикский.
  - Список поддакиваний — оценка, владельцу стоит дополнить.
