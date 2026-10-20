/**
 * ИИ-обложка свободных роликов (12.10.2026): Gemini по умолчанию, кадр ролика как основа, свежие
 * тренды, запасной ответ без поиска, кэш трендов. Без сети и без базы: Gemini (fetch), OpenAI,
 * ключи и поиск подменены; ffmpeg настоящий, тесты кадра пропускаются, если его нет.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SocialVideoTrends } from "@royal-home/shared";

// База не нужна: без `settings` общий сброс настроек из tests/setup.ts пропускает файл.
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => undefined } }));
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGemini: vi.fn(),
  callGeminiGrounded: vi.fn(),
  resolveGeminiKey: vi.fn(),
}));
vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: vi.fn(),
}));
vi.mock("../src/ai/shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/shared.js")>()),
  logAiCall: vi.fn(async () => undefined),
}));
vi.mock("../src/ai/openaiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/openaiClient.js")>()),
  openAiPost: vi.fn(),
  resolveOpenAiKey: vi.fn(),
  logOpenAiCall: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/video/coverOpenAi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/video/coverOpenAi.js")>()),
  loadCoverRuntimeSettings: vi.fn(),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => undefined),
}));

import { callGeminiGrounded, resolveGeminiKey } from "../src/ai/geminiClient.js";
import { resolveGeminiRuntime, type GeminiRuntime } from "../src/ai/geminiSettings.js";
import { OpenAiError, openAiPost, resolveOpenAiKey } from "../src/ai/openaiClient.js";
import { loadCoverRuntimeSettings } from "../src/lib/video/coverOpenAi.js";
import { resolveFfmpegBin } from "../src/lib/ffmpeg.js";
import {
  SocialVideoAiError,
  buildSocialVideoCoverPrompt,
  explainGeminiCoverFailure,
  generateSocialVideoCoverImage,
  listCoverProviders,
} from "../src/lib/socialVideoAi.js";
import { extractVideoFrameJpeg, frameSampleTimes, scoreFrame } from "../src/lib/socialVideoFrame.js";
import {
  EVERGREEN_COVER_RULES,
  getSocialVideoTrends,
  parseTrendDigest,
  resetSocialVideoTrendsCache,
} from "../src/lib/socialVideoTrends.js";

const grounded = vi.mocked(callGeminiGrounded);
const geminiKey = vi.mocked(resolveGeminiKey);
const runtime = vi.mocked(resolveGeminiRuntime);

function geminiRuntime(patch: Partial<GeminiRuntime> = {}): GeminiRuntime {
  return {
    keys: ["gm-key"],
    model: "gemini-test",
    fallbackModels: [],
    transcribeModels: [],
    imageModel: "gemini-image-test",
    liteModel: "",
    explicitCaching: false,
    ...patch,
  };
}

async function png(color: string): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 96, channels: 3, background: color } }).png().toBuffer();
}

const trends: SocialVideoTrends = {
  digest: ["Тёплые пастельные тона с одним акцентом", "Естественный свет из окна"],
  updatedAt: "2026-10-12T00:00:00.000Z",
  source: "LIVE",
  sources: [],
};

// ───────────────────────────── рисование ─────────────────────────────

describe("generateSocialVideoCoverImage: Gemini", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    runtime.mockResolvedValue(geminiRuntime());
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function okResponse(): Promise<Response> {
    const data = (await png("#cc8844")).toString("base64");
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data } }] } }] }),
      { status: 200 }
    );
  }

  function sentBody(call = 0): { contents: { parts: Record<string, any>[] }[]; generationConfig: Record<string, any> } {
    return JSON.parse(fetchMock.mock.calls[call]![1].body as string);
  }

  it("без provider рисует Gemini, а OpenAI не трогает; кадр уходит картинкой-основой, тренды попадают в промт", async () => {
    fetchMock.mockResolvedValue(await okResponse());
    const frame = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#224466" } }).jpeg().toBuffer();

    const result = await generateSocialVideoCoverImage({
      title: "Новый офис",
      brief: "День открытых дверей",
      frameImage: frame,
      trends,
    });

    expect(result).toMatchObject({ provider: "GEMINI", usedFrame: true, usedTrends: true, mimeType: "image/jpeg" });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(openAiPost).not.toHaveBeenCalled();

    const body = sentBody();
    const [first, second] = body.contents[0]!.parts;
    expect(first).toEqual({ inlineData: { mimeType: "image/jpeg", data: frame.toString("base64") } });
    expect(second!.text).toContain("КАДР из самого ролика");
    expect(second!.text).toContain("Новый офис");
    expect(second!.text).toContain("Учти актуальные тренды оформления обложек: Тёплые пастельные тона с одним акцентом; Естественный свет из окна");
    expect(second!.text).toMatch(/БЕЗ ТЕКСТА/);
    expect(body.generationConfig).toMatchObject({ responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16" } });
    expect(fetchMock.mock.calls[0]![0]).toContain("gemini-image-test");
    expect(fetchMock.mock.calls[0]![1].headers["x-goog-api-key"]).toBe("gm-key");
  });

  it("без кадра и трендов уходит один текстовый part и usedFrame/usedTrends = false", async () => {
    fetchMock.mockResolvedValue(await okResponse());
    const result = await generateSocialVideoCoverImage({ title: "Ролик", brief: null });
    expect(result).toMatchObject({ provider: "GEMINI", usedFrame: false, usedTrends: false });
    const parts = sentBody().contents[0]!.parts;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).not.toContain("тренды");
  });

  it("429 free-tier: человеческая ошибка с советом переключиться, другие ключи не перебираются", async () => {
    runtime.mockResolvedValue(geminiRuntime({ keys: ["k1", "k2"] }));
    fetchMock.mockResolvedValue(
      new Response('{"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}', { status: 429 })
    );
    const error = await generateSocialVideoCoverImage({ title: "Ролик", brief: null }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialVideoAiError);
    expect((error as Error).message).toBe(
      "Gemini рисует картинки только на платном проекте Google — переключитесь на ChatGPT или подключите оплату"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("отклонённый ключ (403): пробует следующий ключ", async () => {
    runtime.mockResolvedValue(geminiRuntime({ keys: ["bad", "good"] }));
    fetchMock.mockResolvedValueOnce(new Response("denied", { status: 403 })).mockResolvedValueOnce(await okResponse());
    const result = await generateSocialVideoCoverImage({ title: "Ролик", brief: null });
    expect(result.provider).toBe("GEMINI");
    expect(fetchMock.mock.calls[1]![1].headers["x-goog-api-key"]).toBe("good");
  });

  it("модель не знает imageConfig (400): повтор без него", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("Invalid JSON payload: unknown field imageConfig", { status: 400 }))
      .mockResolvedValueOnce(await okResponse());
    await generateSocialVideoCoverImage({ title: "Ролик", brief: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(0).generationConfig.imageConfig).toBeDefined();
    expect(sentBody(1).generationConfig.imageConfig).toBeUndefined();
  });

  it("ответ без картинки (отказ по содержанию) и нет ключа — SocialVideoAiError по-русски", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ candidates: [{ finishReason: "IMAGE_SAFETY" }] }), { status: 200 }));
    await expect(generateSocialVideoCoverImage({ title: "Ролик", brief: null })).rejects.toThrow(/Gemini отказался рисовать/);

    runtime.mockResolvedValue(geminiRuntime({ keys: [] }));
    fetchMock.mockClear();
    await expect(generateSocialVideoCoverImage({ title: "Ролик", brief: null })).rejects.toThrow(/Ключ Gemini не введён/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("текст ошибок Google не содержит сырого тела ответа", () => {
    expect(explainGeminiCoverFailure(429, "обычный лимит")).toMatch(/частоту/);
    expect(explainGeminiCoverFailure(404, "x")).toMatch(/модел/);
    expect(explainGeminiCoverFailure(500, "internal secret detail")).not.toContain("secret");
  });
});

describe("generateSocialVideoCoverImage: OpenAI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveOpenAiKey).mockResolvedValue({ key: "sk-test", source: "env" });
    vi.mocked(loadCoverRuntimeSettings).mockResolvedValue({
      openaiImageModel: "gpt-image-2.5-sunburst",
      openaiImageQuality: "medium",
    } as Awaited<ReturnType<typeof loadCoverRuntimeSettings>>);
  });

  it("путь жив: кадр игнорируется (usedFrame=false), тренды вписаны в промт текстом", async () => {
    vi.mocked(openAiPost).mockResolvedValue({ data: [{ b64_json: Buffer.from("PNGDATA").toString("base64") }] });
    const result = await generateSocialVideoCoverImage({
      title: "Ролик",
      brief: "Тема",
      provider: "OPENAI",
      frameImage: Buffer.from("frame"),
      trends,
    });
    expect(result).toMatchObject({ provider: "OPENAI", usedFrame: false, usedTrends: true, mimeType: "image/png" });
    const body = vi.mocked(openAiPost).mock.calls[0]![1].body as Record<string, unknown>;
    expect(String(body.prompt)).toContain("Учти актуальные тренды оформления обложек");
    expect(String(body.prompt)).not.toContain("КАДР из самого ролика");
  });

  it("нет денег: прежний текст плюс совет переключиться на Gemini", async () => {
    vi.mocked(openAiPost).mockRejectedValue(new OpenAiError("На счёте OpenAI закончились деньги", 429, "insufficient_quota"));
    const error = await generateSocialVideoCoverImage({ title: "Ролик", brief: null, provider: "OPENAI" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialVideoAiError);
    expect((error as Error).message).toContain("пополните баланс или загрузите обложку сами");
    expect((error as Error).message).toContain("переключиться на Gemini");
  });
});

describe("buildSocialVideoCoverPrompt / listCoverProviders", () => {
  it("с кадром не запрещает людей и просит сохранить героя; без кадра запрет остаётся", () => {
    const withFrame = buildSocialVideoCoverPrompt({ title: "Т", brief: null, frameImage: Buffer.from("x") });
    expect(withFrame).toMatch(/сохрани героя/);
    expect(withFrame).not.toMatch(/Без людей/);
    expect(buildSocialVideoCoverPrompt({ title: "Т", brief: null })).toMatch(/Без людей крупным планом/);
  });

  it("показывает доступность по ключам без сети и называет проблему", async () => {
    runtime.mockResolvedValue(geminiRuntime({ keys: [] }));
    vi.mocked(resolveOpenAiKey).mockResolvedValue({ key: "sk", source: "settings" });
    const providers = await listCoverProviders();
    expect(providers.map((p) => p.provider)).toEqual(["GEMINI", "OPENAI"]);
    expect(providers[0]).toMatchObject({ available: false, problem: "Ключ Gemini не введён — Настройки → ИИ" });
    expect(providers[1]).toMatchObject({ available: true, problem: null });

    runtime.mockResolvedValue(geminiRuntime());
    vi.mocked(resolveOpenAiKey).mockRejectedValue(new Error("db down"));
    const again = await listCoverProviders();
    expect(again[0]).toMatchObject({ available: true });
    expect(again[1]!.available).toBe(false);
    expect(again[1]!.problem).toBeTruthy();
  });
});

// ───────────────────────────── тренды ─────────────────────────────

describe("getSocialVideoTrends", () => {
  const T0 = new Date("2026-10-12T08:00:00Z").getTime();
  const liveAnswer = {
    text: [
      "Вот основные тренды:",
      "1. **Тёплые пастельные тона** с одним ярким акцентом [1]",
      "2. Мягкий естественный свет из окна, без вспышки",
      "- Крупный план человека в интерьере https://example.com/x",
      "• Вертикальная симметрия и чистые линии",
      "Вертикальная симметрия и чистые линии",
      "5. Эстетика «живого» кадра без глянца",
    ].join("\n"),
    sources: [
      { url: "https://example.com/a", title: "Источник А" },
      { url: "ftp://bad.example/b", title: "плохая схема" },
      { url: "https://example.org/c" },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetSocialVideoTrendsCache();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    geminiKey.mockResolvedValue("gm-key");
    grounded.mockResolvedValue(liveAnswer);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("разбирает ответ поиска в пункты и источники; запрос про текущий месяц и год", async () => {
    const result = await getSocialVideoTrends();
    expect(result.source).toBe("LIVE");
    expect(result.updatedAt).toBe(new Date(T0).toISOString());
    expect(result.digest).toEqual([
      "Тёплые пастельные тона с одним ярким акцентом",
      "Мягкий естественный свет из окна, без вспышки",
      "Крупный план человека в интерьере",
      "Вертикальная симметрия и чистые линии",
      "Эстетика «живого» кадра без глянца",
    ]);
    expect(result.digest.every((line) => line.length <= 140)).toBe(true);
    expect(result.sources).toEqual([
      { title: "Источник А", url: "https://example.com/a" },
      { title: "example.org", url: "https://example.org/c" },
    ]);
    const params = grounded.mock.calls[0]![0];
    expect(params.apiKey).toBe("gm-key");
    expect(params.query).toContain("октябрь 2026");
    expect(params.timeoutMs).toBeGreaterThan(0);
  });

  it("кэш на сутки; refresh обходит кэш, но не чаще раза в 5 минут", async () => {
    await getSocialVideoTrends();
    await getSocialVideoTrends();
    expect(grounded).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 60_000);
    await getSocialVideoTrends({ refresh: true });
    expect(grounded).toHaveBeenCalledTimes(1); // слишком рано

    vi.setSystemTime(T0 + 6 * 60_000);
    await getSocialVideoTrends({ refresh: true });
    expect(grounded).toHaveBeenCalledTimes(2);

    vi.setSystemTime(T0 + 6 * 60_000 + 23 * 3_600_000);
    await getSocialVideoTrends();
    expect(grounded).toHaveBeenCalledTimes(2); // сутки ещё не прошли

    vi.setSystemTime(T0 + 6 * 60_000 + 24 * 3_600_000 + 1000);
    await getSocialVideoTrends();
    expect(grounded).toHaveBeenCalledTimes(3);
  });

  it("одновременные вызовы делят один запрос", async () => {
    const [a, b, c] = await Promise.all([getSocialVideoTrends(), getSocialVideoTrends(), getSocialVideoTrends({ refresh: true })]);
    expect(grounded).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("поиск не ответил, бросил, ключа нет или пунктов слишком мало: FALLBACK с вечными правилами", async () => {
    grounded.mockResolvedValueOnce(null);
    let result = await getSocialVideoTrends();
    expect(result).toMatchObject({ source: "FALLBACK", digest: [...EVERGREEN_COVER_RULES], sources: [] });
    expect(EVERGREEN_COVER_RULES).toHaveLength(5);

    resetSocialVideoTrendsCache();
    grounded.mockRejectedValueOnce(new Error("socket hang up"));
    expect((await getSocialVideoTrends()).source).toBe("FALLBACK");

    resetSocialVideoTrendsCache();
    geminiKey.mockResolvedValueOnce(undefined);
    result = await getSocialVideoTrends();
    expect(result.source).toBe("FALLBACK");
    expect(grounded).toHaveBeenCalledTimes(2); // без ключа в поиск не ходили

    resetSocialVideoTrendsCache();
    grounded.mockResolvedValueOnce({ text: "Вот тренды:\nКоротко\nОдин нормальный пункт про свет", sources: [] });
    expect((await getSocialVideoTrends()).source).toBe("FALLBACK");
  });

  it("неудачное принудительное обновление не затирает найденные тренды запасными", async () => {
    const live = await getSocialVideoTrends();
    vi.setSystemTime(T0 + 10 * 60_000);
    grounded.mockResolvedValueOnce(null);
    const after = await getSocialVideoTrends({ refresh: true });
    expect(grounded).toHaveBeenCalledTimes(2);
    expect(after).toEqual(live);
    expect((await getSocialVideoTrends()).source).toBe("LIVE");
  });

  it("parseTrendDigest: чистит нумерацию, ссылки, сноски, повторы; режет до 140 и берёт не больше 7", () => {
    const long = "Очень длинный приём оформления, ".repeat(10);
    const lines = Array.from({ length: 10 }, (_, i) => `${i + 1}. Приём номер ${i + 1} про композицию кадра`);
    const out = parseTrendDigest([long, ...lines].join("\n"));
    expect(out).toHaveLength(7);
    expect(out[0]!.length).toBeLessThanOrEqual(140);
    expect(out[1]).toBe("Приём номер 1 про композицию кадра");
  });
});

// ───────────────────────────── кадр из ролика ─────────────────────────────

describe("кадр из ролика: чистая логика", () => {
  it("точки съёмки: 15/35/55 %, не раньше 0,5 с и строго внутри ролика", () => {
    expect(frameSampleTimes(20)).toEqual([3, 7, 11]);
    expect(frameSampleTimes(1)).toEqual([0.5, 0.55]);
    expect(frameSampleTimes(null).length).toBeGreaterThan(0);
  });

  it("scoreFrame: чёрный кадр = 0, живой выше размытого", async () => {
    const black = await sharp({ create: { width: 128, height: 128, channels: 3, background: "#000" } }).jpeg().toBuffer();
    expect(await scoreFrame(black)).toBe(0);

    const noise = Buffer.alloc(128 * 128 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) % 251;
    const sharpFrame = await sharp(noise, { raw: { width: 128, height: 128, channels: 3 } }).jpeg().toBuffer();
    const blurred = await sharp(sharpFrame).blur(8).jpeg().toBuffer();
    expect(await scoreFrame(sharpFrame)).toBeGreaterThan(await scoreFrame(blurred));
  });
});

const ffmpegAvailable = spawnSync(resolveFfmpegBin("ffmpeg"), ["-version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!ffmpegAvailable)("extractVideoFrameJpeg (настоящий ffmpeg)", () => {
  let dir: string;

  async function makeVideo(name: string, filter: string): Promise<string> {
    const out = path.join(dir, name);
    const run = spawnSync(
      resolveFfmpegBin("ffmpeg"),
      ["-v", "error", "-filter_complex", filter, "-map", "[v]", "-pix_fmt", "yuv420p", "-y", out],
      { stdio: "pipe" }
    );
    expect(run.status, String(run.stderr)).toBe(0);
    return out;
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rh-frame-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("первые секунды чёрные, дальше картинка: берёт непустой кадр не длиннее 1280 px", async () => {
    const video = await makeVideo(
      "mixed.mp4",
      "color=c=black:s=320x568:r=10:d=4[a];testsrc2=s=320x568:r=10:d=6[b];[a][b]concat=n=2:v=1:a=0[v]"
    );
    const jpeg = await extractVideoFrameJpeg(video);
    expect(jpeg).not.toBeNull();
    const meta = await sharp(jpeg!).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1280);
    const mean = (await sharp(jpeg!).greyscale().stats()).channels[0]!.mean;
    expect(mean).toBeGreaterThan(30);
  });

  it("весь ролик чёрный или файла нет — null, без исключения", async () => {
    const black = await makeVideo("black.mp4", "color=c=black:s=320x568:r=10:d=3[v]");
    expect(await extractVideoFrameJpeg(black)).toBeNull();
    expect(await extractVideoFrameJpeg(path.join(dir, "нет-такого.mp4"))).toBeNull();
  });
});
