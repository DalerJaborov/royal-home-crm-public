import { pluralizeRu } from "@royal-home/shared";
import { ApiError } from "../../lib/apiError";

/**
 * Ответ сервера «в черновике уже есть ваши файлы — заменить?» (решение
 * владельца 02.10.2026, глубокая проверка D14): POST
 * /properties/drafts/from-client/:id отвечает 409 с этим кодом и ничего не
 * трогает, пока агент не ответит (routes/properties/drafts.ts).
 */
const CONFLICT_CODE = "DRAFT_MEDIA_REPLACE_CONFIRM";

/** Сколько файлов агента лежит в черновике — или null, если ошибка другая. */
export function draftMediaConflict(err: unknown): { photoCount: number; videoCount: number } | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const data = err.data as { code?: unknown; draftPhotoCount?: unknown; draftVideoCount?: unknown } | null;
  if (!data || data.code !== CONFLICT_CODE) return null;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return { photoCount: count(data.draftPhotoCount), videoCount: count(data.draftVideoCount) };
}

/** «Заменить 3 загруженных фото на фото из переписки?» — с видео, если они есть. */
export function draftMediaConflictTitle(photoCount: number, videoCount: number): string {
  const parts: string[] = [];
  if (photoCount > 0) parts.push(`${photoCount} ${pluralizeRu(photoCount, ["загруженное фото", "загруженных фото", "загруженных фото"])}`);
  if (videoCount > 0) parts.push(`${videoCount} ${pluralizeRu(videoCount, ["видео", "видео", "видео"])}`);
  const what = parts.length > 0 ? parts.join(" и ") : "загруженные файлы";
  return `Заменить ${what} на фото из переписки?`;
}
