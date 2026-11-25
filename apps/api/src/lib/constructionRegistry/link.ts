/**
 * СВЯЗЬ ОБЪЕКТА С ПРОЕКТОМ РЕЕСТРА (20.11.2026). Только внутренняя: ничего из этого не попадает в публичные ответы.
 *
 *  - Уверенное совпадение (scoreRegistryMatch → "auto") связывается само (метод AUTO): после забора, при создании и правке.
 *  - Неуверенное — не хранится, считается на лету и показывается агенту как «предложение» (view.ts).
 *  - Агент может связать вручную (MANUAL) или отвязать (запись REJECTED: больше не предлагаем этот проект).
 *  - Нет совпадения — «в реестре не найден»: честный сигнал, не домысел.
 *
 * ПЕРЕСЧЁТ (25.11.2026). Связь AUTO — вывод из адреса и точки, а не решение человека: поменялись адрес или точка (или
 * правила сопоставления) — вывод пересчитывается. Признаки больше не держат связь — она снимается (не REJECTED: агент её
 * не отвергал, проект снова станет предложением); нашёлся другой однозначный проект — связь переезжает. Ручную связь
 * (MANUAL) автоматика не трогает никогда.
 *
 * ОПОВЕЩЕНИЕ (25.11.2026). Объект связали (сам или агент) с проектом жёлтого или красного цвета — ответственному агенту одно
 * сообщение в ленту под рубильником constructionRegistryNotify. Повтор отсекает notifiedAt на самой связи (захват
 * updateMany ... notifiedAt: null), а не память процесса.
 */
import { REGISTRY_COLOR_LABEL, type RegistryColor } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { notifyFeedOnly } from "../notifications.js";
import { propertyOwnerAgentId } from "../propertyOwner.js";
import { logSystemError } from "../systemError.js";
import { rankCandidates, type PropertyForMatch, type ScoredCandidate } from "./view.js";

/** Сколько объектов за раз берём в разбор; потолок защищает от выборки на весь рост базы. */
const CHUNK = 500;
const MAX_PROPERTIES = 20_000;
/** Два «авто»-кандидата с разницей уверенности меньше этой — неоднозначно, связь не ставим (отдаём агенту). */
export const AMBIGUOUS_GAP = 10;

type PropertyRow = {
  id: string;
  lat: unknown;
  lng: unknown;
  address: string | null;
  title: string;
  description: string | null;
  condition: string;
};

export const MATCH_PROPERTY_SELECT = { id: true, lat: true, lng: true, address: true, title: true, description: true, condition: true } as const;

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

/** Однозначный «авто»-кандидат или null: первый среди auto, и второй auto не наступает ему на пятки. */
export function pickAutoCandidate(candidates: readonly ScoredCandidate[]): ScoredCandidate | null {
  const autos = candidates.filter((c) => c.level === "auto");
  const best = autos[0];
  if (!best) return null;
  const second = autos[1];
  if (second && best.confidence - second.confidence < AMBIGUOUS_GAP) return null;
  return best;
}

export type AutoLinkOutcome = "linked" | "moved" | "kept" | "dropped" | "manual" | "none";

/**
 * Автосвязь одного объекта с пересчётом. Ручную связь не трогает. Возвращает, что сделано.
 * Два одновременных вызова для одного объекта (создание и геокодер) не наезжают друг на друга: замок на объект в транзакции.
 */
export async function autoLinkProperty(property: PropertyForMatch): Promise<AutoLinkOutcome> {
  const candidates = await rankCandidates(property);
  const target = pickAutoCandidate(candidates);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`construction-link:${property.id}`}))`;
    const existing = await tx.constructionPropertyLink.findFirst({
      where: { propertyId: property.id, state: "LINKED" },
      select: { id: true, projectId: true, method: true },
    });
    if (existing?.method === "MANUAL") return { outcome: "manual" as const, linkId: null };
    if (existing && target && target.project.id === existing.projectId) {
      await tx.constructionPropertyLink.update({
        where: { id: existing.id },
        data: { confidence: target.confidence, distanceM: target.distanceM, reasons: target.reasons },
      });
      return { outcome: "kept" as const, linkId: null };
    }
    if (existing) await tx.constructionPropertyLink.deleteMany({ where: { id: existing.id, method: "AUTO", state: "LINKED" } });
    if (!target) return { outcome: existing ? ("dropped" as const) : ("none" as const), linkId: null };
    const link = await tx.constructionPropertyLink.upsert({
      where: { propertyId_projectId: { propertyId: property.id, projectId: target.project.id } },
      create: {
        propertyId: property.id,
        projectId: target.project.id,
        state: "LINKED",
        method: "AUTO",
        confidence: target.confidence,
        distanceM: target.distanceM,
        reasons: target.reasons,
      },
      update: { state: "LINKED", method: "AUTO", confidence: target.confidence, distanceM: target.distanceM, reasons: target.reasons },
      select: { id: true },
    });
    return { outcome: existing ? ("moved" as const) : ("linked" as const), linkId: link.id };
  });
  if (result.linkId) await notifyRiskyLink(result.linkId, null);
  return result.outcome;
}

/**
 * После каждого забора: автосвязь всех объектов с точкой, у которых нет ручной связи (уже связанные AUTO пересчитываются —
 * так правка правил сопоставления доходит и до старых связей). Возвращает, сколько связано или перенесено.
 */
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
        constructionLinks: { none: { state: "LINKED", method: "MANUAL" } },
      },
      select: MATCH_PROPERTY_SELECT,
      orderBy: { id: "asc" },
      take: CHUNK,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const outcome = await autoLinkProperty(toMatchInput(row));
      if (outcome === "linked" || outcome === "moved") linked += 1;
    }
    scanned += rows.length;
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < CHUNK || scanned >= MAX_PROPERTIES) break;
  }
  return linked;
}

/** Ручная привязка агентом. Прежняя связь объекта снимается (на объект — один проект). */
export async function linkPropertyManually(propertyId: string, projectId: string, agentId: string): Promise<void> {
  const linkId = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`construction-link:${propertyId}`}))`;
    await tx.constructionPropertyLink.updateMany({
      where: { propertyId, state: "LINKED", NOT: { projectId } },
      data: { state: "REJECTED" },
    });
    const link = await tx.constructionPropertyLink.upsert({
      where: { propertyId_projectId: { propertyId, projectId } },
      create: { propertyId, projectId, state: "LINKED", method: "MANUAL", confidence: 100, reasons: ["Привязано вручную агентом."], createdById: agentId },
      update: { state: "LINKED", method: "MANUAL", confidence: 100, reasons: ["Привязано вручную агентом."], createdById: agentId },
      select: { id: true },
    });
    return link.id;
  });
  await notifyRiskyLink(linkId, agentId);
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

const COLOR_OUT: Record<"GREEN" | "YELLOW" | "RED", RegistryColor> = { GREEN: "green", YELLOW: "yellow", RED: "red" };

/**
 * Одно сообщение ответственному агенту: объект связан с жёлтым или красным проектом реестра. Никогда не бросает.
 * Рубильник уведомлений выключен — ничего не шлём и событие не «съедаем». Связал сам ответственный — он уже видит цвет
 * на экране: событие отмечаем, сообщение не шлём («редко беспокоить людей»).
 */
export async function notifyRiskyLink(linkId: string, actorId: string | null): Promise<boolean> {
  try {
    const { loadRegistrySettings } = await import("./sync.js");
    if (!(await loadRegistrySettings()).notify) return false;
    const link = await prisma.constructionPropertyLink.findUnique({
      where: { id: linkId },
      select: {
        id: true,
        state: true,
        notifiedAt: true,
        project: { select: { customer: true, colorStatus: true, removedAt: true } },
        property: { select: { id: true, shortId: true, deletedAt: true, intakeAgentId: true, assignedAgentId: true, createdById: true } },
      },
    });
    if (!link || link.state !== "LINKED" || link.notifiedAt || link.property.deletedAt || link.project.removedAt) return false;
    const claimed = await prisma.constructionPropertyLink.updateMany({
      where: { id: link.id, state: "LINKED", notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    if (claimed.count !== 1) return false;
    const color = COLOR_OUT[link.project.colorStatus];
    const agentId = propertyOwnerAgentId(link.property);
    if (color === "green" || !agentId || agentId === actorId) return false;
    const label = REGISTRY_COLOR_LABEL[color];
    try {
      await notifyFeedOnly([agentId], {
        kind: "task",
        title: `Реестр строек: объект №${link.property.shortId} — «${label.title}»`,
        body: `Объект связан с проектом застройщика ${link.project.customer} в реестре разрешённых строек. ${label.warning ?? ""}`.trim(),
        url: `/properties/${link.property.shortId}`,
        tag: `construction-registry-link-${link.property.id}`,
      });
    } catch (err) {
      // Не дошло — вернуть событие, иначе оно потеряется молча; следующая связь объекта попробует снова.
      await prisma.constructionPropertyLink.updateMany({ where: { id: link.id }, data: { notifiedAt: null } });
      throw err;
    }
    return true;
  } catch (err) {
    void logSystemError("api", `Реестр строек: уведомление о связи ${linkId} не отправлено: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
