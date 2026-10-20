import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { describePlace } from "../src/lib/landmarkPick.js";

/**
 * ОРИЕНТИР — ЗНАМЕНИТЫЙ, А НЕ БЛИЖАЙШИЙ (20.09.2026, владелец: «самое главное
 * не отправлять просто ориентиры, которые люди не знают, а именно самые
 * знаменитые»).
 *
 * У 857 записей справочника `Landmark.weight` почти везде остался нулём —
 * заводился он под ручную разметку в Настройках. При нулевом весе отбор
 * вырождался в «ближайший из влезших в потолок»: безымянное кафе в 50 метрах
 * побеждало рынок в 400, хотя дорогу в Душанбе объясняют рынком.
 */

const runId = Date.now();
const POINT = { lat: 38.4911, lng: 68.9123 };
const CAFE = { lat: POINT.lat + 0.00045, lng: POINT.lng }; // ~50 м
const BAZAR = { lat: POINT.lat + 0.0036, lng: POINT.lng }; // ~400 м
const sourcePrefix = `test-landmark-prominence-${runId}`;

async function addLandmark(name: string, category: string, at: { lat: number; lng: number }, weight = 0) {
  await prisma.landmark.create({
    data: { sourceId: `${sourcePrefix}-${name}`, name: `${name} ${runId}`, category, weight, lat: at.lat, lng: at.lng },
  });
}

beforeAll(async () => {
  await addLandmark("Кафе", "Кафе", CAFE);
  await addLandmark("Бозори", "Базар", BAZAR);
});

afterAll(async () => {
  await prisma.landmark.deleteMany({ where: { sourceId: { startsWith: sourcePrefix } } });
});

describe("Выбор ориентира для описания места", () => {
  it("знаменитое место перебивает ближнюю мелочь", async () => {
    const described = await describePlace(POINT.lat, POINT.lng);
    expect(described.landmark?.name).toBe(`Бозори ${runId}`);
    expect(described.text).toContain(`Бозори ${runId}`);
    expect(described.text).not.toContain(`Кафе ${runId}`);
  });

  it("проставленный руками вес сильнее базового по категории", async () => {
    // Владелец открыл справочник и отметил это кафе важным — он знает про место
    // больше таблицы категорий, и его отметка обязана победить.
    await prisma.landmark.updateMany({ where: { sourceId: `${sourcePrefix}-Кафе` }, data: { weight: 100 } });
    try {
      const described = await describePlace(POINT.lat, POINT.lng);
      expect(described.landmark?.name).toBe(`Кафе ${runId}`);
    } finally {
      await prisma.landmark.updateMany({ where: { sourceId: `${sourcePrefix}-Кафе` }, data: { weight: 0 } });
    }
  });

  it("выключенный ориентир не предлагается вовсе", async () => {
    await prisma.landmark.updateMany({ where: { sourceId: `${sourcePrefix}-Бозори` }, data: { enabled: false } });
    try {
      const described = await describePlace(POINT.lat, POINT.lng);
      expect(described.landmark?.name).toBe(`Кафе ${runId}`);
    } finally {
      await prisma.landmark.updateMany({ where: { sourceId: `${sourcePrefix}-Бозори` }, data: { enabled: true } });
    }
  });
});
