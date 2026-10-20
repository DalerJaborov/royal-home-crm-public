import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * authLimiter (15 минут / 20 попыток) считал по IP — та же беда, которую у
 * totpLimiter и refreshLimiter починили раньше, а у самого входа проглядели.
 * Весь офис агентства выходит в интернет через один внешний адрес: сотрудник,
 * подбирающий свой забытый пароль, подъедал общий счёт, а чужой перебор закрывал
 * вход тем, кто ничего не делал.
 *
 * Supertest шлёт все запросы с одного адреса (127.0.0.1) — ровно «весь офис за
 * одним IP». Проверяем, что лимит теперь привязан к номеру из тела запроса:
 * один агент исчерпывает свои попытки, второй с того же адреса в ту же секунду
 * продолжает входить как ни в чём не бывало.
 */

const runId = Date.now();
const password = "testpass123";
const created: string[] = [];

/**
 * Метка агента — ЦИФРА, а не буква: ключ лимитера строится из одних цифр номера
 * (`phone.replace(/\D/g, "")`), и номера вида «+9928a…» / «+9928b…» дали бы один
 * и тот же ключ — тест «проверял» бы совпадение ключей вместо их различия.
 */
async function makeAgent(tag: string) {
  const phone = `+9928${tag}${runId}`;
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент лимитера входа ${tag}`,
      phone,
      passwordHash: await bcrypt.hash(password, 10),
      role: "AGENT",
      isActive: true,
    },
  });
  created.push(agent.id);
  return phone;
}

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: created } } });
});

describe("лимит попыток входа считается по учётке, а не по адресу офиса", () => {
  it(
    "исчерпанный лимит одного номера не мешает войти другому с того же адреса",
    async () => {
      const victim = await makeAgent("1");
      const neighbour = await makeAgent("2");

      // Двадцать промахов по одной учётке — ровно предел окна. С 11-й неудачи
      // по этому же телефону включается задержка ответа (lib/loginThrottle.ts,
      // 2с после 10 неудач за 15 минут) — она умышленная (защита от перебора
      // пароля), поэтому у теста увеличен таймаут, а не убрана задержка.
      let sawLimit = false;
      for (let i = 0; i < 24; i++) {
        const res = await request(app).post("/api/v1/auth/login").send({ phone: victim, password: "неверный" });
        if (res.status === 429) {
          sawLimit = true;
          break;
        }
      }
      expect(sawLimit, "перебор одной учётки должен упереться в лимит").toBe(true);

      // Сосед по офису — тот же 127.0.0.1, тот же момент — входит нормально.
      const ok = await request(app).post("/api/v1/auth/login").send({ phone: neighbour, password });
      expect(ok.status).toBe(200);
      expect(ok.body.accessToken).toBeTruthy();
    },
    40000
  );

  it("тело без номера не роняет лимитер — считает по адресу", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({});
    // 400 (не прошло схему) или 429 (адрес уже под лимитом от прошлого теста) —
    // важно, что запрос обработан, а не упал с 500 в keyGenerator.
    expect([400, 429]).toContain(res.status);
  });
});
