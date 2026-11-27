# Инвентарь сообщений монтажёру: lib/videoHandoff.ts

Дата: 27.11.2026. Ветка claude/montajer-bot-simplify-61b520. Только чтение, ничего не менял и не слал.
Пути относительно `apps/api/src`. Файл `lib/videoHandoff.ts` (4783 строк) прочитан по существу: все места отправки + тексты-источники + триггеры. Вне файла прочитано только то, что файл вызывает (montageObservers.ts, montajerQueueButtons.ts, narrationMontajerNote.ts, narrationDelivery.ts (отправка голоса), narrationAutoFlow.ts::narrationAfterVideoIssued, videoHandoffRedelivery.ts, telegram/api.ts (подписи, лимиты)).

## 0. Главное

Внутри videoHandoff.ts Telegram-сообщения монтажёру уходят ровно из ЧЕТЫРЁХ мест (плюс голос, который запускает хук из этого файла):

| N | Что | Где |
|---|---|---|
| A | Файлы-исходники (документами) с подписью, по одному на ролик | `deliverSourceVideos` 1518-1714 |
| B | «Тяжёлый» файл: вместо документа текст со ссылкой | там же 1608-1631 |
| C | Контрольное «Отправлено N из N файлов…» (+кнопки, +строка про озвучку) | `dispatchToEditorAfterClaim` 1356-1371 |
| D | «Объект №N <причина> — доделывать не нужно…» | `notifyMontajerHandoffCancelled` 3932-3962 |
| E | Запасная ссылка «так и не дошёл файлом» | `sendGiveUpFallbackLinks` 830-854 |
| F | Голос mp3 (+текст озвучки) следом за видео | хук 1373-1379 → `narrationAfterVideoIssued` → `executeNarrationDelivery` |

Все тексты, кроме файлов (A) и голоса (F), идут через `sendToMontajer` (montageObservers.ts:105), которая сама копирует наблюдателям. Файлы (A) копируются отдельным циклом в 1384-1389. Голос (F) копируется своим путём (narrationDelivery.ts::copyNarrationToObservers).

Реактивные ответы бота («очередь», «объект N», кнопки) в этом файле только СОБИРАЮТСЯ (`montajerCardText` 393, `queueStatusForMontajer` 929), а отправляет их telegram/montajerBot.ts, это вне задачи (разобрано в п. 7).

## 1. Общие механики (нужны, чтобы читать таблицу)

**Общая точка текста — `sendToMontajer(chatId, text, {copy, replyMarkup, propertyShortId})`** (montageObservers.ts:105-126):
- есть кнопки -> `sendMessageWithButtons`, иначе `sendMessage`;
- `copy !== false` (в videoHandoff.ts везде true) -> читает Settings.videoMontajerAgentId, имя монтажёра, и каждому наблюдателю шлёт `sendMessage(observerChat, "Копия. Монтажёр: {имя|не назначен}\n\n{text}")`, БЕЗ кнопок;
- наблюдатели: Agent.montageCopiesTelegram=true, isActive, есть telegramChatId, не сам монтажёр, take 50. Ошибка одному наблюдателю не мешает остальным (try/catch, logSystemError).
- Отдельный лимит: `sendMessage` режет текст на куски по 4096 знаков (telegram/api.ts, parts), подпись к файлу режется до 1024 знаков с «…» (CAPTION_MAX_CHARS).

**Подпись файла (`montajerFileCaption`, 1090-1105)** для файла i из M:
```
[{note}\n\n]            <- только у копии наблюдателю: "Копия. Монтажёр: {имя}"
Объект №{shortId} · файл {i+1} из {M}[ · {describeRawVideo}]
<пустая строка>
{body}
```
- `describeRawVideo` (rawVideoFacts.ts:126) = части через « · »: длительность `м:сс`, `ШИРИНАхВЫСОТА`, видеокодек, `⚠ БЕЗ ЗВУКА` (если hasAudio=false). Пустые части пропускаются.
- `body` для файла 1 = `headText` (см. 2.1/2.2), для файлов 2..M = `factsText` (семь фактов, повторяются в КАЖДОМ файле, решение 19.09.2026).
- Файл с номером 1 несёт и очередь, и строку про озвучку, и «Без звука»; остальные только факты.

**`factsText` (`propertyFactsForMontajer`, 163-228)**, пустые строки не печатаются:
```
Объект №{shortId}
Агент: {assignedAgent|intakeAgent fullName}
Район: {district}
Адрес: {address}
Этаж: {floor}
Этажность: {totalFloors}
Площадь: {areaSqm} м²
Комнаты: {rooms}
```
(цены нет с 25.11.2026).

**Имя файла-документа (`montajerFileName`, 129)**: `{shortId}{_{i+1}из{M} если M>1}{расширение исходника}`, например `214_2из3.mov`.

**Порядок и пауза**: файлы по `SOURCE_VIDEO_ORDER` (uploadedAt asc, id asc). Между файлами одного чата `sleep(1100 мс)` (`TELEGRAM_SEND_PAUSE_MS`, в тестах обнуляется `setMontajerSendPauseMsForTests`). Перед КАЖДЫМ файлом перепроверка: объект ещё у этого монтажёра (иначе остаток не шлётся: «removed» / «editor-changed» / «deferred»), и файл принадлежит объекту.

**Три способа отправки одного файла** (в порядке попытки):
1. Размер > `TELEGRAM_BOT_SEND_LIMIT_BYTES` (2 ГБ на своём Bot API, иначе 50 МБ) -> текст-ссылка (сообщение B), файл не шлётся.
2. Есть `video.telegramFileId` -> `sendDocument(chatId, file_id, head)` (секунда, без загрузки). Сбой -> уходит в п. 3 и пишет logSystemError.
3. `sendDocumentFile(chatId, {path}, montajerFileName(...), head, timeout)` (таймаут `60с + 1с/МБ`). Успех -> сохраняет file_id в PropertyVideo. Сбой -> файл «не дошёл», запасной ссылки сразу НЕТ (убрана 24.09.2026, чтобы не было дублей), досылает сторож.
Rate-limit (429 после повторов api.ts) -> остаток круга не шлётся, дошлёт сторож.

**Отметки доставки**: `PropertyVideo.montajerDeliveredAt/ToId` ставится при успехе (файлом или ссылкой B); `Property.videoHandoffDeliveredAt` - когда КАЖДЫЙ файл у монтажёра. Повторы шлют только файлы без отметки (resend="missing"), «все заново» только кнопкой/`force`.

**Защита от дублей одной выдачи**: атомарный захват `videoHandoffDispatchStartedAt` (окно 15 мин, `HANDOFF_DISPATCH_BUSY_WINDOW_MS`); вторая параллельная отправка получает "busy" и ничего не шлёт.

## 2. Сообщения подробно

### 2.1 Файл-документ, обычная передача (сообщение A)
1. **Где**: `deliverSourceVideos` videoHandoff.ts:1518; отправка 1640 (`sendDocument` по file_id) и 1657 (`sendDocumentFile`); подпись `montajerFileCaption` 1090.
2. **Кто запускает**: `dispatchToEditor` (1138) -> `dispatchToEditorAfterClaim` (1273). Вызывается из: `queueVideoHandoff` (740; одобрение в lib/propertyReview.ts:172, восстановление из корзины trashProperty.ts:470, возврат на монтаж publishedVideoFix.ts, «Снова на монтаж») прямо, если место свободно; `releaseQueueIfClear` (4710) в фоне через `dispatchInBackground` (после приёма готового ролика, снятия, публикации, тика сторожа); `montajerQueueControl.ts` (кнопки «Пропустить»/«Взять сейчас»/«Сделаю позже»); `routes/settings.ts:1863` (смена монтажёра); `montajerHandover.ts` (передача новому монтажёру); `routes/marketing.ts:937` (кнопка «Прислать файлами», resend="all"); `resendSourceVideos` (слово «файлы» в боте montajerBot.ts:234/328, staffClip.ts:374); сторож `runVideoHandoffRedeliveryTick` (cron.ts:2459, см. 2.9).
3. **Условия**: Settings.videoHandoffEnabled (проверяется в `queueVideoHandoff` и в тике сторожа, самого `dispatchToEditor` это НЕ гасит); назначен монтажёр; монтажёр isActive и есть telegramChatId; объект держит место (`EDITOR_HOLDER_WHERE`: SENT_TO_EDITOR, не удалён, не ручная загрузка); очередь не на паузе (пауза не даёт выдать место). Файлов 0 -> ничего не шлётся, попытка засчитана, сторож повторит.
4. **Текст (подпись)** для файла 1:
```
Объект №{shortId} · файл 1 из {M}[ · {длит} · {W×H} · {кодек}[ · ⚠ БЕЗ ЗВУКА]]

Объект №{shortId}
Агент: ...
Район: ...
Адрес: ...
Этаж: ...
Этажность: ...
Площадь: ... м²
Комнаты: ...[

Дальше в очереди: {n} {ролик|ролика|роликов}[ (очередь на паузе — следующий пока не придёт)].][

{строка про озвучку, см. 4}][

⚠ Без звука: {имена файлов через ", "} — звук/музыку наложите при монтаже]
```
   Для файлов 2..M: та же первая строка `Объект №N · файл k из M · ...`, пустая строка, потом только `factsText`.
   «Дальше в очереди» считает РОЛИКИ (файлы) неотложенных объектов в очереди, не объекты. Пусто, если очередь пуста.
5. **Кнопки**: нет.
6. **Файлы**: документ, имя `{shortId}[_{k}из{M}].{ext}`, подпись выше; порядок по загрузке; «файл k из M».
7. **Копии наблюдателям**: после ВСЕЙ отправки монтажёру (и после контрольного C и голоса F), цикл 1384-1389: `sendMontageCopies` -> `deliverSourceVideos(observerChat, ..., {note:"Копия. Монтажёр: {имя}", onlyVideoIds})`, только те файлы, что реально ушли монтажёру в этот раз; подпись = `Копия. Монтажёр: {имя}\n\n` + подпись монтажёра. Идут по file_id, который сохранился при отправке монтажёру. Тоже с паузой 1,1 с. Без кнопок.
8. **Что гасит**: videoHandoffEnabled=false (не ставит в очередь и не досылает); не назначен монтажёр; монтажёр отключён/без Telegram (вместо файлов CRM-пуш, см. 2.10); пауза очереди (место не выдаётся); Agent.montageCopiesTelegram у наблюдателя (только копии). Отдельного выключателя на сам текст подписи нет.
9. **Тесты** (apps/api/tests): video-handoff.test.ts, montajer-delivery.test.ts, montage-copies.test.ts, montajer-file-number.test.ts (шапка «Объект №N · файл k из M», имя файла), montage-copy-door.test.ts, montajer-telegram-429.test.ts, montajer-inactive-no-send.test.ts, audit2-e-dispatch-claim.test.ts, video-handoff-redelivery.test.ts, video-handoff-queue-order.test.ts, montajer-bot.test.ts. «Дальше в очереди» - video-handoff.test.ts. «⚠ Без звука» (`silentNote`) по тексту нигде не проверяется (нет совпадений в tests), проверяется только hasAudio в других тестах.

### 2.2 Файл-документ, перемонтаж (сообщение A, remake)
1. Те же функции; ветка `remake` в `buildMontajerMessageText` (326-341); причина берётся с объекта (`videoHandoffRemakeReason/Comment`, кладёт `applyQueueTransition` 720).
2. Триггер: `queueVideoHandoff(id, remake)` из `sendBackToMontajer` (publishedVideoFix.ts), смена цены/озвучки (NARRATION_CHANGED), новые кадры (NEW_FOOTAGE) и т.п.; дальше как 2.1.
3. **Текст `headText`** (подпись файла 1, после шапки «Объект №N · файл 1 из M ...»):
```
🔁 ПЕРЕМОНТАЖ, объект №{shortId}
Причина: {метка}
{комментарий, если есть}
[
Что изменилось в карточке:     <- только WRONG_CAPTION и CARD_DATA_CHANGED и если есть прошлая передача
• {Поле}: «было» → «стало» / добавилось — ... / было «...», теперь не указано]
[
{строка про озвучку}]

{factsText}[

⚠ Без звука: ...]
```
   Метки причин (`VIDEO_REMAKE_REASON_LABELS`): WRONG_CAPTION «Надпись на видео неверная»; NO_MUSIC «Нет музыки или не тот звук»; WRONG_OBJECT «На видео не тот объект»; POOR_EDIT «Плохой монтаж: склейки, дрожь, обрывы»; CARD_DATA_CHANGED «Данные карточки изменились, нужен новый текст»; OTHER «Другое»; NARRATION_CHANGED «Новая озвучка: заменить только звук, монтаж прежний»; NEW_FOOTAGE «Новые кадры от сотрудника: смонтировать заново». В перемонтаже строки «Дальше в очереди» нет. Файлы 2..M как в 2.1.
4. Кнопки, файлы, копии, выключатели, тесты: как 2.1. Тесты на «ПЕРЕМОНТАЖ»: montajer-queue-controls.test.ts, video-remake.test.ts, narration-own-music.test.ts. Блок «Что изменилось в карточке» (`cardFactsDiff`) прямых тестов по тексту НЕ имеет.
5. Шум: номер объекта три раза подряд (шапка файла, «ПЕРЕМОНТАЖ, объект №N», первая строка фактов).

### 2.3 «Тяжёлый» файл вместо документа (сообщение B)
1. `deliverSourceVideos` videoHandoff.ts:1608-1631, `sendMessage` (НЕ через sendToMontajer).
2. Триггер: тот же круг файлов, когда `stat.size > TELEGRAM_BOT_SEND_LIMIT_BYTES`.
3. **Текст**: `{head}\n\nФайл {МБ} МБ — тяжелее, чем принимает Telegram. Скачать: {ссылка}` где `{head}` = полная подпись файла (шапка + факты + очередь и т.д., как в 2.1), а без публичного адреса CRM: `...Заберите через карточку объекта в CRM.` Ссылка: `{crmPublicBase}/api/v1/properties/{propertyId}/videos/{videoId}/download-file?token=...` (токен 7 дней, Content-Disposition: attachment).
4. Кнопок и файла нет. Считается доставленным (`delivered("link")`).
5. Копия наблюдателю: тем же циклом 1384-1389 (`deliverSourceVideos` для наблюдателя пойдёт той же веткой, тот же текст с пометкой «Копия» в начале подписи).
6. Гасится: только размером; отдельного рубильника нет. Ошибка отправки -> «не дошёл», при 429 остаток круга не шлётся.
7. Тесты: прямого теста на фразу «тяжелее, чем принимает» НЕ найдено (grep по tests пустой); смежно video-handoff-montajer-panel.test.ts и social-publish-telegram.test.ts (SEND_LIMIT).

### 2.4 Контрольное сообщение «Отправлено N из N» (сообщение C)
1. `dispatchToEditorAfterClaim` videoHandoff.ts:1356-1371 -> `sendToMontajer`. Текст `montajerDeliveryControlText` 157.
2. Триггер: сразу после цикла файлов, ТОЛЬКО если в этот раз что-то реально ушло (`result.sentVideoIds.size > 0`). На повторе, где всё уже было, не шлётся. При прерывании (`aborted`) не шлётся.
3. **Текст**: 
   - всё у монтажёра: `Отправлено {M} из {M} {файла|файлов} объекта №{shortId}.`
   - не всё: `Объект №{shortId}: дошло {k} из {M} {файла|файлов}, остальное дошлю автоматически.`
   - если голос уйдёт следом (`narrationNextMessageLine`, narrationMontajerNote.ts:60), к тексту через пустую строку добавляется:
     - режим mixByCrm: `🎙 Озвучка — следующим сообщением: под неё длина и темп.`
     - иначе: `🎙 Озвучка — следующим сообщением, вклейте её сами.` (+ `voicelessCopyHint()`, сейчас пусто).
   Склонение «файла/файлов» после «из» (`filesAfterIz`: 1,21,31 -> «файла»).
4. **Кнопки** (`holderTaskButtons`, montajerQueueButtons.ts): один ряд «🗂 Очередь» -> `mj:queue`; «⏭ Пропустить №{shortId}» -> `mj:sk:{shortId}`. Только если Settings.montajerQueueControlEnabled !== false (умолчание true; при ошибке чтения кнопок нет).
5. **Файлов нет**.
6. **Копия наблюдателям**: да, `sendToMontajer({copy:true})`: `Копия. Монтажёр: {имя}\n\n{текст}` без кнопок. Идёт СРАЗУ вслед за монтажёру (внутри sendToMontajer), то есть ДО копий файлов (копии файлов в 1384 идут после голоса).
7. **Гасится**: montajerQueueControlEnabled=false убирает только кнопки; сам текст выключателя не имеет. Если голос не следует (озвучка выключена: CRM_NARRATION_EXECUTION_MODE != LIVE, narrationOff, версия не одобрена и т.п.), строки про озвучку нет.
8. **Тесты**: video-handoff.test.ts, montajer-delivery.test.ts, montage-copies.test.ts, montajer-file-number.test.ts, montajer-queue-controls.test.ts (кнопки), video-handoff-redelivery.test.ts, narration-follows-video.test.ts (строка про озвучку), montajer-bot.test.ts.

### 2.5 Голос (mp3) следом за видео (сообщение F)
1. Запуск в videoHandoff.ts:1373-1379: `await sleep(1100)` и `videoIssuedToMontajerHook(propertyId, montajerAgentId)` = `narrationAfterVideoIssued` (narrationAutoFlow.ts:521; хук ставят index.ts:71 и worker.ts) -> `queueNarrationDelivery` -> `executeNarrationDelivery` (narrationDelivery.ts:~225-320).
2. Условие (`voiceFollows`, 1352): доставка видео целая (`result.delivered`), в этот раз что-то реально ушло, хук поставлен. Дальше: CRM_NARRATION_EXECUTION_MODE=LIVE (`mediaExecutionMode("NARRATION")`), у объекта нет narrationOff, последняя версия озвучки READY, одобрена, source не MANUAL, факты совпадают, цена в тексте не в долларах. Иначе тихо ничего.
3. **Текст-подпись к mp3** (`prepareNarrationDeliveryPlan` narrationDelivery.ts:206-212):
   - mixByCrm: `Объект №{N}. Озвучка, версия {R}: под неё длина и темп. Пришлите ролик БЕЗ голоса (музыка и звуки можно), голос CRM наложит сама. Ролик не короче озвучки.`
   - soundOnly (возврат NARRATION_CHANGED, и голос раньше уже уходил): `Озвучка к ролику №{N}, версия {R}: замените в ролике только голос, музыку и монтаж не трогайте.`
   - иначе: `Озвучка к ролику №{N}, версия {R}, одобрена. Вклейте этот голос сами: музыка, громкость и монтаж ваши.`
   - к подписи добавляется `\n\nТекст:\n{script}`, если влезает в 1024 знака. Не влезло -> mp3 с подписью без текста и ОТДЕЛЬНЫМ сообщением `Текст озвучки №{N}:\n{script}` (sendMessage, до 4096 на кусок).
4. Файл: документ `property-{N}-voice-v{R}.mp3`; режим WITH_SOURCES (ручная передача из карточки) дополнительно шлёт исходники с подписью `Объект №{N}. Исходник. Озвучка v{R}.\n{factsText}`, в автоходе за видео режим AUDIO_ONLY (без исходников).
5. Кнопок нет.
6. **Копия наблюдателям**: `copyNarrationToObservers` после квитанции каждого файла (flushCopies), подпись `Копия. Монтажёр: {имя}\n\n{подпись}`, при превышении 1024 текст отдельным сообщением `Копия. Монтажёр: {имя}\n\nТекст озвучки №N:\n...`.
7. Гасит: CRM_NARRATION_EXECUTION_MODE!=LIVE, narrationOff, рубильники озвучки, отсутствие одобрения. Нет повторов автоматически (UNKNOWN/FAILED -> тревога, «передайте вручную»).
8. Тесты: narration-follows-video.test.ts, narration-delivery.test.ts, narration-delivery-assigned-montajer.test.ts, narration-delivery-copy.test.ts, narration-montajer-audio.test.ts, narration-crm-mix.test.ts, narration-simple-approve.test.ts.
9. Дубль: строка про озвучку идёт ТРИЖДЫ: в подписи файла 1 (2.6), в контрольном C («Озвучка — следующим сообщением»), и сам mp3 с подписью.

### 2.6 Строка про озвучку в подписи файла 1 (часть A, источник `narrationLineForMontajer`, narrationMontajerNote.ts:73)
Входит в headText. Варианты (один на объект, зависит от состояния):
- `🔇 Без озвучки: голос в ролик не нужен.` (narrationOff)
- mixByCrm и есть версия/мастер: `🎙 Озвучку накладывает CRM: пришлите ролик БЕЗ голоса (музыка и звуки можно).`
- нет версии, CRM её подготовит: `🎙 Озвучка готовится и придёт сюда, как будет готова, — вклейте её сами.`
- ручная озвучка маркетинга: `🎙 Озвучку этого объекта ведёт маркетинг вручную: сама она сюда не придёт. Нужна — спросите маркетинг.`
- одобрена, уйдёт следом: `🎙 Озвучка одобрена: mp3 придёт сразу после файлов ролика — вклейте её сами.`
- одобрена, но сразу не уйдёт: `🎙 Озвучка придёт сюда, как будет готова, — вклейте её сами.`
- квота ElevenLabs: `🎙 Озвучка задерживается: сервис озвучки на паузе. Придёт сюда, как будет готова.`
- одобрена при сохранении / ждёт одобрения: `🎙 Озвучка готовится и придёт сюда...` / `🎙 Озвучка ждёт одобрения и придёт сюда, как будет готова, — вклейте её сами.`
Тесты: narration-montajer-prepare-line.test.ts, narration-follows-video.test.ts, narration-review-fixes.test.ts, narration-montajer-audio.test.ts, narration-listen-approve-on-save.test.ts, narration-delivery-assigned-montajer.test.ts.

### 2.7 «Сняли с монтажа» (сообщение D)
1. `notifyMontajerHandoffCancelled` videoHandoff.ts:3932 через `sendToMontajer({copy:true, propertyShortId})` (3951), вызывается из `closeVideoHandoff` 3796 (ветка `wasWithEditor`, 3872) и из `notifyMontajerFinalUploadedManually` 3894.
2. **Триггеры**: 
   - ручное снятие из конвейера (`cancelVideoHandoffQueueEntry`, routes/marketing.ts:840): причина по умолчанию «сняли с монтажа»;
   - продажа/снятие/резерв (`closeWorkAfterLeavingSale`, propertyLeftSale.ts:41): «продан», «снят с продажи», «в резерве»;
   - возврат на доработку (propertyStatusChange.ts:191): «возвращён на доработку»;
   - ролик опубликован вручную/по ссылке (`skipVideoHandoffOnManualPublish`, propertyCompleteEditing.ts:349, properties/crud.ts:1521): по умолчанию «сняли с монтажа»;
   - корзина (`releaseVideoHandoffForTrashed`, trashProperty.ts:307): «удалён», kind PROPERTY_DELETED;
   - готовый ролик загрузили из CRM, пока объект держал монтажёр (finalVideoIntake.ts:43): «готов — ролик загрузили из CRM»;
   - staffClip.ts:416 снимает ждущий (QUEUED) объект.
3. Только когда объект держал место монтажёра (SENT_TO_EDITOR, не ручная загрузка). Если объект только ждал в очереди (QUEUED) - монтажёру НИЧЕГО в Telegram, только запись в журнал `Объект №{N} {reason} — снят из очереди монтажа, ролик монтажёру не отправлялся.` (3878).
4. **Текст**: `Объект №{shortId} {reason} — доделывать не нужно, ролик можно не присылать.`
   Нет Telegram у монтажёра -> только журнал (MontajerMessage), CRM-пуш по-прежнему идёт.
5. Кнопок нет, файлов нет.
6. Копия наблюдателям: да (`Копия. Монтажёр: {имя}\n\n{текст}`).
7. Параллельно уходит ещё CRM-ПУШ модераторам (не монтажёру): заголовок `Объект №{N} снят с монтажа`, тело = тот же текст (3959-3961).
8. Особый случай «Монтажёр сам снял» (`byMontajer`, кнопки «Уже сделан»/«Не нужен», 3867-3871): монтажёру из этого файла НИЧЕГО не шлётся (отвечает бот), пишется журнал и пуш руководству (`montajerSkippedDoneText` 3783): `Монтажёр снял объект №{N} из очереди: уже сделан, ролик пришлёт сам. Объект остался на прежнем этапе.` / `...: ролик не нужен. Объект остался на прежнем этапе.` (+ «Это была переделка вышедшего ролика: старые посты остались как есть.»). Пуш: `Монтажёр пропустил №{N}: уже сделан, ролик пришлёт` / `...: ролик не нужен`.
9. Порядок: сначала D, потом освобождение места (`releaseQueueIfClear` 3884) и отправка файлов СЛЕДУЮЩЕГО объекта. То есть по одному событию снятия монтажёр получает подряд: D, затем целый набор A/C/F следующего объекта.
10. Выключателей на текст D нет (только отсутствие Telegram). 
11. Тесты: video-handoff.test.ts, montage-copies.test.ts, montajer-queue-controls.test.ts (byMontajer, `montajerSkippedDoneText`), video-handoff-never-silent.test.ts, video-handoff-hold.test.ts.

### 2.8 Запасная ссылка «так и не дошёл файлом» (сообщение E)
1. `sendGiveUpFallbackLinks` videoHandoff.ts:830 -> `sendToMontajer({copy:true})` (846), по одному сообщению НА КАЖДЫЙ недоставленный файл.
2. Триггер: ТОЛЬКО сторож `runVideoHandoffRedeliveryTick` (videoHandoffRedelivery.ts:175), когда попытки исчерпаны (`REDELIVERY_MAX_ATTEMPTS`=6), не чаще раза в сутки на объект (`shouldAlert ..., 24ч`). Cron тика cron.ts:2459.
3. **Текст**:
   - `Объект №{N}: ролик «{filename}» так и не дошёл файлом после всех попыток. Ссылка на скачивание: {ссылка}`
   - без публичного адреса: `Объект №{N}: ролик «{filename}» так и не дошёл файлом после всех попыток, а ссылка недоступна (не настроен публичный адрес CRM) — заберите через карточку объекта в CRM.`
   Здесь используется имя исходного файла (`IMG_xxxx.mov`), хотя везде в других местах номер объекта.
4. Кнопок, файлов нет.
5. Копия наблюдателям: да (`Копия. Монтажёр: ...`).
6. Гасит: videoHandoffEnabled=false (тик выходит), нет монтажёра/нет Telegram. Отдельного рубильника нет.
7. Тесты: video-handoff-redelivery.test.ts, video-handoff.test.ts, montajer-bot.test.ts (grep «sendGiveUpFallbackLinks|Ссылка на скачивание|download-file»).

### 2.9 Досылка сторожем (повтор A + C + F)
Не отдельное сообщение, а повтор: `runVideoHandoffRedeliveryTick` (cron.ts:2459; videoHandoffRedelivery.ts:~150-205) зовёт `dispatchToEditor(p.id, montajerAgentId)` для держателей, у которых исходники не дошли. Паузы нарастают: 10 мин, 20, 40... до 6 ч (`REDELIVERY_BASE_DELAY_MS`, `redeliveryDelayMs`), максимум 6 попыток, потом E. Шлёт только файлы без отметки, подпись полная (с «Дальше в очереди»), контрольное C (если что-то ушло), голос F (если после этого круга всё у монтажёра). Если монтажёра сменили - `handOverHolderToCurrentMontajer` (montajerHandover.ts:68) тоже зовёт `dispatchToEditor`: новый монтажёр получает полный набор A/C/F.
Тесты: video-handoff-redelivery.test.ts, montajer-queue-handover.test.ts, montajer-reassign.test.ts.

### 2.10 CRM-пуш монтажёру вместо Telegram (не Telegram, для полноты)
`dispatchToEditorAfterClaim` 1285: если у монтажёра нет Telegram - `sendPushToAgent(montajerAgentId, {title: "🔁 Ролик на перемонтаж" | "🎬 Новый ролик на монтаж", body: "Объект №{N} — заберите через CRM", url: "/properties/{id}"})` и запись в журнал `{headText}\n\nне отправлено: нет Telegram`. Тесты: card-open-by-uuid.test.ts (по заголовкам); прямого теста на этот push не нашёл.

## 3. Тексты, которые файл собирает, а отправляет бот (telegram/montajerBot.ts, не этот файл)
- `montajerCardText(shortId)` (393): `{facts}\n\n{state}`; state: `Сейчас в работе у вас.` / `Стоит в очереди {k}-м, ролик ещё не отправлен.`[` Очередь на паузе — придёт, когда её возобновят.] / `Ролик уже принят, объект на монтаже.` / `Монтаж этого объекта снят руководством — ролик от вас сейчас не ждут.` / `Объект на монтаже, но вам через бот не передавался.` / `Статус объекта: {status}.`; не найден: `Объект №{N} не найден. Проверьте номер — он есть в шапке каждого сообщения с роликом.`
- `queueStatusForMontajer()` (929): `Сейчас монтаж ничего не ждёт.` / `В работе у вас: объект №{N} (отправлен {h} ч назад). Дальше в очереди: {n} {ролик...}. [Очередь на паузе — новые объекты пока не придут. Причина: ...]` + `\nОчередь: 1) №12, 2) №15 (отложен) ... и ещё K.` (до 10).
Эти ответы реактивные (на слово/кнопку монтажёра), копируются ли наблюдателям, решает бот (по докстрингу sendToMontajer: `copy:false` для ответов на команды меню). Тесты: video-handoff.test.ts, video-handoff-queue-order.test.ts, telegram-agent-link.test.ts, montajer-bot.test.ts.

## 4. Журнал (не сообщения, но «что ушло» пишется всегда)
`recordMontajerMessage` (362): MontajerMessage с kind HANDOFF/REMAKE/CANCELLED/PROPERTY_DELETED (из videoHandoff.ts); RECEIPT, QUEUE_CONTROL, FACTS_CHANGED пишут montajerQueueControl.ts / videoHandoffRedelivery.ts / propertyEditNotify.ts / бот. Журнал круга файлов: `{headText}\n\nФайлов: {M}\n{k}. {filename} — {МБ} МБ — ✓ файлом|✓ ссылкой|✓ уже был у монтажёра|✗ не дошёл`, при прерывании `отправка прервана: {сменили монтажёра|файл чужого объекта|монтажёр отложил объект|объект сняли}`. Монтажёру это в Telegram не уходит.

## 5. Выключатели по сообщениям (сводка)

| Выключатель | Что гасит |
|---|---|
| Settings.videoHandoffEnabled (умолч. false) | постановку в очередь и сторож (A, C, F, E); НЕ гасит прямые вызовы `dispatchToEditor` (слово «файлы», кнопка «Прислать файлами», смена монтажёра), там проверки нет |
| Settings.videoMontajerAgentId | всё; не назначен - ничего, только logSystemError |
| Agent.isActive / telegramChatId монтажёра | все Telegram-сообщения; вместо них пуш + журнал |
| Settings.videoHandoffQueuePaused | выдачу места следующему (значит, весь набор A/C/F следующего); текст подписи/очереди меняет |
| Settings.montajerQueueControlEnabled (умолч. true) | только кнопки под C |
| Agent.montageCopiesTelegram | только копии наблюдателям |
| CRM_NARRATION_EXECUTION_MODE (`mediaExecutionMode("NARRATION")` != LIVE), Property.narrationOff, mixByCrm | голос F, строки про озвучку в A и C |
| (нет) | D, E, B, «Дальше в очереди», «⚠ Без звука», «Агент:» - рубильников нет |

## 6. Дубли и шум (по одному событию уходит подряд)

Типичная передача объекта с M файлами и одним наблюдателем: М + 1 (C) + 1 (F: mp3, иногда +1 текст озвучки) = M+2..M+3 сообщения монтажёру, и ЕЩЁ столько же наблюдателю (копии).

1. **Факты карточки повторяются в КАЖДОМ файле** (7 строк x M) и сверху у файла 1 (решение 19.09.2026 «против перепутанных описаний»). При 15 файлах это 15 одинаковых блоков.
2. **Номер объекта 2-3 раза в одной подписи**: шапка `Объект №N · файл k из M`, первая строка фактов `Объект №N`, и в перемонтаже `🔁 ПЕРЕМОНТАЖ, объект №N`; плюс в имени файла.
3. **«Без звука» дважды в подписи файла 1**: `⚠ БЕЗ ЗВУКА` в шапке (из describeRawVideo) и отдельный блок `⚠ Без звука: имена — ...` в конце headText.
4. **Озвучка трижды**: строка в подписи файла 1 (2.6) -> «Озвучка — следующим сообщением» внутри C -> сам mp3 с подписью «Озвучка к ролику...» (и текстом озвучки внутри либо отдельным сообщением).
5. **C дублирует то, что и так видно**: «Отправлено N из N файлов» после N сообщений с «файл k из N» (введено ради №119, когда ушло 16, а видно было 1; но при полной доставке это шум; при неполной полезно).
6. **«Дальше в очереди: n роликов»** стоит в подписи файла 1 каждой выдачи; тот же факт монтажёр видит по кнопке «🗂 Очередь». 
7. **Снятие -> следующий объект**: D («Объект №N ... доделывать не нужно») и тут же весь набор A/C/F следующего объекта; плюс пуш модераторам с тем же текстом.
8. **Копия наблюдателю = полный дубль** всех A, C, E, D, F (в 2.1-2.8): каждый наблюдатель получает всю переписку, включая тяжёлые файлы (по file_id быстро).
9. **Повтор набора**: слово «файлы» / кнопка «Прислать файлами» (resend="all") шлёт ВСЕ файлы заново и снова C и F? F повторно не уйдёт (отметки версии), A и C уйдут; сторож досылает недошедшее с подписью, как в первый раз.
10. **Файл с тем же именем исходника в E** (`IMG_...`), тогда как A везде переименован в номер: единственное место, где монтажёр видит старое имя.
11. **Нет фильтра «не слать, если ничего нового»** на уровне C: если один и тот же круг частично дослан, C уйдёт снова с «дошло k из M», затем сторож снова.

## 7. Что НЕ из этого файла, но идёт монтажёру в связке (чтобы не потерять при упрощении)
- Квитанция «Ролик принят» и ответы на приём (kind RECEIPT) - telegram/montajerBot.ts / finishReceivingVideo (в videoHandoff.ts в 2178-2430 Telegram-сообщений монтажёру НЕ шлёт, проверено grep по sendMessage/sendToMontajer/sendMessageWithButtons: только 846, 1363, 3951, плюс deliverSourceVideos).
- Ответы на кнопки очереди и «Уже сделан / Не нужен» - lib/montajerQueueControl.ts + montajerBot.ts (QUEUE_CONTROL_OFF_TEXT: `Управление очередью из бота выключено руководителем. Порядок очереди меняет руководитель в CRM.`).
- Тревоги про зависшую очередь идут руководству (videoHandoffStaleAlarm.ts), а не монтажёру.
- Сообщения про изменение карточки (FACTS_CHANGED, propertyEditNotify.ts) - отдельный источник.
- Результат публикации (`notifyVideoHandoffPublishResult`, 3629) и «пост для поделиться» - только CRM-пуши ответственному и модераторам и агенту, монтажёру НЕ уходят.

## 8. Тесты: быстрая карта «сообщение -> файл теста»
- A (подпись, имя, порядок, копии): video-handoff.test.ts, montajer-delivery.test.ts, montage-copies.test.ts, montage-copy-door.test.ts, montajer-file-number.test.ts, audit2-e-dispatch-claim.test.ts, montajer-telegram-429.test.ts, montajer-inactive-no-send.test.ts.
- A remake: video-remake.test.ts, montajer-queue-controls.test.ts, narration-own-music.test.ts.
- B (тяжёлый): прямого нет.
- C (контрольное + кнопки): montajer-delivery.test.ts, montage-copies.test.ts, montajer-queue-controls.test.ts, narration-follows-video.test.ts.
- D (снятие): video-handoff.test.ts, montage-copies.test.ts, video-handoff-never-silent.test.ts, montajer-queue-controls.test.ts.
- E (ссылка): video-handoff-redelivery.test.ts, video-handoff.test.ts.
- F (голос): narration-*.test.ts (список в 2.5).
- Сторож: video-handoff-redelivery.test.ts, video-handoff-stale-alarm.test.ts.
- Рубильники: montajer-queue-controls.test.ts (montajerQueueControlEnabled), montage-copies.test.ts (montageCopiesTelegram), video-handoff-hold.test.ts (пауза/отложить).
- Не покрыты текстом: B, «⚠ Без звука», `cardFactsDiff`, пуш «Новый ролик на монтаж» (только косвенно).
Все выводы про тесты получены grep по `apps/api/tests`, сами тесты не запускались.
