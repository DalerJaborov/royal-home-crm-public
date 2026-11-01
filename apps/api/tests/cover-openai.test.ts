import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

/**
 * ОБЛОЖКИ CHATGPT (25.09.2026). Сеть не трогаем: `fetch` подменён целиком,
 * ответы OpenAI собираются здесь. Проверяем транспорт (ключ, таймаут, повтор,
 * разбор ошибки) и весь путь обложки: размеры, логотип нашим PNG, контроль
 * цифр с повтором, честный null на любом сбое, лимит дня, кэш по отпечатку.
 */
const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

// Параметры генерации — константы с 01.11.2026 (lib/settingsConstants.ts): тест
// подменяет их здесь, а не строкой Settings, которую сервер больше не читает.
const tuning = vi.hoisted(() => ({
  imageQuality: "medium", candidates: 2, textMode: "MODEL", imageModel: "gpt-image-1", photoSource: "ORIGINAL",
}));
vi.mock("../src/lib/settingsConstants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/settingsConstants.js")>()),
  OPENAI_COVER_TUNING: tuning,
}));

const { prisma } = await import("../src/db.js");
const { uploadsDir, propertyCoversDir } = await import("../src/upload.js");
const { encryptSecret } = await import("../src/crypto.js");
const { openAiPost, resolveOpenAiKey, OpenAiError } = await import("../src/ai/openaiClient.js");
const {
  makePropertyCover,
  createPropertyCover,
  coverDefects,
  storyFromSquare,
  storyFromGenerated,
  usesPortrait34,
  STORY_34_TOP,
  STORY_34_BODY_HEIGHT,
  buildCoverPrompt,
  loadOwnerPrompt,
  OWNER_PROMPT_PATH,
  INSPECT_PROMPT,
  ANALYZE_PROMPT,
  coverImageSize,
  COVER_IMAGE_ENDPOINT,
  COVER_CHECK_ENDPOINT,
  LOGO_MARGIN,
  MODEL_LOGO_BOX,
  fitLogoToStrip,
  storeManualCover,
  COVER_PHOTO_PICK_PROMPT,
  COVER_FACADE_PICK_PROMPT,
  scenePool,
  isExteriorType,
  SCENE_WORDS,
  SQUARE_TOP_IN_STORY,
  resetOpenAiNoMoneyBreaker,
} = await import("../src/lib/video/coverOpenAi.js");
const { buildCoverPosterValues } = await import("../src/lib/video/coverPoster.js");

const runId = Date.now().toString(36);
const propertyIds: string[] = [];
const files: string[] = [];
let districtId: string;
const districtName = `Сино-ИИ-${runId}`;
let settingsBefore: Record<string, unknown> | null = null;

const RED = { r: 255, g: 0, b: 0 };
let generatedPng: Buffer;

async function writeUpload(name: string, buffer: Buffer): Promise<string> {
  await fs.writeFile(path.join(uploadsDir, name), buffer);
  files.push(path.join(uploadsDir, name));
  return `/uploads/${name}`;
}

async function makeProperty(withPhoto = true) {
  const p = await prisma.property.create({
    data: {
      title: `Тест-обложка-ИИ-${runId}-${propertyIds.length}`,
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
  if (withPhoto) {
    const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
    const url = await writeUpload(`cover-ai-${runId}-${propertyIds.length}.jpg`, photo);
    await prisma.propertyPhoto.create({ data: { propertyId: p.id, url, thumbUrl: url, order: 0 } });
  }
  return p;
}
type Reply = { status?: number; json: unknown } | Error;
type Inspection = {
  rooms?: number | null;
  price?: string | null;
  area?: string | null;
  floor?: number | null;
  words?: string[];
  photo_same?: boolean;
  added?: string;
};

function goodInspection(): Inspection {
  return {
    rooms: 2,
    price: "890 000",
    area: "90",
    floor: 15,
    words: ["ХОНАГА", "НАРХ", "TJS", "М²", "МАСОҲАТ", "ОШЁНА", "ЭТАЖ", "ДУШАНБЕ", "РАЙОН:", districtName.toUpperCase()],
    photo_same: true,
  };
}

function chat(content: unknown): Reply {
  return { json: { choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 1500, completion_tokens: 60 } } };
}

/**
 * Подменённый fetch: images/edits → столько картинок, сколько просили в `n`;
 * chat → по тексту запроса: проверка кандидатки (очередь `inspections`) или выбор лучшей.
 */
function stubOpenAi(opts: { image?: (form: FormData) => Reply; inspections?: Inspection[]; pick?: number; facade?: number } = {}) {
  const calls = { imageRequests: 0, images: 0, inspect: 0, pick: 0, photoPick: 0, n: [] as number[] };
  const queue = [...(opts.inspections ?? [])];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    let reply: Reply;
    if (url.endsWith("/images/edits")) {
      calls.imageRequests++;
      const n = Number((init.body as FormData).get("n") ?? 1);
      calls.n.push(n);
      calls.images += n;
      reply = opts.image ? opts.image(init.body as FormData) : { json: { data: Array.from({ length: n }, () => ({ b64_json: generatedPng.toString("base64") })) } };
    } else {
      const text = JSON.parse(String(init.body)).messages[0].content[0].text as string;
      if (text === INSPECT_PROMPT) {
        calls.inspect++;
        reply = chat(queue.length ? queue.shift() : goodInspection());
      } else if (text === COVER_FACADE_PICK_PROMPT) {
        calls.photoPick++;
        reply = chat({ best: opts.facade ?? 0 });
      } else if (text === COVER_PHOTO_PICK_PROMPT) {
        // Выбор фото для обложки (29.09.2026): берём первое по порядку галереи.
        calls.photoPick++;
        reply = chat({ best: 1 });
      } else {
        calls.pick++;
        reply = chat({ best: opts.pick ?? 2 });
      }
    }
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function editsForms(): FormData[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter((c) => String(c[0]).endsWith("/images/edits"))
    .map((c) => (c as unknown as [string, RequestInit])[1].body as FormData);
}

/** Сколько пикселей знака владельца (тёмно-зелёный на тёмно-сером фоне заглушки) в его боксе. */
async function ownerLogoPixels(img: Buffer, box: { left: number; top: number; height: number }) {
  const width = Math.round((box.height * 510) / 642);
  const { data } = await sharp(img).extract({ left: box.left, top: box.top, width, height: box.height }).raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += 3) if (data[i + 1] > 45 && data[i] < 30) n++;
  return n;
}

async function px(img: Buffer, left: number, top: number) {
  const { data } = await sharp(img).extract({ left, top, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return { r: data[0], g: data[1], b: data[2] };
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: districtName } })).id;
  generatedPng = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 20, g: 20, b: 20 } } }).png().toBuffer();
  const logo = await sharp({ create: { width: 200, height: 200, channels: 4, background: { ...RED, alpha: 1 } } }).png().toBuffer();
  const logoUrl = await writeUpload(`cover-ai-logo-${runId}.png`, logo);
  settingsBefore = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { coverProvider: true, companyLogoUrl: true, openaiApiKey: true, coverGenerationEnabled: true, openaiCoverDailyLimit: true, openaiCandidates: true, openaiTextMode: true, openaiImageModel: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { companyLogoUrl: logoUrl, openaiApiKey: encryptSecret("sk-test-settings-key"), coverProvider: "OPENAI", coverGenerationEnabled: true, openaiCoverDailyLimit: 1000 },
  });
});

beforeEach(async () => {
  logSystemError.mockClear();
  resetOpenAiNoMoneyBreaker(); // предохранитель «нет денег» живёт в памяти процесса
  await prisma.aiLog.deleteMany({ where: { endpoint: { in: [COVER_IMAGE_ENDPOINT, COVER_CHECK_ENDPOINT] } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
});

afterAll(async () => {
  const covers = await prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { socialCoverSquareUrl: true, socialCoverStoryUrl: true } });
  for (const c of covers) {
    for (const u of [c.socialCoverSquareUrl, c.socialCoverStoryUrl]) if (u) files.push(path.join(propertyCoversDir, path.basename(u)));
  }
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await Promise.all(files.map((f) => fs.rm(f, { force: true })));
});

describe("openaiClient", () => {
  it("ключ из Настроек приоритетнее .env", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    expect(await resolveOpenAiKey()).toEqual({ key: "sk-test-settings-key", source: "settings" });
  });

  it("429 → повтор → успех; заголовок Bearer", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () =>
      ++n === 1 ? new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 }) : new Response(JSON.stringify({ ok: 1 }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await openAiPost<{ ok: number }>("/x", { body: {}, timeoutMs: 1000, apiKey: "sk-a", retryDelayMs: 0 });
    expect(res.ok).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-a");
  });

  it("таймаут — понятная ошибка, без повтора", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(openAiPost("/x", { body: {}, timeoutMs: 20, apiKey: "sk-a", retryDelayMs: 0 })).rejects.toThrow(/не ответил за/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ошибка OpenAI {error:{message,code}} → русская строка", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Incorrect API key", code: "invalid_api_key" } }), { status: 401 })));
    const err = await openAiPost("/x", { body: {}, timeoutMs: 1000, apiKey: "sk-a", retryDelayMs: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiError);
    expect((err as Error).message).toMatch(/не принял ключ/);
    expect((err as Error).message).toMatch(/Incorrect API key/);
  });
});

describe("промт и проверка", () => {
  it("копия промта владельца в assets совпадает с docs", async () => {
    const docs = await fs.readFile(path.join(process.cwd(), "..", "..", "docs", "cover-sources-25-09", "prompt-glass-style.md"), "utf8");
    expect(await fs.readFile(OWNER_PROMPT_PATH, "utf8")).toBe(docs);
  });

  it("промт — полный текст владельца + блок данных; нет этажа — явный запрет", async () => {
    const owner = await loadOwnerPrompt();
    expect(owner.length).toBeGreaterThan(3000);
    const values = buildCoverPosterValues(
      { rooms: 2, areaSqm: 90, floor: null, price: 890000, currency: "TJS", districtName: "Сино", address: null },
      { usdToTjs: 10.9 }
    );
    // v5 (29.09.2026): эталон — макеты «Royal Green», фон ChatGPT рисует сам, знак кладём мы.
    const prompt = buildCoverPrompt({ ownerText: owner, values, aspect: "square", strict: false });
    expect(prompt).toContain("Картинка 2 — ЭТАЛОН ДИЗАЙНА");
    expect(prompt).toContain("комната объекта");
    expect(prompt).toContain("ЛОГОТИП НЕ РИСОВАТЬ");
    expect(prompt).toContain("ДАННЫЕ ОБЪЕКТА (писать только их и ровно так)");
    expect(prompt).toContain("Этаж не указан — блок этажа не рисовать");
    expect(prompt).toContain("90 м² / МАСОҲАТ");
    // Слово «ЦЕНА» модель дописывала на обложку (30.09.2026) — в задании его нет как подписи.
    expect(prompt).not.toMatch(/ЦЕНА:/);
    expect(prompt).toContain("без слова «ЦЕНА»");
    expect(prompt.length).toBeLessThan(32000);
    // Свой эталон из Настроек: картинки «фото, логотип, эталон», знак ставит модель.
    const custom = buildCoverPrompt({ values, aspect: "square", strict: true, customReference: true });
    expect(custom).toContain("Картинка 2 — наш логотип. Картинка 3 — ЭТАЛОН ДИЗАЙНА");
    expect(custom).toContain("на то место, где логотип стоит на эталоне");
    expect(custom).toContain("логотип — ровно картинка 2");
  });

  it("сцены: у каждой свой фон; «Сейчас → Можно так» разрешает свои подписи", async () => {
    const values = buildCoverPosterValues(
      { rooms: 2, areaSqm: 80, floor: 15, price: 927000, currency: "TJS", districtName: "Исмоили Сомони", address: null },
      { usdToTjs: 10.9 }
    );
    const interior = buildCoverPrompt({ values, aspect: "square", strict: false });
    expect(interior).toContain("картинка 1 — комната объекта. Сохрани ЭТУ комнату");
    expect(interior).toContain("НИЧЕГО не добавляй и не меняй");
    // 01.10.2026: «придуманной гостиной» больше нет — ни разрешения менять комнату, ни «стильной мебели и декора».
    expect(interior).not.toContain("может отличаться");
    expect(interior).not.toContain("стильная мебель и декор");
    expect(interior).not.toContain("нарисуй самый красивый интерьер");
    expect(buildCoverPrompt({ values, aspect: "square", strict: false, scene: "WINDOW_VIEW" })).toContain("вид из окна с высоты 15 этажа");
    expect(buildCoverPrompt({ values, aspect: "square", strict: false, scene: "LOCATION" })).toContain("карта района «Исмоили Сомони»");
    // Сцена с подписью на фоне (у «До и после» подписи убраны 01.10.2026): белый список слов попадает в промт.
    const contour = buildCoverPrompt({ values, aspect: "story", strict: false, scene: "LAND_CONTOUR" });
    expect(contour).toContain("«СХЕМА»");
    expect(contour).toContain("кроме подписей фона");
    const f = { rooms: 2, priceDigits: "927000", areaSqm: 80, floor: 15, district: "Исмоили Сомони" };
    const read = { rooms: 2, price: "927 000 TJS", area: "80", floor: 15, words: ["ХОНАГА", "СХЕМА"], photoSame: false, added: null };
    expect(coverDefects(f, read, { photoSoft: true })).toEqual([expect.stringMatching(/лишние/)]);
    expect(coverDefects({ ...f, extraWords: ["СХЕМА"] }, read, { photoSoft: true })).toEqual([]);
  });

  const facts = { rooms: 2, priceDigits: "890000", areaSqm: 90, floor: 15, district: "Сино" };
  const base = {
    rooms: 2,
    price: "890 000 TJS",
    area: "90,0",
    floor: 15,
    words: ["2 ХОНАГА", "НАРХ", "М2", "ОШЕНА", "ЭТАЖ", "РАЙОН: СИНО", "ROYAL HOME TJ"],
    photoSame: true,
    added: null,
  };
  it("годная кандидатка — без брака (пробелы, М2, Ё/Е не мешают)", () => {
    expect(coverDefects(facts, base)).toEqual([]);
  });
  it("«ДУЖ» вместо «ЭТАЖ» — брак по слову", () => {
    expect(coverDefects(facts, { ...base, words: [...base.words, "ДУЖ"] }).join()).toMatch(/искажённые слова: ДУЖ/);
  });
  it("фото изменено — брак", () => {
    expect(coverDefects(facts, { ...base, photoSame: false, added: "добавлена люстра" }).join()).toMatch(/фото объекта изменено: добавлена люстра/);
  });
  it("photoSoft: INTERIOR строго (брак), прочие сцены мягко (замечание) — 01.10.2026", () => {
    const changed = { ...base, photoSame: false, added: "добавлен диван" };
    const strictSoft: string[] = [];
    expect(coverDefects(facts, changed, { soft: strictSoft, photoSoft: false }).join()).toMatch(/фото объекта изменено: добавлен диван/);
    expect(strictSoft).toEqual([]);
    const lenientSoft: string[] = [];
    expect(coverDefects(facts, changed, { soft: lenientSoft, photoSoft: true })).toEqual([]);
    expect(lenientSoft.join()).toMatch(/мягкое замечание: фото объекта изменено: добавлен диван/);
  });
  it("проверяющий промт: расхождение — только предметы, отделка, окна, вид; свет и чистота не считаются", () => {
    for (const prompt of [INSPECT_PROMPT, ANALYZE_PROMPT]) {
      expect(prompt).toContain("добавлены предметы, переставлена или убрана мебель и крупные предметы");
      expect(prompt).toContain("цвет или рисунок стен и пола");
      expect(prompt).toContain("другой вид из окна");
      expect(prompt).toMatch(/Свет, яркость, цветокоррекцию и чистоту/);
      expect(prompt).toContain("НЕ считай");
      // 01.10.2026: то, что мы сами просим убрать в промте, не расхождение (проверка бракует уборку).
      expect(prompt).toContain("Убранные мелкие бытовые предметы (бутылки, вещи на диване, мусор, провода, плёнка");
      expect(prompt).toContain("именно это мы просим убрать");
      expect(prompt).not.toContain("убраны или переставлены предметы");
    }
  });
  it("не та цена — брак", () => {
    expect(coverDefects(facts, { ...base, price: "980 000" }).join()).toMatch(/цена/);
  });
});

describe("вертикаль из квадрата", () => {
  it("1080×1920, центр побайтно равен квадрату", async () => {
    const raw = Buffer.alloc(1080 * 1080 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 251;
    const square = await sharp(raw, { raw: { width: 1080, height: 1080, channels: 3 } }).png().toBuffer();
    const story = await storyFromSquare(square, "png");
    expect(await sharp(story).metadata()).toMatchObject({ width: 1080, height: 1920 });
    const center = await sharp(story).extract({ left: 0, top: SQUARE_TOP_IN_STORY, width: 1080, height: 1080 }).removeAlpha().raw().toBuffer();
    expect(center.equals(raw)).toBe(true);
  });
});

describe("вертикаль 3:4 в кадре 1080×1920", () => {
  it("итог 1080×1920; строки 240…1679 — тело 3:4 без швов (побайтно), знак внутри них, края — размытая копия", async () => {
    const raw = Buffer.alloc(1080 * 1440 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 251;
    const body = await sharp(raw, { raw: { width: 1080, height: 1440, channels: 3 } }).png().toBuffer();
    const box = { left: MODEL_LOGO_BOX.story34.left, top: STORY_34_TOP + MODEL_LOGO_BOX.story34.top, height: MODEL_LOGO_BOX.story34.height };
    const logo = await sharp({ create: { width: 100, height: box.height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const story = await storyFromGenerated(body, { input: logo, left: box.left, top: box.top }, { portrait34: true, format: "png" });
    expect(await sharp(story).metadata()).toMatchObject({ width: 1080, height: 1920 });
    expect(STORY_34_TOP).toBe(240);
    expect(STORY_34_BODY_HEIGHT).toBe(1440);
    // Знак целиком в центральных 1440 px (240…1679), т.е. виден в сетке 3:4.
    expect(box.top).toBeGreaterThanOrEqual(240);
    expect(box.top + box.height).toBeLessThanOrEqual(1680);
    // Центр, кроме полосы знака, равен телу побайтно.
    const center = await sharp(story).extract({ left: 0, top: 240, width: 1080, height: 1440 }).removeAlpha().raw().toBuffer();
    const rowBytes = 1080 * 3;
    const logoRows = new Set(Array.from({ length: box.height }, (_, i) => box.top - 240 + i));
    for (let y = 0; y < 1440; y += 7) {
      if (logoRows.has(y)) continue;
      expect(center.subarray(y * rowBytes, (y + 1) * rowBytes).equals(raw.subarray(y * rowBytes, (y + 1) * rowBytes))).toBe(true);
    }
    // Знак лёг поверх тела.
    expect(await px(story, box.left + 10, box.top + 10)).toEqual({ r: 255, g: 0, b: 0 });
    // Полосы по краям затемнены относительно тела (размытая копия ≤ ~35 % яркости).
    const meanOf = async (top: number, height: number) => {
      const part = await sharp(story).extract({ left: 0, top, width: 1080, height }).removeAlpha().png().toBuffer();
      const { channels } = await sharp(part).stats();
      return channels.reduce((a, c) => a + c.mean, 0) / channels.length;
    };
    expect(await meanOf(0, 100)).toBeLessThan((await meanOf(500, 100)) * 0.6);
    expect(await meanOf(1820, 100)).toBeLessThan((await meanOf(500, 100)) * 0.6);
  });

  it("другое соотношение сторон у кандидатки — тело всё равно 1080×1440 (cover), кадр 1080×1920", async () => {
    const odd = await sharp({ create: { width: 1152, height: 1600, channels: 3, background: { r: 30, g: 90, b: 60 } } }).png().toBuffer();
    const story = await storyFromGenerated(odd, null, { portrait34: true });
    expect(await sharp(story).metadata()).toMatchObject({ width: 1080, height: 1920 });
  });
});

describe("makePropertyCover v2", () => {
  it("успех: квадрат и вертикаль по своим эталонам, n=2, выбор лучшей, наш логотип, лимит считает картинки", async () => {
    const property = await makeProperty();
    const { calls } = stubOpenAi();
    const cover = await makePropertyCover(property.id, { retryDelayMs: 0 });
    expect(cover).not.toBeNull();
    expect(calls).toMatchObject({ imageRequests: 2, images: 4, inspect: 4, pick: 2, n: [2, 2] });
    expect(editsForms().map((f) => f.get("size"))).toEqual(["1024x1024", "1024x1536"]);

    const story = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.storyUrl)));
    const square = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.squareUrl)));
    expect(await sharp(story).metadata()).toMatchObject({ width: 1080, height: 1920 });
    expect(await sharp(square).metadata()).toMatchObject({ width: 1080, height: 1080 });
    // Знак владельца (тёмно-зелёный) лежит там, где он на макетах; логотип из Настроек (красный) — нет.
    expect(await ownerLogoPixels(square, MODEL_LOGO_BOX.square)).toBeGreaterThan(300);
    expect(await ownerLogoPixels(story, MODEL_LOGO_BOX.story)).toBeGreaterThan(300);
    expect((await px(square, LOGO_MARGIN + 30, LOGO_MARGIN + 30)).r).toBeLessThan(60);

    expect(await prisma.aiLog.count({ where: { endpoint: COVER_IMAGE_ENDPOINT } })).toBe(4);
    const [form] = editsForms();
    expect(form.get("input_fidelity")).toBe("high");
    // Логотип модели не отдаём: фото и эталон.
    expect(form.getAll("image[]")).toHaveLength(2);
  });

  it("одна кандидатка с «ДУЖ» — берётся вторая без выбора", async () => {
    const property = await makeProperty();
    const { calls } = stubOpenAi({ inspections: [{ ...goodInspection(), words: ["ДУЖ"] }, goodInspection()] });
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).not.toBeNull();
    // квадрат: одна годная — без выбора; вертикаль: обе годные — выбор
    expect(calls).toMatchObject({ imageRequests: 2, inspect: 4, pick: 1 });
  });

  it("INTERIOR: комната изменена — брак (01.10.2026): перебор кандидаток, усиленный повтор, затем запасная обложка шаблона (02.10.2026) и причина в журнале", async () => {
    const property = await makeProperty();
    const changed = { ...goodInspection(), photo_same: false, added: "добавлен диван" };
    const { calls } = stubOpenAi({ inspections: [changed, changed, changed, changed] });
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).toMatchObject({ fallback: true });
    // Квадрат: две кандидатки отбракованы, усиленный повтор — ещё две; вертикаль не заказывается.
    expect(calls).toMatchObject({ imageRequests: 2, images: 4, inspect: 4 });
    expect(String(editsForms()[1].get("prompt"))).toContain("прошлый вариант забракован");
    expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("фото объекта изменено: добавлен диван"), expect.anything());
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.socialCoverError).toBeNull();
    expect(after?.socialCoverInputHash).toMatch(/^fallback-template:/);
  });

  it("INTERIOR: одна из двух кандидаток с изменённой комнатой — берётся вторая, обложка есть", async () => {
    const property = await makeProperty();
    const changed = { ...goodInspection(), photo_same: false, added: "добавлен диван" };
    stubOpenAi({ inspections: [changed, goodInspection(), goodInspection(), goodInspection()] });
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).not.toBeNull();
  });

  it("сцена не INTERIOR (участок): фото перерисовано — по-прежнему не брак, свет и фон меняются намеренно", async () => {
    const property = await makeProperty();
    await prisma.property.update({ where: { id: property.id }, data: { type: "LAND" } });
    const changed = { ...goodInspection(), photo_same: false, added: "добавлен дом" };
    stubOpenAi({ inspections: [changed, changed, changed, changed] });
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).not.toBeNull();
  });

  it("модель нарисовала свой логотип — усиленный повтор; снова — запасная обложка шаблона и журнал", async () => {
    const property = await makeProperty();
    const bad = { ...goodInspection(), words: [...goodInspection().words, "ROYAL HOME TJ"] };
    const { calls } = stubOpenAi({ inspections: [bad, bad, bad, bad] });
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).toMatchObject({ fallback: true });
    expect(calls).toMatchObject({ imageRequests: 2, images: 4, inspect: 4 });
    expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("модель нарисовала свой логотип"), expect.anything());
    expect(String(editsForms()[1].get("prompt"))).toContain("прошлый вариант забракован");
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.socialCoverError).toBeNull();
  });

  it("сеть упала — запасная обложка шаблона, причина в журнале", async () => {
    const property = await makeProperty();
    stubOpenAi({ image: () => new Error("ECONNRESET") });
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).toMatchObject({ fallback: true });
    expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("Нет связи с OpenAI"), expect.anything());
  });

  it("лимит по картинкам: осталась одна — заказывается n=1; ноль — без запроса", async () => {
    const property = await makeProperty();
    await prisma.settings.update({ where: { id: "singleton" }, data: { openaiCoverDailyLimit: 1 } });
    try {
      const first = stubOpenAi();
      // квадрат получает последнюю картинку дня, вертикаль собирается из него
      expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).not.toBeNull();
      expect(first.calls.n).toEqual([1]);
      expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("собрана из квадрата"), expect.anything());
      const second = stubOpenAi();
      // лимит дня исчерпан — ChatGPT не зовём, обложка запасная (02.10.2026)
      expect(await makePropertyCover(property.id, { force: true, retryDelayMs: 0 })).toMatchObject({ fallback: true });
      expect(second.fetchMock).not.toHaveBeenCalled();
      expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("дневной лимит"), expect.anything());
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { openaiCoverDailyLimit: 1000 } });
    }
  });

  it("нет фото в карточке — null, в OpenAI не ходим", async () => {
    const property = await makeProperty(false);
    const { fetchMock } = stubOpenAi();
    expect(await makePropertyCover(property.id)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("Нет фото в карточке"), expect.anything());
  });

  it("кэш: без изменений — без запроса; force («Перерисовать») и смена главного фото — заново", async () => {
    const property = await makeProperty();
    stubOpenAi();
    const a = await makePropertyCover(property.id, { retryDelayMs: 0 });
    const cached = stubOpenAi();
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).toMatchObject({ cached: true, storyUrl: a!.storyUrl });
    expect(cached.fetchMock).not.toHaveBeenCalled();
    const forced = stubOpenAi();
    expect(await makePropertyCover(property.id, { force: true, retryDelayMs: 0 })).toMatchObject({ cached: false });
    expect(forced.calls.imageRequests).toBe(2);

    const newPhoto = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 90, b: 10 } } }).jpeg().toBuffer();
    const url = await writeUpload(`cover-ai-${runId}-new-main.jpg`, newPhoto);
    await prisma.propertyPhoto.create({ data: { propertyId: property.id, url, thumbUrl: url, order: -1 } });
    const third = stubOpenAi();
    expect((await makePropertyCover(property.id, { retryDelayMs: 0 }))?.cached).toBe(false);
    expect(third.calls.imageRequests).toBe(2);
    // Два фото — модель выбирала, какое взять на обложку.
    expect(third.calls.photoPick).toBe(1);
  });

  it("вертикаль забракована дважды — собрана из квадрата, обложка есть, причина в журнале", async () => {
    const property = await makeProperty();
    const bad = { ...goodInspection(), words: ["ДУЖ"] };
    // квадрат: 2 годные; вертикаль: 2 + 2 брака
    const { calls } = stubOpenAi({ inspections: [goodInspection(), goodInspection(), bad, bad, bad, bad] });
    const cover = await makePropertyCover(property.id, { retryDelayMs: 0 });
    expect(cover).not.toBeNull();
    expect(calls.imageRequests).toBe(3);
    const story = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.storyUrl)));
    expect(await sharp(story).metadata()).toMatchObject({ width: 1080, height: 1920 });
    expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("собрана из квадрата"), expect.anything());
  });

  it("openaiCandidates = 1 — по одной картинке на формат, без выбора", async () => {
    const property = await makeProperty();
    tuning.candidates = 1;
    try {
      const { calls } = stubOpenAi();
      expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).not.toBeNull();
      expect(calls).toMatchObject({ n: [1, 1], pick: 0 });
    } finally {
      tuning.candidates = 2;
    }
  });

  it("выключено — null без журнала; пробная (dryRun) рисует и не пишет в объект", async () => {
    const property = await makeProperty();
    await prisma.settings.update({ where: { id: "singleton" }, data: { coverGenerationEnabled: false } });
    try {
      const { fetchMock } = stubOpenAi();
      expect(await makePropertyCover(property.id)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logSystemError).not.toHaveBeenCalled();
      stubOpenAi();
      const dry = await createPropertyCover(property.id, { dryRun: true, retryDelayMs: 0 });
      expect(dry.ok).toBe(true);
      expect((await prisma.property.findUnique({ where: { id: property.id } }))?.socialCoverStoryUrl).toBeNull();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { coverGenerationEnabled: true } });
    }
  });
});

describe("ChatGPT Images 2.5 (живой прогон v4)", () => {
  it("размеры: квадрат 1024², вертикаль нативно 9:16 (1152×2048); у gpt-image-1 — 1024×1536", () => {
    expect(coverImageSize("gpt-image-2.5-sunburst", "square")).toBe("1024x1024");
    expect(coverImageSize("gpt-image-2.5-sunburst", "story")).toBe("1152x2048");
    expect(coverImageSize("gpt-image-1", "story")).toBe("1024x1536");
  });

  it("размеры 3:4 (01.10.2026): вертикаль для модели 1152×1536, у gpt-image-1 прежняя, квадрат не меняется", () => {
    expect(coverImageSize("gpt-image-2.5-sunburst", "story", true)).toBe("1152x1536");
    expect(coverImageSize("gpt-image-1", "story", true)).toBe("1024x1536");
    expect(coverImageSize("gpt-image-2.5-sunburst", "square", true)).toBe("1024x1024");
    expect(usesPortrait34("gpt-image-2.5-sunburst", "MODEL")).toBe(true);
    expect(usesPortrait34("gpt-image-2.5-sunburst", undefined)).toBe(true);
    expect(usesPortrait34("gpt-image-1", "MODEL")).toBe(false);
    expect(usesPortrait34("gpt-image-2.5-sunburst", "OVERLAY")).toBe(false);
  });

  it("промт вертикали 3:4: «вертикаль 3:4», квадратный эталон вытянут, без фразы про нижние 8 % (она была про 9:16)", () => {
    const values = buildCoverPosterValues(
      { rooms: 2, areaSqm: 90, floor: 15, price: 890000, currency: "TJS", districtName: "Сино", address: null },
      { usdToTjs: 10 }
    );
    const story = buildCoverPrompt({ values, aspect: "story", strict: false, portrait34: true });
    expect(story).toContain("вертикаль 3:4");
    expect(story).toContain("формат вытянут по высоте до 3:4");
    expect(story).toContain("ничего не обрезано");
    expect(story).not.toContain("нижние 8 %");
    expect(story).not.toContain("9:16");
    // Свой эталон: дизайн берём с него, но кадр тот же и ничего не режем.
    const custom = buildCoverPrompt({ values, aspect: "story", strict: false, portrait34: true, customReference: true });
    expect(custom).toContain("вертикаль 3:4");
    expect(custom).not.toContain("вытянут по высоте");
    // Старый путь (gpt-image-1 / OVERLAY) не тронут.
    expect(buildCoverPrompt({ values, aspect: "story", strict: false })).toContain("вертикаль 9:16 для Reels: нижние 8 %");
  });

  it("мягкие замечания: Ҳ/Ӣ и одна буква у читалки — не брак; цифры строго", () => {
    const facts = { rooms: 3, priceDigits: "1700000", areaSqm: 112.5, floor: 15, district: "Фирдавсӣ" };
    const base = { rooms: 3, price: "1 700 000", area: "112,5", floor: 15, photoSame: false, added: "нет кресла" };
    const soft: string[] = [];
    const words = ["ХОНАГА", "МАСОХАТ:", "ОШӮНА", "ФИРДАВСЙ", "ЕТАЖ", "ROYAL", "HOME", "TJ"];
    expect(coverDefects(facts, { ...base, words }, { soft, photoSoft: true })).toEqual([]);
    expect(soft.join()).toMatch(/мягкое замечание/);
    expect(coverDefects(facts, { ...base, words: ["ДУЖ"] }, { photoSoft: true }).join()).toMatch(/искажённые слова: ДУЖ/);
    expect(coverDefects(facts, { ...base, words, price: "117000000" }, { photoSoft: true }).join()).toMatch(/цена/);
  });

  it("своя обложка из карточки: вертикаль собрана из квадрата, публикация её не перерисовывает, «Перерисовать» — да", async () => {
    const property = await makeProperty();
    const mine = await sharp({ create: { width: 1500, height: 1500, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toBuffer();
    const manual = await storeManualCover(property.id, { square: mine, story: null });
    const story = await fs.readFile(path.join(propertyCoversDir, path.basename(manual.storyUrl)));
    expect(await sharp(story).metadata()).toMatchObject({ width: 1080, height: 1920 });

    const { fetchMock } = stubOpenAi();
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).toMatchObject({ squareUrl: manual.squareUrl, cached: true });
    expect(fetchMock).not.toHaveBeenCalled();

    // «Перерисовать» не вышла — поставленная руками обложка остаётся (аудит 29.09.2026).
    stubOpenAi({ image: () => new Error("ECONNRESET") });
    expect(await makePropertyCover(property.id, { force: true, retryDelayMs: 0 })).toBeNull();
    const kept = await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { socialCoverSquareUrl: true, socialCoverError: true } });
    expect(kept.socialCoverSquareUrl).toBe(manual.squareUrl);
    expect(kept.socialCoverError).toBeTruthy();

    stubOpenAi();
    const redrawn = await makePropertyCover(property.id, { force: true, retryDelayMs: 0 });
    expect(redrawn?.squareUrl).not.toBe(manual.squareUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /* АУДИТ CODEX 04.10.2026, PUB13: автоматическая генерация читает карточку в начале,
     минуты ждёт ChatGPT, а storeCovers писал безусловно — обложка, поставленная руками
     за это время, затиралась. Запись автоматических путей теперь условная. */
  it("PUB13: медленная автоматическая генерация не затирает обложку, поставленную руками, пока она ждала ChatGPT", async () => {
    const property = await makeProperty();
    const mine = await sharp({ create: { width: 1500, height: 1500, channels: 3, background: { r: 30, g: 30, b: 200 } } }).jpeg().toBuffer();
    const { fetchMock } = stubOpenAi();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atEdits = new Promise<void>((r) => (reached = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).endsWith("/images/edits")) {
          reached();
          await gate;
        }
        return fetchMock(url, init);
      })
    );

    const run = makePropertyCover(property.id, { retryDelayMs: 0 });
    await atEdits;
    const manual = await storeManualCover(property.id, { square: mine, story: null });
    release();
    const result = await run;

    expect(result).toMatchObject({ squareUrl: manual.squareUrl, storyUrl: manual.storyUrl, cached: true });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { socialCoverSquareUrl: true, socialCoverStoryUrl: true, socialCoverInputHash: true } });
    expect(after.socialCoverInputHash).toMatch(/^manual:/);
    expect(after.socialCoverSquareUrl).toBe(manual.squareUrl);
    expect(after.socialCoverStoryUrl).toBe(manual.storyUrl);
    // Файлы проигравшей автоматической обложки убраны, остались только ручные.
    const onDisk = (await fs.readdir(propertyCoversDir)).filter((n) => n.startsWith(`${property.id}-`)).sort();
    expect(onDisk).toEqual([path.basename(manual.squareUrl), path.basename(manual.storyUrl)].sort());
  });

  it("PUB13: «Перерисовать» (force) по-прежнему заменяет ручную обложку", async () => {
    const property = await makeProperty();
    const mine = await sharp({ create: { width: 1500, height: 1500, channels: 3, background: { r: 30, g: 30, b: 200 } } }).jpeg().toBuffer();
    const manual = await storeManualCover(property.id, { square: mine, story: null });
    stubOpenAi();
    const redrawn = await makePropertyCover(property.id, { force: true, retryDelayMs: 0 });
    expect(redrawn?.squareUrl).not.toBe(manual.squareUrl);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { socialCoverInputHash: true } });
    expect(after.socialCoverInputHash).not.toMatch(/^manual:/);
  });

  it("новостройка: не «журнальная квартира», а сцена; фасада нет — другая сцена, есть — «закат»", async () => {
    const property = await makeProperty();
    await prisma.property.update({ where: { id: property.id }, data: { condition: "NEW_BUILDING" } });
    const second = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 120, g: 110, b: 100 } } }).jpeg().toBuffer();
    const url = await writeUpload(`cover-ai-${runId}-facade.jpg`, second);
    await prisma.propertyPhoto.create({ data: { propertyId: property.id, url, thumbUrl: url, order: 1 } });
    const random = vi.spyOn(Math, "random").mockReturnValue(0); // первая сцена пула: без фасада — «вид из окна», с фасадом — «закат»
    try {
      stubOpenAi({ facade: 0 });
      expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).not.toBeNull();
      const noFacade = String(editsForms()[0].get("prompt"));
      expect(noFacade).toContain("вид из окна");
      expect(noFacade).not.toContain("комната объекта");
      expect(noFacade).not.toContain("СЕЙЧАС"); // «До и после» убран совсем (01.10.2026)

      // «Фасада нет» помнится для этого набора фото — добавляем снимок дома, набор новый.
      const outside = await writeUpload(`cover-ai-${runId}-outside.jpg`, second);
      await prisma.propertyPhoto.create({ data: { propertyId: property.id, url: outside, thumbUrl: outside, order: 2 } });
      stubOpenAi({ facade: 3 });
      expect(await makePropertyCover(property.id, { force: true, retryDelayMs: 0 })).not.toBeNull();
      expect(String(editsForms()[0].get("prompt"))).toContain("«золотой час»");
    } finally {
      random.mockRestore();
    }
  });

  it("дом, участок, коммерция: своя сцена без выдуманных комнат (владелец 30.09.2026)", async () => {
    const withSecondPhoto = async (type: "HOUSE" | "LAND" | "COMMERCIAL", condition: "GOOD" | "NEW_BUILDING" = "GOOD") => {
      const property = await makeProperty();
      await prisma.property.update({ where: { id: property.id }, data: { type, condition } });
      const second = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 130, g: 120, b: 110 } } }).jpeg().toBuffer();
      const url = await writeUpload(`cover-ai-${runId}-${type}-${propertyIds.length}.jpg`, second);
      await prisma.propertyPhoto.create({ data: { propertyId: property.id, url, thumbUrl: url, order: 1 } });
      return property;
    };
    const promptAt = async (id: string, random: number, stub: Parameters<typeof stubOpenAi>[0]) => {
      const spy = vi.spyOn(Math, "random").mockReturnValue(random);
      try {
        stubOpenAi(stub);
        expect(await makePropertyCover(id, { force: true, retryDelayMs: 0 })).not.toBeNull();
        return String(editsForms()[0].get("prompt"));
      } finally {
        spy.mockRestore();
      }
    };

    // Дом с фото снаружи: закат (с уборкой кадра), чистый двор, карта района («Потенциал» убран 01.10.2026).
    const house = await withSecondPhoto("HOUSE");
    const sunset = await promptAt(house.id, 0, { facade: 2 });
    expect(sunset).toContain("«золотой час»");
    expect(sunset).toContain("убери из кадра посторонних людей, бельё, провода и мусор");
    expect(sunset).toContain("НЕ исправлять");
    expect(await promptAt(house.id, 0.4, { facade: 2 })).toContain("Убери всё лишнее: посторонних людей, бельё, провода, мусор");
    const map = await promptAt(house.id, 0.99, { facade: 2 });
    expect(map).toContain("карта района");
    expect(map).not.toContain("ПОТЕНЦИАЛ");

    // Участок: карта с контуром, закат, визуализация застройки.
    const land = await withSecondPhoto("LAND");
    expect(await promptAt(land.id, 0, {})).toContain("золотым контуром");
    expect(await promptAt(land.id, 0.99, {})).toContain("«ВИЗУАЛИЗАЦИЯ»");

    // Коммерция без фото снаружи и с ремонтом — интерьер; новостройка без фасада — карта/планировка.
    const finished = await withSecondPhoto("COMMERCIAL", "GOOD");
    expect(await promptAt(finished.id, 0, { facade: 0 })).toContain("комната объекта");
    const shell = await withSecondPhoto("COMMERCIAL", "NEW_BUILDING");
    expect(await promptAt(shell.id, 0.99, { facade: 0 })).toContain("«ПРИМЕР ПЛАНИРОВКИ»");
  });

  it("scenePool: наборы по типу, закат и прочие фасадные сцены — только если есть фото снаружи", () => {
    expect(scenePool("APARTMENT", "GOOD", false)).toEqual(["INTERIOR"]);
    expect(scenePool("APARTMENT", "NEW_BUILDING", false)).not.toContain("FACADE_SUNSET");
    expect(scenePool("APARTMENT", "NEW_BUILDING", true)).toContain("FACADE_SUNSET");
    expect(scenePool("HOUSE", "GOOD", true)).toEqual(["FACADE_SUNSET", "CLEAN_YARD", "LOCATION"]);
    expect(scenePool("HOUSE", "GOOD", false)).toEqual(["INTERIOR"]);
    expect(scenePool("LAND", "GOOD", false)).toEqual(["LAND_CONTOUR", "LAND_SUNSET", "FUTURE_HOUSE"]);
    expect(scenePool("COMMERCIAL", "GOOD", true)).toEqual(["EVENING_FACADE", "LOCATION", "COMMERCIAL_PLAN"]);
    expect(scenePool("COMMERCIAL", "NEEDS_REPAIR", false)).toEqual(["LOCATION", "COMMERCIAL_PLAN"]);
    expect(isExteriorType("HOUSE") && isExteriorType("LAND") && isExteriorType("COMMERCIAL")).toBe(true);
    expect(isExteriorType("APARTMENT")).toBe(false);
    // «До и после» и «Потенциал» убраны совсем (владелец 01.10.2026): ни в пуле, ни в сценах, ни в промте.
    for (const type of ["APARTMENT", "HOUSE", "LAND", "COMMERCIAL"]) {
      for (const condition of ["GOOD", "NEW_BUILDING", "NEEDS_REPAIR"]) {
        for (const hasFacade of [true, false]) {
          const pool = scenePool(type, condition, hasFacade);
          expect(pool.length).toBeGreaterThan(0);
          expect(pool.map(String)).not.toContain("BEFORE_AFTER");
          expect(pool.map(String)).not.toContain("POTENTIAL");
        }
      }
    }
    expect(Object.keys(SCENE_WORDS)).not.toContain("BEFORE_AFTER");
    expect(Object.keys(SCENE_WORDS)).not.toContain("POTENTIAL");
    expect(Object.values(SCENE_WORDS).flat()).not.toContain("СЕЙЧАС");
    expect(scenePool("APARTMENT", "NEW_BUILDING", false)).toEqual(["WINDOW_VIEW", "LOCATION"]);
    expect(scenePool("APARTMENT", "NEEDS_REPAIR", true)).toEqual(["FACADE_SUNSET", "WINDOW_VIEW", "LOCATION"]);
  });

  it("свой эталон из Настроек: «фото, логотип, эталон», знак ставит модель, своего поверх нет", async () => {
    const property = await makeProperty();
    const ref = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: { r: 10, g: 90, b: 60 } } }).png().toBuffer();
    const name = `ref-square-${runId}.png`;
    await fs.mkdir(path.join(uploadsDir, "cover-references"), { recursive: true });
    await fs.writeFile(path.join(uploadsDir, "cover-references", name), ref);
    tuning.candidates = 1; await prisma.settings.update({ where: { id: "singleton" }, data: { coverReferenceSquareUrl: `/uploads/cover-references/${name}` } });
    try {
      stubOpenAi();
      const cover = await makePropertyCover(property.id, { retryDelayMs: 0 });
      expect(cover).not.toBeNull();
      const [square, story] = editsForms();
      for (const form of [square, story]) {
        expect(form.getAll("image[]").map((f) => (f as File).name)).toEqual(["photo.jpg", "logo.png", "style.jpg"]);
        expect(String(form.get("prompt"))).toContain("Картинка 2 — наш логотип");
      }
      const out = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.squareUrl)));
      expect(await ownerLogoPixels(out, MODEL_LOGO_BOX.square)).toBeLessThan(20);
    } finally {
      tuning.candidates = 2; await prisma.settings.update({ where: { id: "singleton" }, data: { coverReferenceSquareUrl: null } });
      await fs.rm(path.join(uploadsDir, "cover-references", name), { force: true });
    }
  });

  it("запрос к 2.5: без input_fidelity, картинки «фото, логотип, эталон», свой логотип поверх не кладём, цена по usage", async () => {
    const property = await makeProperty();
    tuning.imageModel = "gpt-image-2.5-sunburst"; tuning.candidates = 1;
    try {
      const { calls } = stubOpenAi();
      const cover = await makePropertyCover(property.id, { retryDelayMs: 0 });
      expect(cover).not.toBeNull();
      // Квадрат + вертикаль 3:4 + достройка верха и низа до 9:16 (01.10.2026): три запроса картинок.
      expect(calls.imageRequests).toBe(3);
      const [square, story, outpaint] = editsForms();
      expect(outpaint.get("mask")).not.toBeNull();
      expect(outpaint.get("size")).toBe("1152x2048");
      expect(outpaint.get("quality")).toBe("medium");
      expect(square.get("model")).toBe("gpt-image-2.5-sunburst");
      expect(square.get("input_fidelity")).toBeNull();
      expect(story.get("size")).toBe("1152x1536");
      expect(square.get("size")).toBe("1024x1024");
      // 3:4: эталон — квадратный royal-green-square, в промте «вертикаль 3:4».
      expect(String(story.get("prompt"))).toContain("вертикаль 3:4");
      expect(String(story.get("prompt"))).not.toContain("нижние 8 %");
      const storyRef = story.getAll("image[]")[1] as File;
      const squareRef = square.getAll("image[]")[1] as File;
      expect(storyRef.size).toBe(squareRef.size);
      const names = square.getAll("image[]").map((f) => (f as File).name);
      expect(names).toEqual(["photo.jpg", "style.jpg"]);
      const out = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.squareUrl)));
      expect((await px(out, LOGO_MARGIN + 30, LOGO_MARGIN + 30)).r).toBeLessThan(60); // красного логотипа поверх нет
      // Вертикаль 1080×1920, знак владельца в кремовой полосе 3:4 (в центральных 1440 px).
      const storyOut = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.storyUrl)));
      expect(await sharp(storyOut).metadata()).toMatchObject({ width: 1080, height: 1920 });
      // Тело заглушки — сплошной тёмный квадрат, кремовой полосы нет: знак по запасному варианту (≤ 200 px от левого края).
      const fit = fitLogoToStrip(510 / 642, null);
      const box34 = { left: fit.left, top: STORY_34_TOP + MODEL_LOGO_BOX.story34.top, height: fit.height };
      expect(await ownerLogoPixels(storyOut, box34)).toBeGreaterThan(300);
    } finally {
      tuning.imageModel = "gpt-image-1"; tuning.candidates = 2;
    }
  });

  it("достройка 9:16 упала (отказ модели): обложка не страдает, вертикаль 1080×1920 из размытой копии, причина в журнале", async () => {
    const property = await makeProperty();
    tuning.imageModel = "gpt-image-2.5-sunburst"; tuning.candidates = 1;
    try {
      const { calls } = stubOpenAi({
        image: (form) => (form.get("mask") ? { status: 400, json: { error: { message: "mask rejected" } } } : { json: { data: [{ b64_json: generatedPng.toString("base64") }] } }),
      });
      const cover = await makePropertyCover(property.id, { retryDelayMs: 0 });
      expect(cover).not.toBeNull();
      expect(calls.imageRequests).toBe(3);
      const storyOut = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.storyUrl)));
      expect(await sharp(storyOut).metadata()).toMatchObject({ width: 1080, height: 1920 });
      // Края — размытая затемнённая копия (тёмнее тела), а не ответ модели.
      const { channels } = await sharp(storyOut).extract({ left: 0, top: 0, width: 1080, height: 100 }).removeAlpha().stats();
      expect(channels.reduce((a, c) => a + c.mean, 0) / channels.length).toBeLessThan(20);
      expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("Достройка вертикали обложки до 9:16 не вышла"), expect.anything());
      // Неудача достройки в журнале ИИ как провалившаяся картинка (считается лимитом дня).
      const failed = await prisma.aiLog.count({ where: { endpoint: COVER_IMAGE_ENDPOINT, ok: false } });
      expect(failed).toBeGreaterThanOrEqual(1);
    } finally {
      tuning.imageModel = "gpt-image-1"; tuning.candidates = 2;
    }
  });

  it("достройка 9:16 удалась: верх и низ от модели, цена и картинка попадают в дневной счёт", async () => {
    const property = await makeProperty();
    tuning.imageModel = "gpt-image-2.5-sunburst"; tuning.candidates = 1;
    try {
      const outpainted = await sharp({ create: { width: 1152, height: 2048, channels: 3, background: { r: 200, g: 50, b: 50 } } }).png().toBuffer();
      stubOpenAi({
        image: (form) => ({ json: { data: [{ b64_json: (form.get("mask") ? outpainted : generatedPng).toString("base64") }] } }),
      });
      const cover = await makePropertyCover(property.id, { retryDelayMs: 0 });
      expect(cover).not.toBeNull();
      const storyOut = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.storyUrl)));
      expect(await sharp(storyOut).metadata()).toMatchObject({ width: 1080, height: 1920 });
      const top = await px(storyOut, 600, 20);
      expect(top.r).toBeGreaterThan(150);
      expect(top.g).toBeLessThan(90);
      // Все три картинки (квадрат, вертикаль, достройка) записаны в журнал по endpoint обложек.
      expect(await prisma.aiLog.count({ where: { endpoint: COVER_IMAGE_ENDPOINT, ok: true } })).toBe(3);
    } finally {
      tuning.imageModel = "gpt-image-1"; tuning.candidates = 2;
    }
  });

  it("достройка 9:16 при исчерпанном дневном лимите пропускается (запроса нет), вертикаль — размытая копия", async () => {
    const property = await makeProperty();
    // Лимит дня = 2 картинки: квадрат и вертикаль 3:4 забирают обе, на достройку не остаётся.
    tuning.imageModel = "gpt-image-2.5-sunburst"; tuning.candidates = 1; await prisma.settings.update({ where: { id: "singleton" }, data: { openaiCoverDailyLimit: 2 } });
    try {
      const { calls } = stubOpenAi();
      const cover = await makePropertyCover(property.id, { retryDelayMs: 0 });
      expect(cover).not.toBeNull();
      expect(calls.imageRequests).toBe(2);
      const storyOut = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.storyUrl)));
      expect(await sharp(storyOut).metadata()).toMatchObject({ width: 1080, height: 1920 });
    } finally {
      tuning.imageModel = "gpt-image-1"; tuning.candidates = 2; await prisma.settings.update({ where: { id: "singleton" }, data: { openaiCoverDailyLimit: 1000 } });
    }
  });
});

/**
 * Б7 (25.09.2026, уборка диска) — обложка после замены не доходила до сайта у
 * объекта, который уже AVAILABLE (publishedOnSite): resyncPhotosIfPublished
 * никто не звал из makePropertyCover, и первая картинка на сайте оставалась
 * старой (устаревшие цифры) до следующего случайного повода досослаться.
 * enqueueBackgroundJob пишет запись «в отрыве» (void, без await в coverOpenAi.ts) —
 * читаем её через waitFor/waitForSettled, а не сразу после ответа.
 */
describe("Б7 — ресинк сайта после новой обложки", () => {
  afterEach(async () => {
    // Чистим только свои задания — по dedupeKey, не каталог целиком.
    await prisma.backgroundJob.deleteMany({ where: { type: "site-resync", dedupeKey: { in: propertyIds.map((id) => `site-resync:${id}`) } } });
  });

  it("успех и не из кэша — задание ресинка есть только у объекта, опубликованного на сайте", async () => {
    const onSite = await makeProperty();
    await prisma.property.update({ where: { id: onSite.id }, data: { publishedOnSite: true } });
    const offSite = await makeProperty();

    stubOpenAi();
    expect(await makePropertyCover(onSite.id, { retryDelayMs: 0 })).not.toBeNull();
    const job = await waitFor(() => prisma.backgroundJob.findFirst({ where: { type: "site-resync", dedupeKey: `site-resync:${onSite.id}` } }), {
      label: "задание site-resync после новой обложки",
    });
    expect(job).not.toBeNull();

    stubOpenAi();
    expect(await makePropertyCover(offSite.id, { retryDelayMs: 0 })).not.toBeNull();
    const noJob = await waitForSettled(() => prisma.backgroundJob.findFirst({ where: { type: "site-resync", dedupeKey: `site-resync:${offSite.id}` } }));
    expect(noJob).toBeNull();
  });

  it("повтор из кэша — новых файлов на диске нет, ресинку нечего досылать", async () => {
    const property = await makeProperty();
    await prisma.property.update({ where: { id: property.id }, data: { publishedOnSite: true } });

    stubOpenAi();
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).not.toBeNull();
    await waitFor(() => prisma.backgroundJob.findFirst({ where: { type: "site-resync", dedupeKey: `site-resync:${property.id}` } }));
    await prisma.backgroundJob.deleteMany({ where: { type: "site-resync", dedupeKey: `site-resync:${property.id}` } });

    const cached = stubOpenAi();
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).toMatchObject({ cached: true });
    expect(cached.fetchMock).not.toHaveBeenCalled();
    const noJob = await waitForSettled(() => prisma.backgroundJob.findFirst({ where: { type: "site-resync", dedupeKey: `site-resync:${property.id}` } }));
    expect(noJob).toBeNull();
  });

  it("сбой ChatGPT — запасная обложка шаблона, ресинк уходит (иначе сайт держит устаревшую картинку)", async () => {
    const property = await makeProperty();
    await prisma.property.update({ where: { id: property.id }, data: { publishedOnSite: true } });

    stubOpenAi({ image: () => new Error("ECONNRESET") });
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).toMatchObject({ fallback: true });
    const job = await waitFor(() => prisma.backgroundJob.findFirst({ where: { type: "site-resync", dedupeKey: `site-resync:${property.id}` } }), {
      label: "задание site-resync после сбоя обложки",
    });
    expect(job).not.toBeNull();
  });
});

/**
 * ЗАПАСНАЯ ОБЛОЖКА ШАБЛОНОМ (02.10.2026). У OpenAI закончились деньги (429 «no credits»),
 * и публикация Reel оставалась без обложки. Теперь, если ChatGPT не смог, обложку строит
 * наш «Royal Green» из настоящего фото без единого вызова ИИ; метка `fallback-template:`
 * в хэше не даёт принять её за кэш, когда ChatGPT снова доступен.
 */
describe("запасная обложка шаблоном", () => {
  const noCredits = () => ({ status: 429, json: { error: { message: "You have no credits remaining. Add credits to continue.", type: "invalid_request_error", code: null } } });

  it("нет денег у OpenAI: обложка шаблона 1080×1080 и 1080×1920, метка в хэше, один запрос к ChatGPT и ни одного после", async () => {
    const property = await makeProperty();
    const { calls, fetchMock } = stubOpenAi({ image: noCredits });
    const cover = await makePropertyCover(property.id, { retryDelayMs: 0 });
    expect(cover).toMatchObject({ fallback: true, cached: false });
    expect(calls.imageRequests).toBe(1);
    // Ни одного обращения к чему-то кроме первой неудачной картинки: ни выбор фото, ни Gemini.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.socialCoverInputHash).toMatch(/^fallback-template:/);
    expect(after.socialCoverError).toBeNull();
    const square = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.squareUrl)));
    const story = await fs.readFile(path.join(propertyCoversDir, path.basename(cover!.storyUrl)));
    expect(await sharp(square).metadata()).toMatchObject({ width: 1080, height: 1080 });
    expect(await sharp(story).metadata()).toMatchObject({ width: 1080, height: 1920 });
    expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("запасная обложка"), expect.objectContaining({ dedupKey: expect.stringMatching(/^cover-fallback-template:/) }));
    expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("закончились деньги"), expect.anything());
  });

  it("нет ключа OpenAI: запасная обложка без единого запроса в сеть", async () => {
    const property = await makeProperty();
    await prisma.settings.update({ where: { id: "singleton" }, data: { openaiApiKey: null } });
    try {
      const { fetchMock } = stubOpenAi();
      expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).toMatchObject({ fallback: true });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { openaiApiKey: encryptSecret("sk-test-settings-key") } });
    }
  });

  it("повтор при мёртвом ChatGPT: запасная обложка из кэша, файлы не переписываются (и при force)", async () => {
    const property = await makeProperty();
    stubOpenAi({ image: noCredits });
    const first = await makePropertyCover(property.id, { retryDelayMs: 0 });
    stubOpenAi({ image: noCredits });
    expect(await makePropertyCover(property.id, { retryDelayMs: 0 })).toMatchObject({ fallback: true, cached: true, squareUrl: first!.squareUrl });
    stubOpenAi({ image: noCredits });
    expect(await makePropertyCover(property.id, { force: true, retryDelayMs: 0 })).toMatchObject({ fallback: true, cached: true, storyUrl: first!.storyUrl });
  });

  it("ChatGPT снова работает: запасная метка не считается кэшем — обложка перерисована ChatGPT-ом", async () => {
    const property = await makeProperty();
    stubOpenAi({ image: noCredits });
    const fallback = await makePropertyCover(property.id, { retryDelayMs: 0 });
    expect(fallback?.fallback).toBe(true);

    resetOpenAiNoMoneyBreaker(); // прошло два часа / деньги пополнили
    const { calls } = stubOpenAi();
    const redrawn = await makePropertyCover(property.id, { retryDelayMs: 0 });
    expect(redrawn).toMatchObject({ cached: false });
    expect(redrawn?.fallback).toBeUndefined();
    expect(redrawn?.squareUrl).not.toBe(fallback!.squareUrl);
    expect(calls.imageRequests).toBeGreaterThan(0);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.socialCoverInputHash).not.toMatch(/^fallback-template:/);
  });

  it("обложки выключены в Настройках — запасной обложки нет", async () => {
    const property = await makeProperty();
    await prisma.settings.update({ where: { id: "singleton" }, data: { coverGenerationEnabled: false } });
    try {
      const { fetchMock } = stubOpenAi({ image: noCredits });
      expect(await makePropertyCover(property.id, { force: true })).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.socialCoverInputHash).toBeNull();
      expect(after.socialCoverSquareUrl).toBeNull();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { coverGenerationEnabled: true } });
    }
  });

  it("объект удалён или без фото — запасной обложки нет", async () => {
    const noPhoto = await makeProperty(false);
    stubOpenAi({ image: noCredits });
    expect(await makePropertyCover(noPhoto.id, { retryDelayMs: 0 })).toBeNull();
    const deleted = await makeProperty();
    await prisma.property.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    expect(await makePropertyCover(deleted.id, { retryDelayMs: 0 })).toBeNull();
    expect((await prisma.property.findUniqueOrThrow({ where: { id: deleted.id } })).socialCoverInputHash).toBeNull();
  });

  it("ручная обложка: «Перерисовать» при мёртвом ChatGPT её не заменяет запасной", async () => {
    const property = await makeProperty();
    const mine = await sharp({ create: { width: 1500, height: 1500, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toBuffer();
    const manual = await storeManualCover(property.id, { square: mine, story: null });
    stubOpenAi({ image: noCredits });
    expect(await makePropertyCover(property.id, { force: true, retryDelayMs: 0 })).toBeNull();
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.socialCoverSquareUrl).toBe(manual.squareUrl);
    expect(after.socialCoverInputHash).toMatch(/^manual:/);
  });

  it("пробная обложка из Настроек (dryRun) проверяет именно ChatGPT: отказ остаётся отказом", async () => {
    const property = await makeProperty();
    stubOpenAi({ image: noCredits });
    const dry = await createPropertyCover(property.id, { dryRun: true, retryDelayMs: 0 });
    expect(dry.ok).toBe(false);
    expect(dry.reason).toMatch(/закончились деньги/);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).socialCoverStoryUrl).toBeNull();
  });
});
