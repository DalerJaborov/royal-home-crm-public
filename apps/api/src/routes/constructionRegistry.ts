/**
 * РЕЕСТР РАЗРЕШЁННЫХ СТРОЕК (memor.pro, 20.11.2026) — маршруты для сотрудников CRM.
 *
 * Всё под requireAuth: данные видят только сотрудники (решение владельца), не директор-only. Публичных маршрутов, сайта,
 * бота и рекламы это не касается и касаться не должно — охраняет tests/construction-registry-private.test.ts.
 *  - GET  /property/:id        карточка объекта: связь или предложения или «в реестре не найден»
 *  - POST /property/:id/link   связать вручную { projectId }
 *  - POST /property/:id/reject отвергнуть предложение { projectId }
 *  - DELETE /property/:id/link отвязать
 *  - POST /property/:id/none   «нет в реестре / не новостройка» (25.11.2026)
 *  - GET  /projects?q=&lat=&lng=  поиск по всему жилому реестру для поля выбора (25.11.2026)
 *  - POST /match-preview       лучший проект у точки ДО создания объекта, ничего не пишет (25.11.2026)
 *  - GET  /map                 метки реестра и цвета наших объектов для слоя карты
 *  - GET  /status              состояние забора для Настроек
 *  - POST /sync                забрать сейчас (право settings.manage)
 */
import { Router } from "express";
import { z } from "zod";
import {
  decisionYearFromQaror,
  rateDeveloper,
  type RegistryColor,
  type RegistryMapResponse,
  type RegistryMatchPreviewResponse,
  type RegistryProjectSearchResponse,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { canEditRegistryLinkAs } from "../lib/constructionRegistry/access.js";
import { loadRegistrySettings, runConstructionRegistrySync } from "../lib/constructionRegistry/sync.js";
import { buildPropertyResponse, lastRegistryUpdate } from "../lib/constructionRegistry/view.js";
import { linkPropertyManually, markNotInRegistry, rejectSuggestion, toMatchInput, unlinkProperty } from "../lib/constructionRegistry/link.js";
import { previewRegistryMatch, searchRegistryProjects, SEARCH_LIMIT_MAX } from "../lib/constructionRegistry/search.js";
import { REGISTRY_NOTHING_TO_REJECT } from "../lib/constructionRegistry/autoLinkOnSave.js";

export const constructionRegistryRouter = Router();

const COLOR_OUT: Record<"GREEN" | "YELLOW" | "RED", RegistryColor> = { GREEN: "green", YELLOW: "yellow", RED: "red" };
/** Потолок меток на карте: в реестре сегодня ~550, запас на рост. */
const MAP_CAP = 3000;

const projectBodySchema = z.object({ projectId: z.string().uuid() });

const latSchema = z.coerce.number().min(-90).max(90);
const lngSchema = z.coerce.number().min(-180).max(180);

/** Поиск по реестру: точка необязательна, но приходит парой. */
const searchQuerySchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    lat: latSchema.optional(),
    lng: lngSchema.optional(),
    limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: "Точка задаётся парой lat и lng" });

/** Предпросмотр до сохранения объекта: точка и то, по чему сопоставляем. */
const previewBodySchema = z.object({
  propertyId: z.string().uuid().optional(),
  lat: latSchema.nullable(),
  lng: lngSchema.nullable(),
  address: z.string().trim().max(500).nullable().optional(),
  title: z.string().trim().max(300).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  isNewBuilding: z.boolean().optional(),
});

/** Объект по uuid или по короткому номеру из адресной строки (/properties/1042). */
async function findProperty(idOrShort: string) {
  const isShort = /^\d+$/.test(idOrShort);
  if (!isShort && !/^[0-9a-f-]{36}$/i.test(idOrShort)) return null;
  return prisma.property.findFirst({
    where: { ...(isShort ? { shortId: Number(idOrShort) } : { id: idOrShort }), deletedAt: null },
    select: {
      id: true,
      lat: true,
      lng: true,
      address: true,
      title: true,
      description: true,
      condition: true,
      intakeAgentId: true,
      assignedAgentId: true,
      createdById: true,
    },
  });
}

/** Менять связь может тот, кто вправе править карточку объекта: одно правило с формой и Шабнам (lib/constructionRegistry/access.ts). */
function canEditLink(req: Parameters<typeof can>[0], property: { intakeAgentId: string | null; assignedAgentId: string | null; createdById: string | null }): boolean {
  return canEditRegistryLinkAs({ agentId: req.agent!.id, can: (permission) => can(req, permission) }, property);
}

constructionRegistryRouter.get("/property/:id", requireAuth, async (req, res) => {
  const property = await findProperty(String(req.params.id));
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  const { enabled } = await loadRegistrySettings();
  res.json(await buildPropertyResponse(toMatchInput(property), enabled));
});

constructionRegistryRouter.post("/property/:id/link", requireAuth, async (req, res) => {
  const parsed = projectBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const property = await findProperty(String(req.params.id));
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canEditLink(req, property)) return res.status(403).json({ error: "Менять привязку может ответственный агент или руководитель" });
  const project = await prisma.constructionProject.findUnique({ where: { id: parsed.data.projectId }, select: { id: true } });
  if (!project) return res.status(404).json({ error: "Проект реестра не найден" });
  await linkPropertyManually(property.id, project.id, req.agent!.id);
  res.json(await buildPropertyResponse(toMatchInput(property), true));
});

constructionRegistryRouter.post("/property/:id/reject", requireAuth, async (req, res) => {
  const parsed = projectBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const property = await findProperty(String(req.params.id));
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canEditLink(req, property)) return res.status(403).json({ error: "Менять привязку может ответственный агент или руководитель" });
  const exists = await prisma.constructionProject.findUnique({ where: { id: parsed.data.projectId }, select: { id: true } });
  if (!exists) return res.status(404).json({ error: "Проект реестра не найден" });
  await rejectSuggestion(property.id, parsed.data.projectId, req.agent!.id);
  res.json(await buildPropertyResponse(toMatchInput(property), true));
});

constructionRegistryRouter.delete("/property/:id/link", requireAuth, async (req, res) => {
  const property = await findProperty(String(req.params.id));
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canEditLink(req, property)) return res.status(403).json({ error: "Менять привязку может ответственный агент или руководитель" });
  await unlinkProperty(property.id, req.agent!.id);
  res.json(await buildPropertyResponse(toMatchInput(property), true));
});

/** «Нет в реестре / не новостройка»: связь снимается, проекты рядом больше не предлагаются. */
constructionRegistryRouter.post("/property/:id/none", requireAuth, async (req, res) => {
  const property = await findProperty(String(req.params.id));
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canEditLink(req, property)) return res.status(403).json({ error: "Менять привязку может ответственный агент или руководитель" });
  const { enabled } = await loadRegistrySettings();
  if (!enabled) return res.status(409).json({ error: "Реестр строек выключен в Настройках" });
  // Отвергать нечего (нет точки, рядом нет проектов и связи нет) — честный отказ, а не «200 и ничего» (ревью PR #441):
  // иначе геокодер позже поставит точку, автосвязь привяжет проект, и решение сотрудника потеряется молча.
  if ((await markNotInRegistry(property.id, req.agent!.id)) === 0) return res.status(409).json({ error: REGISTRY_NOTHING_TO_REJECT });
  res.json(await buildPropertyResponse(toMatchInput(property), enabled));
});

/** Поиск по всему жилому списку реестра для поля выбора (до 20 штук; с точкой — ближние выше). */
constructionRegistryRouter.get("/projects", requireAuth, async (req, res) => {
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const [{ enabled }, updated] = await Promise.all([loadRegistrySettings(), lastRegistryUpdate()]);
  const body: RegistryProjectSearchResponse = { enabled, updatedAt: updated?.toISOString() ?? null, notLoaded: updated === null, items: [] };
  if (!enabled || !updated) return res.json(body);
  const hits = await searchRegistryProjects(parsed.data);
  body.items = hits.map(({ score: _score, ...option }) => option);
  res.json(body);
});

/** До создания объекта: лучший проект реестра у точки, уровень уверенности и до трёх запасных. Ничего не пишет. */
constructionRegistryRouter.post("/match-preview", requireAuth, async (req, res) => {
  const parsed = previewBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const body: RegistryMatchPreviewResponse = await previewRegistryMatch(parsed.data);
  res.json(body);
});

constructionRegistryRouter.get("/map", requireAuth, async (_req, res) => {
  const { enabled } = await loadRegistrySettings();
  const updatedAt = (await lastRegistryUpdate())?.toISOString() ?? null;
  if (!enabled) {
    const off: RegistryMapResponse = { enabled: false, updatedAt, projects: [], propertyColors: {} };
    return res.json(off);
  }
  const [projects, links] = await Promise.all([
    prisma.constructionProject.findMany({
      where: { removedAt: null },
      select: { id: true, lat: true, lng: true, colorStatus: true, title: true, customer: true, category: true, developerId: true, qaror: true },
      take: MAP_CAP,
    }),
    prisma.constructionPropertyLink.findMany({
      where: { state: "LINKED", property: { deletedAt: null, offSite: false }, project: { removedAt: null } },
      select: { propertyId: true, project: { select: { colorStatus: true } } },
      take: 20_000,
    }),
  ]);
  // Буква застройщика на метке: считаем один раз по уже загруженным проектам.
  const byDeveloper = new Map<string, { color: RegistryColor; decisionYear: number | null }[]>();
  for (const p of projects) {
    const list = byDeveloper.get(p.developerId) ?? [];
    list.push({ color: COLOR_OUT[p.colorStatus], decisionYear: decisionYearFromQaror(p.qaror) });
    byDeveloper.set(p.developerId, list);
  }
  const letters = new Map<string, ReturnType<typeof rateDeveloper>["letter"]>();
  for (const [id, list] of byDeveloper) letters.set(id, rateDeveloper(list).letter);

  const body: RegistryMapResponse = {
    enabled: true,
    updatedAt,
    projects: projects.map((p) => ({
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      color: COLOR_OUT[p.colorStatus],
      title: p.title,
      customer: p.customer,
      category: p.category,
      letter: letters.get(p.developerId) ?? null,
      developerId: p.developerId,
    })),
    propertyColors: Object.fromEntries(links.map((l) => [l.propertyId, COLOR_OUT[l.project.colorStatus]])),
  };
  res.json(body);
});

constructionRegistryRouter.get("/status", requireAuth, async (_req, res) => {
  const [settings, runs, active, linked] = await Promise.all([
    loadRegistrySettings(),
    prisma.constructionSyncRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 5,
      select: { startedAt: true, finishedAt: true, ok: true, trigger: true, fetched: true, created: true, changed: true, removed: true, linked: true, error: true },
    }),
    prisma.constructionProject.count({ where: { removedAt: null } }),
    prisma.constructionPropertyLink.count({ where: { state: "LINKED" } }),
  ]);
  res.json({ ...settings, activeProjects: active, linkedProperties: linked, runs });
});

constructionRegistryRouter.post("/sync", requireAuth, requirePermission("settings.manage"), async (_req, res) => {
  // Забор длится минуты (страницы объектов идут с паузой): отвечаем сразу, итог виден в /status.
  void runConstructionRegistrySync({ trigger: "manual" });
  res.status(202).json({ started: true });
});
