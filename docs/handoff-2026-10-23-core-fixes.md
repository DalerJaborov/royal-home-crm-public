# Мост: починки нового ядра клиентского бота — 23.10.2026

Для продолжения из любой сессии. Источник задачи: аудит Codex 21–22.10 (17 находок F01–F17),
перепроверенный Claude по коду `origin/main` и базе прода. Владелец 23.10: «обнови ревизию и
чини всё по порядку». Выкат на прод — только по слову владельца (`npm run ship` НЕ запускался).

## Что уже сделано на проде (без кода)

- 23.10 ~03:14 Душанбе: ревизия ядра обновлена с сервера (политика 24 → 25, активная ревизия
  `319e8509…`), от учётки директора с пометкой «по поручению владельца Далера» в AuditLog.
  До этого с 12:37 22.10 ядро молчало: 34 сообщения из 12 переписок HELD
  `current_artifact_revision_mismatch` (релиз PR30 тронул `privateFiles.ts`, входящий в хеш).
- После обновления новых входящих в ядро до 04:31 не было — живая проверка ответов ещё впереди.

## Ветки

Сводная ветка **`fix/customer-core-23-10`** (worktree `C:\Users\Daler\.claude\worktrees\core-all`,
от `origin/main` fd4cbba). В неё слиты:

| Пачка | Ветка | Что | Статус |
|---|---|---|---|
| A | `fix/core-revision-23-10` | F01: сторож logSystemError при расхождении ревизии (раз на ревизию), проверка на старте api/worker, `coreHash` без общих утилит | слита |
| B | `fix/core-shield-23-10` | F03: живой входящий снимает паузу щита (ручную — нет), `lastInboundAt` только вперёд, ответ на входящий = ответ вне 10 мин; F02: два глобальных секрета Meta → строгая проверка; F12: отложенные входы в текущем вводе, HELD-вход не «новее» | слита (конфликт в `customerDmAgentTurn.ts` с D разведён руками: язык считается по полному блоку с отложенным текстом) |
| C | `fix/core-loop-23-10` | F08: подтверждение по receipt при любом позднем HELD; F09: одна коррекция кривого JSON/skip/неизвестного инструмента в DM; предчтения и отклонённый батч не тратят лимит; mixed_model_protocol снят; facts_unavailable → clarify; код причины в трассе (`causeCode` в `packages/shared/src/botTurnTrace.ts`) | слита |
| D | `fix/core-language-23-10` | F04/F05: словарь tg, вырезание URL/@ников, явная просьба языка, нейтральные реплики не переключают; роль через `ai/customerAgentRole.ts` (нормализация, границы слов, отрицание, job раньше buyer/seller) | слита |
| E | `fix/core-render-23-10` | F06/F07/F10/F11/F13: услуги, цена за м², дедуп блоков, «вакансий нет» без «CRM» и с учётом объявления, резюме один раз, причина нераспознанной ссылки, каталог вакансий без падения на 25. Не сделано: `facebook.com/share/…` (нужен редирект), повтор разбора ссылки на следующем ходе (только внутри хода) | слита |
| F | `fix/core-delivery-23-10` | F14: повтор только при доказанной недоставке (429/408/503/отказ соединения), **одна повторная попытка** (щит режет третий дословный повтор), 5xx/таймаут остаются UNKNOWN без дубля, квитанция с повтором (окончательный сбой → unknown); UNKNOWN ↔ echo по golden-цепочке, `ambiguous_own_send` ≤15 мин; F15: первая причина в `note` рядом с expired; F16: audio-only → not_visible; F17: контекст ветки оставлен прежним (чужой родитель модели не уходит), адресат определяется отдельно; пропуск только без обращения к компании (критика/жалоба/вопрос/наш @ отвечаются) | слита |

Стык пачек: C добавил корректирующий раунд → золотой сценарий N01 (`customer-agent-golden-companions-postgres`) переписан под два скриптованных ответа модели (коммит `5d68482`). Остальные падения точечного прогона были от параллельных прогонов трёх агентов на одном контейнере Postgres — полный `test:api` гонять одним процессом.

Все пачки меняют `coreHash` → **после выката обязательно «Настройки → Новый бот → Обновить
версию бота»**, иначе бот молчит (сторож из A это теперь напишет в журнал ошибок).

## Как проверять

```bash
cd C:/Users/Daler/.claude/worktrees/core-all
node scripts/agent-stand.mjs up --api 4790 --web 5290   # ссылки на node_modules D:\CRM, клиент Prisma, база agent_4790
cd apps/api && npx prisma migrate deploy                 # эталон стенда отстаёт от публичных миграций
cd ../.. && npm run build:shared && npm run build --workspace=apps/api && npm run build --workspace=apps/web
cd apps/api && npx vitest run <файлы>                    # .env стенда уже лежит в apps/api/.env (вне git)
npm run test:api                                         # полный прогон перед PR/ship
node scripts/agent-stand.mjs down --api 4790 --web 5290  # погасить
```

Тесты, которые агенты не могли гонять без базы (их прогон — на сводной ветке):
`customer-original-source-artifact`, `customer-own-site-artifact`, `customer-agent-registration-postgres`,
`customer-agent-routine-refresh-postgres`, `outbound-shield`, `customer-public-envelope-*-postgres`,
`customer-dm-agent-turn-postgres`, `customer-ingress-recovery-postgres`, `customer-actions-postgres`,
`customer-public-agent-postgres`, `customer-agent-mutation-session-postgres`, `customer-handover-ack-postgres`,
`customer-state`, `customer-new-lead-bridge-postgres`, `customer-reply-language-postgres`,
`customer-qualifier-turn`, `customer-agent-verified-context-postgres`, `recruitment-*`, `customer-outbox-postgres`.

## Что осталось / решения владельца

1. **Архитектурное.** Модель в ядре не пишет текст: она возвращает JSON `{kind, refs, social,
   question}`, текст собирает `ai/customerAgentRenderer.ts` из шаблонов. Это защита от выдумок, но
   поэтому бот «не как человек». Нужно решение: добавлять ли канал заземлённого свободного текста
   (модель пишет 1–2 фразы, сервер проверяет: нет чисел/обещаний/контактов вне refs).
2. F12: сценарии «A отложен из-за B, B кончился HELD → A получает ответ» и «A+B → один ответ»
   проверить на стенде вручную (SQL-часть без тестов).
3. F17: адресат комментария пока только пропуск; в `publicState` модели не передаётся (нужна схема в shared).
4. Инструменты ядра перепроверить на живом трафике после выката: язык/роль, резюме, комментарии.
5. `incomingSpam`/`commentHate`/`listingAd` убраны из `coreHash`: правки словарей больше не требуют
   обновления версии, но ядро узнаёт о них только после «Обновить версию бота».
