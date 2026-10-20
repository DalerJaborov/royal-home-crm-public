/**
 * РУЧНАЯ ПЕРЕДАЧА ОБЪЕКТА ДРУГОМУ АГЕНТУ И ЕЁ ПРИНЯТИЕ (владелец 24.09.2026:
 * «я не могу из админки поменять даже вручную агента, передать его другому,
 * будто нет механизма; и если я передаю другому агенту — там нет таймера,
 * а агент принимает объект, читает, почему был переведён, и информацию про
 * объект, чтобы он знал перед принятием, чей это объект»).
 *
 * Сам перенос — lib/propertyHandover.ts, тот же, что зовёт «Передача дел»:
 * два входа, одна логика, нечему разойтись.
 *
 * ⚠️ ПОРЯДОК РЕГИСТРАЦИИ: `GET /handover/pending` — статичный двухсегментный
 * путь; `GET /:id/...` с двумя сегментами в проекте нет, но роутер всё равно
 * подключается ДО listRouter — как /delete-requests и /summary (см. index.ts).
 */
import { Router } from "express";
import { propertyTransferSchema } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { can, requireAuth, requirePermission } from "../../auth/middleware.js";
import { logAudit } from "../../lib/audit.js";
import { acceptPropertyHandover } from "../../lib/propertyHandover.js";
import { transferPropertyWithSeller } from "../../lib/propertyTransferWithSeller.js";
import { propertyOwnerAgentId } from "../../lib/propertyOwner.js";
import { assignableAgentError, canReassignPropertyAgents } from "./shared.js";

export const propertyTransferRouter = Router();

/** Объекты, переданные мне и ещё не принятые, — для плашки в списке и колокольчика. */
propertyTransferRouter.get("/handover/pending", requireAuth, async (req, res) => {
  const me = req.agent!.id;
  const rows = await prisma.property.findMany({
    where: { deletedAt: null, handoverPendingSince: { not: null }, intakeAgentId: me },
    orderBy: { handoverPendingSince: "asc" },
    take: 100,
    select: {
      id: true,
      shortId: true,
      title: true,
      address: true,
      price: true,
      currency: true,
      status: true,
      handoverPendingSince: true,
      handoverReason: true,
      handoverFromAgent: { select: { id: true, fullName: true, avatarUrl: true } },
      photos: { orderBy: { order: "asc" }, take: 1, select: { url: true } },
    },
  });
  res.json(rows);
});

/**
 * Передать объект другому агенту. Право — то же, что на смену риелтора в PATCH
 * (canReassignPropertyAgents: properties.editForeign И clients.assign): передаёт
 * руководство, а не сам агент — иначе объект можно было бы «подарить» коллеге в
 * обход правил владения. С 02.10.2026 (владелец, «да, по советам») и маркетинг с
 * монтажёром не передают объект вовсе — даже без продавца: раньше (глубокая
 * проверка A4) им закрыли только передачу вместе с продавцом.
 */
propertyTransferRouter.post("/:id/transfer", requireAuth, requirePermission("properties.editForeign"), async (req, res) => {
  if (!canReassignPropertyAgents(req)) {
    return res.status(403).json({ error: "Передать объект другому агенту может руководитель" });
  }
  const parsed = propertyTransferSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const property = await prisma.property.findUnique({
    where: { id: req.params.id },
    select: { id: true, deletedAt: true, status: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
  });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден" });
  if (property.status === "SOLD" || property.status === "WITHDRAWN") {
    return res.status(409).json({ error: "Объект уже продан или снят с продажи — передавать нечего" });
  }
  const { toAgentId, reason } = parsed.data;
  if (propertyOwnerAgentId(property) === toAgentId) {
    return res.status(409).json({ error: "Объект уже у этого агента" });
  }
  // Уволенному, замороженному или не-агенту объект не передаётся — та же
  // проверка, что у PATCH intakeAgentId/assignedAgentId.
  const agentError = await assignableAgentError(toAgentId);
  if (agentError) return res.status(400).json({ error: agentError });

  // Продавец едет вместе с объектом (глубокая проверка A4) — право на это,
  // clients.assign, уже проверено в начале маршрута для любой передачи.

  const result = await transferPropertyWithSeller({
    propertyId: property.id,
    toAgentId,
    reason,
    actorId: req.agent!.id,
    source: "manual",
  });
  logAudit(req, "PROPERTY_TRANSFER", "Property", property.id, {
    fromAgentId: result.fromAgentId,
    toAgentId,
    reason,
  });
  res.json({ ok: true, fromAgentId: result.fromAgentId, toAgentId, sellerMoved: result.sellerMoved });
});

/** Новый хозяин принял объект: прочитал причину, отметка «передан вам» снимается. */
propertyTransferRouter.post("/:id/accept-handover", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({
    where: { id: req.params.id },
    select: { id: true, deletedAt: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
  });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден" });
  // Принять может хозяин; руководитель с полным доступом — тоже, за него
  // (например, когда агент принял устно, а кнопку не нажал).
  if (propertyOwnerAgentId(property) !== req.agent!.id && !can(req, "properties.editForeign")) {
    return res.status(403).json({ error: "Принять объект может только тот, кому он передан" });
  }
  const outcome = await acceptPropertyHandover(property.id, propertyOwnerAgentId(property) ?? req.agent!.id);
  if (outcome === "not_pending") return res.status(409).json({ error: "Объект уже принят" });
  if (outcome === "not_owner") return res.status(403).json({ error: "Принять объект может только тот, кому он передан" });
  logAudit(req, "PROPERTY_HANDOVER_ACCEPT", "Property", property.id, {});
  res.json({ ok: true });
});
