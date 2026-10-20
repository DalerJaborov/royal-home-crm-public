import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import * as pf from "../src/lib/privateFiles.js";

/**
 * Голосовые заметки сотрудников переживают ночную уборку вложений (G2, 02.10.2026).
 *
 * Так было: заметка (причина отказа, заморозки, заявки на удаление) писалась в
 * общую папку с вложениями переписки, и уборка через 180 дней стирала её наравне
 * с одноразовыми фото из чатов — плеер в карточке отдавал «Файл не найден».
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const runId = `${Date.now()}-${process.pid}`;
const privateDir = path.join(os.tmpdir(), `rh-voice-retention-${runId}`);
const phone = `+992977${String(Date.now()).slice(-7)}`;
const password = "testpass123";
let previousDirEnv: string | undefined;
let agentId = "";
let token = "";

function age(full: string, days: number) {
  const at = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(full, at, at);
}

function findOnDisk(name: string): string | null {
  for (const dir of [privateDir, path.join(privateDir, "voice-notes")]) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

beforeAll(async () => {
  previousDirEnv = process.env.PRIVATE_UPLOADS_DIR;
  process.env.PRIVATE_UPLOADS_DIR = privateDir;
  fs.mkdirSync(privateDir, { recursive: true });
  await prisma.agent.deleteMany({ where: { phone } });
  const agent = await prisma.agent.create({
    data: { fullName: "Агент старых заметок", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 4) },
  });
  agentId = agent.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone, password });
  token = login.body.accessToken;
});

afterAll(async () => {
  if (previousDirEnv === undefined) delete process.env.PRIVATE_UPLOADS_DIR;
  else process.env.PRIVATE_UPLOADS_DIR = previousDirEnv;
  fs.rmSync(privateDir, { recursive: true, force: true });
  await prisma.session.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Голосовая заметка и уборка вложений", () => {
  it("новая заметка старше срока хранения остаётся и отдаётся", async () => {
    const upload = await request(app)
      .post("/api/v1/me/voice-notes")
      .set("Authorization", `Bearer ${token}`)
      .attach("audio", Buffer.from("заметка о причине отказа"), { filename: "note.webm", contentType: "audio/webm" });
    expect(upload.status).toBe(200);
    const name = (upload.body.url as string).split("/").pop()!;
    const full = findOnDisk(name);
    expect(full, "файл заметки записан").not.toBeNull();
    age(full!, 400);

    pf.cleanupPrivateFiles();

    const res = await request(app).get(`/api/v1/me/voice-notes/${name}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("заметка, записанная до правки в общую папку, уносится из-под уборки, если на неё есть ссылка", async () => {
    const referenced = (await pf.savePrivateFile(Buffer.from("старая заметка"), "audio/webm"))!;
    const orphan = (await pf.savePrivateFile(Buffer.from("старое вложение"), "audio/webm"))!;
    age(path.join(privateDir, referenced), 400);
    age(path.join(privateDir, orphan), 400);
    await prisma.agent.update({ where: { id: agentId }, data: { frozenReasonVoiceUrl: `/me/voice-notes/${referenced}` } });

    const adopt = (pf as Record<string, unknown>).adoptReferencedVoiceNotes as (() => Promise<{ moved: number }>) | undefined;
    expect(typeof adopt, "перенос старых заметок существует").toBe("function");
    const { moved } = await adopt!();
    expect(moved).toBeGreaterThanOrEqual(1);
    pf.cleanupPrivateFiles();

    const res = await request(app).get(`/api/v1/me/voice-notes/${referenced}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Ничьё старое вложение уборка по-прежнему убирает.
    expect(findOnDisk(orphan)).toBeNull();
  });
});
