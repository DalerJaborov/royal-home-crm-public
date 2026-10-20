import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import sharp from "sharp";

/**
 * ЗНАК В КРЕМОВОЙ ПОЛОСЕ (01.10.2026). Владелец: знак «ROYAL HOME TJ» торчит за край светлой полосы —
 * у модели она 205–250 px, а знак стоял с x=131 при ширине ~160. Тела здесь синтетические (кремовая
 * полоса заданной ширины + зелёное «фото»); сети нет.
 */
const {
  fitLogoToStrip,
  measureCreamStrip,
  placeLogoInStrip,
  stripRightEdge,
  isCreamPixel,
  storyFromGenerated,
  OWNER_LOGO_PATH,
  MODEL_LOGO_BOX,
  STORY_34_TOP,
  STRIP_FALLBACK_RIGHT,
} = await import("../src/lib/video/coverOpenAi.js");

const CREAM = { r: 245, g: 238, b: 220 };
const GREEN = { r: 30, g: 90, b: 60 };
const W = 1080;
const H = 1440;

/** Тело 3:4: слева кремовая полоса шириной `strip` (0 — без полосы), справа «фото» зелёного цвета. */
async function bodyWithStrip(strip: number, opts: { stripFrom?: number } = {}): Promise<Buffer> {
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = x < strip && y >= (opts.stripFrom ?? 0) ? CREAM : GREEN;
      const i = (y * W + x) * 3;
      raw[i] = c.r;
      raw[i + 1] = c.g;
      raw[i + 2] = c.b;
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

async function px(img: Buffer, left: number, top: number) {
  const { data } = await sharp(img).extract({ left, top, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return { r: data[0], g: data[1], b: data[2] };
}

const PAD = Math.round(W * 0.04);

describe("кремовый пиксель и край полосы", () => {
  it("кремовый — светлый и малонасыщенный; золото, зелень и тёмное — нет", () => {
    expect(isCreamPixel(245, 238, 220)).toBe(true);
    expect(isCreamPixel(255, 255, 255)).toBe(true);
    expect(isCreamPixel(212, 175, 55)).toBe(false); // золото
    expect(isCreamPixel(30, 90, 60)).toBe(false); // зелёная панель
    expect(isCreamPixel(120, 120, 120)).toBe(false); // тёмное
  });

  it("край — минимум по строкам, одиночный тёмный пиксель шумом не обрывает полосу", () => {
    const w = 600;
    const raw = Buffer.alloc(w * 4 * 3, 20);
    const put = (x: number, y: number, c: { r: number; g: number; b: number }) => {
      const i = (y * w + x) * 3;
      raw[i] = c.r;
      raw[i + 1] = c.g;
      raw[i + 2] = c.b;
    };
    const widths = [230, 210, 250, 220];
    widths.forEach((sw, y) => {
      for (let x = 0; x < sw; x++) put(x, y, CREAM);
    });
    put(100, 0, GREEN); // одиночный выброс в строке 0
    expect(stripRightEdge(raw, w, [0, 1, 2, 3])).toBe(210);
  });
});

describe("fitLogoToStrip: знак целиком внутри полосы, по центру", () => {
  const aspect = 510 / 642;
  for (const strip of [205, 250]) {
    it(`полоса ${strip} px: [pad, strip−pad], центр по полосе, высота не больше бокса`, () => {
      const fit = fitLogoToStrip(aspect, strip);
      const pad = Math.min(PAD, Math.floor(strip / 3));
      expect(fit.left).toBeGreaterThanOrEqual(pad);
      expect(fit.left + fit.width).toBeLessThanOrEqual(strip - pad);
      // Левый и правый зазоры равны с точностью до пикселя.
      expect(Math.abs(fit.left - (strip - fit.left - fit.width))).toBeLessThanOrEqual(1);
      expect(fit.height).toBeLessThanOrEqual(MODEL_LOGO_BOX.story34.height);
      expect(fit.height).toBeGreaterThan(100);
    });
  }

  it("очень узкая полоса: знак мельче, но не вылезает", () => {
    const fit = fitLogoToStrip(aspect, 90);
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.left + fit.width).toBeLessThanOrEqual(90);
    expect(fit.width).toBeGreaterThan(0);
  });

  it("полоса не измерена (null): прежняя высота не растёт, правый край не дальше 200 px", () => {
    const fit = fitLogoToStrip(aspect, null);
    expect(fit.left + fit.width).toBeLessThanOrEqual(STRIP_FALLBACK_RIGHT);
    expect(fit.height).toBeLessThanOrEqual(MODEL_LOGO_BOX.story34.height);
    expect(fit.left).toBeGreaterThanOrEqual(0);
  });

  it("широкая полоса: размер не больше бокса (206 px по высоте)", () => {
    const fit = fitLogoToStrip(aspect, 400);
    expect(fit.height).toBeLessThanOrEqual(MODEL_LOGO_BOX.story34.height);
  });
});

describe("placeLogoInStrip на синтетических телах", () => {
  it.each([205, 250])("полоса %i px: измерена точно, знак целиком внутри и по центру, за полосой — фото", async (strip) => {
    const body = await bodyWithStrip(strip);
    expect(await measureCreamStrip(body)).toBe(strip);
    const logo = await fs.readFile(OWNER_LOGO_PATH);
    const layer = await placeLogoInStrip(logo, body);
    const meta = await sharp(layer.input).metadata();
    expect(layer.top).toBe(STORY_34_TOP + MODEL_LOGO_BOX.story34.top);
    expect(layer.left).toBeGreaterThanOrEqual(Math.min(PAD, Math.floor(strip / 3)));
    expect(layer.left + meta.width!).toBeLessThanOrEqual(strip - Math.min(PAD, Math.floor(strip / 3)));
    expect(Math.abs(layer.left - (strip - layer.left - meta.width!))).toBeLessThanOrEqual(1);

    // На готовом кадре правее полосы — по-прежнему «фото», знак его не закрыл.
    const story = await storyFromGenerated(body, layer, { portrait34: true, format: "png" });
    const rowMid = layer.top + Math.round(meta.height! / 2);
    expect(await px(story, strip + 2, rowMid)).toEqual(GREEN);
    expect(await px(story, strip + 40, rowMid)).toEqual(GREEN);
  });

  it("полосы нет (всё зелёное): запасной вариант, знак не правее 200 px", async () => {
    const body = await bodyWithStrip(0);
    expect(await measureCreamStrip(body)).toBeNull();
    const layer = await placeLogoInStrip(await fs.readFile(OWNER_LOGO_PATH), body);
    const meta = await sharp(layer.input).metadata();
    expect(layer.left + meta.width!).toBeLessThanOrEqual(STRIP_FALLBACK_RIGHT);
  });

  it("полоса начинается ниже строк знака (в диапазоне знака полосы нет): запасной вариант", async () => {
    const body = await bodyWithStrip(230, { stripFrom: 600 });
    expect(await measureCreamStrip(body)).toBeNull();
  });

  it("тело другого размера (1152×1536) приводится к 1080×1440 до измерения", async () => {
    const small = await sharp(await bodyWithStrip(230)).resize(1152, 1536, { fit: "fill" }).png().toBuffer();
    const measured = await measureCreamStrip(small);
    expect(measured).not.toBeNull();
    expect(Math.abs(measured! - 230)).toBeLessThanOrEqual(3);
  });
});
