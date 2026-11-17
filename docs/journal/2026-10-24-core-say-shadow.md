# 2026-10-24 — канал «заземлённого свободного текста» (`say`), режим «тень»

Ветка `feat/core-say-24-10`. Реализация раздела 9 плана `docs/design/customer-core-say-plan-2026-10-24.md` (пачка I).

## Что и зачем
Владелец: бот не должен отвечать «по-ИИшному» и не должен выдумывать. Модель получила право на 1-2 короткие живые фразы (`say`), которые
сервер проверяет **целиком или отбрасывает целиком** — ничего не режет и не чинит. Факты, квитанции и вопрос по-прежнему дают шаблоны.

- `packages/shared/src/customerAgent.ts`: `say` (необязательное, 2–200 символов) в `reply`, `clarify`, `propose`; закрытый список причин
  `customerAgentSayDropReasonSchema` (14 кодов валидатора + `language_disabled` + `shadow`); режимы `shadow|live`.
- `ai/customerAgentSay.ts` (чистая детерминированная функция): все 14 кодов отказа плана (`surface_disabled`, `length`, `question`,
  `number_or_date`, `contact`, `promise`, `fact_claim`, `place`, `meta`, `cliche`, `language`, `echo`, `repeat`, `double_greet`) плюс `language_disabled`
  (таджикский выключен в v1). Порядок проверок: meta раньше contact (иначе латинские CRM/JSON попадали бы в contact). Слова обещаний «позвоним/свяжемся»
  открывает только квитанция `callback_requested`/`handover_requested` в refs решения, «записал/сохранил» — `contact_saved`/`job_application_saved`;
  «уточню/проверю/оформлено/подтверждено» запрещены всегда. Топонимы и слова с заглавной внутри предложения допустимы только если клиент написал их сам.
- Ядро (`customerAgentCore.ts`): `say` вынимается из сырого JSON ДО строгого разбора (плохой `say` не губит решение и не даёт круг исправления);
  результат `say: {status, reason?}`; режим `shadow` по умолчанию — валидный `say` считается как `dropped/shadow` и в решение не попадает;
  `live` кладёт проверенный текст в `decision.say`. `replyLanguage` едет в `serverSurface` (с контекстом) или отдельной частью в конце `currentParts` (без контекста).
- Рендерер: `say` вместо social-строки («Понял.», «Спасибо!», «Извините…»), `greet` остаётся первой строкой, вопрос-шаблон последним; рендерер
  повторно зовёт тот же валидатор из тех же входов → печать доставки (`sealDmCustomerAgentDeliveryEvidence`) перерисовывает тот же текст. Правило «пустой ответ → null» считается без `say`.
- Промт: блок правил `say` + по 3 примера ru/tg (`CUSTOMER_AGENT_SAY_GUIDANCE`, `CUSTOMER_AGENT_SAY_EXAMPLES` в `ai/customerAgentSay.ts`; тест гоняет каждый пример через валидатор). ОТСТУПЛЕНИЕ ОТ ПЛАНА: блок едет в серверном контексте хода (`serverSurface.sayGuidance`, только личные сообщения), а НЕ в `CUSTOMER_AGENT_SYSTEM`. Причина: `lib/customerAgentOwnerPolicy.ts` (revision advance) запрещает менять `promptHash` обычным обновлением версии — нужна отдельная утверждённая пара «из → в» (как `CUSTOMER_RECRUITMENT_RESUME_UPGRADE_V2`) и флаг подтверждения владельца; правка системного промта сломала бы «Обновить версию бота» и 7 закреплённых тестов. `promptHash` остаётся `eaf64976…`; меняются `coreHash`, `modelSchemaHash`, `rendererHash` (файл `customerAgentSay` внесён в группу rendererHash, тест `customer-agent-core-hash-scope`).
- Метрики: трасса `customerCore.sayStatus/sayDropReason` (текста нет); счётчики `GuardHit`: `say_used`, `say_dropped_<код>` (экран «Обучение бота»);
  `lib/customerAgentSayStats.ts` — раз в сутки (ключ `customer-agent-say:<день>`) строка в `logSystemError`, если отброшено >20% (при выборке ≥5) или был хоть один `promise`/`contact`; `shadow` считается как принятая.
- Режим: `CUSTOMER_AGENT_SAY_MODE` (env), по умолчанию `shadow`, `live` только точным словом. Колонка в Settings потребовала бы миграции схемы — не делалась.

## Чем проверено
`npm run build:shared`, `build:api`, `build:web` — 0; `npm run test:web` — 1863/1863; `cd apps/api && npx vitest run customer-agent-say customer-agent-core customer-agent-renderer customer-agent-golden-companions-postgres customer-dm-agent-turn-postgres bot-turn-trace` — 465/465 (в т.ч. сквозной тест через БД: shadow → шаблон, live → фраза проходит печать, плохая фраза → шаблон, счётчики растут). `map:check`, `audit:mocks` — чисто.

## Что осталось до включения live
1. Неделя режима «тень» на 10% DM ru: смотреть `say_dropped_*` на экране «Обучение бота» (цель — отброшено <15%, ноль `promise`/`contact`/`number_or_date` в отправленном).
2. Корпус `tests/attack/say/*.json` и ночной прогон на живой модели (стенд `feat/core-attack-harness-24-10`) — гейт плана: 0 утечек.
3. Выборочная проверка судьёй `ai/botAudit.ts`.
4. Новая ревизия («Обновить версию бота») и когорта 10% → 50% → 100%; `CUSTOMER_AGENT_SAY_MODE=live` в окружении сервера — отдельным решением владельца.
5. Таджикский: включать (`SAY_ENABLED_LANGUAGES`) только после проверки носителем 50 образцов; публичные комментарии выключены.
6. Если нужен переключатель в «Настройках» — потребуется миграция (колонка в `Settings`).
