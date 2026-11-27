# 2026-11-28: короткие сообщения монтажёру в Telegram

Решение владельца: упростить автосообщения CRM монтажёру. План: `docs/plans/montajer-messages-2026-11-27.md`, инвентарь: `docs/plans/montajer-messages-2026-11-27-inventory/`.

## Что сделано
- Один модуль текстов `apps/api/src/lib/montajerTexts.ts`: короткий набор (`SHORT_MONTAJER_TEXTS`) и прежний (`LEGACY_MONTAJER_TEXTS`, слово в слово). Вызывающие файлы (videoHandoff, narrationDelivery, narrationMontajerNote, narrationAutoFlow, propertyEditNotify, montajerHandover, montajerReceive, routes/settings, routes/properties/narration) берут тексты оттуда.
- Рубильник `Settings.montajerShortMessages` (по умолчанию ВКЛ, миграция `20261128120000_montajer_short_messages`), подпись в Настройках «Короткие сообщения монтажёру». Выключен: прежние тексты.
- Факты карточки только под первым файлом; файлы 2..N: «Объект №N · 🎬 видео i из N · размер, длительность». Строка «Дальше в очереди» из подписи убрана.
- Один файл без голоса: итога нет, кнопки «Очередь» и «Пропустить» под самим файлом (`sendDocumentFile`/`sendDocument` принимают `buttons`). Несколько файлов или голос: короткий итог `Объект №N: K видео отправлено. Голос придёт следом.` с теми же кнопками.
- «Передан другому монтажёру» одной функцией `tellPreviousMontajerHandedOver`.
- Не менялось: очередь передачи, первая строка квитанции, коды `mj:*`, имена файлов, MontajerMessage, sendToMontajer, копии наблюдателям, мёртвый код «без голоса».

## Тесты
`tests/montajer-short-messages.test.ts` (сторож: без «—», «–», «ОБ-», «ролик №N»; режим ВЫКЛ; голос задерживается, «Без озвучки», «Чей это ролик», «Жду ролик», альбом, montajerViews, тяжёлый файл) плюс обновлённые тексты в соседних тестах.
