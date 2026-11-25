import { registryBriefLine, registryBriefWarning, registryUpdatedDate, type RegistryBriefStatus } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { ASSISTANT_REGISTRY_GUIDE } from "../promptSections.js";
import { autoLinkPropertyById } from "../../../lib/constructionRegistry/autoLinkOnSave.js";
import { loadRegistryBriefs } from "../../../lib/constructionRegistry/view.js";

/**
 * СТРОКА РЕЕСТРА СТРОЕК В ОТВЕТАХ ШАБНАМ ПРО ОБЪЕКТЫ (25.11.2026): find_property, search_properties, get_property_card и
 * сообщение после создания объекта. Только внутренний помощник сотрудников: клиентский бот, голосовой бот и сайт эту функцию
 * не зовут (сторож tests/construction-registry-private.test.ts). Логика та же, что у значка в списке CRM — loadRegistryBriefs
 * (lib/constructionRegistry/view.ts), второй реализации нет. Пакетом: один вызов на весь список.
 */
export interface AssistantRegistryNote {
  /** «Реестр строек: разрешение есть, оценка застройщика B. По реестру memor.pro на 21.11.2026.» */
  registry: string;
  /** У жёлтого и красного — прямое предупреждение сотруднику; клиенту пересказать своими словами. */
  registryWarning?: string;
}

/** Раздел промта про реестр — только при включённом рубильнике. Сбой чтения настроек — без раздела. */
export async function registryPromptGuide(): Promise<string> {
  try {
    const { loadRegistrySettings } = await import("../../../lib/constructionRegistry/sync.js");
    return (await loadRegistrySettings()).enabled ? ASSISTANT_REGISTRY_GUIDE : "";
  } catch {
    return "";
  }
}

export async function registryNotesFor(properties: readonly { id: string; condition: string }[]): Promise<Map<string, AssistantRegistryNote>> {
  const out = new Map<string, AssistantRegistryNote>();
  try {
    const { briefs, updatedAt } = await loadRegistryBriefs(properties);
    const date = registryUpdatedDate(updatedAt);
    for (const [id, brief] of briefs) {
      const warning = registryBriefWarning(brief);
      const source = brief.status === "none" || !date ? "" : ` По реестру memor.pro на ${date}.`;
      out.set(id, { registry: `${registryBriefLine(brief)}${source}`, ...(warning ? { registryWarning: warning } : {}) });
    }
  } catch {
    // Реестр — дополнение к ответу про объект: его сбой не должен ронять поиск объектов.
  }
  return out;
}

/** Таджикские строки для сообщения сотруднику (не клиенту). Проверить носителем — пометка в журнале 25.11.2026. */
const TG_BRIEF: Record<RegistryBriefStatus, string> = {
  green: "Феҳристи сохтмонҳо: иҷозати сохтмон ҳаст.",
  yellow: "Феҳристи сохтмонҳо: ҳуҷҷатҳо ҳанӯз омода мешаванд. Ба мизоҷ ваъда надиҳед, ки иҷозат ҳатман мешавад.",
  red: "Феҳристи сохтмонҳо: иҷозати сохтмон нест. Ба мизоҷ пеш аз шартнома ҳатман гӯед.",
  none: "Дар феҳристи сохтмонҳо пайванд нест, иҷозатро худатон санҷед.",
};

/**
 * Строка после создания объекта (черновик в Telegram): сначала сверка с реестром (ждём её, а не фоновую), потом статус.
 * Нет точки на карте или реестр выключен — null: сверит геокодер, когда точка появится, и молчать здесь честнее.
 */
export async function registryNoteAfterCreate(propertyId: string, lang: "ru" | "tg"): Promise<string | null> {
  try {
    const outcome = await autoLinkPropertyById(propertyId);
    if (outcome === null) return null;
    const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, condition: true } });
    if (!property) return null;
    const { briefs, updatedAt } = await loadRegistryBriefs([property]);
    const brief = briefs.get(propertyId);
    if (!brief) return null;
    if (lang === "tg") return TG_BRIEF[brief.status];
    const date = registryUpdatedDate(updatedAt);
    const warning = registryBriefWarning(brief);
    const source = brief.status === "none" || !date ? "" : ` По реестру memor.pro на ${date}.`;
    return `${registryBriefLine(brief)}${source}${warning ? `\nВнимание: ${warning}` : ""}`;
  } catch {
    return null;
  }
}
