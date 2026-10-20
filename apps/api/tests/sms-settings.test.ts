import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Раздел «СМС» в Настройках (routes/sms.ts). Главное правило: вход по коду
 * нельзя включить без рабочего провайдера — иначе он запер бы всех снаружи.
 * Сам рубильник в общей строке Settings здесь НЕ включается ни на миг: соседние
 * файлы входят паролем параллельно.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { payomSend, payomBalance } = await import("../src/lib/sms/payom.js");
const { toSmsPhone, sendSms, __setSmsTransportForTests } = await import("../src/lib/sms/index.js");
const { payomWebhookKey } = await import("../src/lib/sms/webhookKey.js");

const password = "testpass123";
const phone = `+99277090${String(Date.now()).slice(-4)}`;
let adminId: string;
let token: string;
const FIELDS = ["smsProvider", "smsLogin", "smsApiToken", "smsSender", "smsLoginCodeEnabled"] as const;
let saved: Record<string, unknown> = {};

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone } });
  const passwordHash = await bcrypt.hash(password, 10);
  adminId = (await prisma.agent.create({ data: { fullName: "Админ СМС", phone, role: "ADMIN", passwordHash } })).id;
  token = (await request(app).post("/api/v1/auth/login").send({ phone, password })).body.accessToken;
  grantElevation(adminId);
  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = Object.fromEntries(FIELDS.map((k) => [k, (current as Record<string, unknown>)[k]]));
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.agent.delete({ where: { id: adminId } }).catch(() => {});
  await prisma.$disconnect();
});

const patch = (body: Record<string, unknown>) =>
  request(app).patch("/api/v1/sms/settings").set("Authorization", `Bearer ${token}`).send(body);

describe("PATCH /sms/settings", () => {
  it("ключ хранится зашифрованным, наружу — только маска; GET /settings его не отдаёт вовсе", async () => {
    const res = await patch({ provider: "payom", apiToken: "secret-token-1234", sender: "RoyalHome" });
    expect(res.status).toBe(200);
    expect(res.body.tokenMasked).toBe("••••1234");
    expect(res.body.configured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("secret-token");
    const s = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(s.smsApiToken).not.toContain("secret-token");
    const all = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${token}`);
    expect(all.body).not.toHaveProperty("smsApiToken");
  });

  it("имя отправителя кириллицей или длиннее 11 знаков не принимается", async () => {
    expect((await patch({ sender: "РоялХоум" })).status).toBe(400);
    expect((await patch({ sender: "RoyalHomeAgency" })).status).toBe(400);
    // Payom пускает только латиницу, цифры и точку — пробел или дефис он отбил бы 422 на каждой отправке.
    expect((await patch({ sender: "Royal Home" })).status).toBe(400);
    expect((await patch({ sender: "Royal-Home" })).status).toBe(400);
    expect((await patch({ sender: "payom.tj" })).status).toBe(200);
  });

  it("GET /sms/status отвечает любому вошедшему, без реквизитов", async () => {
    const res = await request(app).get("/api/v1/sms/status").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["configured"]);
  });
});

describe("номер для провайдера", () => {
  it("три записи таджикского номера → 992XXXXXXXXX; иностранный → null", () => {
    expect(toSmsPhone("+992 98 000 10 06")).toBe("992980001006");
    expect(toSmsPhone("0980001006")).toBe("992980001006");
    expect(toSmsPhone("980001006")).toBe("992980001006");
    expect(toSmsPhone("+7 916 123 45 67")).toBeNull();
  });
});

describe("Payom: запрос и разбор ответа", () => {
  const creds = { token: "tkn", sender: "RoyalHome" };

  it("201 → id, части и первый статус; JSON POST с Bearer, +992, отправителем и адресом вебхука", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "a1b2", deliveryStatus: "SERVICE_ACCEPTED", configuration: { senderName: "RoyalHome", quantityByLength: 2 } }),
        { status: 201 }
      )
    );
    const r = await payomSend(creds, "992980001006", "текст", { webhookUrl: "https://crm.example/api/v1/sms/webhook/payom/k" });
    expect(r).toEqual({ ok: true, messageId: "a1b2", parts: 2, deliveryStatus: "SERVICE_ACCEPTED" });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gateway.payom.tj/api/message");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tkn");
    expect(JSON.parse(String(init.body))).toEqual({
      telephone: "+992980001006",
      text: "текст",
      senderName: "RoyalHome",
      type: "SMS",
      webhookUrl: "https://crm.example/api/v1/sms/webhook/payom/k",
    });
    spy.mockRestore();
  });

  it("403 (IP не в белом списке) → причина словами из ответа Payom, а не голый код", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ "@type": "hydra:Error", "hydra:title": "An error occurred", "hydra:description": "Доступ запрещен: добавьте IP в белый список." }),
        { status: 403 }
      )
    );
    const r = await payomSend(creds, "992980001006", "текст");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/белый список/);
    spy.mockRestore();
  });

  it("401 и 422 → понятные причины; нарушения полей перечислены", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 401, message: "Invalid JWT Token" }), { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ violations: [{ propertyPath: "senderName", message: "Неизвестное имя" }] }), { status: 422 })
      );
    const a = await payomSend(creds, "992980001006", "т");
    const b = await payomSend(creds, "992980001006", "т");
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok) expect(a.error).toMatch(/токен/);
    if (!b.ok) expect(b.error).toMatch(/senderName: Неизвестное имя/);
    spy.mockRestore();
  });

  it("основной хост не соединился → отправка идёт через запасной; оборвалось после соединения → повтора нет", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "x", deliveryStatus: "SERVICE_ACCEPTED" }), { status: 201 }));
    const r = await payomSend(creds, "992980001006", "т");
    expect(r.ok).toBe(true);
    expect(String(spy.mock.calls[1][0])).toBe("https://gateway-p22.payom.tj/api/message");
    spy.mockRestore();

    const spy2 = vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const r2 = await payomSend(creds, "992980001006", "т");
    expect(r2.ok).toBe(false);
    expect(spy2).toHaveBeenCalledTimes(1);
    spy2.mockRestore();
  });

  it("баланс: строка «1500.0000» → число и валюта; сеть недоступна → отказ, а не исключение", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ username: "u", balance: "1500.0000", currency: "TJS" }), { status: 200 }));
    expect(await payomBalance(creds)).toEqual({ ok: true, balance: 1500, currency: "TJS" });
    spy.mockRestore();
    const spy2 = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));
    expect((await payomBalance(creds)).ok).toBe(false);
    spy2.mockRestore();
  });
});

describe("вебхук статусов доставки Payom", () => {
  const messageId = `payom-test-${Date.now()}`;
  const url = (key = payomWebhookKey()) => `/api/v1/sms/webhook/payom/${key}`;

  beforeAll(async () => {
    await patch({ provider: "payom", apiToken: "secret-token-1234", sender: "RoyalHome" });
    __setSmsTransportForTests(async () => ({ ok: true, messageId, parts: 1, deliveryStatus: "SERVICE_ACCEPTED" }));
    const r = await sendSms({ phone: "+992980001006", text: "проверка", purpose: "TEST" });
    __setSmsTransportForTests(null);
    expect(r.ok).toBe(true);
  });

  afterAll(async () => {
    await prisma.smsMessage.deleteMany({ where: { providerMessageId: messageId } });
  });

  const row = () => prisma.smsMessage.findFirstOrThrow({ where: { providerMessageId: messageId } });

  it("первый статус — из ответа на отправку", async () => {
    expect((await row()).deliveryStatus).toBe("SERVICE_ACCEPTED");
  });

  it("чужой секрет → 404, статус не меняется", async () => {
    const res = await request(app).post(url("0".repeat(40))).send({ id: messageId, status: "DELIVERED", timestamp: Date.now() });
    expect(res.status).toBe(404);
    expect((await row()).deliveryStatus).toBe("SERVICE_ACCEPTED");
  });

  it("неразборчивое тело → 400", async () => {
    expect((await request(app).post(url()).send({ id: messageId, status: "WHATEVER", timestamp: 1 })).status).toBe(400);
  });

  it("вразнобой: поздно пришедший SENT не затирает DELIVERED; повтор ничего не ломает", async () => {
    const t = Date.now();
    expect((await request(app).post(url()).send({ id: messageId, status: "DELIVERED", timestamp: t })).status).toBe(200);
    expect((await request(app).post(url()).send({ id: messageId, status: "SENT", timestamp: t - 5000 })).status).toBe(200);
    expect((await request(app).post(url()).send({ id: messageId, status: "DELIVERED", timestamp: t })).status).toBe(200);
    const r = await row();
    expect(r.deliveryStatus).toBe("DELIVERED");
    expect(r.deliveryStatusAt?.getTime()).toBe(t);
  });

  it("незнакомый id → 200 без изменений (повторов у Payom нет, ошибка ничего не даст)", async () => {
    const res = await request(app).post(url()).send({ id: "no-such-id", status: "DELIVERED", timestamp: Date.now() });
    expect(res.status).toBe(200);
  });
});

describe("номер для провайдера", () => {
  it("три записи таджикского номера → 992XXXXXXXXX; иностранный → null", () => {
    expect(toSmsPhone("+992 98 000 10 06")).toBe("992980001006");
    expect(toSmsPhone("0980001006")).toBe("992980001006");
    expect(toSmsPhone("980001006")).toBe("992980001006");
    expect(toSmsPhone("+7 916 123 45 67")).toBeNull();
  });
});
