import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildPropertyTitle } from "@royal-home/shared";

/**
 * РАЙОН НАШЁЛСЯ ПО ТОЧКЕ — НАЗВАНИЕ ДОГОНЯЕТ (25.09.2026, остаток разбора карты
 * объектов). Название объекта ведёт сервер: «3-комн · Сино». У объекта без
 * района оно просто «3-комн». Геокодер, заполнивший пустой район по точке,
 * раньше район ставил, а название оставлял без него — пересобиралось оно только
 * при следующей правке карточки человеком.
 *
 * Геокодер и район по точке подменены: тест про название, не про Nominatim и не
 * про границы районов в общей базе.
 */

const DISTRICT_NAME = `Тест-район-название-${Date.now()}`;
let districtId = "";
/** Подмена «во время запроса района»: тест имитирует правку карточки пользователем. */
let duringDistrictLookup: (() => Promise<void>) | null = null;

vi.mock("../src/lib/geocode.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/geocode.js")>();
  return { ...original, geocodeAddress: vi.fn(async () => ({ lat: 38.5601, lng: 68.7739 })) };
});
vi.mock("../src/lib/propertyDistrict.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/propertyDistrict.js")>();
  return {
    ...original,
    districtByPoint: vi.fn(async () => {
      await duringDistrictLookup?.();
      return { id: districtId, name: DISTRICT_NAME, source: "point" as const };
    }),
  };
});

const { prisma } = await import("../src/db.js");
const { geocodeJob } = await import("../src/jobs/geocode.js");

const runId = Date.now();
const propertyIds: string[] = [];

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: DISTRICT_NAME } })).id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function makeProperty(title: string) {
  // Закрытый объект (offSite) — единственный, у кого район может быть пустым.
  const p = await prisma.property.create({
    data: {
      title,
      type: "APARTMENT",
      rooms: 3,
      areaSqm: 70,
      price: 90000,
      currency: "TJS",
      condition: "GOOD",
      status: "AVAILABLE",
      offSite: true,
      address: `улица Названия ${runId}, 7`,
    },
  });
  propertyIds.push(p.id);
  return p;
}

describe("Геокодер заполнил пустой район", () => {
  it("автоматическое название без района получает район", async () => {
    const autoTitle = buildPropertyTitle({ type: "APARTMENT", rooms: 3 });
    const p = await makeProperty(autoTitle);

    await geocodeJob.run({ propertyId: p.id });

    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.districtId).toBe(districtId);
    expect(after.title).toBe(buildPropertyTitle({ type: "APARTMENT", rooms: 3, districtName: DISTRICT_NAME }));
    expect(after.title).toContain(DISTRICT_NAME);
  });

  it("название, набранное не сервером (импорт), не трогается", async () => {
    const own = `Пентхаус у парка ${runId}`;
    const p = await makeProperty(own);

    await geocodeJob.run({ propertyId: p.id });

    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.districtId).toBe(districtId);
    expect(after.title).toBe(own);
  });

  it("CHANNEL-NEW-04: комнаты и название поменяли во время поиска района: район ставится, название пользователя не затирается", async () => {
    const autoTitle = buildPropertyTitle({ type: "APARTMENT", rooms: 3 });
    const p = await makeProperty(autoTitle);
    duringDistrictLookup = async () => {
      await prisma.property.update({ where: { id: p.id }, data: { rooms: 4, title: "Моё название после правки" } });
    };
    try {
      await geocodeJob.run({ propertyId: p.id });
    } finally {
      duringDistrictLookup = null;
    }

    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.rooms).toBe(4);
    expect(after.title).toBe("Моё название после правки");
    expect(after.districtId).toBe(districtId);
  });

  it("CHANNEL-NEW-04: адрес сменили во время поиска района: район от старой точки не записывается", async () => {
    const autoTitle = buildPropertyTitle({ type: "APARTMENT", rooms: 3 });
    const p = await makeProperty(autoTitle);
    duringDistrictLookup = async () => {
      await prisma.property.update({ where: { id: p.id }, data: { address: `переехали ${runId}, 99` } });
    };
    try {
      await geocodeJob.run({ propertyId: p.id });
    } finally {
      duringDistrictLookup = null;
    }

    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.districtId).toBeNull();
    expect(after.title).toBe(autoTitle);
  });
});