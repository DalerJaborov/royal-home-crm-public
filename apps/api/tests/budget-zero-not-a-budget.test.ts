import { afterAll, describe, expect, it } from "vitest";
import { positiveBudget } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { clientPropertyEligible, hasClientMatchingCriteria, type MatchingBuyerCriteria, type MatchingPropertyFacts } from "../src/lib/clientPropertyMatching.js";
import { DEFAULT_MATCH_POLICY } from "../src/lib/matchPolicy.js";

/**
 * Бюджет 0 это «не указан», а не «до нуля сомони» (21.11.2026, кадры владельца: «Запрос покупателя:
 * Квартира, До 0 с.» и «Подбор объектов 0, Показано 0 из 0» при «Вся база»).
 * Класс: любая запись нуля превращается в null одной дверью (db.ts), а читающие места (подбор, экран)
 * ноль границей не считают.
 */
const PHONE = "+992557700333";
const created: string[] = [];

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describe("запись: ноль не сохраняется как бюджет", () => {
  it("create с нулями даёт null", async () => {
    await prisma.client.deleteMany({ where: { phone: PHONE } });
    const c = await prisma.client.create({ data: { fullName: "Тест Ноль", phone: PHONE, source: "WALK_IN", budgetMin: 0, budgetMax: 0 } });
    created.push(c.id);
    const back = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(back.budgetMin).toBeNull();
    expect(back.budgetMax).toBeNull();
  });

  it("update: 0, { set: 0 } и отрицательное дают null; 450000 остаётся", async () => {
    const id = created[0];
    await prisma.client.update({ where: { id }, data: { budgetMax: 450_000 } });
    expect(Number((await prisma.client.findUniqueOrThrow({ where: { id } })).budgetMax)).toBe(450_000);
    await prisma.client.update({ where: { id }, data: { budgetMax: 0 } });
    expect((await prisma.client.findUniqueOrThrow({ where: { id } })).budgetMax).toBeNull();
    await prisma.client.update({ where: { id }, data: { budgetMax: 300_000 } });
    await prisma.client.update({ where: { id }, data: { budgetMax: { set: 0 } } });
    expect((await prisma.client.findUniqueOrThrow({ where: { id } })).budgetMax).toBeNull();
    await prisma.client.update({ where: { id }, data: { budgetMin: -5 } });
    expect((await prisma.client.findUniqueOrThrow({ where: { id } })).budgetMin).toBeNull();
  });

  it("updateMany тоже", async () => {
    const id = created[0];
    await prisma.client.update({ where: { id }, data: { budgetMax: 300_000 } });
    await prisma.client.updateMany({ where: { id }, data: { budgetMax: 0 } });
    expect((await prisma.client.findUniqueOrThrow({ where: { id } })).budgetMax).toBeNull();
  });
});

describe("чтение: уже записанный в базу ноль не отсекает подбор", () => {
  it("positiveBudget: 0, «0.00», пусто, минус дают null", () => {
    expect(positiveBudget(0)).toBeNull();
    expect(positiveBudget("0.00")).toBeNull();
    expect(positiveBudget("")).toBeNull();
    expect(positiveBudget(null)).toBeNull();
    expect(positiveBudget(-3)).toBeNull();
    expect(positiveBudget("500000.00")).toBe(500_000);
  });

  const buyer = (over: Partial<MatchingBuyerCriteria>): MatchingBuyerCriteria => ({
    currency: "TJS", budgetMin: null, budgetMax: null, desiredDistrictId: null, desiredType: null, desiredRooms: null, ...over,
  });

  it("только нули: критериев нет (подбор по всей базе, не «до нуля»)", () => {
    expect(hasClientMatchingCriteria(buyer({ budgetMin: "0.00", budgetMax: "0.00" }))).toBe(false);
    expect(hasClientMatchingCriteria(buyer({ budgetMax: "500000.00" }))).toBe(true);
  });

  it("объект проходит клиента с бюджетом 0 так же, как клиента без бюджета (а не «до нуля сомони»)", () => {
    const property = {
      id: "p1", type: "APARTMENT", districtId: null, price: 500_000, currency: "TJS", rooms: 2, areaSqm: 60, floor: 3, totalFloors: 9,
      lat: null, lng: null,
    } as unknown as MatchingPropertyFacts;
    const money = { usdToTjs: 10.5 } as never;
    expect(clientPropertyEligible(buyer({ desiredRooms: 2 }), property, money, DEFAULT_MATCH_POLICY)).toBe(true);
    expect(clientPropertyEligible(buyer({ desiredRooms: 2, budgetMin: "0.00", budgetMax: "0.00" }), property, money, DEFAULT_MATCH_POLICY)).toBe(true);
    // Контроль: настоящий потолок ниже цены по-прежнему отсекает.
    expect(clientPropertyEligible(buyer({ desiredRooms: 2, budgetMax: "100000.00" }), property, money, DEFAULT_MATCH_POLICY)).toBe(false);
  });
});
