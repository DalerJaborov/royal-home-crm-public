import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * Рабочие часы и часы тревог «начало = конец» не сохраняются (G8, 02.10.2026).
 *
 * Так было: «00:00–00:00» (директор хотел «круглосуточно») сохранялось молча.
 * isWithinDushanbeWindow читает пустое окно как «никогда» — новые заявки бота и
 * сайта ложились в очередь без агента, утренняя раздача не наступала, а сайт
 * показывал «вне рабочих часов». Ошибки нигде не было. Заодно — пара порогов
 * «продавец без объекта»: красная метка раньше напоминания.
 */

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const phone = `+992983${runId}`;
let directorId: string;
let token: string;
let original: {
  workHoursStart: string;
  workHoursEnd: string;
  alarmHoursStart: string;
  alarmHoursEnd: string;
  sellerPropertyMissingWarnDays: number;
  sellerPropertyMissingCriticalDays: number;
} | null = null;

function patch(body: Record<string, unknown>) {
  grantElevation(directorId);
  return request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${token}`).send(body);
}

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone } });
  const d = await prisma.agent.create({
    data: { fullName: "Директор часов", phone, role: "DIRECTOR", passwordHash: await bcrypt.hash(password, 4) },
  });
  directorId = d.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone, password });
  token = login.body.accessToken;
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  original = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      workHoursStart: true,
      workHoursEnd: true,
      alarmHoursStart: true,
      alarmHoursEnd: true,
      sellerPropertyMissingWarnDays: true,
      sellerPropertyMissingCriticalDays: true,
    },
  });
});

afterAll(async () => {
  if (original) await prisma.settings.update({ where: { id: "singleton" }, data: original });
  await prisma.session.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
  await prisma.$disconnect();
});

describe("PATCH /settings — пустые окна и перевёрнутые пороги", () => {
  it("рабочие часы 00:00–00:00 — 400 с понятным текстом, в базе прежнее", async () => {
    const res = await patch({ workHoursStart: "00:00", workHoursEnd: "00:00" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/рабоч/i);
    const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { workHoursStart: true, workHoursEnd: true } });
    expect(s).toEqual({ workHoursStart: original!.workHoursStart, workHoursEnd: original!.workHoursEnd });
  });

  it("одно поле, совпавшее с тем, что уже в базе, — тоже 400", async () => {
    const res = await patch({ workHoursEnd: original!.workHoursStart });
    expect(res.status).toBe(400);
  });

  it("часы тревог с одинаковыми началом и концом — 400", async () => {
    const res = await patch({ alarmHoursStart: "10:00", alarmHoursEnd: "10:00" });
    expect(res.status).toBe(400);
  });

  it("ночное окно входящих с одинаковыми началом и концом — 400, станция и CRM читают его по-разному", async () => {
    const res = await patch({ incomingNightStart: "21:00", incomingNightEnd: "21:00" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ночн/i);
  });

  it("порог красной метки не раньше напоминания — 400", async () => {
    const res = await patch({ sellerPropertyMissingWarnDays: 5, sellerPropertyMissingCriticalDays: 3 });
    expect(res.status).toBe(400);
  });

  it("ночное окно через полночь по-прежнему сохраняется", async () => {
    const res = await patch({ alarmHoursStart: "22:00", alarmHoursEnd: "08:00" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
