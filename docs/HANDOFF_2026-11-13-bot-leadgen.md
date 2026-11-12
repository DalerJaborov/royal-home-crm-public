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

## Состояние (13.11, ~03:30)
Два исполнителя architect работают параллельно:
- A: эта копия, ветка `claude/bot-leadgen-13-11`: метка рекламы в CORE, вакансия по рекламе,
  объект рекламы → агент, запрет повтора (CORE + LEGACY).
- B: `D:/PublicWorktrees-20261021/bot-leadonly-mode-13-11`, ветка `claude/bot-leadonly-mode-13-11`:
  режим «только заявки», переключатели botLeadOnlyMode / botUseWhatsappNumber / botMaxPhoneAsks /
  botHotIntentHandover (по умолчанию режим выключен), BotTab.
После обоих: свести ветки, полный precheck, ревью architect без контекста автора, ship (ветку A
первой), включить режим в Настройках, перечитать живые переписки за сутки.
Важно: у бота два маршрута (CORE и LEGACY), правка обязана работать в обоих.
Голосовой робот имеет свой промпт (ai/liveVoicePersona.ts) и в эту правку не входит.

### Ветка A сделана (13.11, исполнитель architect)
Коммиты на `claude/bot-leadgen-13-11` (не запушены): метка рекламы в CORE + вакансия по рекламе +
объект рекламы → агент; запрет повтора блоков в CORE и LEGACY. Журнал:
`docs/journal/2026-11-13-bot-ad-attribution-no-repeats.md`. Общие точки с веткой B при сведении:
`ai/customerAgentRenderer.ts` (вопросы и защита от повтора), `lib/customerDmAgentTurn.ts` (одна строка
предварительного поиска), `services/leads/intake.ts` (`processNewCustomerLeadPolicy`),
`messengers/conversation.ts` (блок атрибуции и «спасибо»), `lib/outboundShield.ts`.
Не покрыто: маршрут HELD; проверка на живых чатах после выката.
