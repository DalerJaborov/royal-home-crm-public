import { Router } from "express";
import { z } from "zod";
import { isReadOnlyRole, showingQuestionAnswerSchema } from "@royal-home/shared";
import { can, requireAuth } from "../auth/middleware.js";
import { answerShowingQuestion, listShowingQuestions } from "../lib/showingQuestions.js";

/**
 * Вопросы агенту о показе в CRM (владелец 22.11.2026) — страховка к Шабнам: тот же
 * вопрос карточкой на Главной и в карточке клиента. Ответ — та же дверь, что у кнопок
 * Шабнам (lib/showingQuestions.ts): ответил здесь — в Шабнам кнопки снимаются.
 *
 * Список — только свои вопросы (агент показа). Ответить за чужой может руководство
 * (clients.assign) — тем же правилом, что перенос и отмена показа в календаре.
 */
export const showingQuestionsRouter = Router();

const listQuery = z.object({ clientId: z.string().trim().min(1).max(64).optional() }).strict();

showingQuestionsRouter.get("/", requireAuth, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры запроса", details: parsed.error.flatten() });
  const items = await listShowingQuestions(req.agent!.id, { clientId: parsed.data.clientId });
  res.json({ items });
});

showingQuestionsRouter.post("/:id/answer", requireAuth, async (req, res) => {
  if (isReadOnlyRole(req.agent!.role)) return res.status(403).json({ error: "Недостаточно прав" });
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "Неверный идентификатор вопроса" });
  const parsed = showingQuestionAnswerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверный ответ", details: parsed.error.flatten() });
  const result = await answerShowingQuestion({
    questionId: req.params.id,
    actorId: req.agent!.id,
    canActForOthers: can(req, "clients.assign"),
    via: "crm",
    answer: parsed.data,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, message: result.message });
});
