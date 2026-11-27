import { isReadOnlyRole } from "@royal-home/shared";
import type { AssistantToolPlugin } from "./types.js";

/**
 * ЗАПИСЬ ИЛИ ЧТЕНИЕ — ОДНО ПРАВИЛО НА ВСЕ ИНСТРУМЕНТЫ (ревью #506, 27.11.2026).
 * Запись: уровни B и C (через брокер действий) и уровень A с `sideEffect` (действие без
 * карточки). Ходы «только прочитать» и режим просмотра смотрят сюда, а не на уровень.
 */
export function pluginWrites(plugin: AssistantToolPlugin): boolean {
  return plugin.level !== "A" || plugin.sideEffect !== undefined;
}

/**
 * Закрыт ли инструмент режиму просмотра (акционер): запись — да, кроме «только своё»
 * (исполнитель с `readOnlyRoleAllowed`, действие с `sideEffect: "own"`).
 */
export function readOnlyRoleBlocked(plugin: AssistantToolPlugin, role: string | null | undefined): boolean {
  if (!isReadOnlyRole(role)) return false;
  if (plugin.level !== "A") return plugin.executor.readOnlyRoleAllowed !== true;
  return plugin.sideEffect === "shared";
}
