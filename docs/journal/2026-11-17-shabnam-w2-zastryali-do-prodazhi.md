# 17.11.2026 — Шабнам, волна 2: «вывести без Instagram» и сводка «застряли до продажи»

- **Почему.** ОБ-000193: ролик принят 06.11, вышел в YouTube, Facebook, Telegram, TikTok, а в
  Instagram — нет (ключ Instagram мёртв с 12.11, пароль сменили → 401). Правило 02.08 требует
  ссылку на Reels, поэтому объект 11 дней стоял на «Монтаже». Всего до продажи застряли 13 объектов,
  и одним списком «что стоит, почему и кто следующий» их нигде не было видно.

- **Почему Instagram не опубликовал и почему объект висел (по коду).**
  - Instagram берёт маркер из аккаунта по умолчанию (`MessengerAccount` INSTAGRAM, маркер `IGAA…`),
    иначе из `Settings.metaIgToken` / `META_IG_TOKEN` (`messengers/meta.ts:108-153`; маркер Страницы
    `EAA…` из аккаунта для публикации пропускается). Мёртвый ключ → `instagramTokenIdentity` не
    проходит → канал «не удалось», строка в журнале ошибок (`lib/socialPublish.ts:3235-3246`).
  - Повтор: только для «попросили позже» и только у TikTok (`lib/videoHandoff.ts:3354-3384`).
    Отказ Instagram — окончательный: задание публикации завершается DONE (`jobs/videoHandoffPublish.ts:142-157`).
  - Узнаёт один раз пуш «опубликован частично… Не ушло: INSTAGRAM. В продажу не вышел…» модераторам и
    хозяину (`lib/videoHandoff.ts:3545-3563`); сторож недоехавших публикаций смотрит только объекты,
    где не вышло НИЧЕГО (`lib/videoHandoffUnfinishedPublishWatchdog.ts:64`).
  - Выход в продажу — `finalizePropertyAvailability`, а он упирается в `blockersForSale` «нет ссылки на
    Instagram» (`lib/videoHandoff.ts:1853-1854`, `lib/propertyPipeline.ts:115-138`) — отсюда «Монтаж» навсегда.
  - Кнопки «повторить только Instagram» нет: «Опубликовать сейчас» отказывает, если ролик уже вышел
    хоть где-то (`lib/videoHandoff.ts:2989-2991`). Ручной путь — опубликовать в приложении и вписать
    ссылку в карточку (автовыход в продажу при вставке ссылки, `routes/properties/crud.ts`).

- **Что изменилось.**
  - `lib/propertyCompleteEditing.ts` — дверь «Готово» принимает `withoutInstagram: true`: право
    `properties.delete` (директор/админ, «кто удаляет — тот и судит»), ролик принят (проверка не PENDING
    и не REJECTED; NONE — проверка не требовалась) и вышел хотя бы в одну сеть. Снимается только причина
    «нет ссылки на Instagram»; мало фото или чужая ссылка — прежний отказ. Остальным — 403 «попросите
    директора». Обычный отказ без ссылки несёт подсказку `withoutInstagram {allowed, needsDirector,
    channels, reason}`. Успех пишет `PROPERTY_SALE_WITHOUT_INSTAGRAM` (кто, источник, сети, причина).
  - Маршрут `POST /properties/:id/complete-editing` — тело `{ withoutInstagram? }` (Zod), в отказе —
    `code`, `blockers`, `withoutInstagram`.
  - Инструмент Шабнам `complete_property_editing` — аргумент `withoutInstagram`, в карточке подтверждения
    явная строка «Без Instagram: ролик вышел в …»; отказ подсказывает модели предложить это директору,
    рядовому — «попросите директора».
  - Экран: в «Готово, в продажу» (одна компонента на ПК и телефоне, `PropertyDetail.tsx`) после отказа
    у директора/админа появляется «Вывести в продажу без Instagram» с подтверждением; решает сервер
    (`apps/web/src/lib/saleWithoutInstagram.ts`). Подпись журнала — `apps/web/src/lib/audit.ts`.
  - `lib/stuckBeforeSale.ts` — одна функция «застряли до продажи» (больше 3 суток на этапе, по Душанбе,
    предел 50/200, счётчик): этап, с какого числа, дни, причина словами, кто следующий. Где ролик —
    `summarizePropertyWork`, условия — `saleBlockerCodes`/`saleWithoutInstagramEligibility`.
    `get_stuck_work` показывает блок `beforeSale` и строки в display.
  - Попутно (тот же класс): `summarizePropertyWork` называл принятый ролик на проверке «публикация не
    завершена» — ветка «ждёт решения» не достигалась. Теперь проверка ролика стоит первой.
  - `docs/product-flows.*`, `docs/product-map-simple.json` пересобраны.

- **Чем проверено.** Сборка и тесты НЕ запускались (в копии нет `node_modules`, по заданию). Написаны:
  `apps/api/tests/property-sale-without-instagram.test.ts`, `apps/api/tests/stuck-before-sale.test.ts`,
  случай в `apps/api/tests/assistant-property-work-status.unit.test.ts`,
  `apps/web/src/lib/__tests__/saleWithoutInstagram.test.ts`. `product-flows --check` и
  `product-map-simple --check` зелёные; `product-map.mjs` не запускался (нужен `typescript`).

- **Что осталось.** Прогнать `npm run build`, `npm run map`, `npm run precheck`, новые тесты; кадры кнопки
  на ПК и телефоне. Починить ключ Instagram (Настройки → Каналы) — без «да» на прод не трогали. Кнопки
  «повторить публикацию только в Instagram» нет — отдельная задача. Сторож `audit:audit-labels` не видит
  `logAgentAudit(` — подпись добавлена руками.
