import { z } from "zod";

/**
 * ВОЗВРАТ РОЛИКА МОНТАЖЁРУ НА ПЕРЕДЕЛКУ (20.09.2026, решение владельца: «чтобы
 * просто так не ходил, а причину чтобы я указал, зачем, чтобы он тоже прочитал»).
 *
 * Единственный источник правды для причин возврата — коды и человеческие
 * названия здесь, а не в api или web по отдельности (правило репозитория «не
 * дублировать типы между apps»). Контракт: POST /api/v1/properties/:id/send-
 * back-to-montajer, см. apps/api/src/routes/properties/videos.ts и
 * apps/api/src/lib/publishedVideoFix.ts::sendBackToMontajer.
 */
export const VIDEO_REMAKE_REASONS = [
  "WRONG_CAPTION",
  "NO_MUSIC",
  "WRONG_OBJECT",
  "POOR_EDIT",
  "CARD_DATA_CHANGED",
  "OTHER",
] as const;
export type VideoRemakeReason = (typeof VIDEO_REMAKE_REASONS)[number];

/** Человеческие названия — ровно эти тексты уходят и в Telegram монтажёру
 *  (lib/videoHandoff.ts), и в хронику объекта, и в UI. Меняются в одном месте. */
export const VIDEO_REMAKE_REASON_LABELS: Record<VideoRemakeReason, string> = {
  WRONG_CAPTION: "Надпись на видео неверная",
  NO_MUSIC: "Нет музыки или не тот звук",
  WRONG_OBJECT: "На видео не тот объект",
  POOR_EDIT: "Плохой монтаж: склейки, дрожь, обрывы",
  CARD_DATA_CHANGED: "Данные карточки изменились, нужен новый текст",
  OTHER: "Другое",
};

/**
 * CARD_DATA_CHANGED — это НАША правка карточки, а не брак монтажёра. Он
 * переснимает не потому, что ошибся, а потому что данные объекта поменялись
 * ПОСЛЕ того, как он уже всё сделал правильно. Используется, чтобы не
 * засчитывать этот заход в статистику брака монтажёра (Property.videoRemakeCount
 * растёт всегда — это просто «сколько раз объект уходил на монтаж», а отдельно
 * считать вину монтажёра нужно этим списком-исключением).
 */
export const VIDEO_REMAKE_REASONS_NOT_EDITOR_FAULT: readonly VideoRemakeReason[] = ["CARD_DATA_CHANGED"];

export function isVideoRemakeEditorFault(reason: VideoRemakeReason): boolean {
  return !VIDEO_REMAKE_REASONS_NOT_EDITOR_FAULT.includes(reason);
}

/** Причины, где комментарий обязателен — без него монтажёр и руководитель
 *  не поймут, что именно неверно (WRONG_CAPTION) или что вообще случилось (OTHER). */
export const VIDEO_REMAKE_REASONS_REQUIRING_COMMENT: readonly VideoRemakeReason[] = ["OTHER", "WRONG_CAPTION"];

export const sendBackToMontajerSchema = z
  .object({
    reason: z.enum(VIDEO_REMAKE_REASONS),
    comment: z.string().trim().min(1, "Комментарий не может быть пустым").max(2000).optional(),
    /**
     * Замена исходника (22.09.2026): id PropertyVideo, уже ПОЛНОСТЬЮ загруженных
     * через upload-sessions этого объекта. Все остальные исходники объекта сервер
     * удаляет в той же транзакции, что ставит объект на перемонтаж. Нет поля —
     * исходники остаются как были.
     */
    replaceVideoIds: z.array(z.string().min(1).max(64)).min(1).max(30).optional(),
    /**
     * Снять старый ролик из соцсетей ПЕРЕД постановкой в очередь монтажёру
     * (24.09.2026, п.4 задания). По умолчанию false — поведение не меняется.
     * Право на true — то же, что у кнопки «Убрать из соцсетей»
     * (routes/properties/videos.ts::requireMarketingRole), проверяется на
     * роуте, не здесь.
     */
    removeFromSocial: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (VIDEO_REMAKE_REASONS_REQUIRING_COMMENT.includes(data.reason) && !data.comment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comment"],
        message: `Для причины «${VIDEO_REMAKE_REASON_LABELS[data.reason]}» нужен комментарий.`,
      });
    }
  });

/**
 * Тело POST .../videos/upload-sessions/:id/complete (22.09.2026, решение
 * владельца). MONTAJER_SOURCE — новый исходник из окна «Вернуть монтажёру»:
 * такая загрузка НЕ возвращает объект на проверку (обычная загрузка агентом —
 * возвращает, как и раньше). Пустое тело — обычная загрузка.
 */
export const completeVideoSessionSchema = z
  .object({ purpose: z.enum(["MONTAJER_SOURCE"]).optional() })
  .optional();

export type SendBackToMontajerInput = z.infer<typeof sendBackToMontajerSchema>;

/**
 * «УДАЛЕНО В ПРИЛОЖЕНИИ» (24.09.2026). Instagram (без ключа удаления) и TikTok не
 * дают снять вышедший ролик программой, и канал оставался в publishedChannels
 * навсегда — новый ролик туда уже не уходил: публикация пропускает каналы, где
 * старый стоит. Человек удаляет пост в приложении и говорит об этом кнопкой.
 */
export const MANUAL_REMOVAL_CHANNELS = ["INSTAGRAM", "TIKTOK"] as const;
export const markRemovedByHandSchema = z.object({ channel: z.enum(MANUAL_REMOVAL_CHANNELS) });
export type MarkRemovedByHandInput = z.infer<typeof markRemovedByHandSchema>;
