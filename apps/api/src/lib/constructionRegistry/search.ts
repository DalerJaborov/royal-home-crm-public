/**
 * ПОИСК ПО РЕЕСТРУ И ПРЕДПРОСМОТР СОВПАДЕНИЯ (25.11.2026). Только для сотрудников (routes/constructionRegistry.ts под
 * requireAuth и инструмент Шабнам «привяжи объект к застройщику»). Ничего не пишет в базу.
 *
 *  - searchRegistryProjects: поле выбора «Застройщик и разрешение» ищет по ВСЕМУ жилому списку реестра (название,
 *    застройщик, адрес, номер решения). Правило совпадения — packages/shared (registryQueryScore), одно на сервер и экран.
 *    Реестр небольшой (~550 проектов), поэтому один запрос с потолком и отбор в памяти, без N+1.
 *  - previewRegistryMatch: до создания объекта по точке и адресу — лучший вариант, уровень уверенности и до трёх
 *    запасных. Та же оценка, что у автосвязи (rankCandidates + pickAutoCandidate): «auto» здесь значит ровно то, что
 *    автосвязь свяжет сама при сохранении.
 */
import {
  distanceMeters,
  registryQueryScore,
  type RegistryColor,
  type RegistryMatchPreviewResponse,
  type RegistryProjectOption,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { pickAutoCandidate } from "./link.js";
import { lastRegistryUpdate, rankCandidates, type ScoredCandidate } from "./view.js";
import { loadRegistrySettings } from "./settings.js";

const COLOR_OUT: Record<"GREEN" | "YELLOW" | "RED", RegistryColor> = { GREEN: "green", YELLOW: "yellow", RED: "red" };
/** Потолок выборки: в реестре ~550 проектов, запас на рост. */
const SEARCH_SCAN_CAP = 3000;
export const SEARCH_LIMIT_MAX = 20;
/** Запасных вариантов в предпросмотре. */
const PREVIEW_ALTERNATIVES = 3;

export interface RegistrySearchInput {
  q?: string;
  lat?: number | null;
  lng?: number | null;
  limit?: number;
}

export interface RegistrySearchHit extends RegistryProjectOption {
  score: number;
}

/** Поиск по всему жилому реестру. Пустой запрос с точкой — ближайшие; пустой без точки — по алфавиту. */
export async function searchRegistryProjects(input: RegistrySearchInput): Promise<RegistrySearchHit[]> {
  const limit = Math.min(Math.max(input.limit ?? SEARCH_LIMIT_MAX, 1), SEARCH_LIMIT_MAX);
  const hasPoint = typeof input.lat === "number" && typeof input.lng === "number";
  const rows = await prisma.constructionProject.findMany({
    where: { removedAt: null, category: "residential" },
    select: {
      id: true,
      title: true,
      customer: true,
      address: true,
      qaror: true,
      colorStatus: true,
      lat: true,
      lng: true,
      sourceUrl: true,
      developer: { select: { displayName: true } },
    },
    take: SEARCH_SCAN_CAP,
  });
  const hits: RegistrySearchHit[] = [];
  for (const r of rows) {
    const score = registryQueryScore(input.q, {
      title: r.title,
      customer: r.customer,
      developer: r.developer.displayName,
      address: r.address,
      qaror: r.qaror,
    });
    if (score === null) continue;
    hits.push({
      id: r.id,
      title: r.title,
      developer: r.developer.displayName || r.customer,
      address: r.address,
      qaror: r.qaror,
      color: COLOR_OUT[r.colorStatus],
      distanceM: hasPoint ? Math.round(distanceMeters(input.lat!, input.lng!, r.lat, r.lng)) : null,
      sourceUrl: r.sourceUrl,
      score,
    });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (a.distanceM ?? Number.MAX_SAFE_INTEGER) - (b.distanceM ?? Number.MAX_SAFE_INTEGER) ||
      a.title.localeCompare(b.title, "ru"),
  );
  return hits.slice(0, limit);
}

export interface RegistryPreviewInput {
  /** Объект уже есть (форма правки): его отвергнутые проекты не предлагаем. */
  propertyId?: string | null;
  lat: number | null;
  lng: number | null;
  address?: string | null;
  title?: string | null;
  description?: string | null;
  isNewBuilding?: boolean;
}

async function toOptions(candidates: readonly ScoredCandidate[]): Promise<Map<string, RegistryProjectOption>> {
  const developerIds = [...new Set(candidates.map((c) => c.project.developerId))];
  const developers =
    developerIds.length === 0
      ? []
      : await prisma.constructionDeveloper.findMany({ where: { id: { in: developerIds } }, select: { id: true, displayName: true } });
  const names = new Map(developers.map((d) => [d.id, d.displayName]));
  return new Map(
    candidates.map((c) => [
      c.project.id,
      {
        id: c.project.id,
        title: c.project.title,
        developer: names.get(c.project.developerId) || c.project.customer,
        address: c.project.address,
        qaror: c.project.qaror,
        color: COLOR_OUT[c.project.colorStatus],
        distanceM: c.distanceM,
        sourceUrl: c.project.sourceUrl,
      },
    ]),
  );
}

/** Предпросмотр совпадения до сохранения объекта. Ничего не пишет. */
/**
 * `knownEnabled` — рубильник уже известен вызывающему (Шабнам берёт его из своего кэша настроек): Settings не читаем.
 */
export async function previewRegistryMatch(input: RegistryPreviewInput, knownEnabled?: boolean): Promise<RegistryMatchPreviewResponse> {
  const [settings, updated] = await Promise.all([
    knownEnabled === undefined ? loadRegistrySettings() : Promise.resolve({ enabled: knownEnabled }),
    lastRegistryUpdate(),
  ]);
  const noPoint = input.lat === null || input.lng === null;
  const base: RegistryMatchPreviewResponse = {
    enabled: settings.enabled,
    updatedAt: updated?.toISOString() ?? null,
    notLoaded: updated === null,
    noPoint,
    level: "none",
    best: null,
    alternatives: [],
  };
  if (!settings.enabled || base.notLoaded || noPoint) return base;
  const candidates = await rankCandidates({
    id: input.propertyId ?? "",
    lat: input.lat,
    lng: input.lng,
    address: input.address ?? null,
    title: input.title ?? "",
    description: input.description ?? null,
    isNewBuilding: input.isNewBuilding === true,
  });
  if (candidates.length === 0) return base;
  const auto = pickAutoCandidate(candidates);
  const best = auto ?? candidates[0]!;
  const rest = candidates.filter((c) => c.project.id !== best.project.id).slice(0, PREVIEW_ALTERNATIVES);
  const options = await toOptions([best, ...rest]);
  return {
    ...base,
    level: auto ? "auto" : "suggest",
    best: { ...options.get(best.project.id)!, confidence: best.confidence, reasons: best.reasons },
    alternatives: rest.map((c) => options.get(c.project.id)!),
  };
}
