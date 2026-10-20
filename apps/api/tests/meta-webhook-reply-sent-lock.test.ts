import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ЗАМОК ДУБЛЯ НЕ СНИМАЕТСЯ, ЕСЛИ ОТВЕТ УЖЕ УШЁЛ КЛИЕНТУ (18.09.2026, диалог
 * 133c76fa: «приняли ваши данные» и тут же переспрос того же текста).
 *
 * Замок ставится ДО обработки (lib/webhookDedupe.ts), а при сбое хода catch в
 * routes/webhooks.ts его снимает, чтобы повторная доставка от Meta дала клиенту
 * ответ. Но если сбой случился ПОСЛЕ успешной отправки первой реплики (вторая
 * реплика, mid), клиент ответ уже видел — снятие замка пускало повторную доставку
 * в processMessengerTurn заново, и уходил второй, слегка другой ответ.
 *
 * Здесь вебхук одного и того же сообщения доставляется ДВАЖДЫ (это и есть
 * идемпотентность): ход бота должен отработать один раз, если ответ ушёл, и
 * отработать заново, если не ушёл ничего.
 */

const { sendMessage, verifySignature, isMetaEnabled, getWaPhoneId, showReadAndTyping, processMessengerTurn } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]): Promise<string | null> => "mid-fake"),
  verifySignature: vi.fn(async () => true),
  isMetaEnabled: vi.fn(async () => true),
  getWaPhoneId: vi.fn(async () => undefined as string | undefined),
  showReadAndTyping: vi.fn(async (..._args: unknown[]) => undefined),
  processMessengerTurn: vi.fn(async (..._args: unknown[]) => ({
    shouldReply: true,
    reply: "Приняли ваши данные",
    reply2: "Подскажите бюджет",
  })),
}));

vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendMessage,
  verifySignature,
  isMetaEnabled,
  getWaPhoneId,
  showReadAndTyping,
}));
vi.mock("../src/messengers/conversation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/conversation.js")>()),
  processMessengerTurn,
}));
// Паузы «набора» — секунды на каждую реплику; для проверки замка они не нужны.
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()),
  sleep: async () => undefined,
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { drainBackgroundTasks } = await import("../src/lib/shutdownState.js");

const runId = Date.now();
let whatsapp: CustomerMessengerFixture;
beforeAll(async () => { whatsapp = await createCustomerMessengerFixture("WHATSAPP"); });

function waTextBody(from: string, mid: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: whatsapp.externalId },
              contacts: [{ wa_id: from, profile: { name: "Клиент" } }],
              messages: [{ from, id: mid, type: "text", text: { body: "Хочу двухкомнатную квартиру" } }],
            },
          },
        ],
      },
    ],
  };
}

/** Доставляем один и тот же вебхук и ждём, пока вся фоновая обработка отработает. */
async function deliver(body: unknown): Promise<void> {
  const res = await request(app).post("/api/v1/webhooks/meta").set("x-hub-signature-256", whatsapp.sign(body)).send(body);
  expect(res.status).toBe(200);
  await drainBackgroundTasks(10_000);
  // `markProcessedMessageComplete` и `releaseProcessedMessage` в обработчике идут
  // через `void` — даём им дописаться в базу.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

afterAll(async () => {
  await whatsapp.dispose();
  await prisma.processedMessage.deleteMany({ where: { messageId: { startsWith: `wamid.reply-sent-lock-${runId}` } } });
});

describe("повторная доставка вебхука Meta: замок дубля и уже ушедший ответ", () => {
  beforeEach(() => {
    sendMessage.mockReset();
    processMessengerTurn.mockClear();
  });

  it("первая реплика ушла, вторая упала — повтор НЕ прогоняет ход заново (клиент не получит второй ответ)", async () => {
    const from = `992${String(runId).slice(-8)}1`;
    const body = waTextBody(from, `wamid.reply-sent-lock-${runId}-a`);
    sendMessage.mockResolvedValueOnce("mid-1").mockRejectedValueOnce(new Error("Graph API 500 на второй реплике"));

    await deliver(body);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(processMessengerTurn).toHaveBeenCalledTimes(1);

    await deliver(body); // Meta доставила то же сообщение второй раз
    expect(processMessengerTurn).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("ответ не ушёл вовсе (сбой на первой реплике) — замок снят, повтор отрабатывает и даёт клиенту ответ", async () => {
    const from = `992${String(runId).slice(-8)}2`;
    const body = waTextBody(from, `wamid.reply-sent-lock-${runId}-b`);
    sendMessage.mockRejectedValueOnce(new Error("Graph API 500 на первой реплике"));
    sendMessage.mockResolvedValue("mid-ok");

    await deliver(body);
    expect(processMessengerTurn).toHaveBeenCalledTimes(1);

    await deliver(body);
    expect(processMessengerTurn).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.filter((c) => c[2] === "Приняли ваши данные")).toHaveLength(2);
  });
});
