import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { FOLK_PLACES, folkCoverage, folkGeographyBlock, resetFolkCoverageCache } from "../src/ai/folkPlaces.js";
import { normalizeGeoText } from "../src/lib/geoNormalize.js";
import { resetDistrictReferenceCache } from "../src/lib/propertyDistrict.js";

/**
 * СПИСОК НАРОДНЫХ НАЗВАНИЙ ТАЕТ САМ, КОГДА МЕСТО ПОЯВЛЯЕТСЯ НА КАРТЕ (20.09.2026).
 *
 * Владелец: «их тоже возьми в информацию с картами… если их нет — потом удали,
 * чтобы бот больше не обращался туда по старой памяти». Проверяем оба конца:
 * известное карте название уходит из промта, неизвестное остаётся, а расхождение
 * по району остаётся тоже — его разбирает человек, а не молчание.
 */

const runId = Date.now();
// Квадрат вокруг точки — этого хватает для точки-в-полигоне (lib/geo.ts).
const POINT = { lat: 38.5701, lng: 68.7801 };
const RING = [
  [POINT.lng - 0.01, POINT.lat - 0.01],
  [POINT.lng + 0.01, POINT.lat - 0.01],
  [POINT.lng + 0.01, POINT.lat + 0.01],
  [POINT.lng - 0.01, POINT.lat + 0.01],
  [POINT.lng - 0.01, POINT.lat - 0.01],
];
const BOUNDARY = `POLYGON((${RING.map(([lng, lat]) => `${lng} ${lat}`).join(",")}))`;

/** «Профсоюз» в купленном слое отсутствует — на нём и проверяем обе стороны. */
const FOLK = FOLK_PLACES.find((p) => p.name === "Профсоюз")!;
const createdDistrictIds: string[] = [];
const sourceId = `test-folk-${runId}`;
let landmarkId = "";

async function districtNamed(name: string, boundary: string | null): Promise<string> {
  const existing = await prisma.district.findUnique({ where: { name } });
  if (existing) {
    await prisma.district.update({ where: { id: existing.id }, data: { boundary } });
    return existing.id;
  }
  const created = await prisma.district.create({ data: { name, boundary } });
  createdDistrictIds.push(created.id);
  return created.id;
}

function reset(): void {
  resetFolkCoverageCache();
  resetDistrictReferenceCache();
}

beforeAll(async () => {
  await districtNamed(FOLK.district, BOUNDARY);
  const landmark = await prisma.landmark.create({
    data: { sourceId, name: `Профсоюз ${runId}`, category: "ТЦ", lat: POINT.lat, lng: POINT.lng },
  });
  landmarkId = landmark.id;
  await prisma.geoAlias.create({
    data: {
      text: FOLK.name,
      normalized: normalizeGeoText(FOLK.name),
      targetType: "landmark",
      targetId: landmarkId,
      source: "agent",
    },
  });
  reset();
});

afterAll(async () => {
  await prisma.geoAlias.deleteMany({ where: { targetId: landmarkId } });
  await prisma.landmark.deleteMany({ where: { sourceId } });
  await prisma.district.deleteMany({ where: { id: { in: createdDistrictIds } } });
  reset();
});

describe("Народные названия сверяются с картой города", () => {
  it("название, которое знает карта, из промта уходит", async () => {
    const block = await folkGeographyBlock();
    expect(block).not.toContain(FOLK.name);
    // Остальной список при этом на месте — ушла одна строка, а не блок целиком.
    expect(block).toContain("АЛГОРИТМ РАБОТЫ С РАЙОНАМИ");
    expect(block).toContain("Караболо");
  });

  it("карта отвечает ДРУГИМ районом — название остаётся, расхождение видно", async () => {
    // Ориентир переезжает в чужой район: строка обязана вернуться в промт, потому
    // что разобрать такое расхождение может только человек.
    const otherName = FOLK.district === "Сино" ? "Фирдавси" : "Сино";
    await prisma.district.updateMany({ where: { name: FOLK.district }, data: { boundary: null } });
    const otherId = await districtNamed(otherName, BOUNDARY);
    try {
      reset();
      const rows = await folkCoverage();
      const row = rows.find((r) => r.place.name === FOLK.name)!;
      expect(row.onMap).toBe(true);
      expect(row.mapDistrict).toBe(otherName);
      expect(await folkGeographyBlock()).toContain(FOLK.name);
    } finally {
      await prisma.district.update({ where: { id: otherId }, data: { boundary: null } });
      await prisma.district.updateMany({ where: { name: FOLK.district }, data: { boundary: BOUNDARY } });
      reset();
    }
  });

  it("неизвестное карте название печатается как раньше", async () => {
    const rows = await folkCoverage();
    const unknown = rows.find((r) => r.place.name === "Медгородок")!;
    expect(unknown.onMap).toBe(false);
    expect(await folkGeographyBlock()).toContain("Медгородок");
  });

  it("правило Марказа печатается всегда", async () => {
    expect(await folkGeographyBlock()).toContain("Марказ калон аст");
  });

  /**
   * ШЕСТЬ РАЙОНОВ, ИСПРАВЛЕННЫХ ПО ДОКУМЕНТУ МЭРИИ (20.09.2026).
   *
   * Список писался владельцем на глаз в июле, и шесть названий стояли не в своём
   * районе. Исправлено по постановлению раиса города №522 от 05.10.2022, где все
   * махалли и улицы перечислены по районам (разбор — docs/folk-names-web-check-20-09.md).
   * Тест держит именно эти шесть: правка рукой по памяти вернула бы их обратно
   * молча, а бот записывал бы лид не в тот район — молчаливая ошибка ровно того
   * рода, с которой начался весь разбор географии.
   */
  it("районы, исправленные по документу мэрии, не возвращаются к старым", () => {
    const district = (name: string) => FOLK_PLACES.find((p) => p.name === name)?.district;
    expect(district("Медгородок")).toBe("Исмоили Сомони");
    expect(district("ДОК")).toBe("Шохмансур");
    expect(district("Лучоб")).toBe("Сино");
    expect(district("Хаёти Нав")).toBe("Сино");
    expect(district("Автоцентр")).toBe("Фирдавси");
    expect(district("ОВИР")).toBe("Исмоили Сомони");
  });
});
