import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { buildCommentSystem, DEFAULT_COMMENT_PROMPT } from "../src/messengers/comments.js";

/**
 * Окно «Бот»: кто вправе менять то, что уходит прямо в промт бота
 * (уроки и недельная сводка удалены 13.11.2026 вместе с «Обучением бота»). Значит правка обязана требовать и права настроек, и свежего
 * подтверждения личности: иначе чужой человек за незапертым ноутбуком меняет то,
 * что бот говорит клиентам.
 */

const runId = Date.now();
const password = "testpass123";

/** Комментарий-заглушка для сборки промта: сам текст здесь не важен, важно, чей
 *  промт лёг в основу — свой из Настроек или зашитый по умолчанию. */
const PROMPT_INPUT = { text: "Чанд сомон?", authorName: "tester", isThreadReply: false, answered: 0 };

let adminToken: string;
let agentToken: string;
let adminId: string;
let agentId: string;
let noElevationId: string;
let noElevationToken: string;

async function login(phone: string, elevate: boolean) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  if (elevate) {
    const agent = await prisma.agent.findUnique({ where: { phone }, select: { id: true } });
    if (agent) grantElevation(agent.id);
  }
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Бот-Админ", phone: `+992970${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const agent = await prisma.agent.create({
    data: { fullName: "Бот-Агент", phone: `+992971${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const noElevation = await prisma.agent.create({
    data: { fullName: "Бот-Админ без элевации", phone: `+992972${runId}`, role: "ADMIN", passwordHash },
  });
  noElevationId = noElevation.id;

  adminToken = await login(admin.phone, true);
  agentToken = await login(agent.phone, false);
  noElevationToken = await login(noElevation.phone, false);

});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId, noElevationId] } } });
});

describe("Промт комментариев в Настройках", () => {
  const custom = `Отвечай только цифрами ${runId}`;

  it("свой текст сохраняется и помечается изменённым", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ botCommentPrompt: custom });
    expect(res.status).toBe(200);
    expect(res.body.botCommentPrompt).toBe(custom);
    expect(res.body.botCommentPromptIsCustom).toBe(true);

    // И бот берёт именно его, а не зашитый.
    expect(buildCommentSystem(PROMPT_INPUT, {}, custom)).toContain(custom);
  });

  it("очистка возвращает зашитый по умолчанию, а не пустой промт", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ botCommentPrompt: "   " });
    expect(res.status).toBe(200);
    expect(res.body.botCommentPromptIsCustom).toBe(false);
    expect(res.body.botCommentPrompt).toBe(DEFAULT_COMMENT_PROMPT);

    // В базе именно null: пустая строка означала бы «инструкций нет».
    const saved = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { botCommentPrompt: true },
    });
    expect(saved?.botCommentPrompt).toBeNull();
  });

  it("рядовой агент промт комментариев не видит и не меняет", async () => {
    const read = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${agentToken}`);
    expect(read.status).toBe(200);
    expect(read.body.botCommentPrompt).toBeUndefined();

    const write = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ botCommentPrompt: "что угодно" });
    expect(write.status).toBe(403);
  });
});

describe("Пауза и окно напоминаний в Настройках", () => {
  it("потолок ожидания ниже паузы не принимается", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ botReplyDelaySec: 30, botReplyMaxWaitSec: 10 });
    expect(res.status).toBe(400);
  });

  it("конец окна напоминаний раньше начала не принимается", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ followUpWindowStart: "21:00", followUpWindowEnd: "08:00" });
    expect(res.status).toBe(400);
  });

  it("осмысленные значения сохраняются", async () => {
    const before = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        botReplyDelaySec: true,
        botReplyMaxWaitSec: true,
        followUpWindowStart: true,
        followUpWindowEnd: true,
        followUpEnabled: true,
      },
    });
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ botReplyDelaySec: 20, botReplyMaxWaitSec: 80, followUpWindowStart: "09:00", followUpWindowEnd: "19:00" });
    expect(res.status).toBe(200);
    expect(res.body.botReplyDelaySec).toBe(20);
    expect(res.body.followUpWindowEnd).toBe("19:00");
    // Возвращаем как было: настройки одни на всю базу, и следующий тест не должен
    // унаследовать чужие значения.
    if (before) {
      await prisma.settings.update({ where: { id: "singleton" }, data: before });
    }
  });
});
