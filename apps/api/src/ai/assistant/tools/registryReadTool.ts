import { z } from "zod";
import { REGISTRY_COLOR_LABEL, registrySourceCaption } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { loadRegistrySettings } from "../../../lib/constructionRegistry/sync.js";
import { buildPropertyResponse, loadDeveloperDtos, projectDto } from "../../../lib/constructionRegistry/view.js";
import { toMatchInput } from "../../../lib/constructionRegistry/link.js";
import { safeField } from "./safeField.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * РЕЕСТР РАЗРЕШЁННЫХ СТРОЕК ДЛЯ ШАБНАМ (21.11.2026). Только сотрудникам: в личке и в рабочих группах (с 25.11.2026, решение
 * владельца: данные публичные — memor.pro, объекты в группе и так видны через поиск). Клиентам и на сайт не уходит.
 * Та же логика, что у карточки объекта (lib/constructionRegistry/view.ts): второй реализации нет. Ничего не пишет.
 * Клиенту это не отдаётся: сотрудник пересказывает своими словами и называет дату обновления реестра.
 */
const args = z.object({
  property: z.coerce.number().int().positive().optional(),
  query: z.string().trim().min(2).max(80).optional(),
});

export const getConstructionRegistryTool: AssistantReadToolPlugin = {
  name: "get_construction_registry",
  level: "A",
  statusPhrase: "Смотрю реестр разрешённых строек…",
  description:
    "Реестр разрешённых строек Душанбе (memor.pro): есть ли у новостройки разрешение (зелёный — есть, жёлтый — частично, красный — нет) " +
    "и какая оценка у застройщика (A–D по его проектам). property — номер объекта из CRM (например 1042): вернёт проект, статус и застройщика. " +
    "query — название комплекса или застройщика: вернёт до 5 проектов. Зови на «есть ли разрешение на стройку», «застройщик надёжный», " +
    "«ҷавозро иҷозат дорад», «бунёдкор боэътимод аст». Это данные внешнего реестра на дату обновления, не гарантия: " +
    "всегда называй дату из updatedCaption; клиенту — только своими словами, документ не пересылать.",
  parameters: {
    type: "object",
    properties: {
      property: { type: "number", description: "Номер объекта в CRM" },
      query: { type: "string", description: "Название комплекса или застройщика" },
    },
  },
  async run(raw) {
    const parsed = args.safeParse(raw ?? {});
    if (!parsed.success || (!parsed.data.property && !parsed.data.query)) return { error: "Нужен номер объекта или название комплекса/застройщика" };
    const { enabled } = await loadRegistrySettings();
    if (!enabled) return { error: "Реестр строек выключен в Настройках" };

    if (parsed.data.property) {
      const p = await prisma.property.findFirst({
        where: { shortId: parsed.data.property, deletedAt: null },
        select: { id: true, lat: true, lng: true, address: true, title: true, description: true, condition: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
      });
      if (!p) return { error: "Объект не найден" };
      const r = await buildPropertyResponse(toMatchInput(p), true);
      if (r.notLoaded) return { error: "Реестр ещё не загружен, первый забор не был", href: "/settings" };
      const updatedCaption = registrySourceCaption(r.updatedAt);
      if (r.link) {
        const label = REGISTRY_COLOR_LABEL[r.link.project.color];
        return {
          property: parsed.data.property,
          status: label.title,
          hint: label.hint,
          warning: label.warning ?? null,
          project: safeField(r.link.project.title, 160),
          developer: safeField(r.link.developer.name, 120),
          rating: r.link.developer.rating.letter,
          ratingScore: r.link.developer.rating.score,
          ratingReasons: r.link.developer.rating.reasons.slice(0, 4).map((x) => safeField(x, 160)),
          blocks: r.link.project.blocks.slice(0, 10),
          floors: r.link.project.floors,
          updatedCaption,
          href: `/properties/${parsed.data.property}`,
        };
      }
      if (r.noPoint) return { property: parsed.data.property, linked: false, note: "У объекта нет точки на карте, реестр сопоставить нечем", updatedCaption };
      if (r.suggestions.length > 0) {
        return {
          property: parsed.data.property,
          linked: false,
          note: "Связь не подтверждена агентом, это только предложения: назови их как вероятные, не как факт",
          suggestions: r.suggestions.slice(0, 3).map((s) => ({
            project: safeField(s.project.title, 160),
            developer: safeField(s.developer.name, 120),
            status: REGISTRY_COLOR_LABEL[s.project.color].title,
            distanceM: s.distanceM != null ? Math.round(s.distanceM) : null,
          })),
          updatedCaption,
          href: `/properties/${parsed.data.property}`,
        };
      }
      return { property: parsed.data.property, linked: false, notFound: r.notFound, updatedCaption };
    }

    const q = parsed.data.query!;
    const projects = await prisma.constructionProject.findMany({
      where: { removedAt: null, OR: [{ title: { contains: q, mode: "insensitive" } }, { customer: { contains: q, mode: "insensitive" } }] },
      take: 5,
      orderBy: { lastSeenAt: "desc" },
    });
    const devs = await loadDeveloperDtos(projects.map((p) => p.developerId));
    return {
      query: q,
      found: projects.length,
      items: projects.map((p) => {
        const d = projectDto(p);
        const dev = devs.get(p.developerId);
        return {
          project: safeField(d.title, 160),
          developer: safeField(d.customer, 120),
          status: REGISTRY_COLOR_LABEL[d.color].title,
          warning: REGISTRY_COLOR_LABEL[d.color].warning ?? null,
          rating: dev?.rating.letter ?? null,
        };
      }),
      updatedCaption: registrySourceCaption((await prisma.constructionSyncRun.findFirst({ where: { ok: true }, orderBy: { startedAt: "desc" }, select: { finishedAt: true } }))?.finishedAt?.toISOString() ?? null),
    };
  },
};
