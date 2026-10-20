import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import sharp from "sharp";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { uploadsDir } from "../src/upload.js";

/**
 * Аватар сотрудника: несуществующий сотрудник — 404, а не 500 с файлом-сиротой;
 * замена аватара убирает прежний файл (G18, 02.10.2026).
 */

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const phone = `+992993${runId}`;
let directorId = "";
let token = "";
let png: Buffer;

function avatarFiles(agentId: string): string[] {
  return fs.readdirSync(uploadsDir).filter((f) => f.startsWith(`avatar-${agentId}-`));
}

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone } });
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор аватаров", phone, role: "DIRECTOR", passwordHash: await bcrypt.hash(password, 4) },
    })
  ).id;
  token = (await request(app).post("/api/v1/auth/login").send({ phone, password })).body.accessToken;
  png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#3366ff" } }).png().toBuffer();
});

afterAll(async () => {
  for (const f of avatarFiles(directorId)) fs.rmSync(path.join(uploadsDir, f), { force: true });
  await prisma.session.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
  await prisma.$disconnect();
});

describe("Аватар сотрудника", () => {
  it("на несуществующего сотрудника — 404 и ни одного файла", async () => {
    const ghost = randomUUID();
    grantElevation(directorId);
    const res = await request(app)
      .post(`/api/v1/agents/${ghost}/avatar`)
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", png, { filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(404);
    expect(avatarFiles(ghost)).toEqual([]);
  });

  it("замена своего аватара убирает прежний файл", async () => {
    const first = await request(app)
      .post("/api/v1/me/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", png, { filename: "a.png", contentType: "image/png" });
    expect(first.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    const second = await request(app)
      .post("/api/v1/me/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", png, { filename: "b.png", contentType: "image/png" });
    expect(second.status).toBe(200);
    expect(avatarFiles(directorId)).toEqual([path.basename(second.body.avatarUrl)]);
  });
});
