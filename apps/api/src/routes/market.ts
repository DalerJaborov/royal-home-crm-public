import { Router } from "express";
import { can, requireAuth } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { cardWhereFromParam } from "../lib/cardIdParam.js";
import { emptyDynamics, findDynamics } from "../lib/market/dynamics.js";
import { evaluatePropertyAgainstMarket, PROPERTY_MARKET_SELECT } from "../lib/market/propertyMarket.js";
import { loadMoneyContext } from "../lib/money.js";
import { findOverpricedPropertiesCached } from "../lib/market/overpriced.js";
import { findSegments } from "../lib/market/segments.js";
import { marketSegmentsQuerySchema } from "@royal-home/shared";

export const marketRouter = Router();

/**
 * GET /api/v1/market/property/:id — блок «Рынок» в карточке объекта: стоит ли цена
 * владельца своих денег. Объект и его цена читаются на сервере (одна дверь:
 * ремонт/признак дома/курс считаются здесь, а не на каждом экране); права те же,
 * что у самой карточки (GET /properties/:id: удалённый — только с archive.view).
 */
marketRouter.get("/property/:id", requireAuth, async (req, res) => {
  const where = cardWhereFromParam(String(req.params.id));
  if (!where) return res.status(404).json({ error: "Объект не найден" });
  const p = await prisma.property.findUnique({ where, select: PROPERTY_MARKET_SELECT });
  if (!p || (p.deletedAt && !can(req, "archive.view"))) return res.status(404).json({ error: "Объект не найден" });

  // Сборка предмета сравнения и вердикт — одно место (lib/market/propertyMarket.ts), его же зовёт помощница.
  res.json(await evaluatePropertyAgainstMarket(p, await loadMoneyContext()));
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

/**
 * GET /api/v1/market/overpriced — наши объекты в продаже, которые просят дороже рынка (14.11.2026).
 * Права те же, что у блока «Рынок» и таблицы сегментов: любой вошедший сотрудник (в ответе только то, что
 * и так видно в карточках объектов, и цены чужих объявлений в сводке; телефонов нет). Сравнение одним
 * проходом по сегментам, предел выборки в lib/market/overpriced.ts, ответ кэшируется на 10 минут (один на всех).
 * Ориентировочно: точный разбор в карточке.
 */
marketRouter.get("/overpriced", requireAuth, async (_req, res) => {
  res.json(await findOverpricedPropertiesCached());
});
