import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/db.js";
import { uploadsDir } from "../src/upload.js";
import {
  generateCoverPoster,
  buildCoverPosterValues,
  computeCoverPosterLayout,
  buildCoverPosterSvg,
  renderCoverPosterImage,
  COVER_SQUARE_SIZE,
  COVER_STORY_WIDTH,
  COVER_STORY_HEIGHT,
} from "../src/lib/video/coverPoster.js";
import { COVER_CAP_HEIGHT, COVER_SUP_HEIGHT, COVER_X_HEIGHT } from "../src/lib/video/coverMetrics.js";

/**
 * Подмена всего модуля, не голого `fetch` — тем же приёмом, что
 * `property-photo-enhance.test.ts` подменяет `enhancePropertyPhoto` целиком:
 * `coverPosterStyle.ts` сам по себе не тестируется здесь (это вызов внешнего
 * Google API, тестам сети не нужно), проверяется только то, что
 * `generateCoverPoster` честно использует его результат и честно откатывается
 * на исходное фото при отказе. Подмена безопасна для остальных тестов файла —
 * `style` не запрошен, функция вообще не зовётся.
 */
const stylizeCoverPhotoWithGemini = vi.fn();
vi.mock("../src/ai/coverPosterStyle.js", () => ({
  stylizeCoverPhotoWithGemini: (buf: Buffer, name: string) => stylizeCoverPhotoWithGemini(buf, name),
}));

/**
 * Обложка объекта для соцсетей (1080x1080 / 1080x1920 JPEG, владелец
 * 21.09.2026) — покрываем то, что не видно по сборке: точный размер обоих
 * форматов, честный отказ без фото, таджикские правила форматирования из
 * брифа («2 хонага», «890 000 TJS», ни «сомонӣ», ни «$»), и что отсутствующее
 * поле (этаж/район/ориентир у объекта-участка) не рисует пустую строку.
 */
const runId = Date.now().toString(36);
let districtId: string;
const propertyIds: string[] = [];
const photoFiles: string[] = [];

async function writeFakePhoto(filename: string): Promise<void> {
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
      title: `Тест-обложка-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 90,
      floor: 15,
      totalFloors: 16,
      price: 890000,
      currency: "TJS",
      districtId,
      address: "Парк Победы",
      condition: "GOOD",
      ...overrides,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Сино-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await Promise.all(photoFiles.map((f) => fs.rm(path.join(uploadsDir, f), { force: true })));
});

describe("обложка объекта для соцсетей (lib/video/coverPoster.ts)", () => {
  it("рисует JPEG ровно 1080x1080 в аспекте square", async () => {
    const property = await makeProperty();
    const filename = `cover-poster-${runId}-1.jpg`;
    await writeFakePhoto(filename);
    await prisma.propertyPhoto.create({
      data: { propertyId: property.id, url: `/uploads/${filename}`, thumbUrl: `/uploads/thumbs/${filename}`, order: 0 },
    });

    const result = await generateCoverPoster(property.id, "square");
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();

    const sharp = (await import("sharp")).default;
    const meta = await sharp(result.image!).metadata();
    expect(meta.width).toBe(COVER_SQUARE_SIZE);
    expect(meta.height).toBe(COVER_SQUARE_SIZE);
    expect(meta.format).toBe("jpeg");
  });

  it("рисует JPEG ровно 1080x1920 в аспекте story — тот же холст, что cover_url Reels", async () => {
    const property = await makeProperty();
    const filename = `cover-poster-${runId}-2.jpg`;
    await writeFakePhoto(filename);
    await prisma.propertyPhoto.create({
      data: { propertyId: property.id, url: `/uploads/${filename}`, thumbUrl: `/uploads/thumbs/${filename}`, order: 0 },
    });

    const result = await generateCoverPoster(property.id, "story");
    expect(result.ok).toBe(true);

    const sharp = (await import("sharp")).default;
    const meta = await sharp(result.image!).metadata();
    expect(meta.width).toBe(COVER_STORY_WIDTH);
    expect(meta.height).toBe(COVER_STORY_HEIGHT);
  });

  it("честно отказывает у объекта без единой фотографии, а не падает исключением", async () => {
    const property = await makeProperty();
    const result = await generateCoverPoster(property.id, "square");
    expect(result.ok).toBe(false);
    expect(result.image).toBeNull();
    expect(result.error).toMatch(/фотограф/i);
  });

  it("отказывает понятной ошибкой, а не исключением, для несуществующего объекта", async () => {
    const result = await generateCoverPoster("00000000-0000-0000-0000-000000000000", "square");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/не найден/i);
  });

  it("рисует по явно переданному кадру (ffmpeg-кадр ролика), не трогая фото объекта", async () => {
    const property = await makeProperty();
    const framePath = path.join(uploadsDir, `cover-poster-frame-${runId}.jpg`);
    const tinyJpeg = Buffer.from(
      "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
      "base64"
    );
    await fs.writeFile(framePath, tinyJpeg);
    try {
      // Объекту намеренно НЕ даём ни одной фотографии — если бы generateCoverPoster
      // тайком игнорировал sourceImagePath и лез за главным фото, здесь был бы отказ.
      const result = await generateCoverPoster(property.id, "story", framePath);
      expect(result.ok).toBe(true);
      expect(result.image).not.toBeNull();
    } finally {
      await fs.rm(framePath, { force: true });
    }
  });

  it("не оставляет дыр: объект-участок без комнат/этажа/района рисует валидную картинку", async () => {
    const property = await makeProperty({ type: "LAND", rooms: null, floor: null, totalFloors: null, districtId: null, address: null });
    const filename = `cover-poster-${runId}-3.jpg`;
    await writeFakePhoto(filename);
    await prisma.propertyPhoto.create({
      data: { propertyId: property.id, url: `/uploads/${filename}`, thumbUrl: `/uploads/thumbs/${filename}`, order: 0 },
    });

    const result = await generateCoverPoster(property.id, "square");
    expect(result.ok).toBe(true);
    const sharp = (await import("sharp")).default;
    const meta = await sharp(result.image!).metadata();
    expect(meta.width).toBe(COVER_SQUARE_SIZE);
  });

  it("style=gemini: обработанное фото идёт в отрисовку, styleApplied — правда", async () => {
    const property = await makeProperty();
    const filename = `cover-poster-${runId}-4.jpg`;
    await writeFakePhoto(filename);
    await prisma.propertyPhoto.create({
      data: { propertyId: property.id, url: `/uploads/${filename}`, thumbUrl: `/uploads/thumbs/${filename}`, order: 0 },
    });

    // Подделка возвращает ЗАВЕДОМО ДРУГУЮ картинку (зелёный квадрат 200×200),
    // чем исходное фото 1×1: если бы generateCoverPoster проигнорировал ответ
    // Gemini и рисовал по исходному пути, тест бы этого не заметил на
    // одинаковых буферах.
    const sharp = (await import("sharp")).default;
    const styled = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 120, b: 40 } },
    })
      .jpeg()
      .toBuffer();
    stylizeCoverPhotoWithGemini.mockResolvedValueOnce({ ok: true, image: styled, error: null, status: 200 });

    const result = await generateCoverPoster(property.id, "square", undefined, "gemini");
    expect(result.ok).toBe(true);
    expect(result.styleApplied).toBe(true);
    expect(stylizeCoverPhotoWithGemini).toHaveBeenCalledTimes(1);
    const meta = await sharp(result.image!).metadata();
    expect(meta.width).toBe(COVER_SQUARE_SIZE);
  });

  it("style=gemini: отказ Gemini не роняет обложку — рисуем исходным фото, styleApplied ложь", async () => {
    const property = await makeProperty();
    const filename = `cover-poster-${runId}-5.jpg`;
    await writeFakePhoto(filename);
    await prisma.propertyPhoto.create({
      data: { propertyId: property.id, url: `/uploads/${filename}`, thumbUrl: `/uploads/thumbs/${filename}`, order: 0 },
    });

    stylizeCoverPhotoWithGemini.mockResolvedValueOnce({
      ok: false,
      image: null,
      error: "Ключ Gemini не настроен",
      status: null,
    });

    const result = await generateCoverPoster(property.id, "square", undefined, "gemini");
    // Главное этого теста: отказ ИИ — это обложка БЕЗ обработки, а не отсутствие
    // обложки. Публикация ролика не должна вставать из-за недоступного Google.
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.styleApplied).toBe(false);
    const sharp = (await import("sharp")).default;
    const meta = await sharp(result.image!).metadata();
    expect(meta.width).toBe(COVER_SQUARE_SIZE);
  });

  it("без style обработка не зовётся вовсе — лишней траты квоты Gemini нет", async () => {
    const property = await makeProperty();
    const filename = `cover-poster-${runId}-6.jpg`;
    await writeFakePhoto(filename);
    await prisma.propertyPhoto.create({
      data: { propertyId: property.id, url: `/uploads/${filename}`, thumbUrl: `/uploads/thumbs/${filename}`, order: 0 },
    });

    stylizeCoverPhotoWithGemini.mockClear();
    const result = await generateCoverPoster(property.id, "square");
    expect(result.ok).toBe(true);
    expect(result.styleApplied).toBe(false);
    expect(stylizeCoverPhotoWithGemini).not.toHaveBeenCalled();
  });
});

describe("таджикские правила брифа (buildCoverPosterValues)", () => {
  const money = { usdToTjs: 10 };

  it("цена — строго «N NNN TJS», никогда сомонӣ/$/сокращений", () => {
    const values = buildCoverPosterValues(
      { rooms: 2, areaSqm: 90, floor: 15, price: 890000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
      money
    );
    // toLocaleString("ru-RU") группирует НЕразрывным пробелом (U+00A0), не
    // обычным — сравниваем той же локалью, а не пробелом с клавиатуры.
    expect(values.price).toBe(`${(890000).toLocaleString("ru-RU")} TJS`);
    expect(values.price).not.toMatch(/сомон|\$|USD|K\b/i);
  });

  it("объект в долларах переводится в сомони тем же курсом, что и остальной проект — не долларом на обложке", () => {
    const values = buildCoverPosterValues(
      { rooms: 2, areaSqm: 90, floor: 15, price: 1000, currency: "USD", districtName: null, address: null },
      money
    );
    expect(values.price).toBe(`${(10000).toLocaleString("ru-RU")} TJS`);
  });

  it("«N хонага», «N м²», «N ошёна» — точные подписи брифа", () => {
    const values = buildCoverPosterValues(
      { rooms: 2, areaSqm: 90, floor: 15, price: 890000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
      money
    );
    expect(values.roomsNumber).toBe("2");
    expect(values.roomsWord).toBe("хонага");
    expect(values.area).toBe("90 м²");
    expect(values.floor).toBe("15 ошёна");
  });

  it("нет этажа — floor null, а не «null ошёна» или пустая строка", () => {
    const values = buildCoverPosterValues(
      { rooms: 2, areaSqm: 90, floor: null, price: 890000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
      money
    );
    expect(values.floor).toBeNull();
  });

  it("нет комнат (участок) — вместо цифры комнат крупно площадь и подпись «квадрат»", () => {
    const values = buildCoverPosterValues(
      { rooms: null, areaSqm: 582, floor: null, price: 890000, currency: "TJS", districtName: null, address: null },
      money
    );
    expect(values.roomsNumber).toBe("582");
    expect(values.roomsWord).toBe("квадрат");
    expect(values.heroKind).toBe("area");
  });

  it("участок с сотками — крупно сотки и подпись «сотих», а не квадраты", () => {
    const values = buildCoverPosterValues(
      { rooms: null, areaSqm: 600, landAreaSotka: 6, floor: null, price: 890000, currency: "TJS", districtName: null, address: null },
      money
    );
    expect(values.roomsNumber).toBe("6");
    expect(values.roomsWord).toBe("сотих");
    expect(values.heroKind).toBe("area");
  });

  it("дробные сотки — с запятой; пустые или нулевые — откат на квадраты", () => {
    const base = { rooms: null, areaSqm: 450, floor: null, price: 890000, currency: "TJS", districtName: null, address: null };
    expect(buildCoverPosterValues({ ...base, landAreaSotka: "6.5" }, money).roomsNumber).toBe("6,5");
    for (const landAreaSotka of [null, 0, undefined]) {
      const values = buildCoverPosterValues({ ...base, landAreaSotka }, money);
      expect(values.roomsNumber).toBe("450");
      expect(values.roomsWord).toBe("квадрат");
    }
  });

  it("с комнатами сотки не подменяют цифру комнат (дом 5 комнат на 6 сотках)", () => {
    const values = buildCoverPosterValues(
      { rooms: 5, areaSqm: 200, landAreaSotka: 6, floor: null, price: 890000, currency: "TJS", districtName: null, address: null },
      money
    );
    expect(values.roomsNumber).toBe("5");
    expect(values.roomsWord).toBe("хонага");
  });

  it("дробная площадь без комнат округляется до целого в крупной цифре", () => {
    const values = buildCoverPosterValues(
      { rooms: null, areaSqm: 112.5, floor: null, price: 890000, currency: "TJS", districtName: null, address: null },
      money
    );
    expect(values.roomsNumber).toBe("113");
  });

  it("7 комнат — цифра и «хонага» рисуются (раньше отсекалось на 6)", () => {
    const values = buildCoverPosterValues(
      { rooms: 7, areaSqm: 300, floor: 2, price: 890000, currency: "TJS", districtName: null, address: null },
      money
    );
    expect(values.roomsNumber).toBe("7");
    expect(values.roomsWord).toBe("хонага");
  });

  it("1 и 9 комнат — границы диапазона, цифра есть", () => {
    for (const rooms of [1, 9]) {
      const values = buildCoverPosterValues(
        { rooms, areaSqm: 60, floor: null, price: 890000, currency: "TJS", districtName: null, address: null },
        money
      );
      expect(values.roomsNumber).toBe(String(rooms));
    }
  });

  it("10, 12 и 99 комнат — цифра рисуется целиком (раньше потолок был 9)", () => {
    for (const rooms of [10, 12, 99]) {
      const values = buildCoverPosterValues(
        { rooms, areaSqm: 400, floor: 2, price: 890000, currency: "TJS", districtName: null, address: null },
        money
      );
      expect(values.roomsNumber).toBe(String(rooms));
      expect(values.roomsWord).toBe("хонага");
      expect(values.heroKind).toBe("rooms");
    }
  });

  it("0, 100 и дробное число комнат — это не комнаты: крупно площадь", () => {
    for (const rooms of [0, 100, 2.5]) {
      const values = buildCoverPosterValues(
        { rooms, areaSqm: 60, floor: null, price: 890000, currency: "TJS", districtName: null, address: null },
        money
      );
      expect(values.roomsNumber).toBe("60");
      expect(values.heroKind).toBe("area");
    }
  });
});

/** Геометрия — содержательный блок (снизу) не должен наезжать на логотип
 *  (сверху), с запасом хотя бы на минимальный клин фотографии между ними —
 *  тот же принцип проверки без похода в БД/sharp, что у
 *  computeStoryCardTextLayout в storyCard.test.ts. */
describe("раскладка обложки (computeCoverPosterLayout)", () => {
  const values = buildCoverPosterValues(
    { rooms: 2, areaSqm: 90, floor: 15, price: 890000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
    { usdToTjs: 10 }
  );

  it("квадрат 1080x1080: контент не начинается выше низа логотипа", () => {
    const layout = computeCoverPosterLayout(COVER_SQUARE_SIZE, COVER_SQUARE_SIZE, values);
    expect(layout.contentTopY).toBeGreaterThanOrEqual(layout.logoBottomY);
  });

  it("вертикаль 1080x1920: контент ниже логотипа, ключевой блок в центральной зоне 1:1 (кроп сетки профиля)", () => {
    const layout = computeCoverPosterLayout(COVER_STORY_WIDTH, COVER_STORY_HEIGHT, values);
    expect(layout.contentTopY).toBeGreaterThanOrEqual(layout.logoBottomY);
    // Кроп 1:1 из середины 1080x1920 — полоса y 420..1500: цифра комнат обязана
    // в неё попасть, иначе в сетке профиля обложка без главного.
    expect(layout.contentTopY).toBeGreaterThanOrEqual(420);
    expect(layout.contentTopY).toBeLessThan(1500);
    expect(layout.contentBottomY).toBeLessThanOrEqual(COVER_STORY_HEIGHT);
  });

  it("безопасная зона — пересечение реальных кропов показа", () => {
    // Квадрат: карточка сайта 16:10 (самое тесное), объявление на телефоне 4:3,
    // сетка Instagram 4:5 — все по центру (site-pr-verify: CardPhotoCarousel,
    // ListingDetailPage). Вертикаль: сетка Instagram 4:5 и кроп профиля 1:1 на y=420.
    const square = computeCoverPosterLayout(COVER_SQUARE_SIZE, COVER_SQUARE_SIZE, values).safeZone;
    expect(square.x).toBeGreaterThanOrEqual(108); // 4:5 → x 108…972
    expect(square.x + square.width).toBeLessThanOrEqual(972);
    expect(square.y).toBeGreaterThanOrEqual(202.5); // 16:10 → y 202,5…877,5
    expect(square.y + square.height).toBeLessThanOrEqual(877.5);

    const story = computeCoverPosterLayout(COVER_STORY_WIDTH, COVER_STORY_HEIGHT, values).safeZone;
    expect(story.y).toBeGreaterThanOrEqual(420);
    expect(story.y + story.height).toBeLessThanOrEqual(1500);
  });

  it("цена в SVG: число и «TJS» отдельными строками, «TJS» мельче; площадь дробью с запятой", () => {
    const v = buildCoverPosterValues(
      { rooms: 3, areaSqm: 112.5, floor: 7, price: 890000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
      { usdToTjs: 10 }
    );
    expect(v.priceNumber).toBe("890 000");
    expect(v.areaNumber).toBe("112,5");
    const { textSvg } = buildCoverPosterSvg(COVER_SQUARE_SIZE, COVER_SQUARE_SIZE, v);
    const size = (content: string): number => Number(new RegExp(`font-size="([0-9.]+)"[^>]*>${content}<`).exec(textSvg)![1]);
    expect(size("TJS")).toBeLessThan(size("890 000"));
    // нижняя строка — капслоком, как в эталоне
    expect(textSvg).toContain("РАЙОН: СИНО");
    expect(textSvg).toContain("ОРИЕНТИР: ПАРК ПОБЕДЫ");
    expect(textSvg).toContain("7 ОШЁНА");
  });

  it("пустые поля не рисуют строк: нет района/ориентира/этажа — нет «РАЙОН:», «ОРИЕНТИР:», «ЭТАЖ»", () => {
    const v = buildCoverPosterValues(
      { rooms: 2, areaSqm: 90, floor: null, price: 890000, currency: "TJS", districtName: null, address: null },
      { usdToTjs: 10 }
    );
    const { textSvg } = buildCoverPosterSvg(COVER_SQUARE_SIZE, COVER_SQUARE_SIZE, v);
    expect(textSvg).not.toContain("РАЙОН:");
    expect(textSvg).not.toContain("ОРИЕНТИР:");
    expect(textSvg).not.toContain("ЭТАЖ");
    expect(textSvg).not.toMatch(/null|undefined/);
  });

  it("«м²» рядом с площадью ростом как на эталоне, а не вдвое мельче", () => {
    const v = buildCoverPosterValues(
      { rooms: 2, areaSqm: 90, floor: 15, price: 890000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
      { usdToTjs: 10 }
    );
    const canvases = [
      [COVER_SQUARE_SIZE, COVER_SQUARE_SIZE],
      [COVER_STORY_WIDTH, COVER_STORY_HEIGHT],
    ] as const;
    for (const [w, h] of canvases) {
      const { textSvg } = buildCoverPosterSvg(w, h, v);
      const size = (content: string): number => Number(new RegExp(`font-size="([0-9.]+)"[^>]*>${content}<`).exec(textSvg)![1]);
      // Высота глифа — кегль × ЕГО собственная мерка: у цифр высота заглавной,
      // у строчной «м» — x-height, у «²» — свой рост. Через высоту заглавной
      // «м» и «²» рисовались 0,42 и 0,13 от цифр вместо эталонных 0,78 и 0,26
      // (замер IMG_9508 22.09) — эта проверка и сторожит тот промах.
      const digits = size("90") * COVER_CAP_HEIGHT;
      const unit = size("м") * COVER_X_HEIGHT;
      const sup = size("²") * COVER_SUP_HEIGHT;
      expect(unit / digits).toBeGreaterThan(0.7);
      expect(unit / digits).toBeLessThan(0.85);
      expect(sup / digits).toBeGreaterThan(0.2);
      expect(sup / digits).toBeLessThan(0.32);
    }
  });

  it("после Gemini своя цветокоррекция мягче — обработанное фото не красится дважды", async () => {
    // Нейтральный серый: на нём видно ровно то, что делает цветокоррекция, и
    // ничего больше. Полный набор тянет красный вверх, синий вниз (тёплая
    // `recomb`) и поднимает яркость; мягкий — оставляет серый серым.
    const sharp = (await import("sharp")).default;
    const gray = await sharp({
      create: { width: 1200, height: 1200, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .jpeg()
      .toBuffer();
    const values = buildCoverPosterValues(
      { rooms: 2, areaSqm: 90, floor: 15, price: 890000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
      { usdToTjs: 10 }
    );
    const skew = async (styled: boolean): Promise<{ red: number; warm: number }> => {
      const out = await renderCoverPosterImage(gray, values, "square", null, styled);
      const { channels } = await sharp(out).stats();
      return { red: channels[0].mean, warm: channels[0].mean - channels[2].mean };
    };
    const plain = await skew(false);
    const afterGemini = await skew(true);
    // Промт Gemini просит у модели то же самое («ярко, сочно, тепло»), поэтому
    // поверх её ответа тот же набор кладётся вторым слоем и пересвечивает кадр.
    expect(afterGemini.red).toBeLessThan(plain.red);
    expect(afterGemini.warm).toBeLessThan(plain.warm);
  });

  it("дорогая цена остаётся внутри плашки — уменьшается кегль, а не обрезается плашка", () => {
    // Плашка бралась по минимуму (`Math.min(предел, нужная ширина)`), а текст
    // рисовался натуральной величины: с 13 000 000 TJS «TJS» уходил за край
    // плашки в вертикали, а к 20 000 000 — и за холст. 13 млн сомони — это
    // около 1,2 млн долларов, обычная коммерция; картинка при этом рисуется
    // без единой ошибки, поэтому ни сборка, ни остальные тесты такого не видят.
    const plateRx = /<rect x="([0-9.]+)" y="[0-9.]+" width="([0-9.]+)" height="[0-9.]+" rx="[0-9.]+" fill="url\(#goldGradient\)"\/>/;
    const curRx = /<text (?:x="([0-9.]+)"|transform="translate\(([0-9.]+) [0-9.]+\)[^"]*")[^>]*?font-size="([0-9.]+)"[^>]*>TJS<\/text>/;
    const canvases = [
      [COVER_SQUARE_SIZE, COVER_SQUARE_SIZE],
      [COVER_STORY_WIDTH, COVER_STORY_HEIGHT],
    ] as const;
    for (const price of [890_000, 20_000_000]) {
      const v = buildCoverPosterValues(
        { rooms: 3, areaSqm: 120, floor: 9, price, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
        { usdToTjs: 10.9 }
      );
      for (const [w, h] of canvases) {
        const { textSvg } = buildCoverPosterSvg(w, h, v);
        const plate = plateRx.exec(textSvg)!;
        const plateRight = Number(plate[1]) + Number(plate[2]);
        const cur = curRx.exec(textSvg)!;
        const curSize = Number(cur[3]);
        // Ширина «TJS» с запасом — тем же грубым коэффициентом, что svgText.ts.
        const curRight = Number(cur[1] ?? cur[2]) + curSize * 0.62 * 3;
        expect(curRight).toBeLessThanOrEqual(plateRight);
      }
    }
    // Обычная цена не должна мельчать заодно с дорогой: подгонка включается
    // только когда надпись действительно не влезает.
    const story = buildCoverPosterSvg(
      COVER_STORY_WIDTH,
      COVER_STORY_HEIGHT,
      buildCoverPosterValues(
        { rooms: 3, areaSqm: 120, floor: 9, price: 890_000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
        { usdToTjs: 10.9 }
      )
    ).textSvg;
    const bigStory = buildCoverPosterSvg(
      COVER_STORY_WIDTH,
      COVER_STORY_HEIGHT,
      buildCoverPosterValues(
        { rooms: 3, areaSqm: 120, floor: 9, price: 100_000_000_000_000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
        { usdToTjs: 10.9 }
      )
    ).textSvg;
    const size = (svg: string, content: string): number =>
      Number(new RegExp(`font-size="([0-9.]+)"[^>]*>${content}<`).exec(svg)![1]);
    // Порог подгонки после переноса вертикали на координаты исходника владельца
    // (плашка растёт до x=990) сдвинулся далеко вправо: 20 млн теперь влезают
    // как есть и кегль не трогается. Сравниваем с заведомо не влезающей ценой —
    // проверка сторожит сам механизм, а не конкретное число.
    expect(size(story, "890 000")).toBeGreaterThan(size(bigStory, "100 000 000 000 000"));
  });

  it("ни одна надпись и плашка не уходит за край — ни в одном формате, ни на одних данных", () => {
    // Класс поломки, найденной на цене 22.09: раскладка посчитана под
    // «обычный» объект, а на краю значений элемент молча вылезает за холст.
    // Картинка при этом валидная, размер правильный — остальные тесты такого
    // не видят. Здесь перебираются края: участок без комнат и этажа, шесть
    // комнат, дробная площадь, дорогая коммерция, доллары, длинные район и
    // ориентир разом, пустые поля.
    const cases: { name: string; p: Parameters<typeof buildCoverPosterValues>[0] }[] = [
      { name: "обычная квартира", p: { rooms: 2, areaSqm: 90, floor: 15, price: 890_000, currency: "TJS", districtName: "Сино", address: "Парк Победы" } },
      { name: "шесть комнат", p: { rooms: 6, areaSqm: 240, floor: 3, price: 3_500_000, currency: "TJS", districtName: "Сино", address: "Парк Победы" } },
      { name: "участок без комнат и этажа", p: { rooms: null, areaSqm: 12000, floor: null, price: 4_500_000, currency: "TJS", districtName: "Рудаки", address: null } },
      { name: "дробная площадь", p: { rooms: 3, areaSqm: 112.5, floor: 7, price: 1_200_000, currency: "TJS", districtName: "Сино", address: "Парк Победы" } },
      { name: "дорогая коммерция", p: { rooms: null, areaSqm: 1850, floor: null, price: 28_000_000, currency: "TJS", districtName: "Фирдавсӣ", address: "Проспект Рудаки" } },
      { name: "доллары, 1,5 млн", p: { rooms: 5, areaSqm: 320, floor: 2, price: 1_500_000, currency: "USD", districtName: "Сино", address: "Парк Победы" } },
      {
        name: "всё длинное разом",
        p: {
          rooms: 6,
          areaSqm: 12345.5,
          floor: 24,
          price: 128_500_000,
          currency: "TJS",
          districtName: "Исмоили Сомонӣ (бывший Фрунзенский)",
          address: "Напротив рынка Корвон, за новым мостом через канал, дом 14 корпус 2",
        },
      },
      { name: "10 комнат", p: { rooms: 10, areaSqm: 480, floor: 2, price: 2_500_000, currency: "TJS", districtName: "Сино", address: null } },
      { name: "без района и ориентира", p: { rooms: 2, areaSqm: 90, floor: 15, price: 890_000, currency: "TJS", districtName: null, address: null } },
    ];
    const canvases = [
      [COVER_SQUARE_SIZE, COVER_SQUARE_SIZE, "квадрат"],
      [COVER_STORY_WIDTH, COVER_STORY_HEIGHT, "вертикаль"],
    ] as const;

    for (const { name, p } of cases) {
      const values = buildCoverPosterValues(p, { usdToTjs: 10.9 });
      for (const [w, h, layout] of canvases) {
        // Каждая надпись, плашка, иконка и эмблема обязаны лежать внутри
        // БЕЗОПАСНОЙ ЗОНЫ, а не просто внутри холста: сайт режет квадрат до
        // 16:10, сетка Instagram — до 4:5, и «внутри холста» там уже поздно
        // (жалоба владельца 23.09: «ДУШАНБЕ» и адрес ушли под обрез карточки).
        const { safeZone: z, inkBoxes } = computeCoverPosterLayout(w, h, values);
        expect(inkBoxes.length).toBeGreaterThan(5);
        const out: string[] = [];
        for (const b of inkBoxes) {
          if (b.x < z.x - 0.5 || b.y < z.y - 0.5 || b.x + b.width > z.x + z.width + 0.5 || b.y + b.height > z.y + z.height + 0.5) {
            out.push(`${b.id} ${b.x.toFixed(0)},${b.y.toFixed(0)} ${b.width.toFixed(0)}×${b.height.toFixed(0)}`);
          }
        }
        expect(`${name} / ${layout}: ${out.join("; ") || "всё внутри"}`).toBe(`${name} / ${layout}: всё внутри`);
      }
    }
  });

  it("каждое начертание, которое просит шаблон, лежит файлом в assets/fonts/cover", async () => {
    // Уже кусалось 22.09: у TTNormsPro-Bold нет typographic-family (nameID 16),
    // и pango на запрос веса 700 молча отдавал серифный запасной шрифт. На
    // сервере font-family резолвит СИСТЕМНЫЙ fontconfig по файлам, которые
    // Dockerfile кладёт в /usr/share/fonts (см. apps/api/Dockerfile), поэтому
    // просить начертание, которого нет файлом, — значит получить чужой шрифт
    // на готовой картинке, без единой ошибки в журнале.
    const FILES: Record<string, string> = {
      "TT Norms Pro/500": "TTNormsPro-Medium.ttf",
      "TT Norms Pro/800": "TTNormsPro-ExtraBold.ttf",
      "Playfair Display/700": "PlayfairDisplay-Bold.ttf",
    };
    const values = buildCoverPosterValues(
      { rooms: 2, areaSqm: 90, floor: 15, price: 890_000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
      { usdToTjs: 10 }
    );
    const asked = new Set<string>();
    for (const [w, h] of [
      [COVER_SQUARE_SIZE, COVER_SQUARE_SIZE],
      [COVER_STORY_WIDTH, COVER_STORY_HEIGHT],
    ] as const) {
      const { textSvg } = buildCoverPosterSvg(w, h, values);
      for (const m of textSvg.matchAll(/font-family="([^"]+)" font-weight="([0-9]+)"/g)) asked.add(`${m[1]}/${m[2]}`);
    }
    expect(asked.size).toBeGreaterThan(0);
    const fontsDir = path.join(import.meta.dirname, "..", "assets", "fonts", "cover");
    for (const key of asked) {
      // Нет в списке — либо завели новое начертание и не положили файл, либо
      // положили, но не дописали сюда и в Dockerfile.
      expect(FILES[key], `шаблон просит «${key}», а файла для этого начертания нет`).toBeDefined();
      await expect(fs.access(path.join(fontsDir, FILES[key]))).resolves.toBeUndefined();
    }
  });

  it("длинный ориентир не выталкивает контент выше логотипа", () => {
    const longValues = buildCoverPosterValues(
      {
        rooms: 2,
        areaSqm: 90,
        floor: 15,
        price: 890000,
        currency: "TJS",
        districtName: "Сино",
        address: "Очень длинный ориентир: напротив рынка Корвон, за новым мостом через канал",
      },
      { usdToTjs: 10 }
    );
    const layout = computeCoverPosterLayout(COVER_SQUARE_SIZE, COVER_SQUARE_SIZE, longValues);
    expect(layout.contentTopY).toBeGreaterThanOrEqual(layout.logoBottomY);
  });
});
