/**
 * КНОПКИ УПРАВЛЕНИЯ ОЧЕРЕДЬЮ В БОТЕ МОНТАЖЁРА — ОДНО МЕСТО (19.11.2026).
 *
 * Строки callback_data собираются только здесь и разбираются только в
 * telegram/montajerBot.ts::parseMontajerCallback: подпись под файлами
 * (lib/videoHandoff.ts), «🗂 Очередь» (lib/montajerViews.ts) и ответы на нажатия
 * (lib/montajerQueueControl.ts) не держат своих копий формата. Без импортов —
 * чтобы его могли брать все три файла без кругового импорта.
 *
 * Номер в кнопке — shortId объекта (как у остальных `mj:*`): кнопка под старым
 * сообщением называет объект, а не «текущий», и сервер сверяет его с тем, что
 * сейчас в очереди.
 */
import type { TelegramInlineButton } from "../telegram/api.js";

export type MontajerQueueMove = "up" | "down" | "front";

export const montajerQueueCallback = {
  /** «⏭ Пропустить» держателя — меню из двух вариантов и «Отмена». */
  skip: (shortId: number) => `mj:sk:${shortId}`,
  /** «Сделаю позже» — держатель в конец очереди. */
  skipLater: (shortId: number) => `mj:skl:${shortId}`,
  /** «✅ Уже сделан, ролик пришлю» — держатель снимается, бот ждёт его ролик. */
  skipDone: (shortId: number) => `mj:skd:${shortId}`,
  /** «🚫 Не нужен» — держатель снимается, ролика не ждём. */
  skipNotNeeded: (shortId: number) => `mj:skn:${shortId}`,
  /** Ждущий объект — подменю действий. */
  item: (shortId: number) => `mj:qi:${shortId}`,
  /** «Взять сейчас»; второй номер — кто держал место, когда кнопку рисовали (0 — никто). */
  take: (shortId: number, holderShortId: number | null) => `mj:tk:${shortId}:${holderShortId ?? 0}`,
  move: (shortId: number, to: MontajerQueueMove) => `mj:mv:${shortId}:${to === "up" ? "u" : to === "down" ? "d" : "f"}`,
  /** Ждущий «✅ Уже сделан, ролик пришлю». */
  queuedDone: (shortId: number) => `mj:qd:${shortId}`,
  /** Ждущий «🚫 Не нужен». */
  queuedNotNeeded: (shortId: number) => `mj:qn:${shortId}`,
  cancel: () => "mj:x",
} as const;

/** «🗂 Очередь» и «⏭ Пропустить №N» — под каждым заданием с исходниками. */
export function holderTaskButtons(shortId: number): TelegramInlineButton[][] {
  return [
    [
      { text: "🗂 Очередь", callback_data: "mj:queue" },
      { text: `⏭ Пропустить №${shortId}`, callback_data: montajerQueueCallback.skip(shortId) },
    ],
  ];
}
