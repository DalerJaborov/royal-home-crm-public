import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Посторонний не может запереть сотруднику вход (G6, 02.10.2026).
 *
 * Так было: лимит входа (20 попыток за 15 минут) считался по одному номеру
 * телефона, без адреса. Номер агента отдаёт публичная ссылка на объект, и
 * посторонний раз в 15 минут слал 20 запросов с номером директора — директор
 * весь день получал «Слишком много попыток входа» даже с верным паролем.
 * Решение владельца (аудит 11.09.2026, lib/loginThrottle.ts): перебор
 * тормозить задержкой, но не давать посторонним кнопку «заблокировать».
 *
 * Разные адреса — через X-Forwarded-For при включённом доверии прокси, как на
 * боевом сервере за nginx.
 */

process.env.TRUST_PROXY = "1";
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const phone = `+992984${runId}`;
let agentId = "";

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone } });
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Директор под чужим перебором", phone, role: "DIRECTOR", passwordHash: await bcrypt.hash(password, 4) },
    })
  ).id;
});

afterAll(async () => {
  await prisma.loginLog.deleteMany({ where: { agentId } });
  await prisma.session.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("лимит входа не превращается в блокировку чужого номера", () => {
  it(
    "перебор с одного адреса упирается в лимит, а хозяин со своего адреса входит",
    async () => {
      let sawLimit = false;
      for (let i = 0; i < 24; i++) {
        const res = await request(app)
          .post("/api/v1/auth/login")
          .set("X-Forwarded-For", "203.0.113.77")
          .send({ phone, password: "неверный" });
        if (res.status === 429) {
          sawLimit = true;
          break;
        }
      }
      expect(sawLimit, "перебор с одного адреса должен упереться в лимит").toBe(true);

      const owner = await request(app)
        .post("/api/v1/auth/login")
        .set("X-Forwarded-For", "198.51.100.20")
        .send({ phone, password });
      expect(owner.status, JSON.stringify(owner.body)).toBe(200);
    },
    90000
  );
});
