import { Router } from "express";
import { z } from "zod";
import { can, requireAuth } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { cardWhereFromParam } from "../lib/cardIdParam.js";
import { extractPhoneTails } from "../lib/market/ownMatch.js";
import { phoneTail } from "../lib/clientPhones.js";
import { canManagePropertyAs } from "../lib/propertyAccess.js";
import { stripOwnerContact } from "../lib/ownerContact.js";
import { loadMoneyContext, toTjs } from "../lib/money.js";

/**
 * Совпадения НАШИХ объектов с объявлениями на Somon/Paydo (владелец, 02.11.2026):
 * клиент выставил квартиру ещё и сам — агент видит это рядом с объектом и решает,
 * «наш» это объект или нет. Сами совпадения находит lib/market/ownMatch.ts
 * (runOwnMatching, из cron после сбора каталога); здесь только чтение и ответ
 * агента.
 *
 * Права — те же, что у карточки и правок объекта: читать совпадения может тот, кому
 * открыта карточка (удалённый объект — только с archive.view); менять решение
 * «наш / не наш» — тот, кто вправе управлять объектом (canManagePropertyAs:
 * руководитель или свой объект), иначе любой вошедший гасил бы чужие находки.
 * Телефон продавца площадки НЕ скрывается (решение владельца) — кроме одного
 * случая: он совпал с телефоном владельца объекта, а этот сотрудник телефон
 * владельца видеть не вправе (lib/ownerContact.ts). Сверка идёт по хвосту
 * номера ПРИ КАЖДОЙ выдаче, а не по сохранённым причинам: номер у объявления мог
 * появиться позже, чем посчитался счёт. Иначе объявление стало бы обходным путём
 * к закрытому контакту.
 */
export const marketMatchesRouter = Router();

type Reason = { code?: string; label?: string };

function hasPhoneReason(reasons: unknown): boolean {
  return Array.isArray(reasons) && (reasons as Reason[]).some((r) => r?.code === "phone");
}

marketMatchesRouter.get("/property/:id", requireAuth, async (req, res) => {
  const where = cardWhereFromParam(String(req.params.id));
  if (!where) return res.status(404).json({ error: "Объект не найден" });
  const p = await prisma.property.findUnique({
    where,
    select: {
      id: true, price: true, currency: true, areaSqm: true, deletedAt: true, ownerContact: true,
      assignedAgentId: true, intakeAgentId: true, createdById: true,
    },
  });
  if (!p || (p.deletedAt && !can(req, "archive.view"))) return res.status(404).json({ error: "Объект не найден" });

  const rows = await prisma.propertyMarketMatch.findMany({
    where: { propertyId: p.id, status: { not: "DISMISSED" } },
    orderBy: [{ score: "desc" }, { foundAt: "desc" }],
    take: 20,
    include: {
      listing: {
        select: {
          source: true, sourceUrl: true, title: true, priceTjs: true, areaSqm: true, rooms: true, floor: true,
          totalFloors: true, sellerName: true, sellerPhone: true, isAgency: true, firstSeenAt: true, isActive: true,
        },
      },
    },
  });

  const money = await loadMoneyContext();
  const ourPriceTjs = p.price != null ? Math.round(toTjs(p.price, p.currency, money)) : null;
  const ourArea = p.areaSqm != null ? Number(p.areaSqm) : null;
  const ownerHidden = stripOwnerContact(
    { ownerContact: "x", assignedAgentId: p.assignedAgentId, intakeAgentId: p.intakeAgentId, createdById: p.createdById },
    req.agent!.id,
    can(req, "properties.viewOwners")
  ).ownerContactHidden;
  const ownerTails = ownerHidden ? new Set(extractPhoneTails(p.ownerContact)) : new Set<string>();

  res.json({
    ourPriceTjs,
    matches: rows.map((m) => {
      const l = m.listing;
      const price = l.priceTjs != null ? Number(l.priceTjs) : null;
      const area = l.areaSqm != null ? Number(l.areaSqm) : null;
      const sellerTail = l.sellerPhone ? phoneTail(l.sellerPhone) : "";
      const hidePhone = ownerHidden && (hasPhoneReason(m.reasons) || (sellerTail !== "" && ownerTails.has(sellerTail)));
      return {
        id: m.id,
        status: m.status,
        score: m.score,
        reasons: m.reasons,
        foundAt: m.foundAt,
        source: l.source,
        sourceUrl: l.sourceUrl,
        title: l.title,
        priceTjs: price,
        /** + дороже нашей цены, − дешевле; в процентах от нашей. */
        priceDiffPercent: price != null && ourPriceTjs ? Math.round((price / ourPriceTjs - 1) * 100) : null,
        areaSqm: area,
        areaDiffSqm: area != null && ourArea != null ? Math.round((area - ourArea) * 10) / 10 : null,
        rooms: l.rooms,
        floor: l.floor,
        totalFloors: l.totalFloors,
        sellerName: l.sellerName,
        sellerPhone: hidePhone ? null : l.sellerPhone,
        sellerPhoneHidden: hidePhone && !!l.sellerPhone,
        isAgency: l.isAgency,
        firstSeenAt: l.firstSeenAt,
        isActive: l.isActive,
      };
    }),
  });
});

const statusSchema = z.object({ status: z.enum(["CONFIRMED", "DISMISSED"]) });

/** Агент подтверждает «да, это наш объект» или «нет, не он». Доступ — как у правок объекта. */
marketMatchesRouter.post("/:matchId/status", requireAuth, async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверный статус", details: parsed.error.flatten() });

  const match = await prisma.propertyMarketMatch.findUnique({
    where: { id: String(req.params.matchId) },
    select: { id: true, property: { select: { deletedAt: true, assignedAgentId: true, intakeAgentId: true, createdById: true } } },
  });
  if (!match || (match.property.deletedAt && !can(req, "archive.view"))) {
    return res.status(404).json({ error: "Совпадение не найдено" });
  }
  // Решать «наш / не наш» вправе тот, кто управляет объектом (как правки карточки).
  if (!canManagePropertyAs({ agentId: req.agent!.id, can: (permission) => can(req, permission) }, match.property)) {
    return res.status(403).json({ error: "Недостаточно прав: решает ответственный за объект или руководитель" });
  }
  const updated = await prisma.propertyMarketMatch.update({
    where: { id: match.id },
    data: { status: parsed.data.status },
    select: { id: true, status: true },
  });
  res.json(updated);
});
