import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * «Не присылай мне такое» — для всех и про всё (владелец 10.11.2026).
 *
 * Одна дверь: кнопка «🔕 Не присылать такое», фраза ответом на сообщение или
 * сразу после, тумблер профиля CRM и push CRM пишут/читают одно поле
 * Agent.pushMuted через lib/notificationPrefs.ts. Безопасность не выключается —
 * ни кнопкой, ни словами, ни профилем, и человеку честно сказано почему.
 */
const { sendHtmlMessage, sendMessageWithButtons, answerCallbackQuery, sendNotification } = vi.hoisted(() => {
  let id = 5000;
  return {
    sendHtmlMessage: vi.fn(async (_c: string, _h: string, _r?: number, _b?: unknown) => ({ message_id: ++id })),
    sendMessageWithButtons: vi.fn(async (_c: string, _t: string, _b: unknown) => ({ message_id: ++id })),
    answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => ({})),
    sendNotification: vi.fn(async () => ({}) as unknown),
  };
});
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendHtmlMessage, sendMessageWithButtons, answerCallbackQuery,
}));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: (...args: unknown[]) => sendNotification(...(args as [])) },
}));
process.env.VAPID_PUBLIC_KEY = "тестовый-открытый-ключ";
process.env.VAPID_PRIVATE_KEY = "тестовый-закрытый-ключ";

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { default: request } = await import("supertest");
const { sendPushToAgent } = await import("../src/push.js");
const {
  sendStaffNotice, handleStaffNoticeCallback, handleNoticePreferenceText, parseNoticeIntent, MUTE_BUTTON_TEXT,
} = await import("../src/telegram/staffNotice.js");
const { setKindMuted, isKindMuted } = await import("../src/lib/notificationPrefs.js");
const { PUSH_KINDS, ALWAYS_ON_KINDS } = await import("@royal-home/shared");
const { waitForSettled } = await import("./helpers/waitFor.js");

const runId = String(Date.now()).slice(-7);
let agentId = "";
let chatId = "";
let token = "";
let cb = 1;

const lastHtml = () => String(sendHtmlMessage.mock.calls.at(-1)?.[1] ?? "");
const allButtons = (call: unknown[] | undefined) => JSON.stringify(call?.[3] ?? call?.[2] ?? []);
const muted = async () => (await prisma.agent.findUnique({ where: { id: agentId }, select: { pushMuted: true } }))!.pushMuted;
const say = (text: string, replyTo?: number) => handleNoticePreferenceText({
  chat: { id: Number(chatId), type: "private" }, message_id: 1, text,
  ...(replyTo ? { reply_to_message: { chat: { id: Number(chatId) }, message_id: replyTo } } : {}),
}, { id: agentId }, text);
const press = (data: string) => handleStaffNoticeCallback({
  id: `nm-${runId}-${cb++}`, data, from: { id: Number(chatId) },
  message: { chat: { id: Number(chatId), type: "private" }, message_id: 77, text: "Оплаты" },
});

beforeAll(async () => {
  chatId = String(840_000_000 + Number(runId));
  const agent = await prisma.agent.create({ data: {
    fullName: `Мьют ${runId}`, phone: `+99298${runId}`, role: "DIRECTOR",
    passwordHash: await bcrypt.hash("testpass123", 4), telegramChatId: chatId, telegramUserId: chatId,
  } });
  agentId = agent.id;
  token = signAccessToken({ sub: agent.id, role: "DIRECTOR" } as never);
  await prisma.pushSubscription.create({ data: { agentId, endpoint: `https://example.test/mute/${runId}`, p256dh: "p", auth: "a" } });
});
beforeEach(async () => {
  for (const m of [sendHtmlMessage, sendMessageWithButtons, answerCallbackQuery, sendNotification]) m.mockClear();
  await prisma.agent.update({ where: { id: agentId }, data: { pushMuted: [] } });
});
afterAll(async () => {
  await prisma.staffNotice.deleteMany({ where: { agentId } });
  await waitForSettled(() => prisma.notification.count({ where: { agentId } }));
  await prisma.notification.deleteMany({ where: { agentId } });
  await prisma.pushSubscription.deleteMany({ where: { agentId } });
  await prisma.agent.delete({ where: { id: agentId } });
});

describe("разбор фразы — узко, чужие просьбы не перехватываются", () => {
  it.each([
    ["не присылай мне такое", { type: "mute", kind: null }],
    ["Пожалуйста, больше не присылай такое", { type: "mute", kind: null }],
    ["мне это не нужно", { type: "mute", kind: null }],
    ["не присылай мне оплаты", { type: "mute", kind: "payment" }],
    ["ба ман инро нафирист", { type: "mute", kind: null }],
    ["что у меня выключено?", { type: "list" }],
    ["включи обратно оплаты", { type: "unmute", kind: "payment" }],
    ["включи обратно", { type: "unmute", kind: null }],
  ])("«%s»", (text, expected) => {
    expect(parseNoticeIntent(text)).toEqual(expected);
  });
  it.each([
    "не присылай клиенту показ",
    "отключи публикацию ОБ-000123",
    "выключи объект",
    "клиент сказал не присылать ему такое",
    "найди объекты в Сино",
  ])("«%s» — не про сообщения помощницы", (text) => {
    expect(parseNoticeIntent(text)).toBeNull();
  });
});

describe("дверь sendStaffNotice", () => {
  it("ставит «🔕 Не присылать такое» и пишет журнал с номером сообщения", async () => {
    expect(await sendStaffNotice({ agentId, kind: "payment", html: "💳 Оплаты" })).toBe("sent");
    expect(allButtons(sendHtmlMessage.mock.calls.at(-1))).toContain(MUTE_BUTTON_TEXT);
    expect(allButtons(sendHtmlMessage.mock.calls.at(-1))).toContain("nm:payment");
    const row = await prisma.staffNotice.findFirst({ where: { agentId, kind: "payment" }, orderBy: { createdAt: "desc" } });
    expect(row?.messageId).toBeGreaterThan(0);
  });
  it("один повод — одно сообщение", async () => {
    const dedupKey = `test:${runId}:once`;
    expect(await sendStaffNotice({ agentId, kind: "look", html: "a", dedupKey })).toBe("sent");
    expect(await sendStaffNotice({ agentId, kind: "look", html: "a", dedupKey })).toBe("duplicate");
    expect(sendHtmlMessage).toHaveBeenCalledTimes(1);
  });
  it("выключенный вид не уходит", async () => {
    await setKindMuted(agentId, "payment", true);
    expect(await sendStaffNotice({ agentId, kind: "payment", html: "x" })).toBe("muted");
    expect(sendHtmlMessage).not.toHaveBeenCalled();
  });
  it("у безопасности кнопки выключения нет", async () => {
    await sendStaffNotice({ agentId, kind: "security", html: "🔐" });
    expect(allButtons(sendHtmlMessage.mock.calls.at(-1))).not.toContain(MUTE_BUTTON_TEXT);
  });
});

describe("выключение кнопкой и словами", () => {
  it("кнопка выключает вид, «Включить обратно» — возвращает", async () => {
    expect(await press("nm:payment")).toBe(true);
    expect(await muted()).toContain("payment");
    expect(lastHtml()).toContain("Выключила");
    expect(await press("nu:payment")).toBe(true);
    expect(await muted()).not.toContain("payment");
  });
  it("повторная доставка того же нажатия не переключает второй раз", async () => {
    const query = { id: `nm-${runId}-dup`, data: "nm:look", from: { id: Number(chatId) }, message: { chat: { id: Number(chatId) }, message_id: 1 } };
    await handleStaffNoticeCallback(query);
    await setKindMuted(agentId, "look", false);
    await handleStaffNoticeCallback(query);
    expect(await muted()).not.toContain("look");
  });
  it("«не присылай мне такое» ответом на сообщение — выключает его вид", async () => {
    await sendStaffNotice({ agentId, kind: "publication", html: "🎬 Объект вышел" });
    const messageId = (await prisma.staffNotice.findFirst({ where: { agentId, kind: "publication" }, orderBy: { createdAt: "desc" } }))!.messageId!;
    await sendStaffNotice({ agentId, kind: "payment", html: "💳 позже" });
    expect(await say("не присылай мне такое", messageId)).toBe(true);
    expect(await muted()).toEqual(["publication"]);
  });
  it("сразу после сообщения, без ответа — выключает последний вид", async () => {
    await sendStaffNotice({ agentId, kind: "look", html: "🤝 Подбор" });
    expect(await say("мне это не нужно")).toBe(true);
    expect(await muted()).toContain("look");
  });
  it("ответ на обычный ответ помощницы — честно «выключать нечего»", async () => {
    expect(await say("не присылай мне такое", 999_999)).toBe(true);
    expect(lastHtml()).toContain("выключать нечего");
    expect(await muted()).toEqual([]);
  });
  it("«что у меня выключено» — список тем же модулем, «включи обратно» — включает", async () => {
    await setKindMuted(agentId, "payment", true);
    await say("что у меня выключено?");
    const html = lastHtml();
    expect(html).toContain("🔕 <b>Выключено у вас</b> · 1");
    expect(html).toContain("1️⃣ Оплаты подписок");
    expect(html).toContain("Безопасность");
    await say("включи обратно");
    expect(await muted()).toEqual([]);
  });
});

describe("безопасность не отключается — нигде", () => {
  it("словами: отказ с причиной", async () => {
    await say("не присылай мне безопасность");
    expect(lastHtml()).toContain("выключить нельзя");
    expect(await muted()).toEqual([]);
  });
  it("профилем: 409 с причиной", async () => {
    const res = await request(app).patch("/api/v1/push/preferences").set("Authorization", `Bearer ${token}`).send({ kind: "security", enabled: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("выключить нельзя");
  });
  it("push с видом «безопасность» доходит, даже если вид попал в массив руками", async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { pushMuted: ["security"] } });
    expect(isKindMuted("security", ["security"])).toBe(false);
    await sendPushToAgent(agentId, { kind: "security", title: "🔐 Изменены права", body: "тест", realtime: true });
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});

describe("профиль CRM — та же дверь", () => {
  it("отдаёт все виды, включая оплаты, и список неотключаемых", async () => {
    const res = await request(app).get("/api/v1/push/preferences").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.kinds.map((k: { key: string }) => k.key)).toEqual(PUSH_KINDS.map((k) => k.key));
    expect(res.body.kinds.some((k: { key: string }) => k.key === "payment")).toBe(true);
    expect(res.body.alwaysOn.map((k: { key: string }) => k.key)).toEqual(ALWAYS_ON_KINDS.map((k) => k.key));
  });
  it("выключил в профиле — помощница в Telegram тоже молчит", async () => {
    const res = await request(app).patch("/api/v1/push/preferences").set("Authorization", `Bearer ${token}`).send({ kind: "payment", enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.kinds.find((k: { key: string }) => k.key === "payment").enabled).toBe(false);
    expect(await sendStaffNotice({ agentId, kind: "payment", html: "x" })).toBe("muted");
  });
});
