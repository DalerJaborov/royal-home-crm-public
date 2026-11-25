/**
 * Правила экранов вокруг Шабнам (Telegram сотрудника), 25.11.2026 — одним местом, чтобы
 * три вёрстки профиля и строка сотрудника в Настройках не разъехались снова.
 *
 * Живой случай: «Ноза РОП» не смогла привязать Telegram — блок в профиле показывался
 * только агенту, монтажёру и модератору, и условие было скопировано в трёх местах.
 */
import { canManageStaffTelegram, type Role } from "@royal-home/shared";

/** Блок «Личный чат с ботом CRM в Telegram» в профиле — каждой действующей роли. */
export function canSeeTelegramLink(profile: { role: Role | string } | null | undefined): boolean {
  return !!profile;
}

/** Выдавать ссылку подключения и отключать Шабнам другому сотруднику — директор и администратор.
 *  Правило общее с сервером: packages/shared/src/staffTelegram.ts. */
export function canManageStaffShabnam(role: Role | string | null | undefined): boolean {
  return canManageStaffTelegram(role);
}

/**
 * «Это тот же человек»: связь хранится на одной учётке (samePersonAgentId), а показывается
 * с обеих сторон. Только подпись — права и данные учёток не объединяются.
 */
export function samePersonAccounts<T extends { id: string; samePersonAgentId?: string | null }>(agent: T, all: readonly T[]): T[] {
  const ids = new Set<string>();
  if (agent.samePersonAgentId && agent.samePersonAgentId !== agent.id) ids.add(agent.samePersonAgentId);
  for (const other of all) if (other.id !== agent.id && other.samePersonAgentId === agent.id) ids.add(other.id);
  return all.filter((a) => ids.has(a.id));
}
