/**
 * ОТВЕТ НА ПРЕДЛОЖЕНИЕ ОБЪЕКТА КОЛЛЕГОЙ ИЗ CRM (10.11.2026). Агент-владелец
 * клиента отвечает «Отправлю клиенту / Не подходит» и из Telegram, и из ленты
 * уведомлений CRM — одной функцией `answerPropertyClientOffer`
 * (lib/propertyClientOffers.ts): только адресат, только пока ведёт клиента,
 * только один раз.
 */
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { answerPropertyClientOffer } from "../lib/propertyClientOffers.js";

export const propertyOffersRouter = Router();

const answerSchema = z.object({ answer: z.enum(["WILL_SEND", "NOT_SUITABLE"]) });

propertyOffersRouter.post("/:id/answer", requireAuth, async (req, res) => {
  const id = z.guid().safeParse(req.params.id);
  const body = answerSchema.safeParse(req.body);
  if (!id.success || !body.success) return res.status(400).json({ error: "Неверные данные" });
  const ok = await answerPropertyClientOffer(req.agent!.id, id.data, body.data.answer);
  if (!ok) {
    // Текущий статус — чтобы лента показала ответ плашкой, а не ошибкой.
    const current = await prisma.propertyClientOffer.findFirst({ where: { id: id.data, toAgentId: req.agent!.id }, select: { status: true } });
    return res.status(409).json({ error: "На это предложение уже ответили или оно больше не ваше", code: "OFFER_CLOSED", status: current?.status ?? null });
  }
  res.json({ ok: true, status: body.data.answer });
});
