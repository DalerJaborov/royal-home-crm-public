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
import { prisma } from "../../db.js";
import { can, requireAuth, requirePermission } from "../../auth/middleware.js";
import { logAudit } from "../../lib/audit.js";
import { acceptPropertyHandover } from "../../lib/propertyHandover.js";
import { transferPropertyByManager } from "../../lib/propertyManualTransfer.js";
import { propertyOwnerAgentId } from "../../lib/propertyOwner.js";

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
  // Тело — lib/propertyManualTransfer.ts: тот же путь зовёт помощница (10.11.2026).
  const outcome = await transferPropertyByManager(req.agent!, req.params.id, req.body);
  res.status(outcome.status).json(outcome.body);
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
