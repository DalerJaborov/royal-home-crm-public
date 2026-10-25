import { Router } from "express";
import { z } from "zod";
import { summarizeComparableListings } from "@royal-home/shared";
import { requireAuth } from "../../auth/middleware.js";
import { prisma } from "../../db.js";
import { canManageProperty } from "./shared.js";

export const propertyComparablesRouter = Router();
propertyComparablesRouter.get("/:id/comparables", requireAuth, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success || !z.object({}).strict().safeParse(req.query).success) return res.status(400).json({ error: "Некорректный запрос" });
  const subject = await prisma.property.findUnique({ where: { id: id.data } });
  if (!subject || subject.deletedAt) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, subject)) return res.status(403).json({ error: "Нет доступа к сравнению объекта" });
  const area = Number(subject.areaSqm);
  if (!subject.districtId || !Number.isFinite(area) || area <= 0) return res.json({ ...summarizeComparableListings({ price: Number(subject.price), currency: subject.currency, areaSqm: area }, [], 0), criteria: null, unavailableReason: "Для сравнения нужны район и площадь объекта." });
  const where = { id: { not: subject.id }, deletedAt: null, offSite: false, status: "AVAILABLE" as const, type: subject.type, districtId: subject.districtId,
    rooms: subject.rooms, currency: subject.currency, areaSqm: { gte: area * .8, lte: area * 1.2 }, price: { gt: 0 } };
  const [total, rows] = await Promise.all([prisma.property.count({ where }), prisma.property.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 100,
    select: { id: true, shortId: true, price: true, currency: true, areaSqm: true, updatedAt: true } })]);
  res.json({ ...summarizeComparableListings({ price: Number(subject.price), currency: subject.currency, areaSqm: area }, rows.map(p => ({ ...p, price: Number(p.price), areaSqm: Number(p.areaSqm), updatedAt: p.updatedAt.toISOString() })), total),
    criteria: { type: subject.type, districtId: subject.districtId, rooms: subject.rooms, areaMin: area * .8, areaMax: area * 1.2, status: "AVAILABLE", radiusApplied: false },
    unavailableReason: total ? null : "В CRM пока нет предложений с этими параметрами." });
});
