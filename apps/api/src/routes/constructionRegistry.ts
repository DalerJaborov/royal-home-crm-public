/**
 * РЕЕСТР РАЗРЕШЁННЫХ СТРОЕК (memor.pro, 20.11.2026) — маршруты для сотрудников CRM.
 *
 * Всё под requireAuth: данные видят только сотрудники (решение владельца), не директор-only. Публичных маршрутов, сайта,
 * бота и рекламы это не касается и касаться не должно — охраняет tests/construction-registry-private.test.ts.
 *  - GET  /property/:id        карточка объекта: связь или предложения или «в реестре не найден»
 *  - POST /property/:id/link   связать вручную { projectId }
 *  - POST /property/:id/reject отвергнуть предложение { projectId }
 *  - DELETE /property/:id/link отвязать
 *  - GET  /map                 метки реестра и цвета наших объектов для слоя карты
 *  - GET  /status              состояние забора для Настроек
 *  - POST /sync                забрать сейчас (право settings.manage)
 */
import { Router } from "express";
import { z } from "zod";
import { decisionYearFromQaror, rateDeveloper, type RegistryColor, type RegistryMapResponse } from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { propertyOwnerAgentId } from "../lib/propertyOwner.js";
import { loadRegistrySettings, runConstructionRegistrySync } from "../lib/constructionRegistry/sync.js";
import { buildPropertyResponse, lastRegistryUpdate } from "../lib/constructionRegistry/view.js";
import { linkPropertyManually, rejectSuggestion, toMatchInput, unlinkProperty } from "../lib/constructionRegistry/link.js";

export const constructionRegistryRouter = Router();

const COLOR_OUT: Record<"GREEN" | "YELLOW" | "RED", RegistryColor> = { GREEN: "green", YELLOW: "yellow", RED: "red" };
/** Потолок меток на карте: в реестре сегодня ~550, запас на рост. */
const MAP_CAP = 3000;

const projectBodySchema = z.object({ projectId: z.string().uuid() });

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

/** Менять связь может хозяин объекта или тот, кто правит чужие объекты (то же правило, что у карточки объекта). */
function canEditLink(req: Parameters<typeof can>[0], property: { intakeAgentId: string | null; assignedAgentId: string | null; createdById: string | null }): boolean {
  return can(req, "properties.editForeign") || propertyOwnerAgentId(property) === req.agent!.id;
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
