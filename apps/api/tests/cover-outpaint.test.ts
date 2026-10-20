import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

/**
 * ДОСТРОЙКА ВЕРТИКАЛИ 9:16 МОДЕЛЬЮ (01.10.2026). Владелец забраковал размытые тёмные полосы сверху и снизу:
 * вместо них gpt-image-2.x дорисовывает верх и низ по маске, а центр возвращается из оригинала.
 * `openAiPost` и журнал ИИ подменены целиком: сеть и база не нужны, проверяем картинку, запрос, цену и откаты.
 */
const { post, logCall, logSystemError } = vi.hoisted(() => ({
  post: vi.fn(),
  logCall: vi.fn(async () => {}),
  logSystemError: vi.fn(async () => {}),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));
vi.mock("../src/ai/openaiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/openaiClient.js")>()),
  openAiPost: post,
  logOpenAiCall: logCall,
}));

const { outpaintStoryBody, storyFromGenerated, COVER_IMAGE_ENDPOINT, OUTPAINT_PROMPT, OUTPAINT_QUALITY, STORY_34_TOP } = await import("../src/lib/video/coverOpenAi.js");
const { imageCostFromUsage } = await import("../src/ai/openaiClient.js");

const W = 1080;
const BODY_H = 1440;
const MODEL_GRAY = { r: 120, g: 130, b: 140 };

async function pseudoBody(): Promise<{ png: Buffer; raw: Buffer }> {
  const raw = Buffer.alloc(W * BODY_H * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 251;
  return { raw, png: await sharp(raw, { raw: { width: W, height: BODY_H, channels: 3 } }).png().toBuffer() };
}

async function modelReply(usage?: Record<string, unknown>) {
  const out = await sharp({ create: { width: 1152, height: 2048, channels: 3, background: MODEL_GRAY } }).png().toBuffer();
  return { data: [{ b64_json: out.toString("base64") }], usage };
}

async function px(img: Buffer, left: number, top: number) {
  const { data } = await sharp(img).extract({ left, top, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return { r: data[0], g: data[1], b: data[2] };
}

beforeEach(() => {
  post.mockReset();
  logCall.mockClear();
  logSystemError.mockClear();
});

describe("outpaintStoryBody", () => {
  it("итог 1080×1920; середина тела (строки 300…1620) побайтно равна оригиналу, верх и низ — от модели", async () => {
    const { png, raw } = await pseudoBody();
    post.mockResolvedValue(await modelReply());
    const out = await outpaintStoryBody({ apiKey: "sk-test", model: "gpt-image-2.5-sunburst", body: png });
    expect(await sharp(out).metadata()).toMatchObject({ width: 1080, height: 1920 });

    const middle = await sharp(out).extract({ left: 0, top: 300, width: W, height: 1320 }).removeAlpha().raw().toBuffer();
    expect(middle.equals(raw.subarray((300 - STORY_34_TOP) * W * 3, (1620 - STORY_34_TOP + 0) * W * 3))).toBe(true);
    // Края — то, что нарисовала модель (однотонная заглушка), а не размытая копия тела.
    expect(await px(out, 500, 0)).toEqual(MODEL_GRAY);
    expect(await px(out, 500, 1919)).toEqual(MODEL_GRAY);
    expect(await px(out, 500, 100)).toEqual(MODEL_GRAY);
  });

  it("запрос: images/edits, модель, quality medium, 1152×2048, холст и маска; в маске тело непрозрачно, верх и низ прозрачны", async () => {
    const { png } = await pseudoBody();
    post.mockResolvedValue(await modelReply());
    await outpaintStoryBody({ apiKey: "sk-test", model: "gpt-image-2.5-sunburst", body: png, retryDelayMs: 0 });
    expect(post).toHaveBeenCalledTimes(1);
    const [path, init] = post.mock.calls[0] as [string, { body: FormData; apiKey: string; timeoutMs: number }];
    expect(path).toBe("/images/edits");
    expect(init.apiKey).toBe("sk-test");
    expect(init.timeoutMs).toBeGreaterThan(0);
    const form = init.body;
    expect(form.get("model")).toBe("gpt-image-2.5-sunburst");
    expect(form.get("quality")).toBe(OUTPAINT_QUALITY);
    expect(OUTPAINT_QUALITY).toBe("medium");
    expect(form.get("size")).toBe("1152x2048");
    expect(form.get("n")).toBe("1");
    expect(form.get("prompt")).toBe(OUTPAINT_PROMPT);
    expect(String(form.get("prompt"))).toContain("без размытия");

    const canvas = Buffer.from(await (form.get("image[]") as Blob).arrayBuffer());
    const mask = Buffer.from(await (form.get("mask") as Blob).arrayBuffer());
    for (const img of [canvas, mask]) expect(await sharp(img).metadata()).toMatchObject({ width: 1152, height: 2048 });
    const alphaAt = async (img: Buffer, y: number) => {
      const { data } = await sharp(img).ensureAlpha().extract({ left: 600, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
      return data[3];
    };
    // Тело 1152×1536 стоит со строки 256 до 1791.
    for (const img of [canvas, mask]) {
      expect(await alphaAt(img, 10)).toBe(0);
      expect(await alphaAt(img, 255)).toBe(0);
      expect(await alphaAt(img, 256)).toBe(255);
      expect(await alphaAt(img, 1791)).toBe(255);
      expect(await alphaAt(img, 1792)).toBe(0);
      expect(await alphaAt(img, 2040)).toBe(0);
    }
  });

  it("цена: по usage в onCost и одной строкой в журнал ИИ (endpoint картинок обложки), иначе по таблице", async () => {
    const { png } = await pseudoBody();
    const usage = { input_tokens: 2500, output_tokens: 6200, input_tokens_details: { text_tokens: 300, image_tokens: 2200 } };
    const expected = imageCostFromUsage(usage as never);
    expect(expected).toBeGreaterThan(0);
    post.mockResolvedValueOnce(await modelReply(usage));
    const costs: number[] = [];
    await outpaintStoryBody({ apiKey: "sk-test", model: "gpt-image-2.5-sunburst", body: png, onCost: (usd) => costs.push(usd) });
    expect(costs).toEqual([expected]);
    expect(logCall).toHaveBeenCalledTimes(1);
    expect(logCall).toHaveBeenCalledWith(expect.objectContaining({ endpoint: COVER_IMAGE_ENDPOINT, model: "gpt-image-2.5-sunburst", costUsd: expected, ok: true }));

    // Без usage — табличная цена картинки medium, не ноль.
    post.mockResolvedValueOnce(await modelReply());
    await outpaintStoryBody({ apiKey: "sk-test", model: "gpt-image-2.5-sunburst", body: png, onCost: (usd) => costs.push(usd) });
    expect(costs[1]).toBeGreaterThan(0);
  });

  it("сбой модели (429/таймаут) и пустой ответ бросают, неудача идёт в журнал и считается лимитом дня", async () => {
    const { png } = await pseudoBody();
    post.mockRejectedValueOnce(new Error("429 rate limit"));
    await expect(outpaintStoryBody({ apiKey: "k", model: "gpt-image-2.5-sunburst", body: png })).rejects.toThrow(/429/);
    expect(logCall).toHaveBeenLastCalledWith(expect.objectContaining({ endpoint: COVER_IMAGE_ENDPOINT, costUsd: null, ok: false }));

    post.mockResolvedValueOnce({ data: [] });
    await expect(outpaintStoryBody({ apiKey: "k", model: "gpt-image-2.5-sunburst", body: png })).rejects.toThrow(/без картинки/);
    expect(logCall).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
    expect(logCall).toHaveBeenCalledTimes(2);
  });
});

describe("storyFromGenerated: достройка и откат на размытый вариант", () => {
  // stats() у sharp не видит extract в цепочке — сначала собираем кусок в буфер.
  const meanOf = async (img: Buffer, top: number) => {
    const part = await sharp(img).extract({ left: 0, top, width: W, height: 100 }).removeAlpha().png().toBuffer();
    const { channels } = await sharp(part).stats();
    return channels.reduce((a, c) => a + c.mean, 0) / channels.length;
  };

  it("достройка отдаёт кадр — берём его; ей приходит тело 1080×1440 УЖЕ со знаком", async () => {
    const { png } = await pseudoBody();
    const logo = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const frame = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: { r: 9, g: 99, b: 199 } } }).png().toBuffer();
    let received: Buffer | null = null;
    const story = await storyFromGenerated(png, { input: logo, left: 60, top: STORY_34_TOP + 80 }, {
      portrait34: true,
      format: "png",
      extend: async (body) => {
        received = body;
        return frame;
      },
    });
    expect(await px(story, 5, 5)).toEqual({ r: 9, g: 99, b: 199 });
    expect(received).not.toBeNull();
    expect(await sharp(received!).metadata()).toMatchObject({ width: 1080, height: 1440 });
    // В переданном теле знак стоит в координатах тела (кадр − 240).
    expect(await px(received!, 70, 90)).toEqual({ r: 255, g: 0, b: 0 });
  });

  it.each([
    ["вернула null", async () => null],
    ["упала", async () => { throw new Error("429"); }],
  ])("достройка %s: всё равно 1080×1920, края — размытая затемнённая копия, центр без изменений", async (_name, extend) => {
    const { png, raw } = await pseudoBody();
    const story = await storyFromGenerated(png, null, { portrait34: true, format: "png", extend });
    expect(await sharp(story).metadata()).toMatchObject({ width: 1080, height: 1920 });
    const center = await sharp(story).extract({ left: 0, top: 240, width: W, height: BODY_H }).removeAlpha().raw().toBuffer();
    expect(center.equals(raw)).toBe(true);
    expect(await meanOf(story, 0)).toBeLessThan((await meanOf(story, 500)) * 0.6);
    expect(await meanOf(story, 1820)).toBeLessThan((await meanOf(story, 500)) * 0.6);
  });

  it("без extend (прежний вызов) — размытый вариант как раньше", async () => {
    const { png } = await pseudoBody();
    const story = await storyFromGenerated(png, null, { portrait34: true });
    expect(await sharp(story).metadata()).toMatchObject({ width: 1080, height: 1920, format: "jpeg" });
  });
});
