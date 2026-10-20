import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { DEFAULT_COMMENT_PROMPT } from "../src/messengers/comments.js";

/**
 * КОПИЯ СТАНДАРТНОГО ПРОМТА КОММЕНТАРИЕВ НЕ ЗАМОРАЖИВАЕТСЯ (24.09.2026).
 *
 * Форма «Промт ответов на комментарии» показывает действующий текст, и «открыл —
 * нажал Сохранить» записывало его копией. Свой текст заменяет стандартный целиком,
 * так что с этой минуты ни одна правка правил в коде до бота не доходила. У
 * личности бота эта защита была с августа, у промта комментариев — нет.
 */

const runId = Date.now();
const password = "testpass123";
let adminId: string;
let adminToken: string;
let savedPrompt: string | null = null;

function patch(body: Record<string, unknown>) {
  return request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ промта комментариев", phone: `+992937${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);
  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedPrompt = current.botCommentPrompt;
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { botCommentPrompt: savedPrompt } });
  await prisma.agent.delete({ where: { id: adminId } });
});

describe("PATCH /settings — botCommentPrompt", () => {
  it("копия стандартного текста сохраняется как «свой промт не задан»", async () => {
    const res = await patch({ botCommentPrompt: DEFAULT_COMMENT_PROMPT });
    expect(res.status).toBe(200);
    const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botCommentPrompt: true } });
    expect(row?.botCommentPrompt).toBeNull();
  });

  it("настоящая правка владельца сохраняется как есть", async () => {
    const own = `Отвечай коротко и тепло ${runId}`;
    const res = await patch({ botCommentPrompt: own });
    expect(res.status).toBe(200);
    const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botCommentPrompt: true } });
    expect(row?.botCommentPrompt).toBe(own);
  });
});
