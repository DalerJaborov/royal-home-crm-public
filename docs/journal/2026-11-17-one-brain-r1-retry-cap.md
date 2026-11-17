# 17.11.2026 — один мозг, шаг 3а: повтор хода ядра только при временном сбое и не больше 3 прогонов (ревью #223 R1)

## Что было
- `runCustomerAgentTurn` превращал любое исключение хода в `turn_unavailable`, а каналы (Telegram, личка канала, сайт, YouTube)
  отдавали эту причину в свою лестницу повторов: до 46 платных повторов за ~13 часов. Так же повторялись и собственные лимиты
  ядра (`tool_limit`, `unavailable_tool`, `call_id_reused`, `invalid_server_observation`, `effect_unknown`…), которые на повторе
  падают точно так же. Человек узнавал только от сторожа молчания (30 минут, ночью — утром).
- Тест `channelCoreRetryable("tool_limit") === false` проверял строку-причину, а брошенный лимит приходит как
  `turn_unavailable` + cause.

## Что сделано
- `safeCauseCode`: остановки поставщика — `provider_<reason>`, HTTP — `provider_http_<код>` (без текста поставщика).
- `customerCoreFailureTransient(cause)` (ядро) + `CUSTOMER_CORE_THROWN_CODES`: повторяются только часы (срок, остановленный
  порт), 408/429/5xx, deadline/cancel/accounting поставщика и исключение без своего кода (сеть, наш TypeError). Любой другой
  snake_case-код (лимиты и отказы ядра, `model_*`, `provider_budget_denied`, `provider_unsupported`, 4xx) — сразу сотрудник.
- `channelCoreRetryable(reason, cause)`; `CHANNEL_CORE_MAX_ATTEMPTS = 3` в одной двери `runChannelCoreTurn`: третий прогон,
  вернувший временный сбой, — `staff/core_unavailable` (пуш через `alertChannelStaff`, клиенту строка «передал сотруднику»);
  прогон сверх предела модель не зовёт вовсе.
- Номер прогона: раннер передаёт `context.attempt` в `run`; `telegram-reply-retry`, `telegram-dm-reply-retry`,
  `ai-reply-retry` (→ `retryStuckConversation` → `processMessengerTurn.retryAttempt` → дверь) передают попытка + 1;
  YouTube — `attempts` строки очереди комментариев + 1.
- Пустой env: режим `legacy`, номер попытки игнорируется, старый бот и его лестница без изменений.

## Проверено
- `tests/one-brain-core-retry-cap.test.ts` 26/26: настоящая цепочка дверь → адаптер → ядро; мутация (снять классификацию
  и предел) — 18 красных.
- `telegram-reply-retry-job` 11/11 (БД), `one-brain-step3-review` 29, `-telegram` 4, `channel-core` 21, `shadow` 13,
  `door-guard` 3, `customer-agent-core` 145, `stop-diagnostics` 11, `trace-customer-core` 22, `no-silence` 11,
  `ai-reply-retry-job` 13, `stuck-conversations-retry` 7 (своя база), `telegram-direct*` 9.

## Доработка по ревью 2ed6d7d2 (R1-1, R1-2, R1-4)
- R1-1: `budget_denied`/`unsupported` поставщика останавливают операцию → причина `operation_stopped`. Теперь у неё, как у
  `turn_unavailable`, решает cause (`channelCoreRetryable`): отказ поставщика — сразу сотрудник с текстом «не смог ответить
  по существу». Тест — на настоящей `createProviderOperation`, транспорт подменён (`operation.begin` как у клиента Gemini).
- R1-2: счёт прогонов живёт на сообщении клиента в базе, а не у задания: `claimChannelCoreRun` занимает отметку
  `ProcessedMessage` (`channel-core-run`, ключ = канал + чат + время и отпечаток последней реплики клиента + номер 1…3,
  `ON CONFLICT DO NOTHING`). Номер прогона = max(номер задания, номер по базе). Крон, новое задание, кнопка «Повторить
  зависшим» счёт заново не начинают. Миграции нет (таблица и уборка через 3 дня уже есть). YouTube — по-прежнему строка
  очереди комментариев (`attempts` не сбрасывается).
- R1-2: `alertClientWaiting` при проигранной метке эпизода отдаёт `already` (человеку уже сказали), `alertChannelStaff` —
  тоже `already`; счётчики сторожа считают только `agent`/`director`.
- R1-4: при `staff` клиент ВСЕГДА получает строку «передал сотруднику» (решение владельца 17.11) — чат перестаёт быть
  «зависшим»; если сигнал `skipped`, дверь пишет `logSystemError` (дедуп `channel-core-staff-unalerted:<канал>`).
- Тесты: `one-brain-core-run-ledger` (БД: живой ход + 5 заходов крона → 3 прогона, одна строка передачи; без записи ответа
  5×2 прогона задания → 3; новое сообщение — новый счёт), `one-brain-core-retry-cap` 29.

## Остаётся
- Meta DM (`customerDmAgentTurn`) через ядро не повторяется вовсе (held → строка безопасности + сигнал), `ai_retry` для Meta
  идёт старым ботом — не тронуто.
