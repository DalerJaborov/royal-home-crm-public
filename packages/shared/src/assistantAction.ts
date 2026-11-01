import { z } from "zod";

/**
 * ДЕЙСТВИЕ ИИ-ПОМОЩНИКА — ОДИН ДОГОВОР СЕРВЕРА И ПАНЕЛИ (П4а, 01.11.2026).
 *
 * Сервер (`apps/api/src/lib/assistantActions.ts`, брокер подтверждений) отдаёт
 * этот вид в SSE-событии `confirm` и в ответах маршрутов
 * `POST /ai/assistant/actions/:id/confirm|cancel|undo`; панель на сайте
 * (`components/assistant/ConfirmCard.tsx`) только рисует его. Описание лежит
 * здесь, чтобы поле нельзя было переименовать на одной стороне (правило «одно
 * правило — одно место», CLAUDE.md). Замысел — docs/design/
 * internal-assistant-architecture-2026-10-31.md, §2.3.
 */

/** Совпадает с enum AssistantActionStatus в schema.prisma (сервер сверяет типом в toView). */
export const ASSISTANT_ACTION_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "EXECUTED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "UNDONE",
] as const;
export type AssistantActionStatus = (typeof ASSISTANT_ACTION_STATUSES)[number];

/**
 * Превью «было → станет». Ключи `was`/`becomes` — машинные имена полей
 * (`price`, `agent`…), подпись к ним выбирает интерфейс. Значения — данные из
 * базы: интерфейс показывает их ТЕКСТОМ, никогда не как разметку.
 */
export const assistantActionPreviewSchema = z.object({
  title: z.string().min(1).max(200),
  was: z.record(z.string(), z.unknown()),
  becomes: z.record(z.string(), z.unknown()),
  /** Последствия одной строкой: «уйдёт на сайт, монтажёр получит задание». */
  risk: z.string().max(500).optional(),
  irreversible: z.boolean().optional(),
});
export type AssistantActionPreview = z.infer<typeof assistantActionPreviewSchema>;

export interface AssistantActionView {
  id: string;
  tool: string;
  status: AssistantActionStatus;
  preview: AssistantActionPreview;
  expiresAt: string;
  executedAt: string | null;
  undoneAt: string | null;
  /** До какого момента доступен откат; null — откатить нельзя. */
  undoUntil: string | null;
  result: unknown;
}

/**
 * SSE-событие `confirm`. Уровень C — действие PENDING, ждёт «Подтвердить»;
 * уровень B — уже EXECUTED, панель сразу показывает «Сделано · Отменить».
 */
export type AssistantConfirmEvent = AssistantActionView;

/** Ответ маршрутов confirm/cancel/undo при успехе. */
export interface AssistantActionOutcome {
  action: AssistantActionView;
  /** true — повтор уже выполненного перехода, ничего нового не произошло. */
  replay: boolean;
}

/**
 * Тело ошибки тех же маршрутов: `{error, code, ...extra}`. При 409 STALE в
 * `action` может прийти СВЕЖЕЕ действие с новым превью (или null, если собрать
 * его не вышло); при 409 IN_PROGRESS/NOT_PENDING — текущее состояние действия.
 */
export interface AssistantActionErrorBody {
  error: string;
  code?: string;
  stale?: boolean;
  action?: AssistantActionView | null;
}
