import { describe, expect, it } from "vitest";
import { attachDealVersion, findCachedDeal } from "../dealVersion";
import type { Deal } from "../../types";

/**
 * Замок версии сделки на сайте (24.09.2026, ночная проверка, круг «Сайт: кэш
 * и мутации», находка 2). Сервер отвечает 409, только если version прислан
 * в теле PATCH (routes/deals.ts) — канбан его не слал ни в одном из семи
 * вызовов, и запоздалый офлайн-PATCH тихо перезаписывал более новое
 * состояние сделки. Проверяем чистую сборку тела без React Query/jsdom.
 */

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: "deal-1",
    clientId: "c1",
    client: { id: "c1", shortId: 1, fullName: "Клиент", phone: "+992900000000" },
    propertyId: "p1",
    property: { id: "p1", shortId: 1, title: "Объект", price: "100000", currency: "TJS", photos: [] },
    agentId: "a1",
    agent: { id: "a1", fullName: "Агент" },
    stage: "NEGOTIATION",
    commissionAmount: null,
    commissionPercent: null,
    soldPrice: null,
    commissionIntakeAmount: null,
    commissionRealtorAmount: null,
    commissionCompanyAmount: null,
    currency: "TJS",
    startedAt: "2026-09-01T00:00:00.000Z",
    closedAt: null,
    notes: null,
    version: 3,
    ...overrides,
  };
}

describe("attachDealVersion", () => {
  it("кладёт версию из кэша, если тело её не несёт", () => {
    const deal = makeDeal({ version: 5 });
    expect(attachDealVersion({ stage: "CONTRACT_SIGNED" }, deal)).toEqual({
      stage: "CONTRACT_SIGNED",
      version: 5,
    });
  });

  it("не трогает версию, если вызывающий уже её передал", () => {
    const deal = makeDeal({ version: 5 });
    expect(attachDealVersion({ stage: "CONTRACT_SIGNED", version: 2 }, deal)).toEqual({
      stage: "CONTRACT_SIGNED",
      version: 2,
    });
  });

  it("без сделки в кэше тело уходит как было (обратная совместимость)", () => {
    expect(attachDealVersion({ stage: "CONTRACT_SIGNED" }, undefined)).toEqual({
      stage: "CONTRACT_SIGNED",
    });
  });

  it("без version в самой сделке (старая запись) тело не меняется", () => {
    const deal = makeDeal({ version: undefined });
    expect(attachDealVersion({ stage: "CONTRACT_SIGNED" }, deal)).toEqual({
      stage: "CONTRACT_SIGNED",
    });
  });
});

describe("findCachedDeal", () => {
  it("находит сделку в одном из нескольких закэшированных списков", () => {
    const deal = makeDeal({ id: "deal-2" });
    const found = findCachedDeal([undefined, [makeDeal({ id: "deal-1" }), deal], [makeDeal({ id: "deal-3" })]], "deal-2");
    expect(found?.id).toBe("deal-2");
  });

  it("не находит — undefined", () => {
    expect(findCachedDeal([[makeDeal({ id: "deal-1" })]], "deal-9")).toBeUndefined();
  });
});
