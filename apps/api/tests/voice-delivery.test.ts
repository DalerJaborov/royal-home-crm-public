import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * Доставка голосового СОТРУДНИКА клиенту — весь путь от файла до записи в
 * переписку, с подменённым транспортом (Meta, перекодирование, расшифровка):
 * тест проверяет ПОРЯДОК и РЕШЕНИЯ (заблокировать/отправить), а не сеть и не ffmpeg.
 *
 * Три вещи, которые должны быть верны железно:
 *  1. Заблокированное голосовое НЕ уходит клиенту, но пометка остаётся в переписке
 *     и тревога уходит руководству — агент и директор должны это увидеть.
 *  2. Успешная отправка пишет в историю расшифровку и вложение, с mid для цитат.
 *  3. Сбой расшифровки (модель недоступна) блокирует отправку — «fail closed»,
 *     а не тихая отправка непроверенного голосового.
 */

const {
  transcodeToOggOpus,
  transcodeToM4a,
  isSilentAudio,
  transcribeAudio,
  checkAgentVoiceMessage,
  saveOutgoingVoice,
  sendAudio,
  alertVoiceViolation,
  sendTelegramVoice,
  logSystemError,
} = vi.hoisted(() => ({
  transcodeToOggOpus: vi.fn(async (_buf: Buffer) => Buffer.from("fake-ogg")),
  transcodeToM4a: vi.fn(async (_buf: Buffer) => Buffer.from("fake-m4a")),
  isSilentAudio: vi.fn(async (_ogg: Buffer) => false),
  transcribeAudio: vi.fn(async (_buf: Buffer, _name: string, _mime: string) => "Квартира трёхкомнатная, этаж третий"),
  checkAgentVoiceMessage: vi.fn(async (_t: string) => ({ blocked: false })),
  saveOutgoingVoice: vi.fn(async (_buf: Buffer, _ext?: string) => "/uploads/msg-voice/test.ogg"),
  sendAudio: vi.fn(async (_c: string, _to: string, _url: string) => "wamid.sent-voice-1"),
  alertVoiceViolation: vi.fn(async () => {}),
  sendTelegramVoice: vi.fn(async (_chatId: string, _url: string) => undefined),
  logSystemError: vi.fn(async () => {}),
}));

vi.mock("../src/lib/audioTranscode.js", () => ({ transcodeToOggOpus, transcodeToM4a, isSilentAudio }));
vi.mock("../src/ai/transcribe.js", () => ({ transcribeAudio }));
vi.mock("../src/ai/voiceComplianceGuard.js", () => ({ checkAgentVoiceMessage }));
vi.mock("../src/lib/outgoingVoice.js", () => ({ saveOutgoingVoice }));
vi.mock("../src/lib/voiceSecurityAlert.js", () => ({ alertVoiceViolation }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendAudio,
  isMetaChannelEnabled: vi.fn(async () => true),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendVoice: sendTelegramVoice,
  isTelegramEnabled: vi.fn(() => true),
}));

process.env.CRM_PUBLIC_URL = "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { deliverVoiceToConversation } = await import("../src/lib/conversationDelivery.js");

let instagram: CustomerMessengerFixture;
let whatsapp: CustomerMessengerFixture;
beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
});
function targetOf(c: { id: string; channel: string; subscriberId: string; accountId?: string | null }) {
  const fixture = c.channel === "INSTAGRAM" ? instagram : c.channel === "WHATSAPP" ? whatsapp : null;
  return { kind: "bot" as const, id: c.id, channel: c.channel, subscriberId: c.subscriberId,
    accountId: c.accountId, ...(fixture ? { transport: fixture.transport } : {}) };
}

const runId = Date.now();
const ids: string[] = [];
const telegramIds: string[] = [];

async function makeConversation() {
  const c = await prisma.botConversation.create({
    data: { channel: "INSTAGRAM", accountId: instagram.id, endpointScopeId: instagram.transport.endpointScopeId, subscriberId: `voice-${runId}-${Math.random()}`, messages: [] },
  });
  ids.push(c.id);
  return c;
}

async function makeTelegramConversation() {
  const c = await prisma.telegramConversation.create({
    data: { chatId: `voice-tg-${runId}-${Math.random()}`, messages: [] },
  });
  telegramIds.push(c.id);
  return c;
}

afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await instagram?.dispose();
  await whatsapp?.dispose();
  if (ids.length > 0) await prisma.botConversation.deleteMany({ where: { id: { in: ids } } });
  if (telegramIds.length > 0) await prisma.telegramConversation.deleteMany({ where: { id: { in: telegramIds } } });
});

describe("Успешная отправка", () => {
  it("пишет расшифровку и вложение в историю, ставит паузу боту, отдаёт mid", async () => {
    const c = await makeConversation();
    const result = await deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("исходный webm") },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, clientId: null, clientName: null }
    );

    expect(result.ok).toBe(true);
    // Сверяем ровно то, что проверяет этот тест: канал, получателя и адрес файла.
    // Четвёртый аргумент — маркер аккаунта (messengers/accounts.ts) — здесь нарочно
    // не сверяется: он зависит от того, заведены ли аккаунты в базе прогона, и
    // жёсткая сверка делала бы тест то зелёным, то красным от чужих данных.
    // Ровно на этом он и упал в CI: expect.anything() не принимает undefined.
    const [channel, to, url] = sendAudio.mock.calls[0] ?? [];
    expect(sendAudio).toHaveBeenCalledTimes(1);
    expect(channel).toBe("INSTAGRAM");
    expect(to).toBe(c.subscriberId);
    expect(url).toContain("/uploads/msg-voice/");

    const saved = await prisma.botConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as {
      role: string;
      content: string;
      attachments?: { kind: string; url?: string }[];
      mid?: string;
      by?: { kind: string; agentName?: string };
    }[];
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Квартира трёхкомнатная, этаж третий");
    expect(messages[0].attachments?.[0]).toMatchObject({ kind: "audio", url: "/uploads/msg-voice/test.ogg" });
    expect(messages[0].mid).toBe("wamid.sent-voice-1");
    expect(messages[0].by).toMatchObject({ kind: "agent", agentName: "Фарход" });

    const paused = await prisma.botConversation.findUnique({ where: { id: c.id }, select: { pausedUntil: true } });
    expect(paused!.pausedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("Instagram/Messenger получают m4a, не ogg (Graph API отклоняет ogg — code 100)", async () => {
    const c = await makeConversation(); // канал INSTAGRAM по умолчанию
    await deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("исходный webm") },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, clientId: null, clientName: null }
    );

    expect(transcodeToM4a).toHaveBeenCalledTimes(1);
    expect(saveOutgoingVoice).toHaveBeenCalledWith(expect.anything(), "m4a");
  });

  it("WhatsApp получает ogg — m4a там не нужен", async () => {
    const c = await prisma.botConversation.create({
      data: { channel: "WHATSAPP", accountId: whatsapp.id, endpointScopeId: whatsapp.transport.endpointScopeId, subscriberId: `voice-${runId}-${Math.random()}`, messages: [] },
    });
    ids.push(c.id);

    await deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("исходный webm") },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, clientId: null, clientName: null }
    );

    expect(transcodeToM4a).not.toHaveBeenCalled();
    expect(saveOutgoingVoice).toHaveBeenCalledWith(expect.anything(), "ogg");
  });
});

describe("Заблокировано защитой", () => {
  it("клиент ничего не получает, но в переписке остаётся пометка, и уходит тревога", async () => {
    checkAgentVoiceMessage.mockResolvedValueOnce({ blocked: true, reason: "в голосовом произнесён номер телефона" });
    const c = await makeConversation();

    const result = await deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("исходный webm") },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, clientId: "client-1", clientName: "Азиз" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked).toBe(true);
    expect(sendAudio).not.toHaveBeenCalled();
    expect(alertVoiceViolation).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: "Фарход", clientId: "client-1", clientName: "Азиз" })
    );

    const saved = await prisma.botConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as { content: string; by?: { kind: string } }[];
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("заблокировано автоматикой");
    expect(messages[0].by).toMatchObject({ kind: "system" });

    // Заблокированная попытка не повод молчать боту — пауза не ставится.
    const paused = await prisma.botConversation.findUnique({ where: { id: c.id }, select: { pausedUntil: true } });
    expect(paused!.pausedUntil).toBeNull();
  });
});

describe("Отказ рубежей до отправки", () => {
  it("ffmpeg не смог перекодировать — понятная ошибка, ничего не уходит", async () => {
    transcodeToOggOpus.mockResolvedValueOnce(null);
    const c = await makeConversation();
    const result = await deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("x") },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, clientId: null, clientName: null }
    );
    expect(result.ok).toBe(false);
    expect(sendAudio).not.toHaveBeenCalled();
  });

  it("расшифровка недоступна (модель молчит) — блокирует по правилу fail-closed", async () => {
    transcribeAudio.mockResolvedValueOnce(null);
    const c = await makeConversation();
    const result = await deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("x") },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, clientId: null, clientName: null }
    );
    expect(result.ok).toBe(false);
    expect(sendAudio).not.toHaveBeenCalled();
    expect(checkAgentVoiceMessage).not.toHaveBeenCalled();
    // 24.09.2026: раньше блокировка была тихой — 422 видел только сам агент, а в
    // «Здоровье системы» не оставалось следа, ПОЧЕМУ конкретное голосовое не ушло.
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining("не удалось расшифровать"));
  });

  it("тишина не идёт на расшифровку модели: сообщение отправляется без выдуманного текста", async () => {
    // Найденный случай 16.08.2026: агент прислал 3.2с полной тишины, Gemini
    // сочинил фразу вместо честной пустой строки — она легла в переписку как
    // будто это его слова. Молчащая запись не должна доходить до модели вовсе.
    isSilentAudio.mockResolvedValueOnce(true);
    const c = await makeConversation();
    const result = await deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("тишина") },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, clientId: null, clientName: null }
    );

    expect(result.ok).toBe(true);
    expect(transcribeAudio).not.toHaveBeenCalled();
    // Голосовое всё равно уходит клиенту — тишина в подписи не повод не отправлять звук.
    expect(sendAudio).toHaveBeenCalledTimes(1);

    const saved = await prisma.botConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as { content: string; attachments?: { kind: string }[] }[];
    expect(messages[0].content).toBe("[🎤 голосовое]");
    expect(messages[0].attachments?.[0]).toMatchObject({ kind: "audio" });
  });


  it("канал WEBSITE — честная причина (нет транспорта под файлы), а не «ключи в Настройках → Meta» (11.09.2026)", async () => {
    const c = await prisma.botConversation.create({
      data: { channel: "WEBSITE", subscriberId: `voice-website-${runId}-${Math.random()}`, messages: [] },
    });
    ids.push(c.id);
    const result = await deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("x") },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, clientId: null, clientName: null }
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("Чат на сайте пока не умеет отправлять файлы и голосовые, отправьте текстом");
    expect(sendAudio).not.toHaveBeenCalled();
  });
});

describe("Диск отказал — отказ возвращается, а не бросается (23.09.2026)", () => {
  /**
   * Вся эта функция устроена как «возвращаю отказ, а не бросаю»: у неё для того и
   * заведён VoiceDeliveryResult, и роут читает `status`/`error`, чтобы показать их
   * агенту. `saveOutgoingVoice` из договора выпадал — кончившееся место или том
   * только на чтение бросали наружу, агент получал голый 500 без поля `error`, а
   * бот к тому моменту УЖЕ поставлен на паузу запросом выше: замолчал из-за
   * голосового, которое никто не отправлял. В журнал не попадало ничего.
   */
  it("отказ записи на диск не бросается наружу и не отправляет голосовое", async () => {
    const c = await makeConversation();
    saveOutgoingVoice.mockRejectedValueOnce(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }));

    const result = await deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("исходный webm") },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, clientId: null, clientName: null }
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(503);
    // Клиенту ничего не ушло, и в переписку голосовое не записано: отправлять нечего.
    expect(sendAudio).not.toHaveBeenCalled();
    const saved = await prisma.botConversation.findUnique({ where: { id: c.id } });
    expect(saved!.messages).toHaveLength(0);
  });
});

describe("Telegram — та же цепочка, свой транспорт (19.08.2026)", () => {
  it("уходит через sendVoice, пишется в TelegramConversation.messages, ogg без перекодирования", async () => {
    const c = await makeTelegramConversation();
    const result = await deliverVoiceToConversation(
      { kind: "telegram", id: c.id, subscriberId: c.chatId },
      { buffer: Buffer.from("исходный webm") },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, clientId: null, clientName: null }
    );

    expect(result.ok).toBe(true);
    expect(transcodeToM4a).not.toHaveBeenCalled();
    expect(sendTelegramVoice).toHaveBeenCalledTimes(1);
    expect(sendTelegramVoice.mock.calls[0][0]).toBe(c.chatId);
    expect(sendAudio).not.toHaveBeenCalled();

    const saved = await prisma.telegramConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as { content: string; attachments?: { kind: string }[] }[];
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Квартира трёхкомнатная, этаж третий");
    expect(messages[0].attachments?.[0]).toMatchObject({ kind: "audio" });
  });
});

describe("Фоновое голосовое бота и оператор, взявший диалог (CHANNEL-NEW-09)", () => {
  const botSender = { kind: "bot" as const };
  const yearAhead = () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  it("оператор поставил паузу, пока готовилось аудио: голосовое не уходит, пауза оператора цела", async () => {
    const c = await makeConversation();
    let release!: (text: string) => void;
    transcribeAudio.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));

    const sending = deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("wav бота") },
      { sender: botSender, clientId: null, clientName: null, pausedUntilOverride: new Date() }
    );
    // Пока идёт расшифровка, оператор берёт диалог на себя надолго.
    await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalled());
    const operatorPause = yearAhead();
    await prisma.botConversation.update({ where: { id: c.id }, data: { pausedUntil: operatorPause } });
    release("Здравствуйте, подскажу по квартире");

    const result = await sending;
    expect(result.ok).toBe(false);
    expect(sendAudio).not.toHaveBeenCalled();
    const after = await prisma.botConversation.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.pausedUntil?.getTime()).toBe(operatorPause.getTime());
    expect(after.messages).toHaveLength(0);
  });

  it("диалог уже на паузе оператора до начала: аудио даже не обрабатывается", async () => {
    const c = await makeConversation();
    await prisma.botConversation.update({ where: { id: c.id }, data: { pausedUntil: yearAhead() } });

    const result = await deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("wav бота") },
      { sender: botSender, clientId: null, clientName: null, pausedUntilOverride: new Date() }
    );

    expect(result.ok).toBe(false);
    expect(transcodeToOggOpus).not.toHaveBeenCalled();
    expect(sendAudio).not.toHaveBeenCalled();
  });

  it("клиент отписался (optedOutAt): голосовое бота не уходит", async () => {
    const c = await makeConversation();
    await prisma.botConversation.update({ where: { id: c.id }, data: { optedOutAt: new Date() } });

    const result = await deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("wav бота") },
      { sender: botSender, clientId: null, clientName: null, pausedUntilOverride: new Date() }
    );

    expect(result.ok).toBe(false);
    expect(sendAudio).not.toHaveBeenCalled();
  });

  it("обычный голосовой ответ бота без паузы по-прежнему уходит", async () => {
    const c = await makeConversation();
    const result = await deliverVoiceToConversation(
      targetOf(c),
      { buffer: Buffer.from("wav бота") },
      { sender: botSender, clientId: null, clientName: null, pausedUntilOverride: new Date() }
    );
    expect(result.ok).toBe(true);
    expect(sendAudio).toHaveBeenCalledTimes(1);
  });
});
