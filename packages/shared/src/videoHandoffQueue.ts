import { z } from "zod";

/**
 * ОЧЕРЕДЬ МОНТАЖЁРА: СНЯТИЕ И ПАУЗА (24.09.2026).
 *
 * Администратор снял с монтажа №133, №134, №135 подряд — и каждое снятие молча
 * и сразу отдавало монтажёру следующий объект. Очередь «строго по одному» и
 * автоматическая выдача следующего остаются, но теперь выбор явный:
 * `holdQueue=true` освобождает место и ставит очередь на паузу, следующий не
 * уходит, пока кто-то не нажмёт «Возобновить».
 *
 * Контракт: POST /api/v1/marketing/video-handoff/:id/cancel (тело ниже),
 * GET  /api/v1/marketing/video-handoff/queue-state,
 * POST /api/v1/marketing/video-handoff/queue/pause | /queue/resume —
 * apps/api/src/routes/marketing.ts, apps/api/src/lib/videoHandoff.ts.
 */
export const cancelVideoHandoffBodySchema = z.object({
  /** true — место освобождается, но следующий в очереди НЕ выдаётся: очередь встаёт на паузу. */
  holdQueue: z.boolean().optional().default(false),
  /** Причина придержки (25.09.2026) — необязательная, идёт в тот же
   *  Settings.videoHandoffQueuePauseReason, что и у общей паузы ниже. */
  reason: z.string().trim().max(280).optional(),
});
export type CancelVideoHandoffBody = z.infer<typeof cancelVideoHandoffBodySchema>;
/** То, что шлёт клиент: holdQueue можно не указывать (значит false). */
export type CancelVideoHandoffInput = z.input<typeof cancelVideoHandoffBodySchema>;

/**
 * ТЕЛО «ПРИДЕРЖАТЬ ОЧЕРЕДЬ» (25.09.2026, А4 спецификации «полный контроль
 * монтажа») — причина необязательна, но если владелец или маркетинг её ввели,
 * баннер паузы обязан её показать, а не только факт паузы.
 */
export const pauseVideoHandoffQueueBodySchema = z.object({
  reason: z.string().trim().max(280).optional(),
});
export type PauseVideoHandoffQueueBody = z.infer<typeof pauseVideoHandoffQueueBodySchema>;

export interface VideoHandoffQueueObjectRef {
  id: string;
  shortId: number;
  /** Отложен ли объект (25.09.2026, «Отложить») — null, если не отложен.
   *  Отложенный стоит в очереди на своём месте, но `nextInQueue` его пропускает. */
  heldAt?: string | null;
  /** Причина придержки — null, если не указана или объект не отложен. */
  holdReason?: string | null;
}

/**
 * ОТЛОЖИТЬ / ВЕРНУТЬ В ОЧЕРЕДЬ ОДИН ОБЪЕКТ (25.09.2026, владелец: «чтобы была
 * возможность придерживать какой-то монтаж на паузе»). В отличие от общей
 * паузы очереди выше — точечно, один объект, остальные идут как обычно.
 *
 * Контракт: POST /api/v1/marketing/video-handoff/:id/hold (тело ниже),
 * POST /api/v1/marketing/video-handoff/:id/unhold (без тела) —
 * apps/api/src/routes/marketing.ts, apps/api/src/lib/videoHandoff.ts.
 */
export const holdVideoHandoffBodySchema = z.object({
  reason: z.string().trim().max(280).optional(),
});
export type HoldVideoHandoffBody = z.infer<typeof holdVideoHandoffBodySchema>;

/** Состояние очереди монтажёра для экрана конвейера: кто держит место, кто
 *  следующий (ему место уйдёт при снятии держателя) и стоит ли пауза. */
export interface VideoHandoffQueueState {
  paused: boolean;
  /** Когда поставили на паузу — null, если очередь не на паузе. */
  pausedAt: string | null;
  /** Кто поставил на паузу — null, если неизвестно (или очередь не на паузе). */
  pausedBy: { id: string; fullName: string } | null;
  /** Причина паузы — null, если не указана. */
  pauseReason: string | null;
  holder: VideoHandoffQueueObjectRef | null;
  next: VideoHandoffQueueObjectRef | null;
  queuedCount: number;
  /** Все ждущие в порядке выдачи места (без держателя) — тот же порядок, что у
   *  бота монтажёра и у позиций на экране (lib/videoHandoff.ts::orderedQueue). */
  queue: VideoHandoffQueueObjectRef[];
}

/**
 * ПЕРЕСТАНОВКА В ОЧЕРЕДИ МОНТАЖА (24.09.2026, владелец: «кнопку, чтобы
 * передвигать очередь — какой-то объект быстрее на монтаж»).
 *
 * Контракт: POST /api/v1/marketing/video-handoff/:id/move. Двигаются только
 * ждущие (QUEUED); держатель места — 409 `HOLDER_CANNOT_MOVE`. `position` —
 * место среди ждущих, 1 = получит монтажёра следующим; за краями очереди
 * прижимается к ним.
 */
export const VIDEO_HANDOFF_MOVE_TARGETS = ["front", "up", "down", "position"] as const;
export type VideoHandoffMoveTarget = (typeof VIDEO_HANDOFF_MOVE_TARGETS)[number];

export const videoHandoffMoveBodySchema = z
  .object({
    to: z.enum(VIDEO_HANDOFF_MOVE_TARGETS),
    position: z.number().int().min(1).max(10_000).optional(),
  })
  .refine((b) => b.to !== "position" || b.position !== undefined, {
    message: "Для to=position нужно указать position",
    path: ["position"],
  });
export type VideoHandoffMoveBody = z.infer<typeof videoHandoffMoveBodySchema>;

export interface VideoHandoffMoveResult {
  ok: true;
  shortId: number;
  /** Место среди ждущих до и после хода (1-based). */
  from: number;
  to: number;
}
