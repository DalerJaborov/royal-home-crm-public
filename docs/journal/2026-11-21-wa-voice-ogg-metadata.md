# 21.11.2026 — голосовое агента в WhatsApp: «application/octet-stream»

ErrorLog 21.11 08:06 UTC (только чтение прода): «WhatsApp не доставил наш ответ на 9929888••717: Media upload
error — Audio file uploaded with mimetype as audio/ogg; codecs=opus, however on processing it is of type
application/octet-stream». То же в 08:09.

## Что это было (ФАКТ, прод только чтением)

- Путь: голосовое АГЕНТА из переписки CRM (агент «Умед») → `lib/conversationDelivery.ts`
  (`transcodeToOggOpus` → `saveOutgoingVoice` → `messengers/meta.ts::buildAudioRequest`, `audio.link`).
  Не озвучка объекта: `normalizeNarrationVoice` (#348) в этом пути не участвует, расширение и тип он не меняет.
- Файлы на сервере — настоящий Ogg/Opus, моно, 48 кГц; ссылка отдаёт `content-type: audio/ogg` (проверено curl).
- Отличие от удачных голосовых (октябрь, Chrome/webm): запись с iPhone (Safari пишет mp4), и ffmpeg переносил
  в ogg теги контейнера MP4: `major_brand=iso5`, `handler_name=Core Media Audio`, `vendor_id` из нулевых байтов.
  ОЦЕНКА: на этих тегах распознаватель WhatsApp и сдаётся (воспроизведено локально: теги переносятся).
- Голосовое 19.11 (Chrome) упало с другой причиной («mediaEngineStatus: 0») — НЕТ ДАННЫХ, тот ли это механизм;
  17.11 — закрытое окно 24 часа, не формат.

## Что сделано

- `lib/audioTranscode.ts`: `-map_metadata -1` (без тегов контейнера) и `-ar 48000` для ogg/opus; без тегов и m4a.
- Готовый файл проверяется по содержимому (`sniffAudioMime`): для WhatsApp — только моно Ogg с OpusHead
  (документация Meta: audio/ogg — только opus, только моно). Не то — не отправляем, запись в журнал.
- Тест `tests/audio-transcode-whatsapp.test.ts` на настоящем ffmpeg (проверен поломкой).

## Что осталось

- Если ошибка повторится на файле без тегов — следующий шаг: загружать голосовое в WhatsApp через
  `POST /{phone-number-id}/media` с явным типом и слать по `audio.id`, а не по ссылке.
