# HANDOFF 13.11.2026: бот «только заявки» (лидогенерация)

Владелец 13.11: «Да, делаем» на схему из чата «Проверка глюков бота на проде» (12.11).
Схема и разбор 34 чатов: память `royalhome-bot-leadgen-mode-12-11.md`.

Рабочая копия: `D:/PublicWorktrees-20261021/bot-leadgen-13-11`, ветка `claude/bot-leadgen-13-11`
от origin/main 9de43ca8. Выкатка только `npm run ship` через PowerShell (gh = DalerJaborov).

## Порядок
1. Метка рекламы в CORE + запрет повтора (быстро).
2. Режим «только заявки» с переключателями в Настройках (3 сценария, номер из WhatsApp без вопроса,
   горячие слова → агенту, честное время звонка).
3. Тесты, precheck, ревью architect, ship, перечитать живые переписки за сутки.

## Найдено (ФАКТ, чтение кода 13.11)
- `BotConversation.adExternalId/adTopic/adPropertyId` пишет только старый путь
  `messengers/conversation.ts:1829-1880` (вызов из `routes/webhooks.ts:2629`).
- Разговоры в новом ядре (CORE) уходят раньше: `routes/webhooks.ts:1697-1705` и `:2025`.
- Нормализованный вход CORE (`lib/customerIngressNormalize.ts:115-126`, схема
  `lib/customerIngressPayload.ts`) теряет adRef/adClickId/adTopic; adId остаётся только как
  `propertyEvidence {kind:"ad"}`.
- CORE определяет вакансию только по `RecruitmentPosition.postCodes` или словам
  (`lib/customerState.ts:323-333`); `isJobAdRef`/`adTopicByExternalId`
  (`ai/adTemplateOpener.ts`) в CORE не зовутся → `ad_unmapped` → «какой объект?»
  (`ai/customerAgentRenderer.ts:192`).
- Лид из CORE теряет объект рекламы при назначении агента (`adPropertyId` не пишется).

## Состояние
Код ещё не менялся (только этот файл).
