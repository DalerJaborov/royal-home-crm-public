import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { savePrivateFile, privateFilePath } from "../src/lib/privateFiles.js";

/**
 * Вложение клиента пишется на диск, не останавливая сервер (аудит 23.09.2026,
 * №89). Видео рум-тура — до 16 МБ, и `writeFileSync` держал весь процесс API
 * на время записи: ни запросов, ни живых обновлений, ни событий телефонии.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-private-async-"));
let previous: string | undefined;

beforeAll(() => {
  previous = process.env.PRIVATE_UPLOADS_DIR;
  process.env.PRIVATE_UPLOADS_DIR = dir;
});

afterAll(() => {
  if (previous === undefined) delete process.env.PRIVATE_UPLOADS_DIR;
  else process.env.PRIVATE_UPLOADS_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("запись вложения в закрытое хранилище", () => {
  it("не пишет синхронно и отдаёт имя обещанием; файл целиком на месте", async () => {
    const syncWrite = vi.spyOn(fs, "writeFileSync");
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    try {
      const pending = savePrivateFile(data, "video/mp4");
      expect(pending).toBeInstanceOf(Promise);
      const name = await pending;
      expect(syncWrite).not.toHaveBeenCalled();
      expect(name).toMatch(/\.mp4$/);
      const full = privateFilePath(name!);
      expect(full).not.toBeNull();
      expect(fs.readFileSync(full!).equals(data)).toBe(true);
    } finally {
      syncWrite.mockRestore();
    }
  });
});
