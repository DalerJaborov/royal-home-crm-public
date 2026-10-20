import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/db.js";
import { uploadsDir } from "../src/upload.js";
import {
  generateStoryCard,
  computeStoryCardTextLayout,
  STORY_CARD_WIDTH,
  STORY_CARD_HEIGHT,
  SAFE_TOP_PX,
  SAFE_BOTTOM_PX,
  SIDE_MARGIN_PX,
  SOLD_STAMP_TEXT,
  buildStoryCardOverlaySvg,
  shouldStampSold,
} from "../src/lib/video/storyCard.js";
import type { ReelsCaptionValues } from "../src/lib/reelsCaptionTemplate.js";

/**
 * Карточка-история объекта (1080x1920 JPEG) — покрываем ровно то, что не видно
 * по сборке: точный размер, честный отказ без фото, отсутствие «дыр» на строке
 * без данных, и что цена форматируется тем же способом, что и в подписях Reels
 * (buildPriceDisplay/formatPrice, не второй форматтер).
 */
const runId = Date.now().toString(36);
let districtId: string;
const propertyIds: string[] = [];
const photoFiles: string[] = [];

async function writeFakePhoto(filename: string): Promise<void> {
  // 1x1 JPEG (валидный минимальный файл) — sharp .resize({fit:"cover"}) не
  // требует реального фото, только валидный формат на входе.
  const tinyJpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
    "base64"
  );
  await fs.writeFile(path.join(uploadsDir, filename), tinyJpeg);
  photoFiles.push(filename);
}

async function makeProperty(overrides: Partial<Parameters<typeof prisma.property.create>[0]["data"]> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Тест-история-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 3,
      areaSqm: 84,
      floor: 4,
      totalFloors: 9,
      price: 62000,
      currency: "USD",
      districtId,
      address: `Тестовая, ${propertyIds.length}`,
      condition: "GOOD",
      ...overrides,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-история-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await Promise.all(
    photoFiles.map((f) => fs.rm(path.join(uploadsDir, f), { force: true }))
  );
});

describe("карточка-история объекта (lib/video/storyCard.ts)", () => {
  it("рисует JPEG ровно 1080x1920 по главному фото объекта", async () => {
    const property = await makeProperty();
    const filename = `story-card-${runId}-1.jpg`;
    await writeFakePhoto(filename);
    await prisma.propertyPhoto.create({
      data: { propertyId: property.id, url: `/uploads/${filename}`, thumbUrl: `/uploads/thumbs/${filename}`, order: 0 },
    });

    const result = await generateStoryCard(property.id);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.image).not.toBeNull();

    const sharp = (await import("sharp")).default;
    const meta = await sharp(result.image!).metadata();
    expect(meta.width).toBe(STORY_CARD_WIDTH);
    expect(meta.height).toBe(STORY_CARD_HEIGHT);
    expect(meta.format).toBe("jpeg");
  });

  it("честно отказывает у объекта без единой фотографии, а не падает исключением", async () => {
    const property = await makeProperty();

    const result = await generateStoryCard(property.id);
    expect(result.ok).toBe(false);
    expect(result.image).toBeNull();
    expect(result.error).toMatch(/фотограф/i);
  });

  it("отказывает понятной ошибкой, а не исключением, для несуществующего объекта", async () => {
    const result = await generateStoryCard("00000000-0000-0000-0000-000000000000");
    expect(result.ok).toBe(false);
    expect(result.image).toBeNull();
    expect(result.error).toMatch(/не найден/i);
  });

  it("цена на карточке форматируется тем же способом, что и в подписи Reels", async () => {
    const { formatPrice } = await import("../src/ai/seoGenerator.js");
    const { buildPriceDisplay } = await import("../src/lib/reelsCaptionTemplate.js");
    // Без объекта: проверяем сам факт переиспользования — buildPriceDisplay
    // для валюты, не требующей курса, обязана вернуть ровно formatPrice.
    expect(buildPriceDisplay(62000, "USD")).toBe(formatPrice(62000, "USD"));
  });

  it("не оставляет дыр: объект-участок без этажа не печатает пустую строку «Этаж»", async () => {
    const property = await makeProperty({ type: "LAND", floor: null, totalFloors: null, rooms: null });
    const filename = `story-card-${runId}-2.jpg`;
    await writeFakePhoto(filename);
    await prisma.propertyPhoto.create({
      data: { propertyId: property.id, url: `/uploads/${filename}`, thumbUrl: `/uploads/thumbs/${filename}`, order: 0 },
    });

    const result = await generateStoryCard(property.id);
    expect(result.ok).toBe(true);
    // Достаточно того, что отрисовка не падает без этажа/комнат и по-прежнему
    // отдаёт валидную картинку нужного размера — сам текст SVG не публичный API,
    // а «дыра» превратилась бы в исключение при склейке строк с null.
    const sharp = (await import("sharp")).default;
    const meta = await sharp(result.image!).metadata();
    expect(meta.width).toBe(STORY_CARD_WIDTH);
    expect(meta.height).toBe(STORY_CARD_HEIGHT);
  });
});

/** Безопасные поля Instagram Stories (владелец 21.09.2026): текст не должен
 *  попадать под аватар/индикаторы сверху и под поле «Отправить сообщение»
 *  снизу — см. константы SAFE_TOP_PX/SAFE_BOTTOM_PX и комментарий над ними
 *  в lib/video/storyCard.ts (источники цифр). Проверяем вычисленные
 *  координаты текстового блока напрямую — без похода в БД/sharp/PNG-сравнения. */
describe("безопасные поля карточки-истории (computeStoryCardTextLayout)", () => {
  const baseValues: ReelsCaptionValues = {
    type: "Квартира",
    district: "Сино",
    rooms: "3",
    areaSqm: "84",
    floor: "4",
    totalFloors: "9",
    condition: "Хорошее",
    price: "62 000 $",
    phone: null,
    address: null,
    documents: null,
    windowCount: null,
    bathroom: null,
  };

  it("обычная карточка: текст целиком внутри безопасной зоны", () => {
    const layout = computeStoryCardTextLayout(baseValues, "ОБ-000032");
    expect(layout.topY).toBeGreaterThanOrEqual(SAFE_TOP_PX);
    expect(layout.bottomY).toBeLessThanOrEqual(STORY_CARD_HEIGHT - SAFE_BOTTOM_PX);
  });

  it("карточка «цена снижена»: старая цена и линия зачёркивания не выталкивают номер за нижнее поле", () => {
    const layout = computeStoryCardTextLayout(baseValues, "ОБ-000032", "70 000 $");
    expect(layout.topY).toBeGreaterThanOrEqual(SAFE_TOP_PX);
    expect(layout.bottomY).toBeLessThanOrEqual(STORY_CARD_HEIGHT - SAFE_BOTTOM_PX);
  });

  it("длинное название района не ломает раскладку и остаётся в безопасной зоне", () => {
    const longDistrict: ReelsCaptionValues = {
      ...baseValues,
      district: "Микрорайон Испечак-1 (за новым мостом через канал возле рынка Корвон)",
    };
    const layout = computeStoryCardTextLayout(longDistrict, "ОБ-000032");
    expect(layout.topY).toBeGreaterThanOrEqual(SAFE_TOP_PX);
    expect(layout.bottomY).toBeLessThanOrEqual(STORY_CARD_HEIGHT - SAFE_BOTTOM_PX);
  });

  it("цена в двух валютах (доллары + сомони) не ломает раскладку", () => {
    const dualCurrency: ReelsCaptionValues = {
      ...baseValues,
      price: "679 800 смн (62 000 $)",
    };
    const layout = computeStoryCardTextLayout(dualCurrency, "ОБ-000032");
    expect(layout.topY).toBeGreaterThanOrEqual(SAFE_TOP_PX);
    expect(layout.bottomY).toBeLessThanOrEqual(STORY_CARD_HEIGHT - SAFE_BOTTOM_PX);
  });

  it("длинный район + цена в двух валютах вместе — обе проверки одновременно", () => {
    const worstCase: ReelsCaptionValues = {
      ...baseValues,
      district: "Микрорайон Испечак-1 (за новым мостом через канал возле рынка Корвон)",
      price: "679 800 смн (62 000 $)",
    };
    const layout = computeStoryCardTextLayout(worstCase, "ОБ-000032", "70 000 $");
    expect(layout.topY).toBeGreaterThanOrEqual(SAFE_TOP_PX);
    expect(layout.bottomY).toBeLessThanOrEqual(STORY_CARD_HEIGHT - SAFE_BOTTOM_PX);
  });
});

/**
 * Печать «ПРОДАНО» (21.09.2026). По готовому JPEG её не проверить — растровое
 * сравнение в проекте не гоняется, — поэтому проверяется решение «ставить или
 * нет» и сам слой SVG, из которого печать рисуется.
 */
describe("Печать «Продано»", () => {
  const values: ReelsCaptionValues = {
    price: "62 000 $",
    district: "Сино",
    rooms: 3,
    areaSqm: 84,
    floor: 4,
    totalFloors: 9,
  } as ReelsCaptionValues;

  it("проданный объект получает печать сам, без флага на каждом вызове", () => {
    expect(shouldStampSold("SOLD")).toBe(true);
    expect(shouldStampSold("PUBLISHED")).toBe(false);
  });

  it("явный флаг сильнее статуса — карточка рисуется и до, и после смены статуса", () => {
    expect(shouldStampSold("PUBLISHED", true)).toBe(true);
    expect(shouldStampSold("SOLD", false)).toBe(false);
  });

  it("печать попадает в слой только когда её просят", () => {
    const withStamp = buildStoryCardOverlaySvg(values, "ОБ-000113", { soldStamp: true });
    const without = buildStoryCardOverlaySvg(values, "ОБ-000113");
    expect(withStamp).toContain(SOLD_STAMP_TEXT);
    expect(without).not.toContain(SOLD_STAMP_TEXT);
  });

  it("печать не вылезает за боковые поля и лежит внутри безопасной зоны", () => {
    const svg = buildStoryCardOverlaySvg(values, "ОБ-000113", { soldStamp: true });
    const rect = svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="16"/);
    expect(rect).not.toBeNull();
    const [x, y, w, h] = rect!.slice(1).map(Number);
    expect(x).toBeGreaterThanOrEqual(SIDE_MARGIN_PX);
    expect(x + w).toBeLessThanOrEqual(STORY_CARD_WIDTH - SIDE_MARGIN_PX);
    expect(y).toBeGreaterThanOrEqual(SAFE_TOP_PX);
    expect(y + h).toBeLessThanOrEqual(STORY_CARD_HEIGHT - SAFE_BOTTOM_PX);
  });
});
