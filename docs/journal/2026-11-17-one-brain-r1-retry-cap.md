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

## Остаётся
- Крон `health-automation` раз в 30 минут ставит новое `ai-reply-retry` для зависшего чата сайта; счёт попыток у нового
  задания начинается заново. После предела чат уже не «зависший» (ушла строка передачи), кроме случая, когда сигнал
  сотруднику `skipped` (R3) — тогда до 2 платных вызовов на каждый такой заход крона.
- Meta DM (`customerDmAgentTurn`) через ядро не повторяется вовсе (held → строка безопасности + сигнал), `ai_retry` для Meta
  идёт старым ботом — не тронуто.
