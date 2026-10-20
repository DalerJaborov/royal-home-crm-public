/**
 * «Написать первым в WhatsApp» из карточки клиента (24.09.2026).
 *
 * GET  /:id/whatsapp-first — можно ли сейчас, и если нет — почему, словами.
 * POST /:id/whatsapp-first { propertyShortId? } — отправить одобренный Meta текст.
 *
 * Вся логика — lib/whatsappFirstContact.ts. Доступ — тот же круг, что у
 * «Написать клиенту» (communications.ts, POST /:id/message): свой клиент или
 * руководитель, карточка не в Корзине, лид принят.
 */
import { Router, type Request, type Response } from "express";
import { waFirstContactSendSchema } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { canAccessAssignedAgent, requireAuth, scopeToOwnAgent } from "../../auth/middleware.js";
import { foreignWriteDenied } from "./shared.js";
import { FirstContactError, firstContactStatus, sendFirstContact } from "../../lib/whatsappFirstContact.js";

export const whatsappFirstContactRouter = Router();

const clientSelect = {
  id: true,
  fullName: true,
  phone: true,
  whatsappPhone: true,
  deletedAt: true,
  assignedAgentId: true,
  acceptedAt: true,
} as const;

/** Та же лестница отказов, что у сообщения из карточки. null — можно писать. */
async function loadWritableClient(req: Request, res: Response, clientId: string) {
  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: clientSelect });
  if (!client) {
    res.status(404).json({ error: "Клиент не найден" });
    return null;
  }
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    res.status(403).json({ error: "Недостаточно прав" });
    return null;
  }
  const denied = foreignWriteDenied(req, client, ownAgentId);
  if (denied) {
    res.status(403).json({ error: denied });
    return null;
  }
  if (client.deletedAt) {
    res.status(409).json({ error: "Карточка в Корзине — сначала восстановите её" });
    return null;
  }
  if (ownAgentId && !client.acceptedAt) {
    res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
    return null;
  }
  return client;
}

whatsappFirstContactRouter.get("/:id/whatsapp-first", requireAuth, async (req, res) => {
  const client = await loadWritableClient(req, res, req.params.id);
  if (!client) return;
  try {
    res.json(await firstContactStatus(client, req.agent!.id));
  } catch (err) {
    console.error("[whatsapp] состояние первого сообщения:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Не удалось проверить WhatsApp" });
  }
});

whatsappFirstContactRouter.post("/:id/whatsapp-first", requireAuth, async (req, res) => {
  const parsed = waFirstContactSendSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Номер объекта — только цифры" });
  const client = await loadWritableClient(req, res, req.params.id);
  if (!client) return;
  try {
    res.json(await sendFirstContact({ client, agentId: req.agent!.id, propertyShortId: parsed.data.propertyShortId }));
  } catch (err) {
    if (err instanceof FirstContactError) return res.status(err.status).json({ error: err.message });
    console.error("[whatsapp] первое сообщение:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Не удалось отправить сообщение" });
  }
});
