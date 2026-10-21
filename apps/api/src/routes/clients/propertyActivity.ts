import { Router } from "express";
import { z } from "zod";
import { clientPropertyActivityQuerySchema, type ClientActivityProperty, type ClientPropertyActivity } from "@royal-home/shared";
import { can, canAccessAssignedAgent, requireAuth, scopeToOwnAgent } from "../../auth/middleware.js";
import { prisma } from "../../db.js";
import { phoneSafeText } from "../../lib/clientPhone.js";
import type { Prisma } from "../../generated/prisma/client.js";

export const propertyActivityRouter = Router();
const pageSize = 20;
const propertySelect = {
  id: true, shortId: true, title: true, price: true, currency: true, status: true, deletedAt: true,
  photos: { take: 1, orderBy: { order: "asc" }, select: { thumbUrl: true } },
} satisfies Prisma.PropertySelect;
function propertySelection(viewerId: string) {
  return { ...propertySelect, deleteRequests: { where: { requestedById: viewerId, status: "PENDING" as const }, take: 1, select: { id: true } } } satisfies Prisma.PropertySelect;
}
type ActivityProperty = Prisma.PropertyGetPayload<{ select: ReturnType<typeof propertySelection> }>;

function presentProperty(property: ActivityProperty | null, seesPhone: boolean, canDelete: boolean): ClientActivityProperty | null {
  if (!property || property.deletedAt || (!canDelete && property.deleteRequests.length > 0)) return null;
  return { id: property.id, shortId: property.shortId, title: phoneSafeText(property.title, seesPhone),
    price: String(property.price), currency: property.currency, status: property.status,
    thumbUrl: property.photos[0]?.thumbUrl ?? null };
}

propertyActivityRouter.get("/:id/property-activity", requireAuth, async (req, res) => {
  const id = z.guid().safeParse(req.params.id);
  const query = clientPropertyActivityQuerySchema.safeParse(req.query);
  if (!id.success || !query.success) return res.status(400).json({ error: "Неверные параметры списка объектов" });
  const client = await prisma.client.findUnique({ where: { id: id.data },
    select: { assignedAgentId: true, lastAgentId: true, acceptedAt: true, deletedAt: true } });
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  const ownAgentId = scopeToOwnAgent(req);
  if (!canAccessAssignedAgent(req, client.assignedAgentId) && client.lastAgentId !== ownAgentId) {
    const hasDeal = ownAgentId && await prisma.deal.count({ where: { clientId: id.data, agentId: ownAgentId } });
    if (!hasDeal) return res.status(403).json({ error: "Недостаточно прав" });
  }
  if (ownAgentId === client.assignedAgentId && !client.acceptedAt) return res.status(403).json({ error: "Сначала примите лид" });
  const { section, page } = query.data;
  const skip = (page - 1) * pageSize;
  const seesPhone = can(req, "clients.viewPhone");
  const canDelete = can(req, "properties.delete");
  const selection = propertySelection(req.agent!.id);
  let items: ClientPropertyActivity["items"];
  let total: number;
  if (section === "sent") {
    const where = { clientId: id.data };
    const [rows, count] = await Promise.all([
      prisma.propertyExposure.findMany({ where, orderBy: [{ sentAt: "desc" }, { id: "desc" }], skip, take: pageSize,
        select: { id: true, sentAt: true, shortId: true, channel: true, kind: true, property: { select: selection } } }),
      prisma.propertyExposure.count({ where }),
    ]);
    total = count;
    items = rows.map(row => ({ id: row.id, at: row.sentAt.toISOString(), shortId: row.shortId,
      property: presentProperty(row.property, seesPhone, canDelete), channel: can(req, "clients.viewOrigin") ? row.channel : null,
      kind: row.kind === "PHOTO" ? "PHOTO" : "LINK", state: "sent", scheduledAt: null, canManage: false }));
  } else {
    const where = { clientId: id.data, type: "SHOWING" as const };
    const [rows, count] = await Promise.all([
      prisma.interaction.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip, take: pageSize,
        select: { id: true, agentId: true, subjectAgentId: true, createdAt: true, nextActionDate: true, completedAt: true, declinedAt: true,
          property: { select: selection } } }),
      prisma.interaction.count({ where }),
    ]);
    total = count;
    items = rows.map(row => ({ id: row.id, at: row.createdAt.toISOString(), shortId: row.property?.shortId ?? null,
      property: presentProperty(row.property, seesPhone, canDelete), channel: null, kind: "SHOWING", scheduledAt: row.nextActionDate?.toISOString() ?? null,
      canManage: req.agent!.role !== "SHAREHOLDER" && (can(req, "clients.assign") || (row.subjectAgentId ?? row.agentId) === req.agent!.id),
      state: row.declinedAt ? "cancelled" : row.completedAt ? "completed" : row.nextActionDate && row.nextActionDate > new Date() ? "scheduled" : "unrecorded" }));
  }
  res.json({ items, total, page, pageSize } satisfies ClientPropertyActivity);
});
