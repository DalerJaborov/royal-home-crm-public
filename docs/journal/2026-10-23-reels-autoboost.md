# 2026-10-23 — Автопродвижение роликов (Reels → одна постоянная кампания Meta)

## Что сделано
Каждый ролик объекта, вышедший в Instagram, CRM может сама превращать в объявление ОДНОЙ постоянной
кампании Meta и сама ставить лишнее на паузу. **Выключено по умолчанию, пробный режим включён по
умолчанию**: в таком виде CRM считает решения, пишет их в журнал и таблицу в Настройках, а в Meta не
ходит вообще.

- Настройки `Settings.reelsAutoBoost*` (миграция `20261023120000_reels_autoboost`): `Enabled` (false),
  `DryRun` (true), `AdSetId`, `MaxActive` (30), `MaxAgeDays` (10), `StopLossSpendUsd` (4.00), `CtaType`
  (`WHATSAPP_MESSAGE`). Схема правки и допустимые значения — `packages/shared/src/reelsAutoBoost.ts`.
- Журнал `ReelAutoBoostAd` (`instagramMediaId` уникален: один ролик — одно объявление, даже после
  паузы). Статусы PLANNED / ACTIVE / PAUSED / FAILED / SKIPPED, причина человеческим текстом.
- `apps/api/src/lib/ads/reelsAutoBoostDecide.ts` — чистая функция решений `decideReelsAutoBoost`
  (создать / пауза / оставить), покрыта `tests/reels-autoboost-decide.test.ts` (каждое правило и граница).
- `apps/api/src/lib/ads/reelsAutoBoost.ts` — исполнитель, крон `reels-autoboost` раз в 30 минут
  (`cron.ts`). `lib/ads/reelsAutoBoostMeta.ts` — вызовы Meta. Тесты исполнителя и роутов —
  `tests/reels-autoboost-tick.test.ts`.
- Роуты `GET/PATCH /api/v1/ads/reels-autoboost`, `POST .../run` («Проверить сейчас») — права как у
  остальной рекламы (читает MARKETING и `finance.view`, меняет MARKETING и `finance.manage`).
- Экран: «Настройки → Каналы» → блок «Автопродвижение роликов» (`ReelsAutoBoostSection.tsx`).

## Правила решений
- **Создать:** ролик в Instagram (`publishedPostIds.INSTAGRAM`), объект AVAILABLE, `publishedOnSite`,
  не `offSite`, не в корзине, с выхода прошло не больше `MaxAgeDays`, записи по этому media id нет.
  Дата выхода — `publishedPostIds.RAW_VIDEO_PUBLISHED_AT`; **нет даты — не создаём** (честное «нет данных»).
- **Пауза:** объект SOLD/RESERVED/снят/ушёл с сайта/в корзину; старше `MaxAgeDays`; стоп-лосс (расход ≥
  порога и 0 переписок); вышли за `MaxActive` (первыми самые старые). Новый свежий ролик вытесняет самый
  старый активный, а не стоит в очереди за ним.
- FAILED повторяется не чаще раза в 6 часов, до 3 попыток; повтор сначала ищет в группе объявление с этим
  media id в имени (обрыв между ответом Meta и записью в базу не даст дубля).

## Как включить в бою
1. Оплатить кабинет `2882470011985212` и получить маркер рекламы **с правом `ads_management`** (текущий
   маркер читает статистику, `ads_read`) — Настройки → Каналы → маркер рекламы.
2. В Ads Manager создать ОДНУ кампанию (цель «Сообщения», бессрочно) и группу объявлений в ней; номер
   группы вписать в блок «Автопродвижение роликов».
3. В Настройках → Каналы должен быть указан номер Страницы Facebook (`metaPageId`); к кабинету подключён
   аккаунт Instagram (`/act_<id>/connected_instagram_accounts`). Кабинет должен быть в USD — иначе боевой
   режим сам отказывается (стоп-лосс задан в долларах).
4. Включить «Автопродвижение роликов» (пробный режим остаётся), сутки смотреть таблицу решений, нажать
   «Проверить сейчас». Затем выключить «Пробный режим». Сервер не даёт включить боевой режим без номера группы.

## Источники Meta (сверено поиском по документации 23.10.2026)
- Креатив из готовой публикации: `object_id` (Страница) + `instagram_user_id` + `source_instagram_media_id`,
  POST `/act_<кабинет>/adcreatives` — https://developers.facebook.com/documentation/ads-commerce/instagram/ads-api/guides/use-posts-as-ads
- Объявление: POST `/act_<кабинет>/ads` с `adset_id`, `creative={"creative_id":…}`, `status` —
  https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/partnership-ads/ads-creation/boost-existing-post
- Кнопки: `MESSAGE_PAGE` + `app_destination` `INSTAGRAM_DIRECT`/`MESSENGER` (страница use-posts-as-ads);
  `WHATSAPP_MESSAGE` — https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/messaging-ads/click-to-whatsapp
- Instagram-аккаунт кабинета: `/act_<кабинет>/connected_instagram_accounts` (страница use-posts-as-ads).
- Пригодность публикации: поле `boost_eligibility_info` у медиа Instagram —
  https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/ . Ограничение из документации:
  публикации с лицензионной музыкой и интерактивными элементами (фильтры) продвигать нельзя.
- Результат: insights, действие `onsite_conversion.total_messaging_connection` (запасное —
  `messaging_conversation_started_7d`), то же, что уже читает синхронизация расходов (`conversationsOf`).

## Не проверено на живом кабинете (кабинет не оплачен, маркера записи нет)
- Точный вид `value` у `WHATSAPP_MESSAGE` (может потребоваться ссылка `https://api.whatsapp.com/…`).
- Имена подполей `boost_eligibility_info` (код читает `eligible_to_boost`; если поля нет — «не знаем» и
  решает попытка создания; отказ Meta попадает в журнал ошибок и в причину строки FAILED).
- Условия рилса «≤90 с, 9:16, не расшарен на Facebook» из памяти владельца в коде не проверяются сами —
  непригодную публикацию отсеивает ответ Meta (`SKIPPED`/`FAILED` с причиной).
- Фильтр `name CONTAIN` на `/adset/ads` (поиск дубля при повторе).

## Чем проверено
`npm run build:api`, `npm run build:web`, `npm run test:web`, `npm run map:check`; тесты
`reels-autoboost-decide` (37) и `reels-autoboost-tick` (18); миграция сверена с schema.prisma
(`prisma migrate diff` — без различий); сторож решений проверен нарочной поломкой (`>=` → `>` в стоп-лоссе).
Глазами экран не смотрели (кадры ПК/телефон — на сборщике).
