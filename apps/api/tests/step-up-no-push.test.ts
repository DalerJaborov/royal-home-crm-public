import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * АУДИТ БЕЗОПАСНОСТИ 17.11.2026, S2: код подтверждения личности перед Настройками
 * уходил ПУШЕМ — в том числе в тот же браузер, где открыта сессия. Кто сел за
 * чужую открытую вкладку, жал «Прислать код» и видел код на этом же экране.
 *
 * Теперь: СМС, запасной — Telegram. Пуш — только тому, у кого нет ни
 * таджикского номера, ни Telegram (иначе он остался бы без кода вовсе), и не на
 * устройство, которое просит код. Вход по коду (не step-up) не меняется.
 */
const sms: { phone: string; text: string }[] = [];
const pushes: { endpoints: string[] }[] = [];

vi.mock("../src/lib/sms/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/sms/index.js")>();
  return {
    ...orig,
    sendSms: async (p: { phone: string; text: string }) => {
      sms.push(p);
      return { ok: true, id: "t", parts: 1 };
    },
  };
});

vi.mock("../src/push.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/push.js")>();
  return {
    ...orig,
    sendLoginCodePush: async (subs: { endpoint: string }[]) => {
      pushes.push({ endpoints: subs.map((s) => s.endpoint) });
      return subs.length;
    },
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { pushFallback } = await import("../src/lib/loginSmsCode.js");

const tail = String(Date.now()).slice(-7);
const tajikPhone = `+99273${tail}`;
const foreignPhone = `+7916${tail}`;
let tajikId = "";
let foreignId = "";
const endpointA = `https://push.test/step-up/${tail}/a`;
const endpointB = `https://push.test/step-up/${tail}/b`;

const sendCode = (agentId: string, body: Record<string, unknown> = {}) =>
  request(app)
    .post("/api/v1/auth/step-up/send-code")
    .set("Authorization", `Bearer ${signAccessToken({ sub: agentId, role: "AGENT" })}`)
    .send(body);

async function addSub(agentId: string, endpoint: string) {
  await prisma.pushSubscription.create({ data: { agentId, endpoint, p256dh: "p", auth: "a", lastSeenAt: new Date() } });
}

beforeAll(async () => {
  pushFallback.delayMs = 60_000;
  await prisma.agent.deleteMany({ where: { phone: { in: [tajikPhone, foreignPhone] } } });
  tajikId = (await prisma.agent.create({ data: { fullName: "Step-up таджикский номер", phone: tajikPhone, role: "AGENT" } })).id;
  foreignId = (await prisma.agent.create({ data: { fullName: "Step-up иностранный номер", phone: foreignPhone, role: "AGENT" } })).id;
});

beforeEach(async () => {
  sms.length = 0;
  pushes.length = 0;
  await prisma.loginSmsCode.deleteMany({ where: { agentId: { in: [tajikId, foreignId] } } });
  await prisma.pushSubscription.deleteMany({ where: { agentId: { in: [tajikId, foreignId] } } });
  await prisma.agent.updateMany({ where: { id: { in: [tajikId, foreignId] } }, data: { telegramChatId: null } });
});

afterAll(async () => {
  await prisma.loginSmsCode.deleteMany({ where: { agentId: { in: [tajikId, foreignId] } } });
  await prisma.pushSubscription.deleteMany({ where: { agentId: { in: [tajikId, foreignId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [tajikId, foreignId] } } }).catch(() => {});
});

describe("код подтверждения личности не уходит пушем на открытую сессию", () => {
  it("живое устройство есть, номер таджикский: код по СМС, пуша нет", async () => {
    await addSub(tajikId, endpointA);
    const res = await sendCode(tajikId);
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("sms");
    expect(pushes).toHaveLength(0);
    expect(sms).toHaveLength(1);
    expect(sms[0]!.phone).toBe(tajikPhone);
  });

  it("иностранный номер, но Telegram привязан: код в Telegram (СМС не дойдёт), пуша нет", async () => {
    await prisma.agent.update({ where: { id: foreignId }, data: { telegramChatId: `step-up-${tail}` } });
    await addSub(foreignId, endpointA);
    const res = await sendCode(foreignId, { channel: "telegram" });
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("telegram");
    expect(pushes).toHaveLength(0);
  });

  it("ни таджикского номера, ни Telegram: пуш остаётся, но не на устройство, которое просит код", async () => {
    await addSub(foreignId, endpointA);
    await addSub(foreignId, endpointB);
    const res = await sendCode(foreignId, { pushEndpoint: endpointA });
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.endpoints).toEqual([endpointB]);
  });

  it("ни таджикского номера, ни Telegram, единственное устройство — сам просящий: ему пуша нет", async () => {
    await addSub(foreignId, endpointA);
    await sendCode(foreignId, { pushEndpoint: endpointA });
    expect(pushes.flatMap((p) => p.endpoints)).not.toContain(endpointA);
  });

  it("вход по коду (не подтверждение) по-прежнему сначала пушем", async () => {
    await addSub(tajikId, endpointA);
    const res = await request(app).post("/api/v1/auth/login/code").send({ phone: tajikPhone });
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("push");
  });
});
