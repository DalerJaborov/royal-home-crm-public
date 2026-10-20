/**
 * КОГДА МОНТАЖЁР МОЖЕТ ЗАГРУЗИТЬ ГОТОВЫЙ РОЛИК САМ (25.09.2026, В1 спецификации
 * docs/handoff-2026-09-25-montage-control-spec.md). Одно правило на сервер
 * (apps/api/src/routes/properties/videos.ts) и клиент (PropertyVideoFixCard.tsx
 * в режиме монтажёра) — раньше решение «объект ждёт файл прямо сейчас» жило
 * только в проверке `videoHandoffStatus !== "SENT_TO_EDITOR"` на сервере,
 * карточка монтажёра эту логику вообще не видела (панели не было).
 *
 * Окно, в которое монтажёр сам может заменить уже принятый ролик — ровно
 * RESEND_WINDOW_MS бота (apps/api/src/lib/videoHandoff.ts, 3 ч); равенство
 * держит тест API (video-handoff-montajer-panel.test.ts).
 */
export const MONTAJER_FINAL_REPLACE_WINDOW_MS = 3 * 60 * 60 * 1000;

export const MONTAJER_FINAL_UPLOAD_CLOSED_MESSAGE =
  "Объект сейчас не ждёт готовый ролик от монтажёра. Заменить свой ролик можно в течение 3 часов после приёма, пока он не вышел в сети — дальше через маркетинг.";

/**
 * true — монтажёр может прямо сейчас прислать готовый ролик по этому объекту.
 * `SENT_TO_EDITOR` — объект и так ждёт файл (настоящая передача очередью или
 * ручное ожидание, открытое кем-то из ведущих объект). `RECEIVED` — окно
 * замены: файл уже принят, но не вышел ни в одной сети и не прошло 3 часа с
 * приёма. Во всех остальных случаях (`QUEUED`, `NONE`, `RECEIVED` за окном или
 * с уже опубликованными каналами) — false.
 */
export function montajerMayUploadFinal(
  p: {
    videoHandoffStatus: string | null | undefined;
    receivedAt: string | Date | null | undefined;
    publishedChannels: readonly string[] | null | undefined;
  },
  nowMs: number
): boolean {
  if (p.videoHandoffStatus === "SENT_TO_EDITOR") return true;
  if (p.videoHandoffStatus === "RECEIVED") {
    if (!p.receivedAt) return false;
    if ((p.publishedChannels?.length ?? 0) > 0) return false;
    const receivedMs = p.receivedAt instanceof Date ? p.receivedAt.getTime() : new Date(p.receivedAt).getTime();
    if (!Number.isFinite(receivedMs)) return false;
    return nowMs - receivedMs < MONTAJER_FINAL_REPLACE_WINDOW_MS;
  }
  return false;
}
