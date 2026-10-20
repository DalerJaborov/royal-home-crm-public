/**
 * ЕДИНЫЙ ПРЕДЕЛ ВИДЕО ПРИ ЗАГРУЗКЕ (решение владельца 07.10.2026: «лимит на
 * загрузку видео увеличить до максимума, чтобы таких проблем не было»).
 *
 * Живой случай: агент выбрал IMG_9854.MOV (746,6 МБ), подсказка мастера обещала
 * «сжатие принимает до 300 МБ», а сервер отказал «больше лимита 700 МБ» ещё до
 * первого байта — число было набрано руками в пяти местах и в каждом своё.
 * Теперь число одно, и его читают обе стороны: сервер (мастер и карточка
 * объекта) и экраны выбора файла, которые проверяют размер ДО постановки в
 * очередь.
 *
 * 2 ГБ — «максимум» = прежний потолок сессий загрузки по частям
 * (routes/properties/videos.ts) и одиночного приёма готового ролика
 * (upload.ts::videoHandoffUpload). Видео едет частями по 8 МБ на диск, а не
 * целиком в память, поэтому выше этого предела упирается уже не в код, а в
 * ёмкость диска и терпение мобильного интернета.
 *
 * РОВНО 2 ГиБ − 1 БАЙТ, а не 2 ГиБ: `sizeBytes` у VideoUploadSession,
 * PropertyDraftMedia и PropertyVideo — колонки `Int` (int32, максимум
 * 2 147 483 647). Файл ровно в 2 ГиБ проходил проверку предела и падал 500-й
 * на записи сессии (поймано тестом «ровно предел проходит», 07.10.2026). Для
 * человека это всё те же «2 ГБ» (formatUploadLimit).
 */
export const UPLOAD_VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1;

/** Машинный код отказа «ролик больше предела» в теле ответа 400. */
export const VIDEO_TOO_LARGE_CODE = "VIDEO_TOO_LARGE";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Человеческая подпись предела: «2 ГБ», «700 МБ». Дробь только если она есть («1,5 ГБ»). */
export function formatUploadLimit(bytes: number = UPLOAD_VIDEO_MAX_BYTES): string {
  const trim = (n: number) => String(Math.round(n * 10) / 10).replace(".", ",");
  if (bytes >= GB) return `${trim(bytes / GB)} ГБ`;
  return `${trim(bytes / MB)} МБ`;
}

/**
 * Текст отказа для ролика больше предела — один на сервер и клиент. `sizeLabel`
 * (уже отформатированный вес, «746,6 МБ») необязателен: клиент его знает и
 * называет, серверу достаточно предела.
 */
export function videoTooLargeMessage(filename: string, sizeLabel?: string): string {
  const weight = sizeLabel ? `весит ${sizeLabel} — больше` : "больше";
  return `Ролик «${filename}» ${weight} предела ${formatUploadLimit()}. Снимите короче или в меньшем разрешении (на iPhone: Настройки → Камера → Форматы → «Эффективный») и добавьте снова.`;
}

/**
 * Делит выбранные файлы на годные и слишком тяжёлые — ПО ВСЕМ, а не по первому.
 * Ровно предел проходит; предел + 1 байт — нет (так же сверяет сервер: `>`).
 */
export function partitionVideosByLimit<T extends { size: number }>(
  files: readonly T[],
  maxBytes: number = UPLOAD_VIDEO_MAX_BYTES
): { accepted: T[]; rejected: T[] } {
  const accepted: T[] = [];
  const rejected: T[] = [];
  for (const file of files) (file.size > maxBytes ? rejected : accepted).push(file);
  return { accepted, rejected };
}
