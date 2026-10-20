import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

/**
 * СИЛЬНАЯ ЛОКАЛЬНАЯ РЕТУШЬ, уровень 2 (владелец 02.10.2026: «киношный» вид, но настоящий
 * интерьер, без ИИ). Проверяем на синтетическом кадре: тёмные тени и светлое пятно «окна».
 */
const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const { strongRetouch, localRetouch, retouchCoverPhoto, DEFAULT_LOCAL_RETOUCH_LEVEL } = await import("../src/lib/video/coverPhotoRetouch.js");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "retouch-"));

/** Кадр W×H: слева тёмные тени (35…60), справа середина (90…150), в углу светлое «окно» 250. Градиент даёт фактуру. */
async function frame(width: number, height: number, seed = 0): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const left = x < width / 2;
      const base = left ? 35 + (25 * y) / height : 90 + (60 * x) / width;
      const window = x > width * 0.78 && y < height * 0.3;
      const v = window ? 250 : base + ((x * 7 + y * 13 + seed) % 9);
      const i = (y * width + x) * 3;
      raw[i] = Math.min(255, v + 4);
      raw[i + 1] = Math.min(255, v);
      raw[i + 2] = Math.min(255, v - 6);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

async function stats(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let sum = 0;
  let bright = 0;
  for (let i = 0; i < n; i++) {
    const luma = 0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2];
    sum += luma;
    if (luma >= 250) bright++;
  }
  return { mean: sum / n, brightShare: bright / n };
}

afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("strongRetouch (уровень 2)", () => {
  it("светлее в среднем, пересвет не растёт сильнее чем на 2 п. п., результат — JPEG не больше 1600 px", async () => {
    const input = await frame(2400, 1600);
    const out = await strongRetouch(input);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1600);
    // пропорции сохранены: 2400×1600 → 1600×1067
    expect(meta.width! / meta.height!).toBeCloseTo(1.5, 1);

    const before = await stats(input);
    const after = await stats(out);
    expect(after.mean).toBeGreaterThan(before.mean * 1.15);
    expect(after.brightShare).toBeLessThanOrEqual(before.brightShare + 0.02);
  });

  it("тени поднимаются сильнее, чем светлое: тёмная половина светлеет заметно", async () => {
    const input = await frame(1200, 800);
    const out = await strongRetouch(input);
    const darkBefore = await stats(await sharp(input).extract({ left: 0, top: 0, width: 500, height: 800 }).toBuffer());
    const darkAfter = await stats(await sharp(out).extract({ left: 0, top: 0, width: 500, height: 800 }).toBuffer());
    expect(darkAfter.mean).toBeGreaterThan(darkBefore.mean * 1.3);
  });

  it("детерминирована: один и тот же вход даёт побайтно тот же выход", async () => {
    const input = await frame(900, 600, 3);
    const [a, b] = [await strongRetouch(input), await strongRetouch(input)];
    expect(a.equals(b)).toBe(true);
  });

  it("маленькое фото не увеличивается", async () => {
    const out = await strongRetouch(await frame(300, 200));
    expect(await sharp(out).metadata()).toMatchObject({ width: 300, height: 200 });
  });
});

describe("retouchCoverPhoto: уровень локальной ретуши", () => {
  it("по умолчанию уровень 2", () => {
    expect(DEFAULT_LOCAL_RETOUCH_LEVEL).toBe(2);
  });

  it("localOnly: без единого запроса в сеть, сильная ретушь; level 1 — прежняя мягкая", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("в запасном пути сеть не нужна");
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = await frame(1000, 700, 11);
    const file = path.join(tmp, "photo.jpg");
    await fs.writeFile(file, input);

    const strong = await retouchCoverPhoto(file, { localOnly: true });
    expect(strong.source).toBe("local");
    expect(strong.image.equals(await strongRetouch(input))).toBe(true);

    const soft = await retouchCoverPhoto(file, { localOnly: true, level: 1 });
    expect(soft.source).toBe("local");
    expect(soft.image.equals(await localRetouch(input))).toBe(true);
    expect(soft.image.equals(strong.image)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Gemini недоступен (ключа нет): вместо мягкой — сильная ретушь по умолчанию", async () => {
    const input = await frame(800, 600, 17);
    const file = path.join(tmp, "photo2.jpg");
    await fs.writeFile(file, input);
    const res = await retouchCoverPhoto(file);
    // ключа Gemini в тестовой базе нет — путь тот же, что у отказа Gemini
    expect(["local", "gemini", "gemini-cache"]).toContain(res.source);
    if (res.source === "local") expect(res.image.equals(await strongRetouch(input))).toBe(true);
  });
});
