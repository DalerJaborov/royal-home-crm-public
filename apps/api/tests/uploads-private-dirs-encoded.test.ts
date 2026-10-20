import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { app } from "../src/app.js";
import { uploadsDir } from "../src/upload.js";

/**
 * ЗАКРЫТЫЕ ПАПКИ ЗАГРУЗОК НЕ ОБХОДЯТСЯ ЗАПИСЬЮ ПУТИ (23.09.2026, аудит №27).
 *
 * Сырые ролики объектов (/uploads/video, /automontage, /handoff) отдаются только
 * по токену или входу. Замок стоял на буквальном префиксе, а раздача файлов
 * сама раскодирует и нормализует путь: /uploads/%76ideo/… и /uploads//video/…
 * проходили мимо замка к тому же файлу. nginx передаёт адрес как есть.
 */

const name = `gate-${Date.now()}.mp4`;
const dir = path.join(uploadsDir, "video");
const file = path.join(dir, name);

beforeAll(() => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, "not really a video");
});

afterAll(() => {
  fs.rmSync(file, { force: true });
});

describe("Закрытые папки загрузок без входа", () => {
  it("прямой путь закрыт, как и раньше", async () => {
    const res = await request(app).get(`/uploads/video/${name}`);
    expect(res.status).toBe(403);
  });

  for (const variant of [`/uploads/%76ideo/${name}`, `/uploads//video/${name}`, `/uploads/./video/${name}`, `/uploads/%2Fvideo/${name}`]) {
    it(`обходной путь ${variant} не отдаёт файл`, async () => {
      const res = await request(app).get(variant);
      expect(res.status).not.toBe(200);
      expect(res.text).not.toContain("not really a video");
    });
  }
});
