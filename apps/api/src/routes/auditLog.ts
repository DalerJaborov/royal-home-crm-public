import { investigationViewerRole } from "../auth/investigations.js";
import { visibleAuditWhere, publicAuditMeta, privateLessonAuditIds } from "../lib/investigationAudit.js";
import { Router, type Request } from "express";
import { pageQuerySchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, requireAuth } from "../auth/middleware.js";
import { stripOwnerContact } from "../lib/ownerContact.js";
import { hideOwnerContactInChanges } from "../lib/propertyChanges.js";
import { maskPhonesDeep } from "../lib/clientPhone.js";

export const auditLogRouter = Router();

auditLogRouter.use(requireAuth);

/** История чувствительных действий (удаления, публикации и т.п.) — см. lib/audit.ts.
 *  entityId сужает список до одного предмета — «полная история объекта»
 *  (спецификация владельца) читается тем же маршрутом, просто с обоими фильтрами.
 *
 * ДОСТУП. Общая лента (Архив) требует `auditLog.view` — как и раньше. Но у
 * агента нет этого права, а спецификация требует, чтобы он видел историю
 * СВОЕГО ЖЕ объекта (карточка PropertyHistoryCard) — кто менял статус, кто
 * одобрил/вернул фото и видео. Поэтому узкая выборка entityType=Property с
 * конкретным entityId разрешена ещё и текущему ответственному за объект
 * (риелтор/интейкер/создатель — та же тройка, что и canManageProperty в
 * routes/properties.ts). Чужие объекты агенту без auditLog.view по-прежнему
 * недоступны — сюда попадает не «весь Архив», а один explicit id. */
auditLogRouter.get("/", async (req, res) => {
  const parsedPage = pageQuerySchema.safeParse(req.query);
  if (!parsedPage.success) {
    return res.status(400).json({ error: "Неверный номер страницы", details: parsedPage.error.flatten() });
  }
  const { page } = parsedPage.data;
  const pageSize = 40;
  const entityType = typeof req.query.entityType === "string" ? req.query.entityType : undefined;
  const entityId = typeof req.query.entityId === "string" ? req.query.entityId : undefined;

  if (!can(req, "auditLog.view")) {
    if (entityType !== "Property" || !entityId) {
      return res.status(403).json({ error: "Недостаточно прав" });
    }
    const property = await prisma.property.findUnique({
      where: { id: entityId },
      select: { assignedAgentId: true, intakeAgentId: true, createdById: true },
    });
    if (!property) return res.status(404).json({ error: "Объект не найден" });
    /**
     * Правило то же, что и у canManageProperty в routes/properties.ts: объект
     * ведёт либо ответственный за него, либо тот, кому открыты ВСЕ объекты.
     * Раньше здесь была только тройка ответственных, и маркетинг с монтажёром —
     * те самые люди, которые двигают карточку по конвейеру, — получали 403 на
     * каждое открытие карточки: история объекта у них молча не рисовалась, а в
     * журнал ошибок капал мусор. Выборка по-прежнему узкая: один явный entityId,
     * а не общая лента Архива (она так и требует auditLog.view).
     */
    const isResponsible = [property.assignedAgentId, property.intakeAgentId, property.createdById].includes(
      req.agent!.id
    );
    // "Тот, кому открыты ВСЕ объекты" — это viewOwners ИЛИ editForeign: монтажёру
    // (слой 3, 08.09.2026 — editForeign без viewOwners, roles-check.md §2.2) нужна
    // история чужого объекта, который он ведёт по конвейеру, ровно как маркетингу.
    if (!isResponsible && !can(req, "properties.viewOwners") && !can(req, "properties.editForeign")) {
      return res.status(403).json({ error: "Недостаточно прав" });
    }
  }

  const privateLessonIds = await privateLessonAuditIds(investigationViewerRole(req));
  const where = { ...visibleAuditWhere(investigationViewerRole(req), privateLessonIds), ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) };
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);
  res.json({ items: hideClientPhones(req, await hideOwnerContacts(req, items.map((row) => publicAuditMeta(row, investigationViewerRole(req))))), total, page, pageSize });
});

/**
 * НОМЕР КЛИЕНТА НЕ УТЕКАЕТ ЧЕРЕЗ ЖУРНАЛ (аудит Codex 04.10.2026, ACCESS-01).
 * Записи про карточку клиента (TRASH, RESTORE, PERMANENT_DELETE, CLIENT_MERGE и
 * др.) хранят в meta настоящие phone/fullName клиента («Входящий +992…» тоже), а
 * право auditLog.view не даёт права на номер: clients.viewPhone решает ОТДЕЛЬНО.
 * Правило то же, что везде, — maskPhonesDeep из lib/clientPhone.ts, а не копия.
 * Прячем при отдаче, а не при записи: директору журнал нужен с настоящими
 * значениями. Записи про сотрудников не трогаем: их номер — логин, не клиент.
 */
function hideClientPhones<T extends { entityType: string; meta: unknown }>(req: Request, items: T[]): T[] {
  if (can(req, "clients.viewPhone")) return items;
  return items.map((item) =>
    item.entityType === "Client" && item.meta != null ? { ...item, meta: maskPhonesDeep(item.meta, false) } : item
  );
}

/**
 * НОМЕР СОБСТВЕННИКА НЕ УТЕКАЕТ ЧЕРЕЗ ИСТОРИЮ (ночная проверка 24.09.2026).
 * Запись PROPERTY_FIELDS_CHANGED хранит «Контакт владельца: было → стало» с
 * настоящими номерами (lib/propertyChanges.ts), а этот маршрут отдавал её как
 * есть каждому, кому открыта история объекта, — монтажёру с
 * properties.editForeign без properties.viewOwners в том числе. На карточке у
 * него номер «скрыто», а строкой ниже, в истории, — открытым текстом. Кто видит
 * номер — решает ТО ЖЕ правило, что и на карточке (stripOwnerContact из
 * lib/ownerContact.ts: право viewOwners или свой объект), второй копии правила
 * здесь нет. Прячем при отдаче, а не при записи: старые записи номера уже
 * содержат, а руководителю история нужна с настоящими значениями.
 */
async function hideOwnerContacts<T extends { entityType: string; entityId: string | null; meta: unknown }>(
  req: Request,
  items: T[]
): Promise<T[]> {
  if (can(req, "properties.viewOwners")) return items;
  const propertyIds = [...new Set(items.filter((i) => i.entityType === "Property" && i.entityId).map((i) => i.entityId!))];
  if (propertyIds.length === 0) return items;
  const properties = new Map(
    (
      await prisma.property.findMany({
        where: { id: { in: propertyIds } },
        select: { id: true, assignedAgentId: true, intakeAgentId: true, createdById: true },
      })
    ).map((p) => [p.id, p])
  );
  return items.map((item) => {
    if (item.entityType !== "Property" || !item.entityId) return item;
    // Объекта уже нет в базе — ответственных не узнать, номер закрыт.
    const property = properties.get(item.entityId) ?? {};
    if (!stripOwnerContact(property, req.agent!.id, false).ownerContactHidden) return item;
    return { ...item, meta: hideOwnerContactInChanges(item.meta) };
  });
}
