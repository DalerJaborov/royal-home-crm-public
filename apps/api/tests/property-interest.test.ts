import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { districtDemandForMonth, hotPropertiesNow, recordInterest } from "../src/lib/propertyInterest.js";
import { dushanbeStartOfMonth } from "../src/lib/dushanbeTime.js";

/**
 * ИНТЕРЕС К ОБЪЕКТАМ (владелец 09.09.2026): «каким объектом интересуются на данный
 * момент больше всего, чтобы запустить его на таргетинг» и месячный срез по районам.
 *
 * Проверяем ровно то, из-за чего цифра может оказаться враньём: веса сигналов,
 * отсечку по окну, исключение проданных объектов и группировку по районам.
 */

const runId = Date.now();
let districtA: string;
let districtB: string;
let clientIds: string[] = [];
const propertyIds: string[] = [];

async function makeProperty(districtId: string, status: "AVAILABLE" | "SOLD" = "AVAILABLE") {
  const p = await prisma.property.create({
    data: {
      title: `Интерес ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 70000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  districtA = (await prisma.district.create({ data: { name: `Интерес-А-${runId}` } })).id;
  districtB = (await prisma.district.create({ data: { name: `Интерес-Б-${runId}` } })).id;
  for (let i = 0; i < 3; i++) {
    const c = await prisma.client.create({
      data: { fullName: `Интересующийся ${runId}-${i}`, phone: `+992944${runId}${i}`, kind: "BUYER", source: "PHONE_CALL" },
    });
    clientIds.push(c.id);
  }
});

afterAll(async () => {
  await prisma.propertyInterestEvent.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.district.deleteMany({ where: { id: { in: [districtA, districtB] } } });
  await prisma.$disconnect();
});

describe("Чем интересуются прямо сейчас", () => {
  it("показ весит больше отправленной ссылки — топ считается по весам, а не по числу событий", async () => {
    const many = await makeProperty(districtA);
    const one = await makeProperty(districtA);
    // Четыре отправленные ссылки (вес 1) против одного показа (вес 5).
    for (const c of clientIds) await recordInterest(many.id, "SHARE_SENT", c);
    await recordInterest(many.id, "SHARE_SENT", clientIds[0]);
    await recordInterest(one.id, "SHOWING", clientIds[0]);

    const top = await hotPropertiesNow(7, 10);
    const rowMany = top.find((r) => r.propertyId === many.id)!;
    const rowOne = top.find((r) => r.propertyId === one.id)!;
    expect(rowMany.events).toBe(4);
    expect(rowMany.score).toBe(4);
    expect(rowOne.events).toBe(1);
    expect(rowOne.score).toBe(5);
    expect(top.findIndex((r) => r.propertyId === one.id)).toBeLessThan(
      top.findIndex((r) => r.propertyId === many.id)
    );
  });

  it("считаются РАЗНЫЕ люди, а не только события", async () => {
    const p = await makeProperty(districtA);
    await recordInterest(p.id, "SHARE_OPENED", clientIds[0]);
    await recordInterest(p.id, "SHARE_OPENED", clientIds[0]);
    await recordInterest(p.id, "SHARE_OPENED", clientIds[1]);
    const row = (await hotPropertiesNow(7, 50)).find((r) => r.propertyId === p.id)!;
    expect(row.events).toBe(3);
    expect(row.people).toBe(2);
  });

  /** Реклама запускается на то, что можно продать. */
  it("проданный объект в топ не попадает", async () => {
    const sold = await makeProperty(districtA, "SOLD");
    await recordInterest(sold.id, "SHOWING", clientIds[0]);
    expect((await hotPropertiesNow(7, 50)).some((r) => r.propertyId === sold.id)).toBe(false);
  });

  it("событие старше окна не учитывается", async () => {
    const p = await makeProperty(districtA);
    await recordInterest(p.id, "SHOWING", clientIds[0]);
    await prisma.propertyInterestEvent.updateMany({
      where: { propertyId: p.id },
      data: { createdAt: new Date(Date.now() - 30 * 24 * 3600_000) },
    });
    expect((await hotPropertiesNow(7, 50)).some((r) => r.propertyId === p.id)).toBe(false);
    // То же событие внутри более широкого окна — видно.
    expect((await hotPropertiesNow(60, 200)).some((r) => r.propertyId === p.id)).toBe(true);
  });

  it("несуществующий объект не роняет запись сигнала", async () => {
    await expect(recordInterest("00000000-0000-0000-0000-000000000000", "SHOWING", null)).resolves.toBeUndefined();
  });
});

describe("Месячный срез по районам", () => {
  it("события группируются по району, объекты района считаются отдельно", async () => {
    const a1 = await makeProperty(districtB);
    const a2 = await makeProperty(districtB);
    await recordInterest(a1.id, "SHOWING", clientIds[0]); // 5
    await recordInterest(a2.id, "COMMENT", clientIds[1]); // 2

    const rows = await districtDemandForMonth(dushanbeStartOfMonth(new Date()));
    const b = rows.find((r) => r.districtName === `Интерес-Б-${runId}`)!;
    expect(b.score).toBe(7);
    expect(b.events).toBe(2);
    expect(b.properties).toBe(2);
  });
});
