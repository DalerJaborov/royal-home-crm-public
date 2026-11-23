/**
 * Тип записи диктовки из браузера (POST /transcribe) → тип, который понимает расшифровка.
 *
 * Браузеры называют одну и ту же запись по-разному: `audio/webm;codecs=opus` (Chrome,
 * Firefox), `audio/mp4` (Safari и все браузеры iPhone), `audio/ogg;codecs=opus`
 * (Firefox), а чисто звуковой файл иногда приходит с типом видеоконтейнера
 * (`video/webm`, `video/mp4`). Прежний фильтр пропускал только `audio/*` и отдавал
 * поставщику строку вместе с параметрами кодека.
 *
 * null — это не звук (например, картинка): запрос отклоняется.
 */
export function normalizeDictationMime(raw: string | undefined | null): string | null {
  const base = (raw ?? "").split(";")[0].trim().toLowerCase();
  if (base.startsWith("audio/")) return base === "audio/x-m4a" ? "audio/mp4" : base;
  // Контейнер видео, в котором на деле только звук (запись микрофона): тот же контейнер, тип звука.
  if (base === "video/webm") return "audio/webm";
  if (base === "video/mp4") return "audio/mp4";
  return null;
}
