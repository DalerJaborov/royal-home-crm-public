/**
 * БЛОК «МОНТАЖ» В КАРТОЧКЕ ОБЪЕКТА (25.09.2026, владелец: «чтобы в карточке
 * объекта всё было»). Раньше карточка отдавала обрывки передачи монтажёру
 * отдельными плоскими полями Property (videoHandoffStatus, videoHandoffFinalPath
 * и т.п. — см. Property в apps/web/src/types.ts), а место в очереди, попытки
 * отправки и то, что реально дошло по каждому ролику, было видно только на
 * экране «Подготовка объектов» (/pipeline). Этот объект собирает всё в одном месте специально для
 * карточки одного объекта — GET /api/v1/properties/:id.
 *
 * Контракт: apps/api/src/lib/videoHandoff.ts::videoHandoffCardForProperty,
 * apps/api/src/routes/properties/list.ts (GET /:id).
 */
export interface PropertyVideoHandoffCardVideo {
  id: string;
  /** Имя файла, как его загрузил агент. */
  name: string;
  sizeBytes: number;
  /** null — ffprobe ещё не разобрал файл или недоступен. */
  durationSec: number | null;
  /** null — то же самое, что у durationSec. false — реально без звука. */
  hasAudio: boolean | null;
  /** Ушёл ли этот КОНКРЕТНЫЙ ролик монтажёру хотя бы раз (PropertyVideo.telegramFileId). */
  delivered: boolean;
}

export interface PropertyVideoHandoffCard {
  status: "QUEUED" | "SENT_TO_EDITOR" | "RECEIVED";
  /** 1 — держатель места монтажёра, 2+ — ждёт своей очереди, null — вне очереди
   *  (RECEIVED). См. lib/videoHandoff.ts::videoHandoffQueuePositions. */
  queuePosition: number | null;
  /** Отложен ли объект в очереди (25.09.2026, «Отложить») — null, если не отложен. */
  heldAt: string | null;
  holdReason: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  dispatchAttempts: number;
  /** Идёт ли живая отправка прямо сейчас — null, если нет. */
  dispatchStartedAt: string | null;
  receivedAt: string | null;
  scheduledPublishAt: string | null;
  scheduledPublishReason: string | null;
  montajer: { id: string; fullName: string } | null;
  /** Готовый ролик (публичный /uploads/handoff/…, подписанный ответом API) —
   *  плеер в блоке проверки ролика. null, пока ролик не принят. */
  finalVideoUrl: string | null;
  /** Проверка готового ролика модератором (25.09.2026, lib/clipReview.ts). */
  clipReview: PropertyClipReview;
  /**
   * ХОД ПУБЛИКАЦИИ В СЕТИ (05.10.2026, владелец: «не видно, куда добавляется прямо
   * сейчас, просто по очереди горят соцсети»). Состояние задания публикации ролика:
   * `waiting` — стоит в расписании и выйдет в `runAt`; `running` — идёт прямо сейчас
   * (каналы появляются в publishedChannels по одному, по мере выхода); `retrying` —
   * прошлая попытка не удалась, задание перезапустится в `runAt`. Нет задания — `idle`.
   */
  publish?: { state: "idle" | "waiting" | "running" | "retrying"; runAt: string | null; startedAt: string | null; attempt: number };
  videos: PropertyVideoHandoffCardVideo[];
}

export const CLIP_REVIEW_STATUSES = ["NONE", "PENDING", "APPROVED", "REJECTED"] as const;
export type ClipReviewStatus = (typeof CLIP_REVIEW_STATUSES)[number];

export interface PropertyClipReview {
  status: ClipReviewStatus;
  /** Когда ролик встал на проверку (приём от монтажёра). */
  requestedAt: string | null;
  decidedAt: string | null;
  /** Имя решившего модератора. */
  decidedBy: string | null;
  /** Причина возврата с комментарием — только у REJECTED. */
  comment: string | null;
}

/**
 * КОМПАКТНОЕ СОСТОЯНИЕ МОНТАЖА В СПИСКЕ ОБЪЕКТОВ (25.09.2026, владелец: «в
 * списке объектов сразу видеть, в каком состоянии»). Не то же самое, что
 * PropertyVideoHandoffCard выше — тот собирается на ОДИН объект (карточка),
 * этот — компактно на КАЖДУЮ строку списка без N+1 (lib/propertyListItem.ts).
 */
/** clip_review — ролик принят и ждёт проверки модератора (25.09.2026, lib/clipReview.ts). */
export const VIDEO_HANDOFF_BRIEF_STATES = ["queued", "held", "editing", "received", "scheduled", "clip_review", "none"] as const;
export type PropertyVideoHandoffBriefState = (typeof VIDEO_HANDOFF_BRIEF_STATES)[number];

export interface PropertyVideoHandoffBrief {
  state: PropertyVideoHandoffBriefState;
  /** Место в очереди среди ждущих (2+ в терминах videoHandoffQueuePositions,
   *  здесь считается заново от 1 — «1-й» значит «следующий получит монтажёра»). */
  position?: number;
  /** Сколько часов держатель места уже у монтажёра — только state === "editing". */
  hours?: number;
  /** [дошло, всего] сырых роликов — только state === "editing"/"queued". */
  deliveredOf?: [number, number];
  /** Слот публикации — только state === "received"/"scheduled". */
  publishAt?: string;
}
