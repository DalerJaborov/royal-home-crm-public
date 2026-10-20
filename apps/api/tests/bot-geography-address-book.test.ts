import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { geographyAddressLines, propertyGeographyBlock } from "../src/ai/dushanbeGeography.js";
import { prisma } from "../src/db.js";

/**
 * СПРАВОЧНИК «АДРЕС — РАЙОН» ДЛЯ БОТА (разбор живых переписок 20.09.2026,
 * `docs/bot-razbor-20-09.md`, класс 6 п. 3).
 *
 * В блок попадали и проданные, и снятые объекты, а заголовок звучал как
 * «дома и адреса, которые мы ведём» — рядом с живыми адресами это читается как
 * ассортимент, и бот мог назвать проданный дом вариантом в продаже.
 *
 * Отсев по статусу был бы неверным лечением: адрес дома и его район от продажи
 * квартиры не меняются, а справочник тем и ценен, что знает как можно больше домов
 * Душанбе — иначе вернётся запрещённый владельцем вопрос «это какой район?».
 * Поэтому лечение двойное: живые объекты занимают места в справочнике первыми, а
 * заголовок прямо говорит, что это не список наличия.
 */

const row = (address: string | null, status: string, district: string | null) => ({
  address,
  status,
  district: district ? { name: district } : null,
});

describe("geographyAddressLines — сначала то, что в продаже", () => {
  it("адрес объекта в продаже идёт раньше проданного, даже если проданный свежее", () => {
    expect(
      geographyAddressLines([
        row("Бустон Сити, блок 4", "SOLD", "Шохмансур"),
        row("82 мкр, дом 12", "AVAILABLE", "Сино"),
      ])
    ).toEqual(["82 мкр, дом 12 — Сино", "Бустон Сити, блок 4 — Шохмансур"]);
  });

  it("проданный дом из справочника не выбрасывается — район по нему всё равно известен", () => {
    expect(geographyAddressLines([row("Зарафшон, 7", "SOLD", "Фирдавси")])).toEqual([
      "Зарафшон, 7 — Фирдавси",
    ]);
  });

  it("предел мест достаётся живым объектам, а не проданным", () => {
    const rows = [
      row("Проданный дом", "SOLD", "Сино"),
      row("Живой дом", "AVAILABLE", "Сино"),
    ];
    expect(geographyAddressLines(rows, 1)).toEqual(["Живой дом — Сино"]);
  });

  it("один дом — одна строка, даже если в нём несколько квартир", () => {
    expect(
      geographyAddressLines([
        row(" Зарафшон, 7 ", "AVAILABLE", "Фирдавси"),
        row("зарафшон, 7", "AVAILABLE", "Фирдавси"),
      ])
    ).toEqual(["Зарафшон, 7 — Фирдавси"]);
  });

  it("объект без адреса или без района в справочник не попадает", () => {
    expect(geographyAddressLines([row(null, "AVAILABLE", "Сино"), row("Без района, 1", "AVAILABLE", null)])).toEqual(
      []
    );
  });
});

describe("propertyGeographyBlock — заголовок не обещает наличие", () => {
  const runId = Date.now();
  let districtId = "";
  let propertyId = "";

  beforeAll(async () => {
    districtId = (await prisma.district.create({ data: { name: `Тест-справочник-${runId}` } })).id;
    propertyId = (
      await prisma.property.create({
        data: {
          title: `Справочник ${runId}`,
          type: "APARTMENT",
          areaSqm: 50,
          windowCount: 3,
          price: 300000,
          currency: "TJS",
          districtId,
          address: `Тестовый справочник, ${runId}`,
          condition: "GOOD",
          status: "AVAILABLE",
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.property.delete({ where: { id: propertyId } });
    await prisma.district.delete({ where: { id: districtId } });
    await prisma.$disconnect();
  });

  it("в справочнике прямо сказано, что это не список продающегося", async () => {
    const block = await propertyGeographyBlock();
    expect(block).toContain(`Тестовый справочник, ${runId}`);
    expect(block).toContain("НЕ СПИСОК ТОГО, ЧТО ЕСТЬ В ПРОДАЖЕ");
    expect(block).not.toContain("ДОМА И АДРЕСА, КОТОРЫЕ МЫ ВЕДЁМ");
  });
});
