import { registryBriefLine, registryBriefWarning, registryUpdatedDate, type RegistryBrief, type RegistryBriefStatus } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { ASSISTANT_REGISTRY_GUIDE } from "../promptSections.js";
import { autoLinkPropertyById } from "../../../lib/constructionRegistry/autoLinkOnSave.js";
import { loadRegistryBriefs } from "../../../lib/constructionRegistry/view.js";
import { previewRegistryMatch } from "../../../lib/constructionRegistry/search.js";
import { plainField } from "./safeField.js";

/**
 * СТРОКА РЕЕСТРА СТРОЕК В ОТВЕТАХ ШАБНАМ ПРО ОБЪЕКТЫ (25.11.2026): find_property, search_properties, get_property_card и
 * сообщение после создания объекта. Только внутренний помощник сотрудников: клиентский бот, голосовой бот и сайт эту функцию
 * не зовут (сторож tests/construction-registry-private.test.ts). Логика та же, что у значка в списке CRM: loadRegistryBriefs
 * (lib/constructionRegistry/view.ts), второй реализации нет. Пакетом: один вызов на весь список.
 *
 * В рабочей группе буква оценки застройщика (A–D) не показывается: это НАША оценка, а не данные memor.pro (ревью 25.11.2026).
 */
export interface AssistantRegistryNote {
  /** «Реестр строек: разрешение есть, оценка застройщика B. По реестру memor.pro на 21.11.2026.» */
  registry: string;
  /** У жёлтого и красного прямое предупреждение сотруднику; клиенту пересказать своими словами. */
  registryWarning?: string;
}

/** Канал разговора: в группе без буквы оценки. */
export interface RegistryNoteContext {
  surface?: string;
}

const withoutLetterIn = (ctx: RegistryNoteContext) => ctx.surface === "telegram-group";

/** Раздел промта про реестр, только при включённом рубильнике. Сбой чтения настроек: без раздела. */
export function registryPromptGuide(enabled: boolean): string {
  return enabled ? ASSISTANT_REGISTRY_GUIDE : "";
}

function noteOf(brief: RegistryBrief, date: string | null, ctx: RegistryNoteContext): AssistantRegistryNote {
  const shown: RegistryBrief = withoutLetterIn(ctx) ? { ...brief, letter: null } : brief;
  const warning = registryBriefWarning(shown);
  const source = shown.status === "none" || !date ? "" : ` По реестру memor.pro на ${date}.`;
  return { registry: `${registryBriefLine(shown)}${source}`, ...(warning ? { registryWarning: warning } : {}) };
}

export async function registryNotesFor(
  properties: readonly { id: string; condition: string }[],
  ctx: RegistryNoteContext = {},
): Promise<Map<string, AssistantRegistryNote>> {
  const out = new Map<string, AssistantRegistryNote>();
  try {
    const { briefs, updatedAt } = await loadRegistryBriefs(properties);
    const date = registryUpdatedDate(updatedAt);
    for (const [id, brief] of briefs) out.set(id, noteOf(brief, date, ctx));
  } catch {
    // Реестр лишь дополняет ответ про объект: его сбой не должен ронять поиск объектов.
  }
  return out;
}

/** Таджикские строки для сообщения сотруднику (не клиенту), {date} — дата реестра. Проверить носителем. */
const TG_BRIEF: Record<RegistryBriefStatus, string> = {
  green: "Аз рӯи феҳристи сохтмонҳо (memor.pro) то санаи {date}: иҷозати сохтмон ҳаст.",
  yellow:
    "Аз рӯи феҳристи сохтмонҳо (memor.pro) то санаи {date}: ҳуҷҷатҳо ҳанӯз омода мешаванд. Ба мизоҷ ваъда надиҳед, ки иҷозат ҳатман мешавад.",
  red: "Аз рӯи феҳристи сохтмонҳо (memor.pro) то санаи {date}: иҷозати сохтмон нест. Пеш аз шартнома мизоҷро ҳатман огоҳ кунед.",
  none: "Дар феҳристи сохтмонҳо пайванд нест, иҷозатро худатон санҷед.",
};

/** Таджикская строка статуса (экспорт ради теста текстов). */
export function tajikRegistryLine(status: RegistryBriefStatus, date: string | null): string {
  const line = TG_BRIEF[status];
  return date ? line.replace("{date}", date) : line.replace(" то санаи {date}", "");
}

/**
 * Подсказка «как исправить» под строкой реестра, когда проект не определён уверенно: догадка (если есть) и просьба назвать
 * застройщика или комплекс. Привязку делает инструмент link_property_to_registry. Без «—»: текст уходит сотруднику как есть.
 * Таджикские строки: проверить носителем.
 */
export async function howToFixLine(
  property: { id: string; lat: unknown; lng: unknown },
  lang: "ru" | "tg",
): Promise<string> {
  const lat = property.lat === null ? null : Number(property.lat);
  const lng = property.lng === null ? null : Number(property.lng);
  let guess: { title: string; developer: string } | null = null;
  try {
    const row = await prisma.property.findUnique({ where: { id: property.id }, select: { address: true, title: true, description: true, condition: true } });
    const preview = await previewRegistryMatch({
      propertyId: property.id,
      lat: lat !== null && Number.isFinite(lat) ? lat : null,
      lng: lng !== null && Number.isFinite(lng) ? lng : null,
      address: row?.address ?? null,
      title: row?.title ?? null,
      description: row?.description ?? null,
      isNewBuilding: row?.condition === "NEW_BUILDING",
    });
    if (preview.best) guess = { title: plainField(preview.best.title, 120) ?? "", developer: plainField(preview.best.developer, 120) ?? "" };
  } catch {
    // Догадка лишь помогает: без неё остаётся просьба назвать застройщика.
  }
  if (lang === "tg") {
    const hint = guess ? `\nШояд ин «${guess.title}» (${guess.developer}) бошад: агар ҳамин бошад, нависед «пайваст кун».` : "";
    return `${hint}\nНоми ширкати сохтмонӣ ё маҷмааро нависед, пайваст мекунам.`;
  }
  const hint = guess ? `\nПохоже на «${guess.title}» (застройщик ${guess.developer}): если это он, напишите «привяжи».` : "";
  return `${hint}\nНазовите застройщика или комплекс, привяжу.`;
}

/**
 * Строка после создания объекта (черновик в Telegram): сначала сверка с реестром (ждём её, а не фоновую), потом статус.
 * Автор объекта видит строку здесь, поэтому дверь зовётся от его имени: сообщения в ленту ему не уходит.
 * Нет точки на карте или реестр выключен: null. Сверит геокодер, когда точка появится, и молчать здесь честнее.
 */
export async function registryNoteAfterCreate(propertyId: string, lang: "ru" | "tg", actorId: string): Promise<string | null> {
  try {
    const outcome = await autoLinkPropertyById(propertyId, actorId);
    if (outcome === null) return null;
    const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, condition: true, lat: true, lng: true } });
    if (!property || property.lat === null || property.lng === null) return null;
    const { briefs, updatedAt } = await loadRegistryBriefs([property]);
    const brief = briefs.get(propertyId);
    if (!brief) return null;
    const date = registryUpdatedDate(updatedAt);
    // Не определили уверенно — тут же сказать, как поправить словами (25.11.2026): назвать застройщика или комплекс.
    const fix = brief.status === "none" ? await howToFixLine(property, lang) : "";
    if (lang === "tg") return `${tajikRegistryLine(brief.status, date)}${fix}`;
    const note = noteOf(brief, date, {});
    return `${note.registry}${note.registryWarning ? `\nВнимание: ${note.registryWarning}` : ""}${fix}`;
  } catch {
    return null;
  }
}
