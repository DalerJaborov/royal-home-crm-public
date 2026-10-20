import { canWriteAds, type PermissionId, type Role } from "@royal-home/shared";
import { loadAgentAccess } from "../../auth/middleware.js";

export { canWriteAds };

/**
 * Правило «кто меняет рекламу» живёт в packages/shared (adsAccess.ts) — его же
 * зовёт сайт. Здесь только серверные обёртки: по `req.agent` для роута и по
 * идентификатору для OAuth-колбэка, который приходит от Facebook без нашего
 * токена и к моменту возврата может застать уже сменённую роль или отключённую
 * учётку (ревью Codex 10.10.2026).
 */
export function agentAccessCanWriteAds(role: Role, permissions: ReadonlySet<PermissionId>): boolean {
  return canWriteAds(role, (p) => permissions.has(p));
}

export async function agentCanWriteAds(agentId: string): Promise<boolean> {
  const access = await loadAgentAccess(agentId);
  if (!access || !access.isActive) return false;
  return agentAccessCanWriteAds(access.role, access.permissions);
}
