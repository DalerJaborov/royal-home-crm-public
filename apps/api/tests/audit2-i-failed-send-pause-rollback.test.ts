import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ТОЧНО НЕУДАВШАЯСЯ ОТПРАВКА НЕ ДОЛЖНА ОСТАВЛЯТЬ БОТА НА ПАУЗЕ (аудит CHANNEL-NEW-08, 04.10.2026).
 *
 * Пауза бота ставится ДО отправки (лучше помолчит, чем ответит поверх человека).
 * Но если клиенту заведомо ничего не ушло (окно 24 часа закрыто, щит не выпустил,
 * сбой до самой отправки: файл не сохранился, R2 недоступен), оператор диалог не взял,
 * а бот молчал бы 10 лет. Решение владельца: в таких случаях пауза откатывается
 * условным updateMany (срок равен поставленному нами), чужую паузу не трогаем.
 * Если исход неизвестен (таймаут/сбой транспорта) — пауза остаётся как была.
 */

const {
  sendMessage,
  sendAudio,
  sendImage,
  uploadOutgoingMedia,
  r2PresignDownloadUrl,
  isR2Configured,
  saveOutgoingVoice,
  transcodeToOggOpus,
  transcodeToM4a,
  isSilentAudio,
  transcribeAudio,
  checkAgentVoiceMessage,
  logSystemError,
} = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_c: string, _to: string, _text: string) => "wamid.sent-1"),
  sendAudio: vi.fn(async (_c: string, _to: string, _url: string) => "wamid.sent-voice-1"),
  sendImage: vi.fn(async (_c: string, _to: string, _url: string) => "wamid.sent-image-1"),
  uploadOutgoingMedia: vi.fn(async (id: string, _src: unknown, ext: string, _t?: string) => `chat-media/${id}/t.${ext}`),
  r2PresignDownloadUrl: vi.fn(async (key: string) => `https://r2.test/${key}`),
  isR2Configured: vi.fn(() => true),
  saveOutgoingVoice: vi.fn(async (_b: Buffer, _e?: string) => "/uploads/msg-voice/test.ogg"),
  transcodeToOggOpus: vi.fn(async (_b: Buffer) => Buffer.from("fake-ogg")),
  transcodeToM4a: vi.fn(async (_b: Buffer) => Buffer.from("fake-m4a")),
  isSilentAudio: vi.fn(async (_b: Buffer) => false),
  transcribeAudio: vi.fn(async () => "Здравствуйте"),
  checkAgentVoiceMessage: vi.fn(async (_t: string) => ({ blocked: false })),
  logSystemError: vi.fn(async () => {}),
}));

vi.mock("../src/lib/audioTranscode.js", () => ({ transcodeToOggOpus, transcodeToM4a, isSilentAudio }));
vi.mock("../src/ai/transcribe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/transcribe.js")>()),
  transcribeAudio,
}));
vi.mock("../src/ai/voiceComplianceGuard.js", () => ({ checkAgentVoiceMessage }));
vi.mock("../src/lib/outgoingVoice.js", () => ({ saveOutgoingVoice }));
vi.mock("../src/lib/outgoingMedia.js", () => ({ uploadOutgoingMedia }));
vi.mock("../src/lib/r2Client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/r2Client.js")>()),
  r2PresignDownloadUrl,
  isR2Configured,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendMessage,
  sendAudio,
  sendImage,
  isMetaChannelEnabled: vi.fn(async () => true),
}));

process.env.CRM_PUBLIC_URL = "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { deliverToConversation, deliverVoiceToConversation, deliverMediaToConversation } = await import(
  "../src/lib/conversationDelivery.js"
);
const { OutboundBlockedError } = await import("../src/lib/outboundShield.js");

let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture("INSTAGRAM"); });

const runId = Date.now().toString(36);
const ids: string[] = [];
const agent = { kind: "agent" as const, agentId: "agent-x", agentName: "Агент" };
const HOUR = 60 * 60 * 1000;
const WINDOW_ERR =
  'Graph API HTTP 400: {"error":{"message":"(#131047) Message failed to send because more than 24 hours have passed since the customer last replied to this number.","code":131047}}';

async function makeConversation(pause?: { pausedUntil: Date; botPausedAt: Date }) {
  const c = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      accountId: fixture.id,
      endpointScopeId: fixture.transport.endpointScopeId,
      subscriberId: `rb-${runId}-${ids.length}`,
      messages: [],
      ...(pause ?? {}),
    },
  });
  ids.push(c.id);
  return c;
}
const targetOf = (c: { id: string; channel: string; subscriberId: string }) =>
  ({ kind: "bot" as const, id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport });
const saved = (id: string) =>
  prisma.botConversation.findUnique({ where: { id }, select: { pausedUntil: true, botPausedAt: true } });

afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await fixture?.dispose();
});

describe("Текст: точно неудавшаяся отправка откатывает паузу", () => {
  it("закрытое окно: пауза возвращается к null", async () => {
    const c = await makeConversation();
    sendMessage.mockRejectedValueOnce(new Error(WINDOW_ERR));

    const r = await deliverToConversation(targetOf(c), "Здравствуйте", undefined, { sender: agent });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("window_closed");
    const s = await saved(c.id);
    expect(s!.pausedUntil).toBeNull();
    expect(s!.botPausedAt).toBeNull();
  });

  it("щит не выпустил (409): пауза возвращается, явный срок оператора тоже", async () => {
    const c = await makeConversation();
    sendMessage.mockRejectedValueOnce(
      new OutboundBlockedError({ reason: "x", kind: "text", reasonText: "тест" } as never)
    );

    const r = await deliverToConversation(targetOf(c), "Текст", new Date(Date.now() + 5 * HOUR), { sender: agent });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect((await saved(c.id))!.pausedUntil).toBeNull();
  });

  it("прежняя пауза и её начало возвращаются как были", async () => {
    const prevUntil = new Date(Date.now() + 30 * 60 * 1000);
    const prevAt = new Date(Date.now() - 20 * 60 * 1000);
    const c = await makeConversation({ pausedUntil: prevUntil, botPausedAt: prevAt });
    sendMessage.mockRejectedValueOnce(new Error(WINDOW_ERR));

    // Явный срок оператора укорачивает/сдвигает паузу как есть (без keepLonger).
    await deliverToConversation(targetOf(c), "Текст", new Date(Date.now() + 5 * HOUR), { sender: agent });

    const s = await saved(c.id);
    expect(s!.pausedUntil!.getTime()).toBe(prevUntil.getTime());
    expect(s!.botPausedAt!.getTime()).toBe(prevAt.getTime());
  });

  it("исход неизвестен (таймаут транспорта): пауза остаётся, бот не отвечает поверх человека", async () => {
    const c = await makeConversation();
    sendMessage.mockRejectedValueOnce(new Error("fetch failed: ETIMEDOUT"));

    const r = await deliverToConversation(targetOf(c), "Текст", new Date(Date.now() + 5 * HOUR), { sender: agent });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(502);
    expect((await saved(c.id))!.pausedUntil).not.toBeNull();
  });

  it("гонка: другой оператор успел поставить свою паузу — откат её не трогает", async () => {
    const c = await makeConversation();
    const other = new Date(Date.now() + 2 * HOUR);
    sendMessage.mockImplementationOnce(async () => {
      await prisma.botConversation.update({ where: { id: c.id }, data: { pausedUntil: other } });
      throw new Error(WINDOW_ERR);
    });

    await deliverToConversation(targetOf(c), "Текст", new Date(Date.now() + 5 * HOUR), { sender: agent });

    expect((await saved(c.id))!.pausedUntil!.getTime()).toBe(other.getTime());
  });

  it("успешная отправка паузу оставляет", async () => {
    const c = await makeConversation();
    const r = await deliverToConversation(targetOf(c), "Текст", new Date(Date.now() + 5 * HOUR), { sender: agent });
    expect(r.ok).toBe(true);
    expect((await saved(c.id))!.pausedUntil).not.toBeNull();
  });
});

describe("Голосовое: отказ после паузы, когда клиенту заведомо ничего не ушло", () => {
  const opts = { sender: agent, clientId: null, clientName: null };

  it("файл не сохранился на диске: пауза откатывается", async () => {
    const c = await makeConversation();
    saveOutgoingVoice.mockRejectedValueOnce(new Error("ENOSPC"));

    const r = await deliverVoiceToConversation(targetOf(c), { buffer: Buffer.from("a") }, opts);

    expect(r.ok).toBe(false);
    expect((await saved(c.id))!.pausedUntil).toBeNull();
  });

  it("закрытое окно при отправке голосового: пауза откатывается", async () => {
    const c = await makeConversation();
    sendAudio.mockRejectedValueOnce(new Error(WINDOW_ERR));

    const r = await deliverVoiceToConversation(targetOf(c), { buffer: Buffer.from("a") }, opts);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("window_closed");
    expect((await saved(c.id))!.pausedUntil).toBeNull();
  });

  it("сбой транспорта с неизвестным исходом: пауза остаётся", async () => {
    const c = await makeConversation();
    sendAudio.mockRejectedValueOnce(new Error("socket hang up"));

    const r = await deliverVoiceToConversation(targetOf(c), { buffer: Buffer.from("a") }, opts);

    expect(r.ok).toBe(false);
    expect((await saved(c.id))!.pausedUntil).not.toBeNull();
  });
});

describe("Фото/видео: отказ после паузы, когда клиенту заведомо ничего не ушло", () => {
  const media = { mimetype: "image/jpeg", buffer: Buffer.from("jpg") };

  it("R2 не принял файл: пауза откатывается", async () => {
    const c = await makeConversation();
    uploadOutgoingMedia.mockRejectedValueOnce(new Error("R2 down"));

    const r = await deliverMediaToConversation(targetOf(c), media, { sender: agent });

    expect(r.ok).toBe(false);
    expect((await saved(c.id))!.pausedUntil).toBeNull();
  });

  it("закрытое окно при отправке фото: пауза откатывается", async () => {
    const c = await makeConversation();
    sendImage.mockRejectedValueOnce(new Error(WINDOW_ERR));

    const r = await deliverMediaToConversation(targetOf(c), media, { sender: agent });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("window_closed");
    expect((await saved(c.id))!.pausedUntil).toBeNull();
  });

  it("сбой транспорта с неизвестным исходом: пауза остаётся", async () => {
    const c = await makeConversation();
    sendImage.mockRejectedValueOnce(new Error("socket hang up"));

    await deliverMediaToConversation(targetOf(c), media, { sender: agent });

    expect((await saved(c.id))!.pausedUntil).not.toBeNull();
  });
});
