/**
 * СВЯЗЬ ОБЪЕКТА С ПРОЕКТОМ РЕЕСТРА (20.11.2026). Только внутренняя: ничего из этого не попадает в публичные ответы.
 *
 *  - Уверенное совпадение (scoreRegistryMatch → "auto") связывается само после забора (метод AUTO).
 *  - Неуверенное — не хранится, считается на лету и показывается агенту как «предложение» (view.ts).
 *  - Агент может связать вручную (MANUAL) или отвязать (запись REJECTED: больше не предлагаем этот проект).
 *  - Нет совпадения — «в реестре не найден»: честный сигнал, не домысел.
 */
import { prisma } from "../../db.js";
import { rankCandidates, type PropertyForMatch } from "./view.js";
import { loadRegistrySettings } from "./sync.js";
import { logSystemError } from "../systemError.js";

/** Сколько объектов за раз берём в разбор; потолок защищает от выборки на весь рост базы. */
const CHUNK = 500;
const MAX_PROPERTIES = 20_000;
/** Два «авто»-кандидата с разницей уверенности меньше этой — неоднозначно, связь не ставим (отдаём агенту). */
const AMBIGUOUS_GAP = 10;

type PropertyRow = {
  id: string;
  lat: unknown;
  lng: unknown;
  address: string | null;
  title: string;
  description: string | null;
  condition: string;
};

export function toMatchInput(p: PropertyRow): PropertyForMatch {
  const lat = p.lat === null || p.lat === undefined ? null : Number(p.lat);
  const lng = p.lng === null || p.lng === undefined ? null : Number(p.lng);
  return {
    id: p.id,
    lat: lat !== null && Number.isFinite(lat) ? lat : null,
    lng: lng !== null && Number.isFinite(lng) ? lng : null,
    address: p.address,
    title: p.title,
    description: p.description,
    isNewBuilding: p.condition === "NEW_BUILDING",
  };
}

/** Автосвязь одного объекта. true — связь поставлена. Не трогает ручную связь и уже связанные объекты. */
export async function autoLinkProperty(property: PropertyForMatch): Promise<boolean> {
  const existing = await prisma.constructionPropertyLink.findFirst({ where: { propertyId: property.id, state: "LINKED" }, select: { id: true } });
  if (existing) return false;
  const candidates = await rankCandidates(property);
  const best = candidates[0];
  if (!best || best.level !== "auto") return false;
  const second = candidates[1];
  if (second && second.level === "auto" && best.confidence - second.confidence < AMBIGUOUS_GAP) return false;
  await prisma.constructionPropertyLink.upsert({
    where: { propertyId_projectId: { propertyId: property.id, projectId: best.project.id } },
    create: {
      propertyId: property.id,
      projectId: best.project.id,
      state: "LINKED",
      method: "AUTO",
      confidence: best.confidence,
      distanceM: best.distanceM,
      reasons: best.reasons,
    },
    update: { state: "LINKED", method: "AUTO", confidence: best.confidence, distanceM: best.distanceM, reasons: best.reasons },
  });
  return true;
}

/** После каждого забора: автосвязь всех объектов с точкой, у которых связи ещё нет. Возвращает, сколько связано. */
export async function autoLinkAllProperties(): Promise<number> {
  let linked = 0;
  let cursor: string | undefined;
  let scanned = 0;
  for (;;) {
    const rows = await prisma.property.findMany({
      where: {
        deletedAt: null,
        lat: { not: null },
        lng: { not: null },
        constructionLinks: { none: { state: "LINKED" } },
      },
      select: { id: true, lat: true, lng: true, address: true, title: true, description: true, condition: true },
      orderBy: { id: "asc" },
      take: CHUNK,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (await autoLinkProperty(toMatchInput(row))) linked += 1;
    }
    scanned += rows.length;
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < CHUNK || scanned >= MAX_PROPERTIES) break;
  }
  return linked;
}

/** Ручная привязка агентом. Прежняя связь объекта снимается (на объект — один проект). */
export async function linkPropertyManually(propertyId: string, projectId: string, agentId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.constructionPropertyLink.updateMany({
      where: { propertyId, state: "LINKED", NOT: { projectId } },
      data: { state: "REJECTED" },
    });
    await tx.constructionPropertyLink.upsert({
      where: { propertyId_projectId: { propertyId, projectId } },
      create: { propertyId, projectId, state: "LINKED", method: "MANUAL", confidence: 100, reasons: ["Привязано вручную агентом."], createdById: agentId },
      update: { state: "LINKED", method: "MANUAL", confidence: 100, reasons: ["Привязано вручную агентом."], createdById: agentId },
    });
  });
}

/** Отвязка: связанный проект помечается как отвергнутый, чтобы автосвязь и предложения не вернули его. */
export async function unlinkProperty(propertyId: string, agentId: string): Promise<number> {
  const res = await prisma.constructionPropertyLink.updateMany({
    where: { propertyId, state: "LINKED" },
    data: { state: "REJECTED", createdById: agentId },
  });
  return res.count;
}

/** Отвергнуть предложение (проект рядом, но это не наш объект). */
export async function rejectSuggestion(propertyId: string, projectId: string, agentId: string): Promise<void> {
  await prisma.constructionPropertyLink.upsert({
    where: { propertyId_projectId: { propertyId, projectId } },
    create: { propertyId, projectId, state: "REJECTED", method: "MANUAL", confidence: 0, reasons: [], createdById: agentId },
    update: { state: "REJECTED", createdById: agentId },
  });
}

/**
 * Автосвязь сразу при создании и правке объекта (21.11.2026), не дожидаясь недельного забора. Фоновый вызов: не роняет сохранение.
 * Ничего не делает, если рубильник выключен, у объекта нет точки или связь уже есть; сомнительное оставляет человеку.
 */
export async function autoLinkPropertyById(propertyId: string): Promise<void> {
  try {
    if (!(await loadRegistrySettings()).enabled) return;
    const p = await prisma.property.findFirst({
      where: { id: propertyId, deletedAt: null, lat: { not: null }, lng: { not: null } },
      select: { id: true, lat: true, lng: true, address: true, title: true, description: true, condition: true },
    });
    if (p) await autoLinkProperty(toMatchInput(p));
  } catch (err) {
    void logSystemError("api", `Реестр строек: автосвязь объекта ${propertyId} не удалась: ${err instanceof Error ? err.message : String(err)}`);
  }
}
