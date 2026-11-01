import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * ОБЛОЖКИ CHATGPT v3 — режим OVERLAY (25.09.2026): модель рисует пустые панели,
 * текст кладём мы. Сеть подменена: images/edits → нейтральная подложка; зрение
 * отвечает по тексту запроса (разбор пустого оформления / финальная проверка /
 * выбор лучшей). Проверяем раскладку по рамкам, запасную раскладку эталона,
 * цифру комнат нашим слоем, отбраковку лишних символов и изменённого фото.
 */
const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

// Параметры генерации — константы с 01.11.2026 (lib/settingsConstants.ts): тест
// подменяет их здесь, а не строкой Settings, которую сервер больше не читает.
const tuning = vi.hoisted(() => ({
  imageQuality: "medium", candidates: 1, textMode: "OVERLAY", imageModel: "gpt-image-2.5-sunburst", photoSource: "MODEL",
}));
vi.mock("../src/lib/settingsConstants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/settingsConstants.js")>()),
  OPENAI_COVER_TUNING: tuning,
}));

const { prisma } = await import("../src/db.js");
const { uploadsDir, propertyCoversDir } = await import("../src/upload.js");
const { encryptSecret } = await import("../src/crypto.js");
const { makePropertyCover, buildOverlayPrompt, loadOwnerPrompt, ANALYZE_PROMPT, INSPECT_PROMPT, COVER_IMAGE_ENDPOINT, COVER_CHECK_ENDPOINT, defaultCandidates } =
  await import("../src/lib/video/coverOpenAi.js");
const { buildTextLayerSvg, FIXED_PANELS, overlayCoverText } = await import("../src/lib/video/coverTextLayer.js");
const { buildCoverPosterValues } = await import("../src/lib/video/coverPoster.js");

const runId = Date.now().toString(36);
const districtName = `Сино-ОВ-${runId}`;
const propertyIds: string[] = [];
const files: string[] = [];
let districtId: string;
let settingsBefore: Record<string, unknown> | null = null;
let blankPng: Buffer;

const values = buildCoverPosterValues(
  { rooms: 3, areaSqm: 112.5, floor: 15, price: 1700000, currency: "TJS", districtName: "Фирдавсӣ", address: null },
  { usdToTjs: 10.9 }
);

const GOOD_PANELS = {
  roomsDigit: { x: 0.15, y: 0.15, w: 0.3, h: 0.28, angle: -6 },
  roomsWord: { x: 0.04, y: 0.45, w: 0.6, h: 0.12, angle: -6 },
  price: { x: 0.04, y: 0.6, w: 0.58, h: 0.18, angle: -3 },
  area: { x: 0.65, y: 0.6, w: 0.3, h: 0.17, angle: -4 },
  bottom: { x: 0.18, y: 0.83, w: 0.64, h: 0.08, angle: 0 },
};

async function writeUpload(name: string, buffer: Buffer): Promise<string> {
  await fs.writeFile(path.join(uploadsDir, name), buffer);
  files.push(path.join(uploadsDir, name));
  return `/uploads/${name}`;
}

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Тест-обложка-ОВ-${runId}-${propertyIds.length}`,
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
    },
  });
  propertyIds.push(p.id);
  const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
  const url = await writeUpload(`cover-ov-${runId}-${propertyIds.length}.jpg`, photo);
  await prisma.propertyPhoto.create({ data: { propertyId: p.id, url, thumbUrl: url, order: 0 } });
  return p;
}

type Analysis = { symbols?: string[]; photo_same?: boolean; added?: string; panels?: unknown };

function goodFinal() {
  return {
    rooms: 2,
    price: "890 000",
    area: "90",
    floor: 15,
    words: ["ХОНАГА", "НАРХ", "TJS", "М²", "МАСОҲАТ", "ОШЁНА", "ЭТАЖ", "ДУШАНБЕ", "РАЙОН:", districtName.toUpperCase()],
    photo_same: true,
  };
}

/** Подменённый fetch. `analyses` — ответы разбора пустого оформления по очереди (по умолчанию: цифра «2», фото то же, рамки годные). */
function stubOpenAi(opts: { analyses?: Analysis[]; finals?: unknown[] } = {}) {
  const calls = { imageRequests: 0, analyze: 0, inspect: 0, pick: 0, prompts: [] as string[] };
  const analyses = [...(opts.analyses ?? [])];
  const finals = [...(opts.finals ?? [])];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    let body: unknown;
    if (url.endsWith("/images/edits")) {
      calls.imageRequests++;
      const form = init.body as FormData;
      calls.prompts.push(String(form.get("prompt")));
      const n = Number(form.get("n") ?? 1);
      body = { data: Array.from({ length: n }, () => ({ b64_json: blankPng.toString("base64") })) };
    } else {
      const text = JSON.parse(String(init.body)).messages[0].content[0].text as string;
      let content: unknown;
      if (text === ANALYZE_PROMPT) {
        calls.analyze++;
        content = analyses.length ? analyses.shift() : { symbols: ["2"], photo_same: true, panels: GOOD_PANELS };
      } else if (text === INSPECT_PROMPT) {
        calls.inspect++;
        content = finals.length ? finals.shift() : goodFinal();
      } else {
        calls.pick++;
        content = { best: 1 };
      }
      body = { choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 1000, completion_tokens: 50 } };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: districtName } })).id;
  blankPng = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 60, g: 55, b: 50 } } }).png().toBuffer();
  settingsBefore = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { coverProvider: true, openaiApiKey: true, coverGenerationEnabled: true, openaiCoverDailyLimit: true, openaiCandidates: true, openaiTextMode: true, openaiPhotoSource: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { openaiApiKey: encryptSecret("sk-test-overlay"), coverProvider: "OPENAI", coverGenerationEnabled: true, openaiCoverDailyLimit: 1000 },
  });
});

beforeEach(async () => {
  logSystemError.mockClear();
  await prisma.aiLog.deleteMany({ where: { endpoint: { in: [COVER_IMAGE_ENDPOINT, COVER_CHECK_ENDPOINT] } } });
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  const covers = await prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { socialCoverSquareUrl: true, socialCoverStoryUrl: true } });
  for (const c of covers) for (const u of [c.socialCoverSquareUrl, c.socialCoverStoryUrl]) if (u) files.push(path.join(propertyCoversDir, path.basename(u)));
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await Promise.all(files.map((f) => fs.rm(f, { force: true })));
});

describe("текстовый слой", () => {
  it("текст стоит внутри рамок: цена в рамке price, наклон панели", () => {
    const svg = buildTextLayerSvg(1080, 1080, values, GOOD_PANELS, false, "square", false);
    expect(svg).toContain(">1 700 000<");
    expect(svg).toContain(">МАСОҲАТ<");
    expect(svg).toContain(">15 ОШЁНА<");
    expect(svg).toContain(">РАЙОН: ФИРДАВСӢ<");
    const priceGroup = svg.match(/<g transform="rotate\(-3 ([\d.]+) ([\d.]+)\)">(.*?)<\/g>/);
    expect(priceGroup).not.toBeNull();
    const [cx, cy] = [Number(priceGroup![1]), Number(priceGroup![2])];
    expect(cx).toBeCloseTo((0.04 + 0.29) * 1080, 0);
    expect(cy).toBeCloseTo((0.6 + 0.09) * 1080, 0);
    const xs = [...priceGroup![3].matchAll(/x="([\d.]+)"/g)].map((m) => Number(m[1]));
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0.04 * 1080);
      expect(x).toBeLessThanOrEqual(0.62 * 1080);
    }
  });
  it("панели наши: чёрное стекло, золотая цена, иконки нижнего блока", () => {
    const svg = buildTextLayerSvg(1080, 1080, values, GOOD_PANELS, false);
    expect(svg).toContain('fill="url(#goldPlate)"');
    expect(svg).toContain('fill="url(#glassDark)"');
    expect(svg.match(/<path /g)?.length).toBeGreaterThanOrEqual(4);
  });
  it("цифра комнат рисуется нами только при drawDigit — золотым градиентом", () => {
    expect(buildTextLayerSvg(1080, 1080, values, GOOD_PANELS, false)).not.toContain('fill="url(#gold)"');
    const svg = buildTextLayerSvg(1080, 1080, values, { ...GOOD_PANELS, roomsDigit: null }, true);
    expect(svg).toMatch(/fill="url\(#gold\)"[^>]*>3</);
  });
  it("нет этажа — нижний ряд без «ЭТАЖ»", () => {
    const noFloor = { ...values, floor: null };
    expect(buildTextLayerSvg(1080, 1080, noFloor, GOOD_PANELS, false)).not.toContain(">ЭТАЖ<");
  });
  it("наложение даёт картинку нужного размера и меняет пиксели в рамке цены", async () => {
    const out = await overlayCoverText(blankPng, 1080, 1620, values, FIXED_PANELS.story, true, "story");
    expect(await sharp(out).metadata()).toMatchObject({ width: 1080, height: 1620 });
    const plain = await sharp(blankPng).resize(1080, 1620).raw().toBuffer();
    const drawn = await sharp(out).removeAlpha().raw().toBuffer();
    expect(plain.equals(drawn)).toBe(false);
  });
});

describe("промт OVERLAY", () => {
  it("без единой буквы; цифра разрешена одна; без цифры — явный запрет", async () => {
    const owner = await loadOwnerPrompt();
    const withDigit = buildOverlayPrompt({ ownerText: owner, values, aspect: "square", withDigit: true, strict: false });
    expect(withDigit).toContain("золотую цифру «3»");
    expect(withDigit).toContain("НЕ рисуй: никаких панелей");
    const noDigit = buildOverlayPrompt({ ownerText: owner, values, aspect: "story", withDigit: false, strict: true });
    expect(noDigit).toContain("Никаких цифр");
    expect(noDigit).toContain("прошлый вариант забракован");
  });
  it("кандидаток по умолчанию: OVERLAY 1, MODEL 2", () => {
    expect(defaultCandidates("OVERLAY")).toBe(1);
    expect(defaultCandidates("MODEL")).toBe(2);
  });
});

describe("makePropertyCover: OVERLAY, фото перерисовывает модель", () => {
  it("успех: по одной картинке на формат, цифра от модели, рамки модели, обложки 1080² и 1080×1920", async () => {
    const property = await makeProperty();
    const { calls } = stubOpenAi();
    const cover = await makePropertyCover(property.id, { retryDelayMs: 0 });
    expect(cover).not.toBeNull();
    expect(calls).toMatchObject({ imageRequests: 2, analyze: 2, inspect: 2, pick: 0 });
    expect(calls.prompts[0]).toContain("золотую цифру «2»");
    const square = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.squareUrl)));
    const story = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.storyUrl)));
    expect(await sharp(square).metadata()).toMatchObject({ width: 1080, height: 1080 });
    expect(await sharp(story).metadata()).toMatchObject({ width: 1080, height: 1920 });
  });

  it("цифра кривая — повтор без цифры, цифру кладём мы", async () => {
    const property = await makeProperty();
    const { calls } = stubOpenAi({
      analyses: [
        { symbols: ["Z"], photo_same: true, panels: GOOD_PANELS },
        { symbols: [], photo_same: true, panels: GOOD_PANELS },
      ],
    });
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).not.toBeNull();
    expect(calls.imageRequests).toBe(3); // квадрат 2 захода + вертикаль 1
    expect(calls.prompts[1]).toContain("Никаких цифр");
  });

  it("фото изменено в обоих заходах квадрата — запасная обложка шаблона (02.10.2026) и причина в журнале", async () => {
    const property = await makeProperty();
    const bad = { symbols: [], photo_same: false, added: "добавлен камин", panels: GOOD_PANELS };
    stubOpenAi({ analyses: [bad, bad] });
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).toMatchObject({ fallback: true });
    expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("добавлен камин"), expect.anything());
  });

  it("после наложения проверка нашла перекрытие (слово не читается) — брак этой кандидатки", async () => {
    const property = await makeProperty();
    const unreadable = { ...goodFinal(), words: ["ХОНА"] };
    const { calls } = stubOpenAi({ finals: [unreadable] });
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).not.toBeNull();
    expect(calls.imageRequests).toBe(3);
  });
});

describe("makePropertyCover: OVERLAY, настоящее фото (по умолчанию)", () => {
  let digitDir: string;
  beforeEach(async () => {
    digitDir = path.join(uploadsDir, "cover-digits");
    await fs.rm(digitDir, { recursive: true, force: true });
    tuning.photoSource = "ORIGINAL";
  });
  afterEach(async () => {
    tuning.photoSource = "MODEL";
    await fs.rm(digitDir, { recursive: true, force: true });
  });

  /** fetch: generations → прозрачная «цифра»; зрение: символы цифры / финальная проверка. */
  function stubDigit(symbols: string[]) {
    const calls = { generations: 0, edits: 0, vision: 0 };
    const sprite = sharp({ create: { width: 400, height: 600, channels: 4, background: { r: 230, g: 180, b: 60, alpha: 1 } } }).png().toBuffer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        let body: unknown;
        if (url.endsWith("/images/generations")) {
          calls.generations++;
          expect(JSON.parse(String(init.body))).toMatchObject({ background: "transparent" });
          body = { data: [{ b64_json: (await sprite).toString("base64") }] };
        } else if (url.endsWith("/images/edits")) {
          calls.edits++;
          body = { data: [] };
        } else {
          calls.vision++;
          const text = JSON.parse(String(init.body)).messages[0].content[0].text as string;
          const content = text === INSPECT_PROMPT ? goodFinal() : { symbols };
          body = { choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 500, completion_tokens: 20 } };
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    return calls;
  }

  it("фото не перерисовывается: edits не зовётся, цифра — одна генерация и дальше из кэша", async () => {
    const property = await makeProperty();
    const first = stubDigit(["2"]);
    const cover = await makePropertyCover(property.id, { retryDelayMs: 0 });
    expect(cover).not.toBeNull();
    expect(first).toMatchObject({ generations: 1, edits: 0 });
    const story = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.storyUrl)));
    expect(await sharp(story).metadata()).toMatchObject({ width: 1080, height: 1920 });

    const second = stubDigit(["2"]);
    expect(await makePropertyCover(property.id, { force: true, retryDelayMs: 0 })).not.toBeNull();
    expect(second).toMatchObject({ generations: 0, edits: 0 });
  });

  it("цифра от модели кривая — не кэшируется, цифру рисуем мы, обложка есть", async () => {
    const property = await makeProperty();
    const calls = stubDigit(["Z"]);
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).not.toBeNull();
    expect(calls.generations).toBe(1);
    await expect(fs.readdir(digitDir)).rejects.toThrow();
  });
});
