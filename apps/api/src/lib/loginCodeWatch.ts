/**
 * СТОРОЖ ОТКАЗОВ ВЫДАЧИ КОДА ВХОДА (25.11.2026).
 *
 * Случай: сотрудница жала «ещё раз», упёрлась в 5 кодов за час и не могла войти,
 * а директор узнал об этом только от неё. Теперь 3 и больше отказа у одного
 * сотрудника за 15 минут — лимит часа, «Не удалось отправить код», неверный код —
 * одной записью в журнал ошибок. Первая запись за сутки по сотруднику уходит
 * директору пушем «Новая проблема» штатным путём logSystemError (onNewSystemError).
 *
 * Счёт в памяти процесса и не ждёт базы: вход не замедляется, а перезапуск сервера
 * лишь обнуляет окно. Запись в журнал — фоновая, её сбой вход не ломает.
 */
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";

export const LOGIN_CODE_WATCH_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_CODE_WATCH_THRESHOLD = 3;
const MAX_TRACKED_AGENTS = 2000;

export type LoginCodeRefusalKind = "hour-limit" | "send-failed" | "wrong-code";

const KIND_TEXT: Record<LoginCodeRefusalKind, string> = {
  "hour-limit": "лимит кодов за час",
  "send-failed": "код не удалось отправить",
  "wrong-code": "неверный код",
};

const refusals = new Map<string, { at: number; kind: LoginCodeRefusalKind }[]>();

/** Для тестов. */
export function resetLoginCodeWatch(): void {
  refusals.clear();
}

/** Ключ суток по Душанбе (UTC+5): новый день — новая запись и новый пуш. */
function dayKey(now: number): string {
  return new Date(now + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Запомнить отказ. Возвращается сразу; запись в журнал, если порог достигнут,
 * идёт в фоне. Возвращает true, когда порог достигнут (нужно тестам).
 */
export function noteLoginCodeRefusal(agentId: string, kind: LoginCodeRefusalKind, now = Date.now()): boolean {
  const edge = now - LOGIN_CODE_WATCH_WINDOW_MS;
  const list = (refusals.get(agentId) ?? []).filter((r) => r.at >= edge);
  list.push({ at: now, kind });
  refusals.set(agentId, list);
  if (refusals.size > MAX_TRACKED_AGENTS) {
    for (const [id, rows] of refusals) {
      if (rows.every((r) => r.at < edge)) refusals.delete(id);
    }
  }
  if (list.length < LOGIN_CODE_WATCH_THRESHOLD) return false;

  const counts = new Map<LoginCodeRefusalKind, number>();
  for (const r of list) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const detail = [...counts].map(([k, n]) => `${KIND_TEXT[k]} ×${n}`).join(", ");
  void (async () => {
    const agent = await prisma.agent
      .findUnique({ where: { id: agentId }, select: { fullName: true } })
      .catch(() => null);
    await logSystemError(
      "api",
      `Сотрудник ${agent?.fullName ?? agentId} не может получить код входа: ${list.length} отказа за 15 минут (${detail}). Откройте карточку сотрудника и, если нужно, сбросьте блок входа по коду`,
      { dedupKey: `login-code-refusals:${agentId}:${dayKey(now)}`, dedupWindowMs: 60 * 60 * 1000 }
    );
  })().catch(() => undefined);
  return true;
}
