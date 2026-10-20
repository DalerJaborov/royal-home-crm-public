import { pluralizeRu, type PropertyDraftView } from "@royal-home/shared";

/**
 * ТЕКСТ ПРЕДЛОЖЕНИЯ ЧЕРНОВИКА для первого экрана мастера (property-wizard/DraftGate.tsx).
 *
 * 21.09.2026 черновик ещё показывался баннером на списке объектов; владелец
 * уточнил: «не на главный экран, а на первый экран мастера — если черновик есть;
 * если нет, первым окном будет выбор клиента». Баннер убран, здесь остались
 * только общие формулировки и ключ кэша, который мастер сбрасывает после
 * сохранения и «Начать заново».
 */
export const PROPERTY_DRAFT_QUERY_KEY = ["property-draft"] as const;

/** Сколько фото и видео уже отдано — раздельно, а не «N файлов» (жалоба
 *  владельца: агент не понимал, ролик это или снимки). */
export function draftMediaCounts(draft: PropertyDraftView): { photos: number; videos: number } {
  let photos = 0;
  let videos = 0;
  for (const m of draft.media) {
    if (m.kind === "PHOTO") photos++;
    else videos++;
  }
  return { photos, videos };
}

/** Дата последнего автосохранения — точная, запасной вариант для
 *  formatDraftSavedRelative ниже (черновик старше недели). */
export function formatDraftUpdatedAt(draft: PropertyDraftView): string {
  const when = new Date(draft.updatedAt);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

/**
 * «Сохранён 2 часа назад» / «вчера» / «3 дня назад» — подпись под заголовком
 * DraftGate (владелец 21.09.2026, этот же экран).
 *
 * ИСКЛЮЧЕНИЕ ИЗ ПРАВИЛА «ТОЛЬКО ТОЧНОЕ ВРЕМЯ» (владелец 20.08.2026,
 * см. exactDateTime в lib/format.ts и EventFeed.tsx — «никаких „N минут назад“
 * нигде в CRM»). Там относительная подпись стоит десятками в списке (клиенты,
 * журнал звонков), и каждую надо арифметически привести к текущему часу.
 * Здесь ровно ОДНА подпись на весь экран, и вопрос у неё другой: не «когда
 * именно», а «насколько черновик свежий» — заброшен час назад или неделю
 * назад. Не нашлось готовой функции такого вида в lib/ (относительное время
 * оттуда убрано этим же правилом 20.08.2026), поэтому здесь маленькая своя, а
 * не universalная — использовать где-то ещё значило бы обходить правило
 * стороной. Черновик старше недели — обратно точная дата (formatDraftUpdatedAt),
 * чтобы не считать «12 дней назад» в уме.
 */
export function formatDraftSavedRelative(draft: PropertyDraftView): string {
  const when = new Date(draft.updatedAt);
  if (Number.isNaN(when.getTime())) return "";
  const minutes = Math.floor((Date.now() - when.getTime()) / 60_000);
  if (minutes < 1) return "сохранён только что";
  if (minutes < 60) return `сохранён ${minutes} ${pluralizeRu(minutes, ["минуту", "минуты", "минут"])} назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `сохранён ${hours} ${pluralizeRu(hours, ["час", "часа", "часов"])} назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "сохранён вчера";
  if (days < 7) return `сохранён ${days} ${pluralizeRu(days, ["день", "дня", "дней"])} назад`;
  return `Сохранён ${formatDraftUpdatedAt(draft)}`;
}

/** Сколько дней осталось до удаления черновика (PROPERTY_DRAFT_TTL_DAYS) —
 *  чип «Удалится через N дней» на DraftGate. Только у серверного черновика:
 *  запасная копия в localStorage своего срока не хранит. */
export function draftDaysLeft(draft: PropertyDraftView): number {
  const ms = new Date(draft.expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}
