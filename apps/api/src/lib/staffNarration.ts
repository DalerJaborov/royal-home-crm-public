import { isReadOnlyRole, narrationVariants, type NarrationConfig, type PermissionId } from "@royal-home/shared";
import { loadAgentAccess } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { hasMarketingRole } from "./marketingRole.js";
import { canManagePropertyAs } from "./propertyAccess.js";

/**
 * ОЗВУЧКА ОБЪЕКТА ДЛЯ СОТРУДНИКА — общее место для кнопок Шабнам (telegram/assistantNarration.ts) и
 * её инструментов (ai/assistant/tools/narrationTools.ts), 18.11.2026. Права одни: кто может нажать
 * кнопку «Одобрить» под озвучкой, тот может то же сказать словами.
 */
export type NarrationClicker = { agentId: string; isManager: boolean; role: string };

/**
 * Права на озвучку ЭТОГО объекта: живая учётка, не «только просмотр» и не монтажёр-редактор, объект
 * не удалён и сотрудник вправе им управлять (хозяин или руководство). null — нельзя.
 */
export async function narrationAccessForAgent(agentId: string, propertyId: string): Promise<NarrationClicker | null> {
  const access = await loadAgentAccess(agentId);
  if (!access?.isActive || isReadOnlyRole(access.role) || access.role === "EDITOR") return null;
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { assignedAgentId: true, intakeAgentId: true, createdById: true, deletedAt: true } });
  if (!property || property.deletedAt) return null;
  if (!canManagePropertyAs({ agentId, can: (perm: PermissionId) => access.permissions.has(perm) }, property)) return null;
  return { agentId, isManager: hasMarketingRole(access), role: access.role };
}

/** Голос или шаблон по имени, которое назвал человек: точное совпадение, иначе единственное вхождение. */
export type NameMatch<T> = { ok: true; item: T } | { ok: false; reason: "NONE" | "MANY"; candidates: T[] };
const fold = (text: string) => text.toLowerCase().replaceAll("ё", "е").replace(/\s+/gu, " ").trim();
export function matchByName<T extends { name: string }>(items: readonly T[], query: string): NameMatch<T> {
  const wanted = fold(query);
  if (!wanted) return { ok: false, reason: "NONE", candidates: [] };
  const exact = items.filter((i) => fold(i.name) === wanted);
  if (exact.length === 1) return { ok: true, item: exact[0]! };
  const part = exact.length ? exact : items.filter((i) => fold(i.name).includes(wanted) || wanted.includes(fold(i.name)));
  if (part.length === 1) return { ok: true, item: part[0]! };
  return { ok: false, reason: part.length ? "MANY" : "NONE", candidates: part.length ? [...part] : [...items] };
}

/** Шаблоны, подходящие типу объекта: сначала язык версии, затем другой язык (как кнопка «Другой шаблон»). */
export function narrationTemplatesFor(config: Pick<NarrationConfig, "templates">, versionLang: string | null | undefined, propertyType: string | null | undefined) {
  const templates = config.templates ?? [];
  const lang = versionLang === "ru" ? "ru" : "tg";
  return [...narrationVariants(templates, lang, propertyType), ...narrationVariants(templates, lang === "tg" ? "ru" : "tg", propertyType)];
}
