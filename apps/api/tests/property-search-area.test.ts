import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";

/**
 * Поиск объектов: площадь и ключевые слова из описания.
 *
 * Владелец 10.08.2026: «поиск по (ключевые слова пусть квадратура тоже будет)» и
 * отдельно — «ввожу квадратные метры и так далее, поиск не работает». Оказалось,
 * фильтра площади не существовало вовсе: человек вводил число в строку поиска, а
 * та ищет по названию и адресу. Описание тоже не искалось — а «евроремонт» и
 * «панорамные окна» живут именно там, в названии их не пишут.
 *
 * Проверяется через ту же выборку Prisma, что строит маршрут (см. routes/properties.ts):
 * границы включительные, поиск по описанию находит, фильтры складываются по И, а
 * не подменяют друг друга. Последнее ломается тише всего: фильтр молча перестаёт
 * действовать, и агент получает список, который выглядит правдоподобно.
 */

const runId = Date.now();
let districtId: string;
let agentId: string;
const ids: string[] = [];

async function makeProperty(title: string, areaSqm: number, description: string) {
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      price: 500_000,
      currency: "TJS",
      areaSqm,
      condition: "GOOD",
      description,
      address: `Тестовая улица ${runId}`,
      districtId,
      intakeAgentId: agentId,
      createdById: agentId,
      listingAcceptedAt: new Date(),
      status: "AVAILABLE",
    },
  });
  ids.push(p.id);
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-поиск-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент поиска", phone: `+992931${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;

  await makeProperty("Малая", 45, "Уютная квартира, косметический ремонт");
  await makeProperty("Средняя", 80, "Свежий евроремонт, панорамные окна на город");
  await makeProperty("Большая", 150, "Просторная, без отделки, своя котельная");
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

/** Та же выборка по площади, что строит маршрут: границы включительные. */
function areaWhere(min?: number, max?: number) {
  return {
    districtId,
    deletedAt: null,
    ...(min !== undefined || max !== undefined
      ? { areaSqm: { ...(min !== undefined ? { gte: min } : {}), ...(max !== undefined ? { lte: max } : {}) } }
      : {}),
  };
}

describe("Фильтр площади", () => {
  it("«от 80» отдаёт объекты ровно от 80 и выше — граница включена", async () => {
    const found = await prisma.property.findMany({ where: areaWhere(80), select: { areaSqm: true } });
    const areas = found.map((p) => Number(p.areaSqm)).sort((a, b) => a - b);
    expect(areas).toEqual([80, 150]);
  });

  it("«до 80» тоже включает саму границу", async () => {
    const found = await prisma.property.findMany({ where: areaWhere(undefined, 80), select: { areaSqm: true } });
    const areas = found.map((p) => Number(p.areaSqm)).sort((a, b) => a - b);
    expect(areas).toEqual([45, 80]);
  });

  it("вилка «от 50 до 100» отсекает и мелкое, и крупное", async () => {
    const found = await prisma.property.findMany({ where: areaWhere(50, 100), select: { areaSqm: true } });
    expect(found.map((p) => Number(p.areaSqm))).toEqual([80]);
  });

  it("перевёрнутая вилка даёт пусто, а не весь каталог", async () => {
    // «от 150 до 50» — опечатка в полях. Хуже пустого списка здесь только список
    // из всех объектов подряд: агент решит, что фильтр применился.
    const found = await prisma.property.findMany({ where: areaWhere(150, 50) });
    expect(found).toHaveLength(0);
  });
});

describe("Поиск по ключевым словам", () => {
  /** Тот же набор полей, по которым ищет маршрут после правки 10.08.2026. */
  function textWhere(word: string) {
    return {
      districtId,
      deletedAt: null,
      OR: [
        { title: { contains: word, mode: "insensitive" as const } },
        { address: { contains: word, mode: "insensitive" as const } },
        { description: { contains: word, mode: "insensitive" as const } },
      ],
    };
  }

  it("находит по слову из ОПИСАНИЯ, которого нет ни в названии, ни в адресе", async () => {
    const found = await prisma.property.findMany({ where: textWhere("евроремонт"), select: { areaSqm: true } });
    expect(found).toHaveLength(1);
    expect(Number(found[0].areaSqm)).toBe(80);
  });

  it("регистр не имеет значения — люди пишут как придётся", async () => {
    const found = await prisma.property.findMany({ where: textWhere("КОТЕЛЬНАЯ") });
    expect(found).toHaveLength(1);
  });

  it("площадь и слово действуют вместе, а не вместо друг друга", async () => {
    // Самая тихая поломка: одно условие затирает другое, и выдача выглядит
    // правдоподобно, хотя фильтр не применился.
    const both = await prisma.property.findMany({
      where: { ...textWhere("панорамные"), areaSqm: { gte: 100 } },
    });
    expect(both).toHaveLength(0);
  });
});
