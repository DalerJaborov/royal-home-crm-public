import { Router } from "express";
import { can, requireAuth } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { cardWhereFromParam } from "../lib/cardIdParam.js";
import { emptyDynamics, findDynamics } from "../lib/market/dynamics.js";
import { emptyResult, findSimilar, verdictFor, type Repair } from "../lib/market/similarComps.js";
import { loadMoneyContext, toTjs } from "../lib/money.js";
import { findSegments } from "../lib/market/segments.js";
import { marketSegmentsQuerySchema } from "@royal-home/shared";

export const marketRouter = Router();

/**
 * Состояние объекта → ремонт для подбора. NEW_BUILDING здесь НЕТ: «новостройка» в РТ —
 * признак дома (владелец 02.11.2026), а не ремонт; ремонт в этом случае неизвестен (null),
 * и подбор не режет по нему.
 */
const CONDITION_TO_REPAIR: Record<string, Repair> = {
  NEEDS_REPAIR: "SHELL",
  GOOD: "PARTIAL",
  EXCELLENT: "RENOVATED",
};

/**
 * GET /api/v1/market/property/:id — блок «Рынок» в карточке объекта: стоит ли цена
 * владельца своих денег. Объект и его цена читаются на сервере (одна дверь:
 * ремонт/признак дома/курс считаются здесь, а не на каждом экране); права те же,
 * что у самой карточки (GET /properties/:id: удалённый — только с archive.view).
 */
marketRouter.get("/property/:id", requireAuth, async (req, res) => {
  const where = cardWhereFromParam(String(req.params.id));
  if (!where) return res.status(404).json({ error: "Объект не найден" });
  const p = await prisma.property.findUnique({
    where,
    select: {
      id: true, type: true, rooms: true, areaSqm: true, floor: true, totalFloors: true, price: true, currency: true,
      condition: true, marketType: true, deletedAt: true, district: { select: { name: true } },
    },
  });
  if (!p || (p.deletedAt && !can(req, "archive.view"))) return res.status(404).json({ error: "Объект не найден" });

  const money = await loadMoneyContext();
  const askingPriceTjs = p.price != null ? Math.round(toTjs(p.price, p.currency, money)) : null;
  const subjectBase = {
    districtName: p.district?.name ?? null,
    rooms: p.rooms,
    areaSqm: Number(p.areaSqm),
    floor: p.floor,
    totalFloors: p.totalFloors,
    repair: CONDITION_TO_REPAIR[p.condition] ?? null,
    // «Новостройка» в РТ — признак дома (владелец 02.11.2026). Тип рынка не задан, а состояние
    // «новостройка» — значит новостройка; иначе не задано — не фильтруем.
    isNewBuilding: p.marketType != null ? p.marketType !== "SECONDARY" : p.condition === "NEW_BUILDING" ? true : null,
    askingPriceTjs,
  };

  if ((p.type !== "APARTMENT" && p.type !== "HOUSE") || !(subjectBase.areaSqm > 0)) {
    return res.json({
      subject: { ...subjectBase, propertyType: p.type },
      ...emptyResult("для этого типа объекта рыночная оценка не считается"),
      status: "unsupported",
      comparison: null,
    });
  }

  const result = await findSimilar({ ...subjectBase, propertyType: p.type }, { propertyId: p.id });
  res.json({
    subject: { ...subjectBase, propertyType: p.type },
    ...result,
    comparison: result.status === "ok" ? verdictFor(askingPriceTjs, result.estimatedPriceTjs) : null,
  });
});

/**
 * GET /api/v1/market/property/:id/dynamics — динамика рынка по ушедшим объявлениям
 * похожих (район, комнаты, площадь ±25%): как быстро уходят, по какой цене, снижали
 * ли цену, кто продаёт. «Ушло с площадки» не значит «продано» — формулировки на фронте.
 * Права те же, что у /property/:id.
 */
marketRouter.get("/property/:id/dynamics", requireAuth, async (req, res) => {
  const where = cardWhereFromParam(String(req.params.id));
  if (!where) return res.status(404).json({ error: "Объект не найден" });
  const p = await prisma.property.findUnique({
    where,
    select: { id: true, type: true, rooms: true, areaSqm: true, deletedAt: true, district: { select: { name: true } } },
  });
  if (!p || (p.deletedAt && !can(req, "archive.view"))) return res.status(404).json({ error: "Объект не найден" });

  const areaSqm = Number(p.areaSqm);
  if ((p.type !== "APARTMENT" && p.type !== "HOUSE") || !(areaSqm > 0)) {
    return res.json(emptyDynamics("для этого типа объекта динамика рынка не считается", "unsupported"));
  }
  res.json(await findDynamics({ propertyId: p.id, propertyType: p.type, districtName: p.district?.name ?? null, rooms: p.rooms, areaSqm }));
});

/**
 * GET /api/v1/market/segments — средние цены по сегментам (район × комнаты × ремонт) по активным
 * объявлениям всех площадок каталога. Доступ тот же, что у блока «Рынок» в карточке объекта:
 * любой вошедший сотрудник (данные публичные, из чужих объявлений, личных данных в ответе нет).
 * Сегмент меньше порога MIN_SAMPLE приходит без чисел (enough=false).
 */
marketRouter.get("/segments", requireAuth, async (req, res) => {
  const parsed = marketSegmentsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
  res.json(await findSegments(parsed.data));
});
