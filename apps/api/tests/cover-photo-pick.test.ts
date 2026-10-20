import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { COVER_PHOTO_PICK_PROMPT, chooseCoverPhoto } from "../src/lib/video/coverOpenAi.js";
import { uploadsDir } from "../src/upload.js";

/**
 * Выбор фото для обложки (владелец, 29.09.2026: «чтобы не брал фото кухни»):
 * модель смотрит фото объекта и выбирает общий план комнаты; ответ помнится,
 * без ключа, с одним фото или при ответе не по делу — первое фото.
 */
const files: string[] = [];

async function photos(count: number): Promise<{ id: string; url: string }[]> {
  await fs.mkdir(uploadsDir, { recursive: true });
  const out: { id: string; url: string }[] = [];
  for (let i = 0; i < count; i++) {
    const name = `pick-${crypto.randomUUID()}.jpg`;
    const color = { r: crypto.randomInt(0, 255), g: crypto.randomInt(0, 255), b: crypto.randomInt(0, 255) };
    await fs.writeFile(path.join(uploadsDir, name), await sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().toBuffer());
    files.push(path.join(uploadsDir, name));
    out.push({ id: crypto.randomUUID(), url: `/uploads/${name}` });
  }
  return out;
}

function stubChat(best: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ best }) } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const f of files) await fs.rm(f, { force: true });
});

describe("выбор фото для обложки", () => {
  it("берёт фото, которое назвала модель, и второй раз не спрашивает", async () => {
    const fetchMock = stubChat(3);
    const list = await photos(4);
    const first = await chooseCoverPhoto("sk-test", list, 0);
    expect(first.photo.id).toBe(list[2].id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages[0].content[0].text).toBe(COVER_PHOTO_PICK_PROMPT);
    expect(body.messages[0].content).toHaveLength(5);

    const again = await chooseCoverPhoto("sk-test", list, 0);
    expect(again).toEqual({ photo: list[2], costUsd: 0, found: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("без ключа или с одним фото — первое фото без запроса", async () => {
    const fetchMock = stubChat(2);
    const list = await photos(3);
    expect((await chooseCoverPhoto(null, list, 0)).photo).toEqual(list[0]);
    expect((await chooseCoverPhoto("sk-test", list.slice(0, 1), 0)).photo).toEqual(list[0]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ответ не по делу — первое фото", async () => {
    stubChat(99);
    const list = await photos(3);
    expect((await chooseCoverPhoto("sk-test", list, 0)).photo).toEqual(list[0]);
  });
});
