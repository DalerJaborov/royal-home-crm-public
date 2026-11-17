import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * КОД ВХОДА СНАЧАЛА ПУШЕМ (19.10.2026): живые подписки, подтверждение доставки,
 * запасная СМС с тем же кодом через 10 секунд. Провайдер СМС и отправка пуша
 * подменены ТОЛЬКО в этом файле; задержка запасной СМС сокращена до долей секунды.
 */

const sms: { phone: string; text: string }[] = [];
const pushes: { endpoints: string[]; wire: Record<string, unknown> }[] = [];
let pushAccepted = 1;
let smsFails = false;
let smsWait: Promise<void> | null = null;

vi.mock("../src/lib/sms/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/sms/index.js")>();
  return {
    ...orig,
    sendSms: async (p: { phone: string; text: string }) => {
      if (smsWait) await smsWait;
      if (smsFails) return { ok: false, error: "test provider unavailable" };
      sms.push(p);
      return { ok: true, id: "t", parts: 1 };
    },
  };
});

vi.mock("../src/push.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/push.js")>();
  return {
    ...orig,
    sendLoginCodePush: async (subs: { endpoint: string }[], wire: Record<string, unknown>) => {
      pushes.push({ endpoints: subs.map((s) => s.endpoint), wire });
      return pushAccepted;
    },
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { pushFallback, runSmsFallback } = await import("../src/lib/loginSmsCode.js");

const tail = String(Date.now()).slice(-7);
const phone = `+99271${tail}`;
const noSubPhone = `+99272${tail}`;
const DAY = 24 * 60 * 60 * 1000;
let agentId = "";
let noSubId = "";

const askCode = (p: string, channel?: "sms" | "telegram") =>
  request(app).post("/api/v1/auth/login/code").send(channel ? { phone: p, channel } : { phone: p });
const ack = (body: unknown) => request(app).post("/api/v1/auth/login/code-ack").send(body as object);
const pushCode = () => String(pushes.at(-1)?.wire.code);
const smsCode = () => sms.at(-1)?.text.match(/(\d{6})/)?.[1];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function addSub(endpoint: string, ageDays: number, seenDays?: number) {
  return prisma.pushSubscription.create({
    data: {
      agentId,
      endpoint,
      p256dh: "p",
      auth: "a",
      createdAt: new Date(Date.now() - ageDays * DAY),
      ...(seenDays !== undefined ? { lastSeenAt: new Date(Date.now() - seenDays * DAY) } : {}),
    },
  });
}

beforeAll(async () => {
  pushFallback.delayMs = 300;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент пуш-код", phone, role: "AGENT" } })).id;
  noSubId = (await prisma.agent.create({ data: { fullName: "Агент без устройств", phone: noSubPhone, role: "AGENT" } })).id;
});

beforeEach(async () => {
  sms.length = 0;
  pushes.length = 0;
  pushAccepted = 1;
  smsFails = false;
  smsWait = null;
  await prisma.loginSmsCode.deleteMany({ where: { agentId: { in: [agentId, noSubId] } } });
  await prisma.pushSubscription.deleteMany({ where: { agentId } });
});

afterAll(async () => {
  await prisma.loginSmsCode.deleteMany({ where: { agentId: { in: [agentId, noSubId] } } });
  await prisma.pushSubscription.deleteMany({ where: { agentId } });
  await prisma.session.deleteMany({ where: { agentId: { in: [agentId, noSubId] } } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, noSubId] } } }).catch(() => {});
  await prisma.$disconnect();
});

describe("код входа пушем", () => {
  it("живая подписка: код уходит пушем, СМС сразу нет, полезная нагрузка по договору, вход по коду из пуша работает", async () => {
    await addSub(`https://push.test/${tail}/a`, 1);
    const res = await askCode(phone);
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("push");
    expect(res.body.fallbackAfterSec).toBe(30);
    expect(sms).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    const wire = pushes[0].wire;
    expect(wire).toMatchObject({ kind: "login-code", title: "Код входа Royal Home CRM", tag: "login-code" });
    expect(wire.code).toMatch(/^\d{6}$/);
    expect(wire.body).toBe(`${wire.code} — никому не сообщайте`);
    expect(typeof wire.ackToken).toBe("string");
    // В базе только хеш секрета подтверждения, не он сам.
    const row = await prisma.loginSmsCode.findFirst({ where: { agentId } });
    expect(row?.channel).toBe("push");
    expect(row?.ackTokenHash).toBeTruthy();
    expect(row?.ackTokenHash).not.toBe(wire.ackToken);

    const ok = await request(app)
      .post("/api/v1/auth/login/verify-code")
      .send({ pendingToken: res.body.pendingToken, code: pushCode() });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
  });

  it("подписки: старше 30 дней не живые, свежесть считается по lastSeenAt, не больше трёх самых свежих", async () => {
    await addSub(`https://push.test/${tail}/old`, 60); // давно, не виделась
    await addSub(`https://push.test/${tail}/revived`, 60, 2); // создана давно, но видели недавно
    await addSub(`https://push.test/${tail}/s1`, 1);
    await addSub(`https://push.test/${tail}/s2`, 2);
    await addSub(`https://push.test/${tail}/s3`, 3);
    await addSub(`https://push.test/${tail}/s4`, 4);
    await askCode(phone);
    const used = pushes[0].endpoints.map((e) => e.split("/").pop());
    expect(used).toEqual(["s1", "s2", "revived"]);
  });

  it("только устаревшие подписки: сразу СМС, пуша нет", async () => {
    await addSub(`https://push.test/${tail}/stale`, 45);
    const res = await askCode(phone);
    expect(res.body.channel).toBe("sms");
    expect(res.body.fallbackAfterSec).toBeUndefined();
    expect(pushes).toHaveLength(0);
    expect(sms).toHaveLength(1);
  });

  it("пуш не принят ни одной подпиской: сразу СМС", async () => {
    await addSub(`https://push.test/${tail}/dead`, 1);
    pushAccepted = 0;
    const res = await askCode(phone);
    expect(res.body.channel).toBe("sms");
    expect(sms).toHaveLength(1);
    // Недоставленный пуш-код не остаётся действовать: действует только код СМС.
    expect(await prisma.loginSmsCode.count({ where: { agentId, channel: "push" } })).toBe(0);
    await sleep(500);
    expect(sms).toHaveLength(1);
  });

  it("без подтверждения через задержку уходит СМС с ТЕМ ЖЕ кодом, один раз", async () => {
    await addSub(`https://push.test/${tail}/a`, 1);
    const res = await askCode(phone);
    expect(sms).toHaveLength(0);
    await waitFor(() => sms.length > 0, { timeoutMs: 3000 });
    expect(smsCode()).toBe(pushCode());
    await sleep(600);
    expect(sms).toHaveLength(1);
    const row = await prisma.loginSmsCode.findFirst({ where: { agentId } });
    expect(row?.fallbackSentAt).not.toBeNull();
    // И этим кодом можно войти.
    const ok = await request(app)
      .post("/api/v1/auth/login/verify-code")
      .send({ pendingToken: res.body.pendingToken, code: smsCode() });
    expect(ok.status).toBe(200);
  });

  it("подтверждение доставки гасит запасную СМС и отмечает подписку живой", async () => {
    const sub = await addSub(`https://push.test/${tail}/a`, 1);
    await askCode(phone);
    const res = await ack({ ackToken: pushes[0].wire.ackToken, endpoint: sub.endpoint });
    expect(res.status).toBe(204);
    const row = await prisma.loginSmsCode.findFirst({ where: { agentId } });
    expect(row?.ackedAt).not.toBeNull();
    expect((await prisma.pushSubscription.findUnique({ where: { id: sub.id } }))?.lastSeenAt).not.toBeNull();
    await sleep(700);
    expect(sms).toHaveLength(0);
  });

  it("код уже использован до срока: запасная СМС не уходит", async () => {
    await addSub(`https://push.test/${tail}/a`, 1);
    const res = await askCode(phone);
    const ok = await request(app)
      .post("/api/v1/auth/login/verify-code")
      .send({ pendingToken: res.body.pendingToken, code: pushCode() });
    expect(ok.status).toBe(200);
    await sleep(700);
    expect(sms).toHaveLength(0);
  });

  it("неверный токен, чужой endpoint и мусор ничего не меняют, ответ всегда 204", async () => {
    const mine = await addSub(`https://push.test/${tail}/a`, 1);
    const stranger = await prisma.agent.create({ data: { fullName: "Чужой", phone: `+99273${tail}`, role: "AGENT" } });
    const foreign = await prisma.pushSubscription.create({
      data: { agentId: stranger.id, endpoint: `https://push.test/${tail}/foreign`, p256dh: "p", auth: "a" },
    });
    try {
      await askCode(phone);
      expect((await ack({ ackToken: "совсем-не-тот-токен-1234567890" })).status).toBe(204);
      expect((await ack({ nonsense: true })).status).toBe(204);
      expect((await ack({})).status).toBe(204);
      expect((await prisma.loginSmsCode.findFirst({ where: { agentId } }))?.ackedAt).toBeNull();
      // Верный токен, но endpoint чужого сотрудника: код подтверждён, чужая подписка не тронута.
      expect((await ack({ ackToken: pushes[0].wire.ackToken, endpoint: foreign.endpoint })).status).toBe(204);
      expect((await prisma.pushSubscription.findUnique({ where: { id: foreign.id } }))?.lastSeenAt).toBeNull();
      expect((await prisma.pushSubscription.findUnique({ where: { id: mine.id } }))?.lastSeenAt).toBeNull();
    } finally {
      await prisma.pushSubscription.deleteMany({ where: { agentId: stranger.id } });
      await prisma.agent.delete({ where: { id: stranger.id } });
    }
  });

  it("после пуша нельзя выдать другой код до конца общей минуты", async () => {
    await addSub(`https://push.test/${tail}/a`, 1);
    await askCode(phone);
    const again = await askCode(phone);
    expect(again.status).toBe(429);
    expect(again.body.resendAfterSec).toBeGreaterThan(0);
    expect(pushes).toHaveLength(1);
    expect(sms).toHaveLength(0);
  });

  it("устаревший таймер после нового кода не отправляет прежний код", async () => {
    pushFallback.delayMs = 60_000;
    try {
      await addSub(`https://push.test/${tail}/stale-timer`, 1);
      await askCode(phone);
      const prior = await prisma.loginSmsCode.findFirstOrThrow({ where: { agentId } });
      const code = pushCode();
      await prisma.loginSmsCode.update({ where: { id: prior.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
      expect((await askCode(phone, "sms")).status).toBe(200);
      const count = sms.length;
      await runSmsFallback({ id: agentId, phone, telegramChatId: null }, prior.id, code);
      expect(sms).toHaveLength(count);
      expect((await prisma.loginSmsCode.findUniqueOrThrow({ where: { id: prior.id } })).fallbackSentAt).toBeNull();
    } finally { pushFallback.delayMs = 300; }
  });

  it("два запасных тика доставляют один код; канал отражает успешный fallback", async () => {
    pushFallback.delayMs = 60_000;
    try {
      await addSub(`https://push.test/${tail}/double-timer`, 1);
      await askCode(phone);
      const prior = await prisma.loginSmsCode.findFirstOrThrow({ where: { agentId } });
      const actor = { id: agentId, phone, telegramChatId: null };
      await Promise.all([runSmsFallback(actor, prior.id, pushCode()), runSmsFallback(actor, prior.id, pushCode())]);
      expect(sms).toHaveLength(1);
      expect(smsCode()).toBe(pushCode());
      expect((await prisma.loginSmsCode.findUniqueOrThrow({ where: { id: prior.id } })).channel).toBe("sms");
    } finally { pushFallback.delayMs = 300; }
  });

  it("СМС отказала: Telegram получает тот же код и не допускает немедленный новый", async () => {
    pushFallback.delayMs = 60_000;
    try {
      await addSub(`https://push.test/${tail}/telegram-fallback`, 1);
      await askCode(phone);
      const prior = await prisma.loginSmsCode.findFirstOrThrow({ where: { agentId } });
      smsFails = true;
      await runSmsFallback({ id: agentId, phone, telegramChatId: "test-chat" }, prior.id, pushCode());
      const delivered = await prisma.loginSmsCode.findUniqueOrThrow({ where: { id: prior.id } });
      expect(delivered.channel).toBe("telegram");
      expect(delivered.codeHash).toBe(prior.codeHash);
      expect((await askCode(phone, "telegram")).status).toBe(429);
    } finally { pushFallback.delayMs = 300; }
  });

  it("просроченный код не доставляется запасным каналом", async () => {
    pushFallback.delayMs = 60_000;
    try {
      await addSub(`https://push.test/${tail}/expired`, 1);
      const asked = await askCode(phone);
      const prior = await prisma.loginSmsCode.findFirstOrThrow({ where: { agentId } });
      await prisma.loginSmsCode.update({ where: { id: prior.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await runSmsFallback({ id: agentId, phone, telegramChatId: null }, prior.id, pushCode());
      expect(sms).toHaveLength(0);
      expect((await request(app).post("/api/v1/auth/login/verify-code").send({ pendingToken: asked.body.pendingToken, code: pushCode() })).status).toBe(401);
    } finally { pushFallback.delayMs = 300; }
  });

  it("новая выдача во время ожидания СМС не допускает последующий Telegram со старым кодом", async () => {
    pushFallback.delayMs = 60_000;
    let release!: () => void;
    try {
      await addSub(`https://push.test/${tail}/provider-race`, 1);
      await prisma.agent.update({ where: { id: agentId }, data: { telegramChatId: "test-race-chat" } });
      await askCode(phone);
      const prior = await prisma.loginSmsCode.findFirstOrThrow({ where: { agentId } });
      smsWait = new Promise<void>((resolve) => { release = resolve; });
      smsFails = true;
      const fallback = runSmsFallback({ id: agentId, phone, telegramChatId: "test-race-chat" }, prior.id, pushCode());
      await waitFor(async () => !!(await prisma.loginSmsCode.findUniqueOrThrow({ where: { id: prior.id } })).fallbackSentAt, { timeoutMs: 3000 });
      await prisma.loginSmsCode.update({ where: { id: prior.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
      expect((await askCode(phone, "telegram")).status).toBe(200);
      release();
      await fallback;
      expect((await prisma.loginSmsCode.findUniqueOrThrow({ where: { id: prior.id } })).channel).toBe("push");
      expect(sms).toHaveLength(0);
    } finally {
      release?.(); smsWait = null; pushFallback.delayMs = 300;
      await prisma.agent.update({ where: { id: agentId }, data: { telegramChatId: null } });
    }
  });

  it("нет подписок: как раньше, СМС; чужой номер неотличим (channel sms)", async () => {
    const res = await askCode(noSubPhone);
    expect(res.body.channel).toBe("sms");
    expect(sms).toHaveLength(1);
    const ghost = await askCode("+992770000009");
    expect(ghost.body.channel).toBe("sms");
    expect(ghost.body.fallbackAfterSec).toBeUndefined();
  });

  it("вход по коду открывает свежее подтверждение личности (step-up без второго кода)", async () => {
    const res = await askCode(noSubPhone);
    const ok = await request(app)
      .post("/api/v1/auth/login/verify-code")
      .send({ pendingToken: res.body.pendingToken, code: smsCode() });
    expect(ok.status).toBe(200);
    const status = await request(app).get("/api/v1/auth/step-up").set("Authorization", `Bearer ${ok.body.accessToken}`);
    expect(status.body.elevated).toBe(true);
    // Привязка отпечатка доступна сразу: дальше проверка — уже без 428.
    const opts = await request(app)
      .post("/api/v1/me/passkeys/options")
      .set("Authorization", `Bearer ${ok.body.accessToken}`);
    expect(opts.status).not.toBe(428);
  });
});
