import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { REDRAW_PROMPT, redrawCoverPhoto } from "../src/lib/video/coverPhotoRedraw.js";
import { propertyCoversDir } from "../src/upload.js";

/**
 * Перерисовка фото под обложку «как в журнале» (владелец, 29.09.2026): одна
 * картинка ChatGPT на фото, дальше — из памяти; без ключа или сверх лимита дня
 * OpenAI не зовётся вовсе, а обложка собирается из обычной ретуши.
 */
const tmp = path.join(os.tmpdir(), `redraw-${crypto.randomUUID()}`);
const cached: string[] = [];

async function photoFile(): Promise<string> {
  await fs.mkdir(tmp, { recursive: true });
  const file = path.join(tmp, `${crypto.randomUUID()}.jpg`);
  // Своё фото на каждый тест — у кэша свой ключ, прогоны не мешают друг другу.
  const color = { r: crypto.randomInt(0, 255), g: crypto.randomInt(0, 255), b: crypto.randomInt(0, 255) };
  await fs.writeFile(file, await sharp({ create: { width: 800, height: 600, channels: 3, background: color } }).jpeg().toBuffer());
  return file;
}

function stubEdits() {
  const png = sharp({ create: { width: 64, height: 112, channels: 3, background: { r: 250, g: 240, b: 220 } } }).png().toBuffer();
  const fetchMock = vi.fn(async (url: string) => {
    if (!url.endsWith("/images/edits")) throw new Error(`неожиданный запрос ${url}`);
    return new Response(JSON.stringify({ data: [{ b64_json: (await png).toString("base64") }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const base = { apiKey: "sk-test", model: "gpt-image-1" as const, quality: "medium" as const, imagesLeft: 10, endpoint: "cover-redraw-test", retryDelayMs: 0 };

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  for (const f of cached) await fs.rm(f, { force: true });
});

describe("перерисовка фото обложки", () => {
  it("зовёт images/edits одной картинкой с промтом «журнал», второй раз — из памяти", async () => {
    const fetchMock = stubEdits();
    const photo = await photoFile();
    const before = new Set(await fs.readdir(path.join(propertyCoversDir, "redraw")).catch(() => [] as string[]));
    const first = await redrawCoverPhoto(photo, base);
    expect(first.ok).toBe(true);
    expect(first.ok && first.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const form = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get("prompt")).toBe(REDRAW_PROMPT);
    expect(form.get("n")).toBe("1");
    expect(form.getAll("image[]")).toHaveLength(1);
    expect(form.get("size")).toBe("1024x1536");

    const second = await redrawCoverPhoto(photo, base);
    expect(second.ok && second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const files = await fs.readdir(path.join(propertyCoversDir, "redraw"));
    // Убираем только свою запись кэша.
    cached.push(...files.filter((f) => !before.has(f)).map((f) => path.join(propertyCoversDir, "redraw", f)));
  });

  it("без ключа и сверх лимита дня OpenAI не зовётся", async () => {
    const fetchMock = stubEdits();
    const photo = await photoFile();
    const noKey = await redrawCoverPhoto(photo, { ...base, apiKey: null });
    expect(noKey).toMatchObject({ ok: false, reason: "ключ OpenAI не задан" });
    const noLimit = await redrawCoverPhoto(photo, { ...base, imagesLeft: 0 });
    expect(noLimit).toMatchObject({ ok: false, reason: "исчерпан дневной лимит картинок ChatGPT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("отказ OpenAI — ok: false с причиной, без исключения наружу", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400, headers: { "Content-Type": "application/json" } }))
    );
    const res = await redrawCoverPhoto(await photoFile(), base);
    expect(res.ok).toBe(false);
  });
});
