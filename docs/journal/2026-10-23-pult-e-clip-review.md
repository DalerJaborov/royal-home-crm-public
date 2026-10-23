# Пульт директора: очередь «Проверка ролика» (пачка E, 23.10.2026)

## Что изменилось
- Сервер: `GET /api/v1/properties/clip-review/pending` (`properties.moderate`, query `limit` 1..20 по умолчанию 20, Zod). Отдаёт `items` (id, shortId, title, videoUrl, coverUrl, requestedAt, montajer) и `total`; давние первыми.
- Признак «ждёт проверки» вынесен в `CLIP_REVIEW_PENDING_WHERE` (`lib/clipReview.ts`): RECEIVED + PENDING, без удалённых. Им же теперь пользуется `approveClip`, поэтому список и решение не разойдутся.
- Пульт: очередь `clips` («Проверка ролика», группа «Видео») в `usePultInbox.ts`, ключ `["properties","pult-inbox","clips"]` — её гасит `property.updated`. Строка с кнопкой «Смотреть» открывает `CleanClipReviewSheet` (плеер, «Одобрить», «Вернуть» с обязательной причиной).
- «Вернуть» шлёт `reason: "OTHER"` и `comment` = причина (схема сервера требует комментарий для OTHER).

## Почему не `awaitingReview`
`video.pipeline.awaitingReview` в mission-control считает объекты в статусе `PENDING_REVIEW` (проверка материалов объекта), а не ролики. Ролик ждёт проверки при `videoHandoffStatus=RECEIVED` и `clipReviewStatus=PENDING` — по нему и построен список.

## Проверка
`build:api`, `build:web`, `test:web` (304 файла) зелёные; api: `clip-review-pending-list.test.ts` (3) и `clip-review.test.ts` (12).

## Осталось
Кадры и живая проверка плеера с подписанным URL — у сборщика.
