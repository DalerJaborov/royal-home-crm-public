import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { clientBuyerRequirementsSchema, confirmedClientIntents, confirmClientIntentSchema } from "@royal-home/shared";
import { can, canAccessAssignedAgent, requireAuth, scopeToOwnAgent } from "../../auth/middleware.js";
import { prisma } from "../../db.js";
import { logAudit } from "../../lib/audit.js";
import { logTimeline } from "../../lib/timeline.js";
import { publishClientUpdated } from "../../lib/livePublish.js";
import { foreignWriteDenied, presentClient, restoreMaskedNotes } from "./shared.js";

export const intentsRouter = Router();

async function editableClient(req: Request, res: Response) {
  const id = z.guid().safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: "Неверный идентификатор клиента" }); return null; }
  const client = await prisma.client.findUnique({ where: { id: id.data } });
  if (!client || client.deletedAt) { res.status(404).json({ error: "Клиент не найден" }); return null; }
  const ownAgentId = scopeToOwnAgent(req);
  if (!canAccessAssignedAgent(req, client.assignedAgentId) || foreignWriteDenied(req, client, ownAgentId) || req.agent!.role === "SHAREHOLDER") {
    res.status(403).json({ error: "Карточку изменяет ответственный агент или руководитель" }); return null;
  }
  if (ownAgentId && !client.acceptedAt) { res.status(403).json({ error: "Сначала примите лид" }); return null; }
  return client;
}

intentsRouter.post("/:id/intents", requireAuth, async (req, res) => {
  const input = confirmClientIntentSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Укажите актуальные роли клиента" });
  const client = await editableClient(req, res);
  if (!client) return;
  if (client.kind === "OTHER") return res.status(409).json({ error: "Сначала выберите тип карточки: продавец или покупатель" });
  const dualIntent = input.data.dualIntent;
  const now = new Date();
  const updated = await prisma.$transaction(async tx => {
    // Reassignment or kind changes during confirmation must not authorize a stale form.
    const changed = await tx.client.updateMany({
      where: { id: client.id, assignedAgentId: client.assignedAgentId, kind: client.kind, acceptedAt: client.acceptedAt, deletedAt: null },
      data: { dualIntent, dualIntentConfirmedAt: dualIntent ? now : null, dualIntentConfirmedById: dualIntent ? req.agent!.id : null },
    });
    if (!changed.count) return null;
    await logTimeline({ clientId: client.id, actor: { kind: "agent", agentId: req.agent!.id }, type: "SYSTEM",
      notes: dualIntent ? "Подтверждено: клиент одновременно продаёт и покупает недвижимость" : `Подтверждена одна актуальная роль: ${client.kind === "SELLER" ? "продавец" : "покупатель"}`, tx });
    return tx.client.findUniqueOrThrow({ where: { id: client.id } });
  });
  if (!updated) return res.status(409).json({ error: "Карточка изменилась. Обновите её и повторите подтверждение" });
  logAudit(req, "UPDATE", "Client", client.id, { dualIntent, confirmation: "staff" });
  publishClientUpdated({ clientId: client.id, agentIds: [client.assignedAgentId], actorId: req.agent!.id });
  res.json(presentClient(updated, can(req, "clients.viewPhone"), can(req, "clients.viewOrigin"), req.agent?.role));
});

intentsRouter.post("/:id/buyer-requirements", requireAuth, async (req, res) => {
  const input = clientBuyerRequirementsSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Проверьте пожелания покупателя", details: input.error.flatten() });
  const client = await editableClient(req, res);
  if (!client) return;
  if (!confirmedClientIntents(client).buys) return res.status(409).json({ error: "Сначала подтвердите, что клиент покупает недвижимость" });
  const data = input.data;
  if (typeof data.requirementsNotes === "string" && !can(req, "clients.viewPhone")) {
    const restored = restoreMaskedNotes(data.requirementsNotes, client.requirementsNotes);
    if (restored === null) return res.status(400).json({ error: "Нельзя изменять строку со скрытым контактом. Остальные пожелания можно уточнить" });
    data.requirementsNotes = restored;
  }
  const stale = client.requirementsFieldsKind != null && client.requirementsFieldsKind !== "BUYER";
  const updated = await prisma.$transaction(async tx => {
    const changed = await tx.client.updateMany({ where: { id: client.id, assignedAgentId: client.assignedAgentId, kind: client.kind, acceptedAt: client.acceptedAt, deletedAt: null,
      dualIntent: client.dualIntent, dualIntentConfirmedAt: client.dualIntentConfirmedAt }, data: {
      ...(stale ? { budgetMin: null, budgetMax: null, desiredType: null, desiredDistrictId: null, desiredRooms: null,
        desiredAreaMin: null, desiredFloorMin: null, desiredFloorMax: null, desiredTotalFloors: null, requirementsNotes: null } : {}),
      ...data, requirementsFieldsKind: "BUYER",
    } });
    if (!changed.count) return null;
    const previousPlaces = stale ? await tx.clientDesiredPlace.findMany({ where: { clientId: client.id }, select: { lat: true, lng: true, radiusM: true, label: true } }) : [];
    if (stale) await tx.clientDesiredPlace.deleteMany({ where: { clientId: client.id } });
    const previous = stale ? JSON.stringify({ budgetMin: client.budgetMin, budgetMax: client.budgetMax, currency: client.currency,
      desiredType: client.desiredType, desiredDistrictId: client.desiredDistrictId, desiredRooms: client.desiredRooms,
      desiredAreaMin: client.desiredAreaMin, desiredFloorMin: client.desiredFloorMin, desiredFloorMax: client.desiredFloorMax,
      desiredTotalFloors: client.desiredTotalFloors, requirementsNotes: client.requirementsNotes, desiredPlaces: previousPlaces }) : null;
    await logTimeline({ clientId: client.id, actor: { kind: "agent", agentId: req.agent!.id }, type: "SYSTEM",
      notes: `Уточнены пожелания покупателя${previous ? `. Прежние параметры другой роли сохранены в истории: ${previous}` : ""}`, tx });
    return tx.client.findUniqueOrThrow({ where: { id: client.id } });
  });
  if (!updated) return res.status(409).json({ error: "Роли карточки изменились. Обновите карточку и повторите" });
  logAudit(req, "UPDATE", "Client", client.id, { requirementsFieldsKind: "BUYER" });
  publishClientUpdated({ clientId: client.id, agentIds: [client.assignedAgentId], actorId: req.agent!.id });
  res.json(presentClient(updated, can(req, "clients.viewPhone"), can(req, "clients.viewOrigin"), req.agent?.role));
});
