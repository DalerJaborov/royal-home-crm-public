import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * ПРЕДОХРАНИТЕЛЬ «НЕТ ДЕНЕГ НА OPENAI». Баланс кончился — каждый объект и повтор
 * раньше снова бил в OpenAI (выбор фото + картинки) и тратил дневной лимит картинок
 * на заведомые отказы. Теперь: после первого «нет денег» два часа в OpenAI не ходим,
 * отказ не засчитывается в лимит, ключ журнала общий.
 */
const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const { prisma } = await import("../src/db.js");
const { uploadsDir } = await import("../src/upload.js");
const {
  chooseCoverPhoto,
  generateOpenAiCovers,
  coverImagesUsedToday,
  isOpenAiNoMoneyBreakerOpen,
  resetOpenAiNoMoneyBreaker,
  tripOpenAiNoMoneyBreaker,
  OPENAI_NO_MONEY_BREAKER_MS,
  COVER_IMAGE_NO_MONEY_ENDPOINT,
  COVER_IMAGE_ENDPOINT,
} = await import("../src/lib/video/coverOpenAi.js");
const { buildCoverPosterValues } = await import("../src/lib/video/coverPoster.js");

const files: string[] = [];
async function photos(count: number): Promise<{ id: string; url: string }[]> {
  await fs.mkdir(uploadsDir, { recursive: true });
  const out: { id: string; url: string }[] = [];
  for (let i = 0; i < count; i++) {
    const name = `nomoney-${crypto.randomUUID()}.jpg`;
    const color = { r: crypto.randomInt(0, 255), g: crypto.randomInt(0, 255), b: crypto.randomInt(0, 255) };
    await fs.writeFile(path.join(uploadsDir, name), await sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().toBuffer());
    files.push(path.join(uploadsDir, name));
    out.push({ id: crypto.randomUUID(), url: `/uploads/${name}` });
  }
  return out;
}

const noCredits = () =>
  new Response(JSON.stringify({ error: { message: "You have no credits remaining. Add credits to continue.", type: "invalid_request_error", code: null } }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });

beforeAll(async () => {
  await prisma.aiLog.deleteMany({ where: { endpoint: { in: [COVER_IMAGE_ENDPOINT, COVER_IMAGE_NO_MONEY_ENDPOINT] } } });
});
beforeEach(() => resetOpenAiNoMoneyBreaker());
afterEach(() => {
  vi.unstubAllGlobals();
  resetOpenAiNoMoneyBreaker();
});
afterAll(async () => {
  for (const f of files) await fs.rm(f, { force: true });
});

describe("предохранитель «нет денег на OpenAI»", () => {
  it("выбор фото: после отказа «нет денег» следующие объекты в OpenAI не ходят", async () => {
    const fetchMock = vi.fn(async () => noCredits());
    vi.stubGlobal("fetch", fetchMock);
    const first = await photos(3);
    const res = await chooseCoverPhoto("sk-test", first, 0);
    expect(res.photo).toEqual(first[0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isOpenAiNoMoneyBreakerOpen()).toBe(true);

    const second = await photos(3);
    const again = await chooseCoverPhoto("sk-test", second, 0);
    expect(again.photo).toEqual(second[0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("срок предохранителя — два часа", () => {
    const t0 = 1_000_000;
    tripOpenAiNoMoneyBreaker(t0);
    expect(isOpenAiNoMoneyBreakerOpen(t0 + OPENAI_NO_MONEY_BREAKER_MS - 1)).toBe(true);
    expect(isOpenAiNoMoneyBreakerOpen(t0 + OPENAI_NO_MONEY_BREAKER_MS)).toBe(false);
  });

  it("картинки: отказ «нет денег» не съедает дневной лимит и взводит предохранитель", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => noCredits()));
    const before = await coverImagesUsedToday();
    const values = buildCoverPosterValues(
      { type: "APARTMENT", rooms: 2, areaSqm: 90, floor: 15, totalFloors: 16, price: 890000, currency: "TJS", districtName: "Сино", address: "Тест", condition: "GOOD" } as never,
      { tjsPerUsd: 10.5 } as never
    );
    const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
    const res = await generateOpenAiCovers({
      apiKey: "sk-test",
      photo,
      logo: null,
      references: { square: null, story: null },
      values,
      facts: {} as never,
      quality: "low",
      candidates: 2,
      textMode: "MODEL",
      photoSource: "FIRST",
      imageModel: "gpt-image-1",
      imagesLeft: 100,
      retryDelayMs: 0,
      scene: "INTERIOR",
    } as never);
    expect(res.ok).toBe(false);
    expect(await coverImagesUsedToday()).toBe(before);
    expect(isOpenAiNoMoneyBreakerOpen()).toBe(true);
  });
});
