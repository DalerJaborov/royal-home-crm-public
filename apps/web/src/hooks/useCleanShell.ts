import { useAuthStore } from "../store/auth";
import { UI_SHELL_FOR_EVERYONE } from "@royal-home/shared";
import { useRoyalLookChoice } from "./royalLookChoice";

/**
 * НОВЫЙ ИНТЕРФЕЙС ДЛЯ ВСЕХ — ОДНА ТОЧКА (владелец 21.11.2026: «Удали это и включи
 * просто новый интерфейс для всех и всё»).
 *
 * Чистая оболочка и «Новый вид» включены всем сотрудникам и всем ролям, на компьютере
 * и на телефоне, агентам на телефоне тоже. Решение — константа `UI_SHELL_FOR_EVERYONE`
 * из packages/shared (её же отдаёт сервер на GET /ui-shell для старых вкладок), поэтому
 * запроса на старте больше нет и экран не ждёт ответа: первый кадр сразу новый.
 *
 * Единственный выход — личный и аварийный: адрес `?look=legacy` (на эту вкладку, до
 * `?look=royal` или закрытия вкладки, hooks/royalLookChoice.ts) возвращает прежний
 * интерфейс целиком. Интерфейса для него нет намеренно.
 */
export type CleanShellSelection = { clean: boolean; look?: "royal"; pending: boolean; unavailable?: boolean };

/** Чистое правило: вошедший сотрудник + решение для всех + без личного аварийного отказа. */
export function cleanShellEnabled(agentId: string | undefined, optedOut: boolean): boolean {
  return !!agentId && UI_SHELL_FOR_EVERYONE.enabled && !optedOut;
}

/** Shape kept for the ~50 existing callers; `pending` is always false now (no request). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useCleanShellSelection(_poll = false): CleanShellSelection {
  const agentId = useAuthStore((s) => s.agent?.id);
  const royal = useRoyalLookChoice(!!agentId);
  const clean = cleanShellEnabled(agentId, !royal);
  return clean ? { clean, look: UI_SHELL_FOR_EVERYONE.look, pending: false } : { clean: false, pending: false };
}

export function useCleanShell(): boolean {
  return useCleanShellSelection().clean;
}
