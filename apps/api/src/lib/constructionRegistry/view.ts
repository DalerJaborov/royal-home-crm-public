/**
 * ЧТЕНИЕ РЕЕСТРА СТРОЕК ДЛЯ ЭКРАНА (20.11.2026): проект + застройщик с рейтингом, связь с объектом, предложения.
 * Только для сотрудников (routes/constructionRegistry.ts под requireAuth). Не вызывать из публичных путей, сайта и бота.
 * Рейтинг считается на лету из проектов застройщика по формуле packages/shared/src/constructionRegistry.ts.
 */
import {
  decisionYearFromQaror,
  isInsideDushanbe,
  rateDeveloper,
  scoreRegistryMatch,
  type RegistryDeveloperDto,
  type RegistryProjectDto,
  type RegistryPropertyResponse,
  type RegistrySuggestionDto,
  type RegistryColor,
  type RegistryBrief,
} from "@royal-home/shared";
import type { ConstructionProject, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { loadRegistrySettings } from "./settings.js";

const COLOR_OUT: Record<"GREEN" | "YELLOW" | "RED", RegistryColor> = { GREEN: "green", YELLOW: "yellow", RED: "red" };
export const COLOR_DB: Record<RegistryColor, "GREEN" | "YELLOW" | "RED"> = { green: "GREEN", yellow: "YELLOW", red: "RED" };

/** Окно поиска вокруг точки объекта, градусы (~0,004 ≈ 440 м по широте): шире радиуса кандидата 250 м. */
const SEARCH_WINDOW_DEG = 0.004;
/** Не больше стольких проектов в одном окне — защита от случайной огромной выборки. */
const WINDOW_CAP = 200;

export function projectDto(p: ConstructionProject): RegistryProjectDto {
  const docs = Array.isArray(p.documents) ? (p.documents as unknown[]) : [];
  return {
    id: p.id,
    sourceId: p.sourceId,
    title: p.title,
    customer: p.customer,
    qaror: p.qaror,
    color: COLOR_OUT[p.colorStatus],
    category: p.category,
    lat: p.lat,
    lng: p.lng,
    address: p.address,
    description: p.description,
    floors: p.floors,
    blocks: p.blocks,
    documents: docs
      .filter((d): d is { name: string; ready: boolean } => !!d && typeof d === "object" && typeof (d as { name?: unknown }).name === "string")
      .map((d) => ({ name: d.name, ready: d.ready === true })),
    sourceUrl: p.sourceUrl,
    statusChangedAt: p.statusChangedAt ? p.statusChangedAt.toISOString() : null,
    removed: p.removedAt !== null,
    developerId: p.developerId,
  };
}

/** Рейтинги нужных застройщиков одним запросом: проекты, не пропавшие из реестра. */
export async function loadDeveloperDtos(developerIds: string[], now: Date = new Date()): Promise<Map<string, RegistryDeveloperDto>> {
  const ids = [...new Set(developerIds)];
  const out = new Map<string, RegistryDeveloperDto>();
  if (ids.length === 0) return out;
  const [developers, projects] = await Promise.all([
    prisma.constructionDeveloper.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }),
    prisma.constructionProject.findMany({
      where: { developerId: { in: ids }, removedAt: null },
      select: { developerId: true, colorStatus: true, qaror: true },
      take: 5000,
    }),
  ]);
  const byDeveloper = new Map<string, { color: RegistryColor; decisionYear: number | null }[]>();
  for (const p of projects) {
    const list = byDeveloper.get(p.developerId) ?? [];
    list.push({ color: COLOR_OUT[p.colorStatus], decisionYear: decisionYearFromQaror(p.qaror) });
    byDeveloper.set(p.developerId, list);
  }
  for (const d of developers) {
    out.set(d.id, { id: d.id, name: d.displayName, rating: rateDeveloper(byDeveloper.get(d.id) ?? [], now) });
  }
  return out;
}

/** Время последнего удачного забора реестра. */
export async function lastRegistryUpdate(): Promise<Date | null> {
  const run = await prisma.constructionSyncRun.findFirst({ where: { ok: true }, orderBy: { startedAt: "desc" }, select: { finishedAt: true, startedAt: true } });
  return run ? (run.finishedAt ?? run.startedAt) : null;
}

export interface PropertyForMatch {
  id: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  title: string;
  description: string | null;
  isNewBuilding: boolean;
}

/** Проекты жилого реестра рядом с точкой, не пропавшие из списка. */
export async function projectsNear(lat: number, lng: number): Promise<ConstructionProject[]> {
  const where: Prisma.ConstructionProjectWhereInput = {
    removedAt: null,
    category: "residential",
    lat: { gte: lat - SEARCH_WINDOW_DEG, lte: lat + SEARCH_WINDOW_DEG },
    lng: { gte: lng - SEARCH_WINDOW_DEG, lte: lng + SEARCH_WINDOW_DEG },
  };
  return prisma.constructionProject.findMany({ where, take: WINDOW_CAP });
}

export interface ScoredCandidate {
  project: ConstructionProject;
  level: "auto" | "suggest";
  confidence: number;
  distanceM: number | null;
  reasons: string[];
}

/** Кандидаты для объекта по убыванию уверенности; отвергнутые агентом не возвращаются. */
export async function rankCandidates(property: PropertyForMatch, projects?: ConstructionProject[]): Promise<ScoredCandidate[]> {
  if (property.lat === null || property.lng === null) return [];
  const near = projects ?? (await projectsNear(property.lat, property.lng));
  // Объекта ещё нет (предпросмотр в мастере до создания): отвергнутых у него быть не может.
  const rejected = new Set(
    property.id
      ? (await prisma.constructionPropertyLink.findMany({ where: { propertyId: property.id, state: "REJECTED" }, select: { projectId: true } })).map(
          (l) => l.projectId,
        )
      : [],
  );
  const out: ScoredCandidate[] = [];
  for (const project of near) {
    if (rejected.has(project.id)) continue;
    const m = scoreRegistryMatch({
      property,
      project: { lat: project.lat, lng: project.lng, address: project.address, customer: project.customer },
    });
    if (m.level === "none") continue;
    out.push({ project, level: m.level, confidence: m.confidence, distanceM: m.distanceM, reasons: m.reasons });
  }
  // «Само» раньше «предложить»: у соседнего дома на той же улице уверенность по расстоянию бывает выше, чем у проекта
  // с совпавшим номером дома чуть дальше (25.11.2026), а связывать надо второй.
  const rank = { auto: 0, suggest: 1 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level] || b.confidence - a.confidence || (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9));
}

/**
 * КОРОТКИЙ СТАТУС ДЛЯ СПИСКОВ (25.11.2026): список объектов CRM и ответы Шабнам про объекты. Только сотрудникам.
 * Пакетом, без N+1: связи — одним запросом, рейтинги — одним (loadDeveloperDtos). Рубильник выключен или реестр ещё не
 * загружался — пустая карта (значок не рисуется, Шабнам молчит). Новостройка Душанбе без связи — status "none" («проверьте
 * вручную»); у вторички и у объектов вне Душанбе без связи записи нет: их отсутствие в реестре ничего не значит.
 */
export async function loadRegistryBriefs(
  properties: readonly { id: string; condition: string }[],
): Promise<{ briefs: Map<string, RegistryBrief>; updatedAt: Date | null }> {
  const briefs = new Map<string, RegistryBrief>();
  if (properties.length === 0) return { briefs, updatedAt: null };
  const [settings, updatedAt] = await Promise.all([loadRegistrySettings(), lastRegistryUpdate()]);
  if (!settings.enabled || !updatedAt) return { briefs, updatedAt };
  const ids = [...new Set(properties.map((p) => p.id))];
  const links = await prisma.constructionPropertyLink.findMany({
    where: { propertyId: { in: ids }, state: "LINKED", project: { removedAt: null } },
    select: { propertyId: true, project: { select: { colorStatus: true, developerId: true } } },
    take: ids.length * 2,
  });
  const devs = await loadDeveloperDtos(links.map((l) => l.project.developerId));
  for (const l of links) {
    briefs.set(l.propertyId, { status: COLOR_OUT[l.project.colorStatus], letter: devs.get(l.project.developerId)?.rating.letter ?? null });
  }
  // «Проверьте вручную» только у новостроек Душанбе: реестр душанбинский, у объекта в Вахдате его отсутствие ничего не значит.
  const unlinkedNew = properties.filter((p) => !briefs.has(p.id) && p.condition === "NEW_BUILDING").map((p) => p.id);
  if (unlinkedNew.length > 0) {
    const places = await prisma.property.findMany({
      where: { id: { in: unlinkedNew } },
      select: { id: true, lat: true, lng: true, district: { select: { city: true } } },
      take: unlinkedNew.length,
    });
    for (const p of places) {
      const lat = p.lat === null ? null : Number(p.lat);
      const lng = p.lng === null ? null : Number(p.lng);
      const inDushanbe =
        lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)
          ? isInsideDushanbe(lat, lng)
          : /душанбе/i.test(p.district?.city ?? "");
      if (inDushanbe) briefs.set(p.id, { status: "none", letter: null });
    }
  }
  return { briefs, updatedAt };
}

/** Готовый ответ для карточки объекта. Ничего не пишет в базу. */
export async function buildPropertyResponse(property: PropertyForMatch, enabled: boolean): Promise<RegistryPropertyResponse> {
  const updatedAt = (await lastRegistryUpdate())?.toISOString() ?? null;
  const base: RegistryPropertyResponse = { enabled, updatedAt, link: null, suggestions: [], notFound: false, notLoaded: updatedAt === null, noPoint: property.lat === null || property.lng === null };
  if (!enabled || base.notLoaded) return base;

  const link = await prisma.constructionPropertyLink.findFirst({
    where: { propertyId: property.id, state: "LINKED", project: { removedAt: null } },
    include: { project: true },
  });
  if (link) {
    const devs = await loadDeveloperDtos([link.project.developerId]);
    const developer = devs.get(link.project.developerId);
    if (developer) {
      return {
        ...base,
        link: { method: link.method, confidence: link.confidence, distanceM: link.distanceM, reasons: link.reasons, project: projectDto(link.project), developer },
      };
    }
  }
  if (base.noPoint) return base;

  const candidates = (await rankCandidates(property)).slice(0, 3);
  // «Не найден» — сигнал только для новостройки; у вторички отсутствие в реестре ничего не значит.
  if (candidates.length === 0) return { ...base, notFound: property.isNewBuilding };
  const devs = await loadDeveloperDtos(candidates.map((c) => c.project.developerId));
  const suggestions: RegistrySuggestionDto[] = [];
  for (const c of candidates) {
    const developer = devs.get(c.project.developerId);
    if (!developer) continue;
    suggestions.push({ project: projectDto(c.project), developer, confidence: c.confidence, distanceM: c.distanceM, reasons: c.reasons });
  }
  return { ...base, suggestions, notFound: suggestions.length === 0 && property.isNewBuilding };
}
