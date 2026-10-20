import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * Точка возврата настроек не откатывает системное состояние и не возвращает
 * уволенных (G7, 02.10.2026).
 *
 * Так было: возврат перебирал ВСЕ поля строки Settings. Директор откатывал
 * испорченный промт бота к прошлой неделе — и заодно курс доллара становился
 * прошлонедельным, очередь монтажа вставала на паузу или снималась с неё, а в
 * поле «монтажёр» возвращался уволенный за эту неделю: ролики уходили ему.
 */

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const adminPhone = `+992987${runId}`;
const editorPhone = `+992988${runId}`;
let adminId = "";
let editorId = "";
let token = "";
let saved: Record<string, unknown> = {};
let pointId = "";

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone: { in: [adminPhone, editorPhone] } } });
  adminId = (
    await prisma.agent.create({
      data: { fullName: "Админ отката", phone: adminPhone, role: "ADMIN", passwordHash: await bcrypt.hash(password, 4) },
    })
  ).id;
  editorId = (
    await prisma.agent.create({
      data: {
        fullName: "Монтажёр, уволенный после точки",
        phone: editorPhone,
        role: "EDITOR",
        passwordHash: await bcrypt.hash(password, 4),
        telegramChatId: `6${runId}2`,
      },
    })
  ).id;
  token = (await request(app).post("/api/v1/auth/login").send({ phone: adminPhone, password })).body.accessToken;

  const cur = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = {
    companyName: cur.companyName,
    usdToTjsRate: cur.usdToTjsRate,
    videoHandoffQueuePaused: cur.videoHandoffQueuePaused,
    videoMontajerAgentId: cur.videoMontajerAgentId,
  };

  // Состояние, которое попадёт в точку.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { companyName: `Точка G7 ${runId}`, usdToTjsRate: 12.5, videoHandoffQueuePaused: false, videoMontajerAgentId: editorId },
  });
  grantElevation(adminId);
  const res = await request(app)
    .patch("/api/v1/settings")
    .set("Authorization", `Bearer ${token}`)
    .send({ companyName: `Сейчас G7 ${runId}` });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const point = await prisma.settingsSnapshot.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  pointId = point!.id;

  // После точки: система обновила курс и поставила очередь на паузу, монтажёра уволили.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { usdToTjsRate: 13.1, videoHandoffQueuePaused: true, videoMontajerAgentId: null },
  });
  await prisma.agent.update({ where: { id: editorId }, data: { isActive: false } });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.settingsSnapshot.deleteMany({ where: { agentId: adminId } });
  await prisma.session.deleteMany({ where: { agentId: { in: [adminId, editorId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, editorId] } } });
  await prisma.$disconnect();
});

describe("Возврат к точке настроек", () => {
  it("список отличий не показывает курс доллара и паузу очереди", async () => {
    const list = await request(app).get("/api/v1/settings/restore-points").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: { id: string }) => i.id === pointId);
    const fields = item.changes.map((c: { field: string }) => c.field);
    expect(fields).toContain("companyName");
    expect(fields).not.toContain("usdToTjsRate");
    expect(fields).not.toContain("videoHandoffQueuePaused");
  });

  it("возвращает человеческие настройки, но не курс, не паузу и не уволенного монтажёра", async () => {
    grantElevation(adminId);
    const res = await request(app)
      .post(`/api/v1/settings/restore-points/${pointId}/restore`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.restoredFields).toContain("companyName");
    expect(res.body.restoredFields).not.toContain("videoMontajerAgentId");

    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { companyName: true, usdToTjsRate: true, videoHandoffQueuePaused: true, videoMontajerAgentId: true },
    });
    expect(s!.companyName).toBe(`Точка G7 ${runId}`);
    expect(Number(s!.usdToTjsRate)).toBe(13.1);
    expect(s!.videoHandoffQueuePaused).toBe(true);
    expect(s!.videoMontajerAgentId).toBeNull();
  });
});
