import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { buildPropertyMatchWhere, loadMoneyContext } from "../src/lib/propertyMatchFilter.js";
import type { MoneyContext } from "../src/lib/money.js";

/**
 * ПРЯМОЙ ПОДБОР УЧИТЫВАЕТ ПЛОЩАДЬ И ЭТАЖ (владелец 09.09.2026: подбор идёт по
 * району, адресу, этажности, площади и цене).
 *
 * Обратный подбор («объект → кому подходит», routes/matching.ts) эти поля знал с
 * 03.08.2026 — см. matching-area-floor.test.ts. А прямой («клиент → какие объекты
 * подходят»), тот самый, что стоит за «Подбором» на карточке и за автопушем на
 * новый объект, их не проверял: человеку, просившему «не первый», предлагали
 * первый этаж. Это то самое расхождение между двумя местами, ради устранения
 * которого фильтр когда-то и вынесли в общий модуль.
 *
 * Проверяем через РЕАЛЬНЫЙ запрос в базу, а не через форму объекта where: важно не
 * то, что условие построилось, а то, что SQL по нему отбирает правильные строки —
 * в частности не выбрасывает объекты с незаполненным этажом.
 */

const runId = Date.now().toString(36);
let districtId = "";
let money: MoneyContext;
const propertyIds: string[] = [];

/** Три объекта одного района: 1-й этаж, 5-й этаж и объект без указанного этажа. */
async function makeProperty(label: string, fields: { areaSqm?: number; floor?: number | null; totalFloors?: number | null }) {
  const p = await prisma.property.create({
    data: {
      title: `${label} ${runId}`,
      type: "APARTMENT",
      rooms: 3,
      areaSqm: fields.areaSqm ?? 70,
      floor: fields.floor ?? null,
      totalFloors: fields.totalFloors ?? null,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "AVAILABLE",
    },
  });
  propertyIds.push(p.id);
  return p;
}

let first: string;
let fifth: string;
let noFloor: string;
let small: string;

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Прямой-подбор-${runId}` } })).id;
  money = await loadMoneyContext();
  first = (await makeProperty("Первый этаж", { floor: 1, totalFloors: 5 })).id;
  fifth = (await makeProperty("Пятый этаж", { floor: 5, totalFloors: 9 })).id;
  noFloor = (await makeProperty("Этаж не указан", { floor: null, totalFloors: null })).id;
  small = (await makeProperty("Маленький", { areaSqm: 40, floor: 3, totalFloors: 5 })).id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

const base = {
  budgetMin: null,
  budgetMax: null,
  currency: "TJS",
  desiredDistrictId: null as string | null,
  desiredType: null,
  desiredRooms: null,
};

async function found(criteria: Parameters<typeof buildPropertyMatchWhere>[0]): Promise<string[]> {
  const where = buildPropertyMatchWhere({ ...criteria, desiredDistrictId: districtId }, money);
  const rows = await prisma.property.findMany({ where, select: { id: true } });
  return rows.map((r) => r.id);
}

describe("Прямой подбор: этаж", () => {
  it("«не первый» — первый этаж исчезает из выдачи", async () => {
    const ids = await found({ ...base, desiredFloorMin: 2 });
    expect(ids).not.toContain(first);
    expect(ids).toContain(fifth);
  });

  it("«не выше третьего» — пятый этаж исчезает", async () => {
    const ids = await found({ ...base, desiredFloorMax: 3 });
    expect(ids).not.toContain(fifth);
    expect(ids).toContain(first);
  });

  /**
   * Самая дорогая ошибка такого фильтра: `{ gte: 2 }` в SQL молча выбрасывает
   * строки с NULL. Незаполненный этаж — пробел в карточке объекта, и наказывать
   * за него покупателя нельзя.
   */
  it("объект с незаполненным этажом остаётся в выдаче", async () => {
    expect(await found({ ...base, desiredFloorMin: 2 })).toContain(noFloor);
    expect(await found({ ...base, desiredFloorMax: 3 })).toContain(noFloor);
    expect(await found({ ...base, desiredTotalFloors: 5 })).toContain(noFloor);
  });

  it("«не выше пятиэтажки» — девятиэтажка исчезает", async () => {
    const ids = await found({ ...base, desiredTotalFloors: 5 });
    expect(ids).not.toContain(fifth);
    expect(ids).toContain(first);
  });
});

describe("Прямой подбор: площадь", () => {
  it("«хотя бы 60 квадратов» — сорокаметровый исчезает, семидесятиметровый остаётся", async () => {
    const ids = await found({ ...base, desiredAreaMin: 60 });
    expect(ids).not.toContain(small);
    expect(ids).toContain(first);
  });

  /** Граница мягкая (−10%), как у бюджета: 58 при запросе «от 60» — то же самое. */
  it("допуск 10% вниз работает", async () => {
    const almost = (await makeProperty("Почти", { areaSqm: 58, floor: 2, totalFloors: 5 })).id;
    expect(await found({ ...base, desiredAreaMin: 60 })).toContain(almost);
    expect(await found({ ...base, desiredAreaMin: 70 })).not.toContain(almost);
  });
});

describe("Совместимость", () => {
  it("требований по площади и этажу нет — фильтр работает как раньше", async () => {
    const ids = await found({ ...base });
    expect(ids).toEqual(expect.arrayContaining([first, fifth, noFloor, small]));
  });

  it("площадь и этаж складываются с бюджетом, а не заменяют его", async () => {
    const ids = await found({ ...base, budgetMax: 100000, desiredFloorMin: 2 });
    // Бюджет 100 000 при цене 400 000 (+10% допуска) не проходит ни один объект.
    expect(ids).toHaveLength(0);
  });
});
