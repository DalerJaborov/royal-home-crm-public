import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import * as OTPAuth from "otpauth";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { generateTotpSecret } from "../src/lib/totp.js";
import { revokeElevation } from "../src/lib/stepUp.js";

/**
 * Ролевой аудит 06.08.2026, пункт 3: totpLimiter (5 минут / 8 попыток) висел без
 * keyGenerator и считал по IP. В офисе с одним внешним адресом промах одного
 * сотрудника на /login/verify-totp или /auth/step-up блокировал бы на 5 минут
 * ВСЕХ коллег за тем же IP — не только его самого.
 *
 * Supertest шлёт все запросы с одного и того же адреса (127.0.0.1) — идеальная
 * имитация «весь офис за одним IP». Тест проверяет, что лимит теперь считается
 * по агенту (из pendingToken на /verify-totp, из access-токена на /step-up), а
 * не по этому общему адресу: один агент исчерпывает лимит своими промахами,
 * другой с того же IP в тот же момент продолжает работать как ни в чём не бывало.
 *
 * Каждый под-тест заводит СВОИХ агентов: totpLimiter — один и тот же экземпляр
 * express-rate-limit на обоих роутах (/verify-totp и /step-up), и ключ по агенту
 * общий для обоих путей — переиспользование агента между тестами исчерпало бы
 * его лимит раньше времени и дало бы ложный 429 не в том месте.
 */

function totpCodeFor(secret: string): string {
  return new OTPAuth.TOTP({
    issuer: "Royal Home CRM",
    label: "test",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
}

const runId = Date.now();
const password = "testpass123";
const agentIds: string[] = [];

async function makeTotpAgent(phoneTag: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  const secret = generateTotpSecret();
  const phone = `+9929${phoneTag}${runId}`;
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент лимитера ${phoneTag}`,
      phone,
      role: "AGENT",
      passwordHash,
      totpEnabled: true,
      totpSecret: encryptSecret(secret),
    },
  });
  agentIds.push(agent.id);
  return { id: agent.id, phone, secret };
}

async function pendingTokenFor(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  expect(res.body.requiresTotp).toBe(true);
  return res.body.pendingToken as string;
}

async function accessTokenFor(phone: string, secret: string) {
  const pendingToken = await pendingTokenFor(phone);
  const res = await request(app)
    .post("/api/v1/auth/login/verify-totp")
    .send({ pendingToken, code: totpCodeFor(secret) });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("totpLimiter — ключ по агенту, а не по общему IP офиса", () => {
  it("промахи агента на /verify-totp не блокируют другого агента с того же IP", async () => {
    const a = await makeTotpAgent("81");
    const b = await makeTotpAgent("82");
    const pendingA = await pendingTokenFor(a.phone);

    // Восемь промахов агента A — исчерпывает его собственный лимит (limit: 8).
    for (let i = 0; i < 8; i++) {
      const res = await request(app)
        .post("/api/v1/auth/login/verify-totp")
        .send({ pendingToken: pendingA, code: "000000" });
      expect(res.status).toBe(401);
    }
    // Девятая попытка агента A — лимит исчерпан.
    const blockedA = await request(app)
      .post("/api/v1/auth/login/verify-totp")
      .send({ pendingToken: pendingA, code: "000000" });
    expect(blockedA.status).toBe(429);

    // Агент B — тот же IP (supertest), другой человек: должен пройти правильным кодом.
    const pendingB = await pendingTokenFor(b.phone);
    const okB = await request(app)
      .post("/api/v1/auth/login/verify-totp")
      .send({ pendingToken: pendingB, code: totpCodeFor(b.secret) });
    expect(okB.status).toBe(200);
    expect(okB.body.accessToken).toBeTruthy();
  });

  it("промахи на /auth/step-up считаются по агенту из access-токена, не по IP", async () => {
    const c = await makeTotpAgent("83");
    const d = await makeTotpAgent("84");
    const tokenC = await accessTokenFor(c.phone, c.secret);

    // accessTokenFor уже потратил один слот лимита агента C на /verify-totp (тот
    // же лимитер, тот же ключ agent:C — общий бюджет на оба роута). Оставшихся
    // семь промахов на step-up исчерпывают лимит до восьми запросов включительно.
    for (let i = 0; i < 7; i++) {
      const res = await request(app)
        .post("/api/v1/auth/step-up")
        .set("Authorization", `Bearer ${tokenC}`)
        .send({ code: "000000" });
      expect(res.status).toBe(401);
    }
    const blocked = await request(app)
      .post("/api/v1/auth/step-up")
      .set("Authorization", `Bearer ${tokenC}`)
      .send({ code: "000000" });
    expect(blocked.status).toBe(429);

    // Агент D (свежая сессия, тот же IP) не задет лимитом агента C.
    const tokenD = await accessTokenFor(d.phone, d.secret);
    const stepUpD = await request(app)
      .post("/api/v1/auth/step-up")
      .set("Authorization", `Bearer ${tokenD}`)
      .send({ code: totpCodeFor(d.secret) });
    expect(stepUpD.status).toBe(200);
  });

  /**
   * Ночная проверка 24.09.2026: POST /me/2fa/disable принимает те же шесть цифр,
   * но стоял только под общим apiLimiter (сотни запросов за пять минут) и без
   * requireElevation — из украденной сессии код подбирался перебором. Теперь
   * /me/2fa/* под тем же totpLimiter с ключом по агенту из Bearer-токена, а
   * отключение требует подтверждения личности, как включение.
   */
  it("промахи на /me/2fa/disable считаются по агенту и упираются в 429; без подтверждения личности — 428", async () => {
    const e = await makeTotpAgent("85");
    const f = await makeTotpAgent("86");
    const tokenE = await accessTokenFor(e.phone, e.secret); // слот 1 (verify-totp)

    // Вход по коду уже открыл подтверждение личности (19.10.2026) — снимаем его, чтобы
    // проверить защиту: без подтверждения верный код не отключает 2FA — 428, как у setup.
    revokeElevation(e.id);
    const noElevation = await request(app)
      .post("/api/v1/me/2fa/disable")
      .set("Authorization", `Bearer ${tokenE}`)
      .send({ code: totpCodeFor(e.secret) }); // слот 2
    expect(noElevation.status).toBe(428);
    expect(noElevation.body.stepUpRequired).toBe(true);

    const stepUpE = await request(app)
      .post("/api/v1/auth/step-up")
      .set("Authorization", `Bearer ${tokenE}`)
      .send({ code: totpCodeFor(e.secret) }); // слот 3
    expect(stepUpE.status).toBe(200);

    // Пять промахов — слоты 4–8, лимит в восемь запросов исчерпан.
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/v1/me/2fa/disable")
        .set("Authorization", `Bearer ${tokenE}`)
        .send({ code: "000000" });
      expect(res.status).toBe(401);
    }
    const blocked = await request(app)
      .post("/api/v1/me/2fa/disable")
      .set("Authorization", `Bearer ${tokenE}`)
      .send({ code: "000000" });
    expect(blocked.status).toBe(429);

    // Агент F с того же IP: своя сессия, своё подтверждение — отключает как обычно.
    const tokenF = await accessTokenFor(f.phone, f.secret);
    const stepUpF = await request(app)
      .post("/api/v1/auth/step-up")
      .set("Authorization", `Bearer ${tokenF}`)
      .send({ code: totpCodeFor(f.secret) });
    expect(stepUpF.status).toBe(200);
    const okF = await request(app)
      .post("/api/v1/me/2fa/disable")
      .set("Authorization", `Bearer ${tokenF}`)
      .send({ code: totpCodeFor(f.secret) });
    expect(okF.status).toBe(200);
    expect(okF.body.totpEnabled).toBe(false);
  });
});
