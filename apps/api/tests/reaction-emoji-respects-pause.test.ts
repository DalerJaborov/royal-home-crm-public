import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * СМАЙЛИК-ОТВЕТ НА «🔥»/«👍» ОБЯЗАН МОЛЧАТЬ ТАМ ЖЕ, ГДЕ МОЛЧИТ ОБЫЧНЫЙ ОТВЕТ
 * (находка №105, ночная проверка 24.09.2026).
 *
 * `reactionOnly` в routes/webhooks.ts считался ДО processMessengerTurn и сам по
 * себе не знал ни про рубильник канала (`bot.channels[msg.channel]`), ни про
 * паузу оператора, ни про спам-метку — смайлик уходил клиенту безусловно, даже
 * когда рубильник канала выключен, диалог на паузе или отправитель уже помечен
 * как рассылка. Обычный текстовый ответ во всех трёх случаях молчит — смайлик
 * молчать не умел.
 *
 * Починка: messengers/conversation.ts в ветке `input.silent` возвращает причину
 * молчания (`silenced`), routes/webhooks.ts шлёт смайлик только при
 * `bot.channels[msg.channel] && !result.silenced` (для обеих веток —
 * `reactionOnly` и `result.reactOnly`).
 */

const { sendMessage, sendReaction, verifySignature, isMetaEnabled, getWaPhoneId } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => "mid-fake-1"),
  sendReaction: vi.fn(async (..._args: unknown[]) => {}),
  verifySignature: vi.fn(async () => true),
  isMetaEnabled: vi.fn(async () => true),
  getWaPhoneId: vi.fn(async () => undefined as string | undefined),
}));
const callAi = vi.hoisted(() => vi.fn(async () => { throw new Error("Реакция не должна вызывать модель"); }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

// Подменяем ТОЛЬКО отправку и вход: разбор тела вебхука (parseIncoming) и вся
// остальная логика webhooks.ts/conversation.ts остаются настоящими — их и
// проверяем. Подпись и рубильник metaEnabled не имеют отношения к находке,
// подмена нужна только чтобы не гонять настоящую подпись Meta и не заводить
// ключи в Настройках ради одного теста (см. соседние тесты meta.js).
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendMessage,
  sendReaction,
  verifySignature,
  isMetaEnabled,
  getWaPhoneId,
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now();
let instagram: CustomerMessengerFixture;
let whatsapp: CustomerMessengerFixture;

/** WhatsApp: сообщение с bare-реакцией на входящий номер `from`. */
function waReactionBody(from: string, mid: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: whatsapp.externalId },
              contacts: [{ wa_id: from, profile: { name: "Клиент" } }],
              messages: [{ from, id: mid, type: "text", text: { body: "🔥" } }],
            },
          },
        ],
      },
    ],
  };
}

/** Instagram: то же самое, форма событий `messaging`. */
function igReactionBody(page: string, sender: string, mid: string) {
  return {
    object: "instagram",
    entry: [
      {
        id: page,
        messaging: [
          {
            sender: { id: sender },
            recipient: { id: page },
            message: { mid, text: "🔥" },
          },
        ],
      },
    ],
  };
}

async function messagesOf(channel: string, subscriberId: string): Promise<Record<string, unknown>[]> {
  const row = await prisma.botConversation.findUnique({
    where: { channel_subscriberId: { channel, subscriberId } },
    select: { messages: true },
  });
  return (row?.messages as unknown as Record<string, unknown>[]) ?? [];
}

/** Ждём, пока ход дойдёт до записи «🔥» в переписке — доказательство, что
 *  processMessengerTurn отработал целиком (silent-ветка пишет и возвращается). */
async function waitForReactionSaved(channel: string, subscriberId: string): Promise<void> {
  await waitFor(
    async () => (await messagesOf(channel, subscriberId)).some((m) => String(m.content).includes("🔥")),
    { timeoutMs: 10_000, label: `реакция сохранена в переписке ${channel}/${subscriberId}` }
  );
  // Отправка смайлика (или её отсутствие) решается сразу следом за сохранением,
  // в той же цепочке await — без искусственного сна. Небольшой запас всё же
  // берём: моки resolve'ятся быстро, но не гарантированно в тот же тик, что
  // наш опрос базы.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

const savedSettings: Record<string, unknown> = {};

beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
  getWaPhoneId.mockResolvedValue(whatsapp.externalId);
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botEnabled: true, botWhatsappEnabled: true, botInstagramEnabled: true },
  });
  Object.assign(savedSettings, settings);
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botEnabled: true, botWhatsappEnabled: true, botInstagramEnabled: true },
  });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await instagram?.dispose();
  await whatsapp?.dispose();
});

describe("смайлик-реакция подчиняется тем же правилам молчания, что и обычный ответ", () => {
  // Счётчики моков очищаем перед каждым тестом: проверки ниже смотрят на число
  // вызовов, а не только на факт, и не должны зависеть от порядка/повтора
  // соседних тестов (CI гоняет с retry: 1).
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("канал выключен (WhatsApp) — реакция клиенту не уходит", async () => {
    const from = `992${String(runId).slice(-9)}1`;
    await prisma.settings.update({ where: { id: "singleton" }, data: { botWhatsappEnabled: false } });
    try {
      const body = waReactionBody(from, `wamid.react-pause-${runId}-a`);
      const res = await request(app)
        .post("/api/v1/webhooks/meta")
        .set("x-hub-signature-256", whatsapp.sign(body))
        .send(body);
      expect(res.status).toBe(200);
      await waitForReactionSaved("WHATSAPP", from);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { botWhatsappEnabled: true } });
    }

    expect(sendReaction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(callAi).not.toHaveBeenCalled();
  });

  it("диалог на паузе у оператора (Instagram) — смайлик не уходит", async () => {
    const page = instagram.externalId;
    const sender = `react-pause-${runId}-paused`;
    await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        accountId: instagram.id,
        endpointScopeId: instagram.transport.endpointScopeId,
        subscriberId: sender,
        messages: [{ role: "assistant", content: "Ответил вручную", by: { kind: "manual" } }] as object,
        pausedUntil: new Date(Date.now() + 60 * 60 * 1000),
        botPausedAt: new Date(),
      },
    });

    const body = igReactionBody(page, sender, `mid-react-pause-${runId}-b`);
    const res = await request(app)
      .post("/api/v1/webhooks/meta")
      .set("x-hub-signature-256", instagram.sign(body))
      .send(body);
    expect(res.status).toBe(200);
    await waitForReactionSaved("INSTAGRAM", sender);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendReaction).not.toHaveBeenCalled();
    expect(callAi).not.toHaveBeenCalled();
  });

  it("отправитель уже помечен как рассылка (WhatsApp) — реакция не уходит", async () => {
    const from = `992${String(runId).slice(-9)}2`;
    await prisma.botConversation.create({
      data: {
        channel: "WHATSAPP",
        accountId: whatsapp.id,
        endpointScopeId: whatsapp.transport.endpointScopeId,
        subscriberId: from,
        messages: [] as object,
        spamFlaggedAt: new Date(),
        spamFlagReason: "тестовая метка рассылки",
      },
    });

    const body = waReactionBody(from, `wamid.react-pause-${runId}-c`);
    const res = await request(app)
      .post("/api/v1/webhooks/meta")
      .set("x-hub-signature-256", whatsapp.sign(body))
      .send(body);
    expect(res.status).toBe(200);
    await waitForReactionSaved("WHATSAPP", from);

    expect(sendReaction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(callAi).not.toHaveBeenCalled();
  });

  it("обычный диалог без пауз и меток — смайлик уходит как раньше (контроль)", async () => {
    const from = `992${String(runId).slice(-9)}3`;
    const body = waReactionBody(from, `wamid.react-pause-${runId}-d`);
    const res = await request(app)
      .post("/api/v1/webhooks/meta")
      .set("x-hub-signature-256", whatsapp.sign(body))
      .send(body);
    expect(res.status).toBe(200);
    await waitForReactionSaved("WHATSAPP", from);

    expect(sendReaction).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(callAi).not.toHaveBeenCalled();
  });
});
