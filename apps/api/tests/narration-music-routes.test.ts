import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * БИБЛИОТЕКА МУЗЫКИ ОЗВУЧКИ: маршруты (18.11.2026). База и ffprobe настоящие; вход подменён ролью.
 * Права как у настроек озвучки: видит и слушает маркетинг/руководство, загружает и удаляет директор/админ.
 * Уборка диска считает треки своими файлами (иначе стёрла бы как «исходник без записи»).
 */
const s = vi.hoisted(() => ({ role: "DIRECTOR", marketing: true }));
vi.mock("../src/auth/middleware.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/auth/middleware.js")>(),
  requireAuth: (req: { agent?: unknown }, _res: unknown, next: () => void) => {
    req.agent = { id: "00000000-0000-4000-8000-0000000000aa", role: s.role, permissions: new Set(s.marketing ? ["marketing.access"] : []) };
    next();
  },
}));

const FF = process.env.FFMPEG_BIN || "ffmpeg";
const ffmpegReady = spawnSync(FF, ["-version"], { stdio: "ignore" }).status === 0;
const { prisma } = await import("../src/db.js");
const { narrationMusicRouter } = await import("../src/routes/properties/narrationMusic.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { runDiskCleanup } = await import("../src/lib/diskCleanup.js");
const { deleteNarrationMusicTrack } = await import("../src/lib/narrationMusic.js");
const { uploadDoors } = await import("../src/upload.js");
const { NARRATION_MUSIC_LIMITS } = await import("@royal-home/shared");

const app = express();
app.use(express.json());
app.use("/properties", narrationMusicRouter);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: err.message }));

const tmp = path.join(os.tmpdir(), `narration-music-routes-${Date.now()}`);
const mp3 = path.join(tmp, "Утро в горах.mp3");

beforeAll(async () => {
  await fs.mkdir(tmp, { recursive: true });
  if (ffmpegReady) spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:a", "libmp3lame", mp3], { stdio: "ignore" });
});
beforeEach(async () => {
  s.role = "DIRECTOR"; s.marketing = true;
  for (const t of await prisma.narrationMusicTrack.findMany()) await deleteNarrationMusicTrack(t.id);
});
afterAll(async () => {
  for (const t of await prisma.narrationMusicTrack.findMany()) await deleteNarrationMusicTrack(t.id);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("библиотека музыки: предел двери", () => {
  it("дверь загрузки пускает ровно столько, сколько обещает общий договор (15 МБ)", () => {
    expect(uploadDoors.find((d) => d.name === "narrationMusicUpload")).toMatchObject({ fileSize: NARRATION_MUSIC_LIMITS.maxBytes, files: 1 });
  });
});

describe.skipIf(!ffmpegReady)("библиотека музыки: маршруты", { timeout: 60_000 }, () => {
  it("директор загружает, слушает и удаляет; маркетинг видит список; агент — нет", async () => {
    const up = await request(app).post("/properties/narration-music").field("title", "Утро в горах").attach("file", mp3);
    expect(up.status).toBe(201);
    const list = await request(app).get("/properties/narration-music");
    expect(list.status).toBe(200);
    expect(list.body.canConfigure).toBe(true);
    expect(list.body.tracks).toHaveLength(1);
    expect(list.body.tracks[0]).toMatchObject({ id: up.body.id, title: "Утро в горах", format: "mp3" });
    expect(Math.abs(list.body.tracks[0].durationSec - 6)).toBeLessThan(0.3);
    const file = await request(app).get(`/properties/narration-music/${up.body.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("audio/mpeg");

    s.role = "MARKETING";
    expect((await request(app).get("/properties/narration-music")).body.canConfigure).toBe(false);
    expect((await request(app).delete(`/properties/narration-music/${up.body.id}`)).status).toBe(403);
    expect((await request(app).post("/properties/narration-music").attach("file", mp3)).status).toBe(403);
    s.role = "AGENT"; s.marketing = false;
    expect((await request(app).get("/properties/narration-music")).status).toBe(403);
    expect((await request(app).get(`/properties/narration-music/${up.body.id}/file`)).status).toBe(403);

    s.role = "DIRECTOR"; s.marketing = true;
    const key = (await prisma.narrationMusicTrack.findUniqueOrThrow({ where: { id: up.body.id } })).storageKey;
    expect((await request(app).delete(`/properties/narration-music/${up.body.id}`)).status).toBe(200);
    await expect(fs.access(localVideoFilePath(key)!)).rejects.toThrow();
    expect((await request(app).delete(`/properties/narration-music/${up.body.id}`)).status).toBe(404);
  });

  it("вход проверяется: не звук по содержимому — 400 (даже с именем .mp3), кривой id — 400, длинное название — 400", async () => {
    const fake = path.join(tmp, "fake.mp3");
    await fs.writeFile(fake, "это не музыка, это текст");
    const bad = await request(app).post("/properties/narration-music").attach("file", fake);
    expect(bad.status).toBe(400);
    expect(await prisma.narrationMusicTrack.count()).toBe(0);
    expect((await request(app).post("/properties/narration-music").field("title", "x".repeat(81)).attach("file", mp3)).status).toBe(400);
    expect((await request(app).post("/properties/narration-music")).status).toBe(400);
    expect((await request(app).get("/properties/narration-music/not-a-uuid/file")).status).toBe(400);
  });

  it("уборка диска не трогает файлы библиотеки; такой же файл без записи — убирает", async () => {
    const up = await request(app).post("/properties/narration-music").attach("file", mp3);
    expect(up.status).toBe(201);
    const key = (await prisma.narrationMusicTrack.findUniqueOrThrow({ where: { id: up.body.id } })).storageKey;
    // Своя копия закрытого хранилища: уборка идёт по ней, а не по общему каталогу стенда.
    const raw = path.join(tmp, "raw");
    const kept = path.join(raw, key), orphan = path.join(raw, path.dirname(key), "11111111-1111-4111-8111-111111111111.mp3");
    await fs.mkdir(path.dirname(kept), { recursive: true });
    await fs.copyFile(mp3, kept); await fs.copyFile(mp3, orphan);
    // Далёкое «сейчас»: возраст файла не спасает его, решает только запись о нём.
    await runDiskCleanup({ dryRun: false, now: Date.now() + 365 * 86_400_000, dirs: { raw, handoff: path.join(tmp, "h"), covers: path.join(tmp, "c"), clips: path.join(tmp, "k") } });
    await expect(fs.access(kept)).resolves.toBeUndefined();
    await expect(fs.access(orphan)).rejects.toThrow();
  });
});
