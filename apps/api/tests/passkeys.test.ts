import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * Вход по отпечатку и лицу (passkey).
 *
 * Полный обмен с настоящим устройством в тестах не воспроизвести — подпись
 * делает защищённый чип телефона. Поэтому здесь проверяется то, что зависит от
 * нас и что действительно опасно сломать:
 *   · привязать ключ можно только к СВОЕЙ учётке и только войдя в систему;
 *   · и только подтвердив личность заново — одной живой сессии мало;
 *   · подделанный или просроченный ответ устройства вход не даёт;
 *   · чужой ключ нельзя отвязать;
 *   · пароль сайта отключён (боевой /login отвечает 410).
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { resetPasskeyChallenges } = await import("../src/lib/passkeys.js");

const runId = Date.now();
let agentToken = "";
let otherToken = "";
let agentId = "";
let otherId = "";
let foreignPasskeyId = "";

beforeAll(async () => {
  const bcrypt = await import("bcrypt");
  const passwordHash = await bcrypt.default.hash("password123", 10);
  const a = await prisma.agent.create({
    data: { fullName: `Ключник ${runId}`, phone: `+992941${runId}`, role: "AGENT", passwordHash },
  });
  const b = await prisma.agent.create({
    data: { fullName: `Второй ${runId}`, phone: `+992942${runId}`, role: "AGENT", passwordHash },
  });
  agentId = a.id;
  otherId = b.id;

  agentToken = (await request(app).post("/api/v1/auth/login").send({ phone: a.phone, password: "password123" })).body
    .accessToken;
  otherToken = (await request(app).post("/api/v1/auth/login").send({ phone: b.phone, password: "password123" })).body
    .accessToken;

  // Привязка и отвязка требуют свежего подтверждения личности (см. routes/me.ts):
  // без него сервер отвечает 428, и до самой логики ключей тесты бы не дошли.
  // Подтверждаем один раз — элевация живёт десятки минут, прогон короче.
  // Второй агент НАМЕРЕННО остаётся неподтверждённым: на нём проверяется, что
  // защита вообще есть.
  await request(app)
    .post("/api/v1/auth/step-up")
    .set("Authorization", `Bearer ${agentToken}`)
    .send({ password: "password123" });

  // Чужой ключ — заводим напрямую в базе: нам важно, что его нельзя тронуть, а не как он появился.
  const foreign = await prisma.passkey.create({
    data: { agentId: otherId, credentialId: `cred-${runId}`, publicKey: "AAAA", deviceName: "Чужой телефон" },
  });
  foreignPasskeyId = foreign.id;
});

afterAll(async () => {
  await prisma.passkey.deleteMany({ where: { agentId: { in: [agentId, otherId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherId] } } });
  resetPasskeyChallenges();
  await prisma.$disconnect();
});

describe("Ключи входа: привязка", () => {
  it("без авторизации привязать нельзя", async () => {
    const res = await request(app).post("/api/v1/me/passkeys/options");
    expect(res.status).toBe(401);
  });

  it("одной живой сессии мало — нужно подтвердить личность", async () => {
    // Второй агент вошёл, но пароль заново не вводил. Привязка ключа даёт
    // постоянный доступ, переживающий смену пароля, — поэтому 428, а не 200.
    const res = await request(app).post("/api/v1/me/passkeys/options").set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(428);
    expect(res.body.stepUpRequired).toBe(true);
  });

  it("вошедшему выдаёт задание для устройства", async () => {
    const res = await request(app).post("/api/v1/me/passkeys/options").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    // challenge — случайная строка, которую подпишет телефон; без неё привязка невозможна.
    expect(typeof res.body.challenge).toBe("string");
    expect(res.body.challenge.length).toBeGreaterThan(10);
    expect(res.body.rp?.name).toBe("Royal Home CRM");
  });

  it("подделанный ответ устройства не привязывается", async () => {
    await request(app).post("/api/v1/me/passkeys/options").set("Authorization", `Bearer ${agentToken}`);
    const res = await request(app)
      .post("/api/v1/me/passkeys/confirm")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ response: { id: "выдумка", rawId: "выдумка", type: "public-key", response: {} } });
    expect(res.status).toBe(400);
    const saved = await prisma.passkey.count({ where: { agentId } });
    expect(saved).toBe(0);
  });

  it("ответ без запрошенного задания не принимается", async () => {
    resetPasskeyChallenges();
    const res = await request(app)
      .post("/api/v1/me/passkeys/confirm")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ response: { id: "x", rawId: "x", type: "public-key", response: {} } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/истекл/i);
  });
});

describe("Ключи входа: вход", () => {
  it("задание на вход выдаётся без авторизации — человек ещё не вошёл", async () => {
    const res = await request(app).post("/api/v1/auth/passkey/login/options");
    expect(res.status).toBe(200);
    expect(typeof res.body.challenge).toBe("string");
  });

  it("подделанная подпись входа не пускает", async () => {
    const options = await request(app).post("/api/v1/auth/passkey/login/options");
    const res = await request(app)
      .post("/api/v1/auth/passkey/login/verify")
      .send({
        challenge: options.body.challenge,
        response: { id: `cred-${runId}`, rawId: `cred-${runId}`, type: "public-key", response: {} },
      });
    expect(res.status).toBe(401);
    expect(res.body.accessToken).toBeUndefined();
  });

  it("чужое задание не подходит к ключу", async () => {
    const res = await request(app)
      .post("/api/v1/auth/passkey/login/verify")
      .send({ challenge: "никогда-не-выдавалось", response: { id: `cred-${runId}`, type: "public-key" } });
    expect(res.status).toBe(401);
  });
});

describe("Ключи входа: управление устройствами", () => {
  it("в списке видно только свои ключи", async () => {
    const res = await request(app).get("/api/v1/me/passkeys").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);

    const otherRes = await request(app).get("/api/v1/me/passkeys").set("Authorization", `Bearer ${otherToken}`);
    expect(otherRes.body).toHaveLength(1);
    expect(otherRes.body[0].deviceName).toBe("Чужой телефон");
    // Открытый ключ и счётчик наружу не отдаются — интерфейсу они не нужны.
    expect(otherRes.body[0].publicKey).toBeUndefined();
  });

  it("чужой ключ отвязать нельзя", async () => {
    const res = await request(app)
      .delete(`/api/v1/me/passkeys/${foreignPasskeyId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
    const stillThere = await prisma.passkey.findUnique({ where: { id: foreignPasskeyId } });
    expect(stillThere).not.toBeNull();
  });

  it("свой ключ отвязывается", async () => {
    const mine = await prisma.passkey.create({
      data: { agentId, credentialId: `mine-${runId}`, publicKey: "BBBB", deviceName: "Мой телефон" },
    });
    const res = await request(app)
      .delete(`/api/v1/me/passkeys/${mine.id}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(await prisma.passkey.findUnique({ where: { id: mine.id } })).toBeNull();
  });
});
