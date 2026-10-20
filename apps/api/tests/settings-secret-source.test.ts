import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * tiktokClientSecretSource / youtube*Source (17.09.2026) — без этого признака
 * SecretKeyEditor (source=null жёстко в ChannelsTab до этой правки) показывал
 * «из .env сервера» для ключа, только что сохранённого из формы, хотя у
 * TikTok/YouTube .env-резерва нет вовсе (см. keySource в routes/settings.ts).
 */

const runId = Date.now();
const password = "testpass123";

let adminId: string;
let adminToken: string;
let saved: Record<string, unknown> = {};

const TOUCHED = ["tiktokClientSecret", "youtubeClientSecret", "youtubeRefreshToken"] as const;

function patch(body: Record<string, unknown>) {
  return request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ источников секретов", phone: `+992938${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = Object.fromEntries(TOUCHED.map((k) => [k, (current as Record<string, unknown>)[k]]));
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.agent.delete({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe("GET /settings — source ключей без .env-резерва (TikTok/YouTube)", () => {
  it("tiktokClientSecretSource — 'settings' сразу после сохранения, не 'из .env'", async () => {
    await patch({ tiktokClientSecret: "fresh-secret" });
    const res = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tiktokClientSecretSource).toBe("settings");
  });

  it("youtubeClientSecretSource/youtubeRefreshTokenSource — тот же класс", async () => {
    await patch({ youtubeClientSecret: "fresh-yt-secret" });
    await patch({ youtubeRefreshToken: "fresh-yt-refresh" });
    const res = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.youtubeClientSecretSource).toBe("settings");
    expect(res.body.youtubeRefreshTokenSource).toBe("settings");
  });

  it("ключ не задан — source null, а не 'env' (нет .env-резерва у TikTok/YouTube)", async () => {
    await patch({ tiktokClientSecret: "" });
    const res = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.tiktokClientSecretSource).toBeNull();
  });
});
