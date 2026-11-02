import { Router } from "express";
import { z } from "zod";
import { can, requireAuth } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { cardWhereFromParam } from "../lib/cardIdParam.js";
import { comparePrice, estimateFromComps } from "../lib/market/comps.js";
import { emptyResult, findSimilar, verdictFor, type Repair } from "../lib/market/similarComps.js";
import { loadMoneyContext, toTjs } from "../lib/money.js";

export const marketRouter = Router();

/**
 * GET /api/v1/market/estimate — рыночная оценка по аналогам для карточки
 * клиента ("что он может себе позволить") и карточки объекта ("дорого/в
 * рынке/дёшево"). Внутренние данные компании — доступ только авторизованным
 * (requireAuth), без отдельного права: это справочная подсказка, а не раздел
 * с чувствительными персональными данными, доступ к которому режут по правам.
 *
 * Считает estimateFromComps (apps/api/src/lib/market/comps.ts) — эта функция
 * НЕ переписывается здесь, роут — только тонкая обвязка над ней с валидацией
 * query-параметров и обрезкой listings до 5 штук для фронта.
 */
const querySchema = z.object({
  districtName: z.string().trim().min(1).optional(),
  rooms: z.coerce.number().int().positive().optional(),
  areaSqm: z.coerce.number().positive().optional(),
  /** Цена объекта/бюджета, УЖЕ приведённая к сомони на фронте (lib/format.ts toTjs,
   *  курс из useUsdToTjsRate) — сравнивать с медианой можно только в одной валюте,
   *  а курс лежит в Настройках, которые фронт уже читает для отображения цены. */
  priceTjs: z.coerce.number().positive().optional(),
});

marketRouter.get("/estimate", requireAuth, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
  }
  const { districtName, rooms, areaSqm, priceTjs } = parsed.data;

  const comps = await estimateFromComps({
    districtName: districtName ?? null,
    rooms: rooms ?? null,
    areaSqm: areaSqm ?? null,
  });

  res.json({
    ...comps,
    // Фронту для блока "источники" хватает первых пяти — уже отсортированы
    // estimateFromComps по возрастанию цены за квадрат.
    listings: comps.listings.slice(0, 5),
    comparison: priceTjs !== undefined ? comparePrice(priceTjs, comps) : null,
  });
});

/**
 * GET /api/v1/market/property/:id — блок «Рынок» в карточке объекта: стоит ли цена
 * владельца своих денег. Объект и его цена читаются на сервере (одна дверь:
 * ремонт/признак дома/курс считаются здесь, а не на каждом экране); права те же,
 * что у самой карточки (GET /properties/:id: удалённый — только с archive.view).
 */
const CONDITION_TO_REPAIR: Record<string, Repair> = {
  NEEDS_REPAIR: "SHELL",
  NEW_BUILDING: "WHITE",
  GOOD: "PARTIAL",
  EXCELLENT: "RENOVATED",
};

marketRouter.get("/property/:id", requireAuth, async (req, res) => {
  const where = cardWhereFromParam(String(req.params.id));
  if (!where) return res.status(404).json({ error: "Объект не найден" });
  const p = await prisma.property.findUnique({
    where,
    select: {
      type: true, rooms: true, areaSqm: true, floor: true, totalFloors: true, price: true, currency: true,
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
    // «Новостройка» в РТ — признак дома (владелец 02.11.2026); не задано — не фильтруем.
    isNewBuilding: p.marketType == null ? null : p.marketType !== "SECONDARY",
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

  const result = await findSimilar({ ...subjectBase, propertyType: p.type });
  res.json({
    subject: { ...subjectBase, propertyType: p.type },
    ...result,
    comparison: result.status === "ok" ? verdictFor(askingPriceTjs, result.estimatedPriceTjs) : null,
  });
});
