/**
 * ПАЧКИ РОЛИКОВ В ШАБНАМ (26.11.2026, волна D загрузки). Состояние в памяти процесса:
 * альбом приходит за секунды, после перезапуска худшее — лишний вопрос или карточка.
 *
 *  - Пачка роликов в один черновик (альбом или несколько подряд): карточка одна, когда
 *    сохранится последний ролик пачки, с итогом «Видео добавлено: N». Раньше пять роликов
 *    давали пять одинаковых карточек.
 *  - Подпись альбома: Telegram кладёт её только к первому ролику, и остальные спрашивали
 *    «к какому объекту» заново. Подпись помним по media_group_id 10 минут.
 */
const videoBatches = new Map<string, { pending: number; added: number }>();

export function openVideoBatch(key: string): void {
  const batch = videoBatches.get(key) ?? { pending: 0, added: 0 };
  batch.pending += 1;
  videoBatches.set(key, batch);
}

/** Ролик пачки закончен. null — в пачке ещё есть ролики; число — сколько добавлено за всю пачку. */
export function settleVideoBatch(key: string, added: boolean): number | null {
  const batch = videoBatches.get(key) ?? { pending: 1, added: 0 };
  batch.pending -= 1;
  if (added) batch.added += 1;
  if (batch.pending > 0) { videoBatches.set(key, batch); return null; }
  videoBatches.delete(key);
  return batch.added;
}

const albumCaptions = new Map<string, { caption: string; at: number }>();
const ALBUM_CAPTION_TTL_MS = 10 * 60_000;

/** Подпись ролика с учётом альбома: своя, а если её нет — подпись первого ролика того же альбома. */
export function albumCaption(chatId: string, groupId: string | undefined, caption: string | undefined): string | null {
  const own = caption?.trim() ? caption : null;
  if (!groupId) return own;
  const now = Date.now();
  for (const [key, value] of albumCaptions) if (now - value.at > ALBUM_CAPTION_TTL_MS) albumCaptions.delete(key);
  const key = `${chatId}:${groupId}`;
  if (own) { albumCaptions.set(key, { caption: own, at: now }); return own; }
  return albumCaptions.get(key)?.caption ?? null;
}
