/**
 * Ссылка «Отчёт владельцу» в карточке объекта (03.10.2026, lib/ownerReport/):
 *   GET    /:id/owner-report-link — действующая ссылка или { link: null };
 *   POST   /:id/owner-report-link — создать (идемпотентно: действующая возвращается как есть);
 *   DELETE /:id/owner-report-link — отозвать; следующий POST заведёт новую.
 *
 * Права — те же, что у приватных ссылок на объект (shareLinks.ts): canManageProperty.
 * НИЧЕГО не отправляется владельцу само: сотрудник копирует ссылку и передаёт её сам.
 */
import { Router } from "express";
import { requireAuth } from "../../auth/middleware.js";
import { prisma } from "../../db.js";
import {
  findActiveOwnerReportLink,
  getOrCreateOwnerReportLink,
  presentOwnerReportLink,
  revokeOwnerReportLink,
} from "../../lib/ownerReport/link.js";
import { canManageProperty } from "./shared.js";

export const ownerReportLinkRouter = Router();

async function manageableProperty(req: Parameters<typeof canManageProperty>[0], id: string) {
  const property = await prisma.property.findUnique({
    where: { id },
    select: { id: true, deletedAt: true, assignedAgentId: true, intakeAgentId: true, createdById: true },
  });
  if (!property || property.deletedAt) return { ok: false as const, status: 404, error: "Объект не найден" };
  if (!canManageProperty(req, property)) return { ok: false as const, status: 403, error: "Недостаточно прав" };
  return { ok: true as const, id: property.id };
}

ownerReportLinkRouter.get("/:id/owner-report-link", requireAuth, async (req, res) => {
  const found = await manageableProperty(req, String(req.params.id));
  if (!found.ok) return res.status(found.status).json({ error: found.error });
  const link = await findActiveOwnerReportLink(found.id);
  res.json({ link: link ? presentOwnerReportLink(link) : null });
});

ownerReportLinkRouter.post("/:id/owner-report-link", requireAuth, async (req, res) => {
  const found = await manageableProperty(req, String(req.params.id));
  if (!found.ok) return res.status(found.status).json({ error: found.error });
  const { link, created } = await getOrCreateOwnerReportLink(found.id, req.agent!.id);
  res.status(created ? 201 : 200).json({ link: presentOwnerReportLink(link) });
});

ownerReportLinkRouter.delete("/:id/owner-report-link", requireAuth, async (req, res) => {
  const found = await manageableProperty(req, String(req.params.id));
  if (!found.ok) return res.status(found.status).json({ error: found.error });
  await revokeOwnerReportLink(found.id);
  res.status(204).send();
});
