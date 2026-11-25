import { z } from "zod";
import { REGISTRY_COLOR_LABEL, formatPropertyCode, registrySearchKey } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { propertyOwnerAgentId } from "../../../lib/propertyOwner.js";
import { linkPropertyManually } from "../../../lib/constructionRegistry/link.js";
import { searchRegistryProjects, type RegistrySearchHit } from "../../../lib/constructionRegistry/search.js";
import { loadRegistrySettings } from "../../../lib/constructionRegistry/settings.js";
import { resolveRefOrThrow } from "./propertyToolSupport.js";
import { plainField } from "./safeField.js";
import { asPluginExecutor, loadToolActor } from "./showingToolSupport.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * link_property_to_registry — «привяжи объект 1042 к застройщику / ЖК X» (уровень B, 25.11.2026).
 *
 * Та же ручная связь, что выбор в поле «Застройщик и разрешение» на сайте CRM (linkPropertyManually, метод MANUAL:
 * автоматика её больше не трогает). Проект ищется тем же поиском по всему реестру (searchRegistryProjects), что и поле.
 * Одно уверенное совпадение — привязываем сразу (кнопка «Отменить» вернёт как было); несколько — отказ со списком
 * вариантов, выбирать за человека нельзя; модель показывает список и зовёт снова с projectId.
 *
 * ПРАВА — как у POST /construction-registry/property/:id/link: ответственный агент объекта или тот, кто правит чужие
 * объекты (properties.editForeign). Только сотрудникам; в общей группе скрыт (GROUP_HIDDEN_TOOLS): запись без чужих глаз.
 *
 * ОТКАТ возвращает ровно прежнее состояние: прежнюю связь (тот же метод) и прежнее состояние выбранного проекта у объекта,
 * и только пока сейчас стоит именно наша ручная связь. Тронули после нас — отказ (409), чужая правка не затирается.
 */
const argsSchema = z
  .object({
    ref: z.string().trim().min(1).max(200),
    project: z.string().trim().min(2).max(120).optional(),
    projectId: z.guid().optional(),
  })
  .refine((a) => a.project || a.projectId, { message: "Нужно название комплекса или застройщика" });
type Args = z.infer<typeof argsSchema>;

/** Сколько вариантов показываем, когда совпадение не одно. */
const CANDIDATES_SHOWN = 5;

interface LinkResult {
  propertyId: string;
  shortId: number;
  projectId: string;
  /** Связь до нас (снимается на REJECTED) — её вернёт откат. */
  previous: { projectId: string; method: "AUTO" | "MANUAL" } | null;
  /** Строка выбранного проекта у объекта до нас: null — её не было (откат удаляет). */
  targetBefore: { state: "LINKED" | "REJECTED"; method: "AUTO" | "MANUAL" } | null;
  unchanged?: boolean;
  href: string;
}

async function loadProperty(ref: string, agentId: string, can: (p: "properties.editForeign") => boolean) {
  const { id } = await resolveRefOrThrow(ref);
  const property = await prisma.property.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, shortId: true, title: true, address: true, lat: true, lng: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
  });
  if (!property) throw new AssistantActionError(404, "NOT_FOUND", "Объект не найден");
  if (!can("properties.editForeign") && propertyOwnerAgentId(property) !== agentId) {
    throw new AssistantActionError(403, "FORBIDDEN", "Менять привязку может ответственный агент или руководитель");
  }
  return property;
}

/** Ровно один уверенный проект: единственный найденный или единственный с названием/застройщиком «точь-в-точь». */
function pickUnique(query: string, hits: RegistrySearchHit[]): RegistrySearchHit | null {
  if (hits.length === 1) return hits[0]!;
  const key = registrySearchKey(query);
  const exact = hits.filter((h) => registrySearchKey(h.title) === key || registrySearchKey(h.developer) === key);
  if (exact.length === 1) return exact[0]!;
  return null;
}

async function resolveProject(args: Args, point: { lat: number | null; lng: number | null }): Promise<{ id: string }> {
  if (args.projectId) {
    const found = await prisma.constructionProject.findFirst({ where: { id: args.projectId, removedAt: null }, select: { id: true } });
    if (!found) throw new AssistantActionError(404, "PROJECT_NOT_FOUND", "Такого проекта в реестре нет");
    return found;
  }
  const hits = await searchRegistryProjects({ q: args.project, lat: point.lat, lng: point.lng, limit: 20 });
  if (hits.length === 0) {
    throw new AssistantActionError(404, "PROJECT_NOT_FOUND", `В реестре строек не нашла «${plainField(args.project, 80) ?? ""}». Уточните название комплекса или застройщика.`);
  }
  const unique = pickUnique(args.project!, hits);
  if (unique) return { id: unique.id };
  throw new AssistantActionError(409, "AMBIGUOUS_PROJECT", "Подходит несколько проектов реестра, уточните, какой", {
    candidates: hits.slice(0, CANDIDATES_SHOWN).map((h) => ({
      projectId: h.id,
      title: plainField(h.title, 120),
      developer: plainField(h.developer, 120),
      address: plainField(h.address, 120),
      status: REGISTRY_COLOR_LABEL[h.color].title,
      distanceM: h.distanceM,
    })),
  });
}

const toNumber = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const linkPropertyRegistryExecutor: AssistantActionExecutor<Args> = {
  tool: "link_property_to_registry",
  channels: ["crm", "telegram"],
  parseArgs(raw) {
    const parsed = argsSchema.safeParse(raw);
    if (!parsed.success) throw new AssistantActionError(400, "BAD_ARGS", "Укажите номер объекта и название комплекса или застройщика");
    return parsed.data;
  },

  async snapshot(args, actionActor) {
    await loadToolActor(actionActor);
    if (!(await loadRegistrySettings()).enabled) throw new AssistantActionError(409, "REGISTRY_OFF", "Реестр строек выключен в Настройках");
    const property = await loadProperty(args.ref, actionActor.agentId, actionActor.can);
    const project = await resolveProject(args, { lat: toNumber(property.lat), lng: toNumber(property.lng) });
    const current = await prisma.constructionPropertyLink.findFirst({
      where: { propertyId: property.id, state: "LINKED" },
      select: { projectId: true, method: true },
    });
    return {
      propertyId: property.id,
      shortId: property.shortId,
      targetProjectId: project.id,
      currentProjectId: current?.projectId ?? null,
      currentMethod: current?.method ?? null,
    };
  },

  async buildPreview(_args, snapshot) {
    const ids = [snapshot.targetProjectId, snapshot.currentProjectId].filter((x): x is string => typeof x === "string");
    const projects = await prisma.constructionProject.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, colorStatus: true, developer: { select: { displayName: true } } },
    });
    const byId = new Map(projects.map((p) => [p.id, p]));
    const target = byId.get(String(snapshot.targetProjectId));
    const current = snapshot.currentProjectId ? byId.get(String(snapshot.currentProjectId)) : undefined;
    const color = target ? ({ GREEN: "green", YELLOW: "yellow", RED: "red" } as const)[target.colorStatus] : null;
    return {
      title: `Реестр строек: объект ${formatPropertyCode(Number(snapshot.shortId))}`,
      was: { Проект: current ? `${plainField(current.title, 120) ?? ""} (${plainField(current.developer.displayName, 120) ?? ""})` : "не привязан" },
      becomes: {
        Проект: target ? `${plainField(target.title, 120) ?? ""} (${plainField(target.developer.displayName, 120) ?? ""})` : "",
        ...(color ? { Разрешение: REGISTRY_COLOR_LABEL[color].title } : {}),
      },
      risk: "Связь ручная: автоматика её больше не поменяет. Кнопка «Отменить» вернёт как было.",
    };
  },

  async execute(args, actionActor, ctx) {
    await loadToolActor(actionActor);
    const property = await loadProperty(args.ref, actionActor.agentId, actionActor.can);
    const projectId = String(ctx.snapshotBefore.targetProjectId);
    const href = `/properties/${property.shortId}`;
    const [current, targetRow] = await Promise.all([
      prisma.constructionPropertyLink.findFirst({ where: { propertyId: property.id, state: "LINKED" }, select: { projectId: true, method: true } }),
      prisma.constructionPropertyLink.findUnique({ where: { propertyId_projectId: { propertyId: property.id, projectId } }, select: { state: true, method: true } }),
    ]);
    if (current?.projectId === projectId && current.method === "MANUAL") {
      const unchanged: LinkResult = { propertyId: property.id, shortId: property.shortId, projectId, previous: null, targetBefore: null, unchanged: true, href };
      return { result: { ...unchanged, note: "Объект уже привязан к этому проекту" }, audit: { entityType: "Property", entityId: property.id } };
    }
    await linkPropertyManually(property.id, projectId, actionActor.agentId);
    const result: LinkResult = {
      propertyId: property.id,
      shortId: property.shortId,
      projectId,
      previous: current && current.projectId !== projectId ? { projectId: current.projectId, method: current.method } : null,
      targetBefore: targetRow ? { state: targetRow.state, method: targetRow.method } : null,
      href,
    };
    return { result, audit: { entityType: "Property", entityId: property.id } };
  },

  async undo(_args, actionActor, ctx) {
    await loadToolActor(actionActor);
    const r = ctx.result as LinkResult | null;
    if (!r?.propertyId || !r.projectId) throw new AssistantActionError(409, "UNDO_STALE", "Не нашла, что откатывать");
    if (r.unchanged) return;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`construction-link:${r.propertyId}`}))`;
      const now = await tx.constructionPropertyLink.findFirst({
        where: { propertyId: r.propertyId, state: "LINKED" },
        select: { id: true, projectId: true, method: true, createdById: true },
      });
      if (!now || now.projectId !== r.projectId || now.method !== "MANUAL" || now.createdById !== actionActor.agentId) {
        throw new AssistantActionError(409, "UNDO_STALE", "Привязку уже поменяли после меня, откат затёр бы чужую правку");
      }
      if (r.targetBefore) {
        await tx.constructionPropertyLink.update({ where: { id: now.id }, data: { state: r.targetBefore.state, method: r.targetBefore.method } });
      } else {
        await tx.constructionPropertyLink.delete({ where: { id: now.id } });
      }
      if (r.previous) {
        await tx.constructionPropertyLink.updateMany({
          where: { propertyId: r.propertyId, projectId: r.previous.projectId },
          data: { state: "LINKED", method: r.previous.method },
        });
      }
    });
  },
};

export const linkPropertyRegistryTool: AssistantWriteToolPlugin = {
  name: "link_property_to_registry",
  level: "B",
  statusPhrase: "Привязываю объект к реестру строек…",
  description:
    "Привязать объект CRM к проекту реестра разрешённых строек (memor.pro): «привяжи объект 1042 к ЖК Дурахшон», «это застройщик Сомон», " +
    "«объекти 1042-ро ба маҷмааи … пайваст кун». ref — номер объекта; project — название комплекса или застройщика словами сотрудника; " +
    "projectId — только из списка candidates прошлого ответа. Исполняется сразу, у сотрудника остаётся «Отменить». " +
    "Если в ответе candidates (несколько проектов) — покажи их списком и спроси, какой; не выбирай сам. " +
    "НЕ звать, чтобы просто узнать статус разрешения (get_construction_registry).",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Номер объекта: «1042», «ОБ-001042» или id" },
      project: { type: "string", description: "Название комплекса или застройщика, как сказал сотрудник" },
      projectId: { type: "string", description: "id проекта реестра из списка candidates прошлого ответа" },
    },
    required: ["ref"],
  },
  executor: asPluginExecutor(linkPropertyRegistryExecutor),
};
