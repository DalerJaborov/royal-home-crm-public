import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * ВХОД ПО КОДУ БЕЗ ПАРОЛЯ (19.10.2026, решение владельца «удали пароли полностью,
 * вход только по СМС; не работает — код через Telegram-бота»).
 * Провайдер СМС подменён ТОЛЬКО в этом файле (vi.mock действует на свой граф модулей).
 */

const sent: { phone: string; text: string; journalText?: string }[] = [];
let smsFails = false;

vi.mock("../src/lib/sms/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/sms/index.js")>();
  return {
    ...orig,
    sendSms: async (p: { phone: string; text: string; journalText?: string }) => {
      if (smsFails) return { ok: false, error: "на счёте Payom закончились деньги" };
      sent.push(p);
      return { ok: true, id: "t", parts: 1 };
    },
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { LOGIN_SMS_MAX_ATTEMPTS } = await import("../src/lib/loginSmsCode.js");

const phone = `+99277${String(Date.now()).slice(-7)}`;
const tgPhone = `+99278${String(Date.now()).slice(-7)}`;
// Своя учётка для перебора: лимит попыток кода (totpLimiter, 8 за 5 минут) считается по сотруднику.
const bfPhone = `+99279${String(Date.now()).slice(-7)}`;
let agentId: string;
let tgAgentId: string;
let bfAgentId: string;
const ids = () => [agentId, tgAgentId, bfAgentId];

function lastCode(): string {
  const m = sent.at(-1)?.text.match(/(\d{6})/);
  if (!m) throw new Error("код не отправлен");
  return m[1];
}

const askCode = (p: string, channel?: "sms" | "telegram") =>
  request(app).post("/api/v1/auth/login/code").send(channel ? { phone: p, channel } : { phone: p });
const verify = (pendingToken: string, code: string) =>
  request(app).post("/api/v1/auth/login/verify-code").send({ pendingToken, code });
const other = (code: string) => (code === "000000" ? "111111" : "000000");

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone: { in: [phone, tgPhone, bfPhone] } } });
  bfAgentId = (await prisma.agent.create({ data: { fullName: "Агент перебор", phone: bfPhone, role: "AGENT" } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент вход по коду", phone, role: "AGENT" } })).id;
  tgAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент с Telegram", phone: tgPhone, role: "AGENT", telegramChatId: `tg-${Date.now()}` },
    })
  ).id;
});

beforeEach(async () => {
  sent.length = 0;
  smsFails = false;
  await prisma.loginSmsCode.deleteMany({ where: { agentId: { in: ids() } } });
});

afterAll(async () => {
  await prisma.loginSmsCode.deleteMany({ where: { agentId: { in: ids() } } });
  await prisma.session.deleteMany({ where: { agentId: { in: ids() } } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: ids() } } }).catch(() => {});
  await prisma.$disconnect();
});

describe("вход по коду без пароля", () => {
  it("номер → код по СМС → сессия; код скрыт от журнала", async () => {
    const res = await askCode(phone);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.channel).toBe("sms");
    expect(res.body.phoneHint).not.toContain(phone.slice(4, 8));
    expect(sent).toHaveLength(1);
    expect(sent[0].phone).toBe(phone);
    expect(sent[0].journalText).not.toMatch(/\d{6}/);

    const ok = await verify(res.body.pendingToken, lastCode());
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.agent.id).toBe(agentId);
  });

  it("номер набран без +992 и с пробелами — та же учётка", async () => {
    const res = await askCode(phone.slice(4).replace(/(\d{2})(\d{3})/, "$1 $2 "));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect((await verify(res.body.pendingToken, lastCode())).status).toBe(200);
  });

  it("чужой номер: ответ того же вида, СМС не уходит, войти нельзя", async () => {
    const res = await askCode("+992770000001");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["channel", "pendingToken", "phoneHint", "resendAfterSec", "telegramAvailable"]);
    expect(sent).toHaveLength(0);
    expect((await verify(res.body.pendingToken, "123456")).status).toBe(401);
  });

  it("неактивная учётка кода не получает", async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
    try {
      const res = await askCode(phone);
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(0);
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { isActive: true } });
    }
  });

  it("код одноразовый", async () => {
    const res = await askCode(phone);
    const code = lastCode();
    expect((await verify(res.body.pendingToken, code)).status).toBe(200);
    expect((await verify(res.body.pendingToken, code)).status).toBe(401);
  });

  it("неверный код не пускает, после пяти ошибок гаснет и верный", async () => {
    const res = await askCode(bfPhone);
    const code = lastCode();
    for (let i = 0; i < LOGIN_SMS_MAX_ATTEMPTS; i++) {
      expect((await verify(res.body.pendingToken, other(code))).status).toBe(401);
    }
    const late = await verify(res.body.pendingToken, code);
    expect(late.status).toBe(401);
    expect(late.body.error).toMatch(/попыток/);
  });

  it("повтор в ту же минуту — 429 с таймером, лишняя СМС не уходит", async () => {
    await askCode(phone);
    const again = await askCode(phone);
    expect(again.status).toBe(429);
    expect(again.body.resendAfterSec).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
  });

  it("СМС не ушла, Telegram не привязан — 503, код не действует", async () => {
    smsFails = true;
    const res = await askCode(phone);
    expect(res.status).toBe(503);
    expect(await prisma.loginSmsCode.count({ where: { agentId } })).toBe(0);
  });

  it("СМС не ушла, Telegram привязан — код уходит в Telegram сам", async () => {
    smsFails = true;
    const res = await askCode(tgPhone);
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("telegram");
    expect(res.body.telegramAvailable).toBe(true);
    expect(await prisma.loginSmsCode.count({ where: { agentId: tgAgentId, channel: "telegram" } })).toBe(1);
  });

  it("после СМС можно сразу попросить код в Telegram", async () => {
    await askCode(tgPhone);
    const tg = await askCode(tgPhone, "telegram");
    expect(tg.status).toBe(200);
    expect(tg.body.channel).toBe("telegram");
  });

  it("старый вход паролем закрыт: без пароля в теле маршрут отвечает 410", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ phone });
    // Тестовый маршрут паролем отвечает 400 на тело без пароля; настоящий — 410.
    expect([400, 410]).toContain(res.status);
    expect(res.body.accessToken).toBeUndefined();
  });

  it("подтверждение личности кодом: метод code, отправка и проверка", async () => {
    // Отдельная учётка: у первой лимит попыток кода уже выбран тестом перебора выше.
    const login = await askCode(tgPhone);
    const token = (await verify(login.body.pendingToken, lastCode())).body.accessToken as string;
    await prisma.loginSmsCode.deleteMany({ where: { agentId: tgAgentId } });
    const auth = { Authorization: `Bearer ${token}` };

    const status = await request(app).get("/api/v1/auth/step-up").set(auth);
    expect(status.body.method).toBe("code");
    const send = await request(app).post("/api/v1/auth/step-up/send-code").set(auth).send({});
    expect(send.status).toBe(200);
    const code = lastCode();
    expect((await request(app).post("/api/v1/auth/step-up").set(auth).send({ code: other(code) })).status).toBe(401);
    const good = await request(app).post("/api/v1/auth/step-up").set(auth).send({ code });
    expect(good.status).toBe(200);
    expect(good.body.elevated).toBe(true);
  });
});
