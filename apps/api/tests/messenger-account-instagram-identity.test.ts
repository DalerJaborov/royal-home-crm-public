import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Подключение аккаунта Instagram сохраняет ник и идентификатор личных сообщений
 * из ответа Meta (10.11.2026). Раньше маршрут брал из ответа только externalId:
 * Arvan Estate сохранился без ника, и ядро бота держало всё входящее Instagram.
 */
const identity = vi.hoisted(() => ({ value: { ok: true, id: "", messagingId: "", username: "" } as
  { ok: true; id: string; messagingId?: string; username?: string } | { ok: false; error: string } }));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  instagramTokenIdentity: vi.fn(async () => identity.value),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { grantElevation } = await import("../src/lib/stepUp.js");

const run = randomUUID().replaceAll("-", "").slice(0, 10);
const password = "testpass123";
let adminId = "";
let adminToken = "";
const createdIds: string[] = [];

beforeAll(async () => {
  const admin = await prisma.agent.create({ data: {
    fullName: `Админ ников ${run}`, phone: `+992966${String(Date.now()).slice(-7)}`, role: "ADMIN",
    passwordHash: await bcrypt.hash(password, 10),
  } });
  adminId = admin.id;
  adminToken = (await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password })).body.accessToken;
  grantElevation(adminId);
});

afterAll(async () => {
  await prisma.messengerAccount.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
});

describe("подключение аккаунта Instagram", () => {
  it("сохраняет ник и идентификатор личных сообщений из ответа Meta", async () => {
    identity.value = { ok: true, id: `17841-${run}`, messagingId: `369-${run}`, username: "arvan__estate" };
    const res = await request(app).post("/api/v1/settings/messenger-accounts").set("Authorization", `Bearer ${adminToken}`)
      .send({ channel: "INSTAGRAM", title: `Арван ${run}`, token: "stand-token" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    createdIds.push(res.body.id);
    const saved = await prisma.messengerAccount.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(saved.externalId).toBe(`17841-${run}`);
    expect(saved.username).toBe("arvan__estate");
    expect(saved.messagingId).toBe(`369-${run}`);
  });

  it("без ника в ответе Meta аккаунт не сохраняется", async () => {
    identity.value = { ok: true, id: `17842-${run}`, messagingId: `370-${run}` };
    const res = await request(app).post("/api/v1/settings/messenger-accounts").set("Authorization", `Bearer ${adminToken}`)
      .send({ channel: "INSTAGRAM", title: `Без ника ${run}`, token: "stand-token" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ник/);
    expect(await prisma.messengerAccount.count({ where: { externalId: `17842-${run}` } })).toBe(0);
  });
});
