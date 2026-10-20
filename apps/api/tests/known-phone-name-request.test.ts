import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { countPhoneAsks, countPhoneAsksIn, dropKnownPhoneAsks } from "../src/ai/replyRepeatGuard.js";
import { processMessengerTurn as actualProcessMessengerTurn } from "../src/messengers/conversation.js";

const { model } = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: model,
}));

let messengerFixture: CustomerMessengerFixture;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...messengerFixture.turnInput(input.subscriberId) });
}

const subscriber = `known-phone-name-${randomUUID()}`;
let clientId = "";
let saved: { botEnabled: boolean; botWhatsappEnabled: boolean; botReplyDelaySec: number; botReplyMaxWaitSec: number };

beforeAll(async () => {
  messengerFixture = await createCustomerMessengerFixture("WHATSAPP");
  vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
  vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected external network in known-phone regression"); }));
  saved = await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {},
    select: { botEnabled: true, botWhatsappEnabled: true, botReplyDelaySec: true, botReplyMaxWaitSec: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botWhatsappEnabled: true,
    botReplyDelaySec: 0, botReplyMaxWaitSec: 0 } });
  const client = await prisma.client.create({ data: { fullName: "Synthetic known phone regression",
    phone: `+992${randomInt(100_000_000, 1_000_000_000)}`, source: "WHATSAPP", desiredRooms: 2 } });
  clientId = client.id;
  await prisma.botConversation.update({
    where: { id: (await messengerFixture.ensureConversation(subscriber)).id }, data: { channel: "WHATSAPP", subscriberId: subscriber, clientId,
    leadDraft: { stage: "done", intent: "buy", rooms: 2 },
    // No historical phone: this must use the linked CRM contact, not a number
    // accidentally detected in the client's words or an invalid-model fallback.
    messages: [{ role: "user", content: "Ищу квартиру для покупки.", at: new Date().toISOString() }] } });
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (clientId) await prisma.client.deleteMany({ where: { id: clientId } });
  await messengerFixture?.dispose();
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe("explicit name-phone imperative with a known contact", () => {
  it.each([
    "Назовите номер телефона.",
    "Назовите ваш телефон.",
    "Назовите, пожалуйста, номер телефона.",
  ])("removes only the explicit phone request: %s", (request) => {
    expect(dropKnownPhoneAsks([`${request} Уточните район.`])).toEqual(["Уточните район."]);
  });

  it.each([
    "Назовите номер объекта.",
    "Назовите номер объекта?",
    "Назовите номер квартиры.",
    "Назовите номер квартиры?",
    "Назовите код публикации.",
    "Назовите номер объекта для разговора по телефону.",
    "Назовите номер объекта для разговора по телефону?",
    "Назовите номер объекта. Телефон уже есть.",
    "Номер телефона мы получили. Подскажите номер объекта?",
  ])("preserves property/publication selectors: %s", (request) => {
    expect(dropKnownPhoneAsks([request])).toEqual([request]);
    expect(countPhoneAsks([request])).toBe(0);
    expect(countPhoneAsksIn([request])).toBe(0);
  });

  it("still detects a real phone request alongside an object selector", () => {
    const mixed = "Назовите номер объекта. Назовите номер телефона.";
    expect(countPhoneAsks([mixed])).toBe(1);
    expect(countPhoneAsksIn([mixed])).toBe(1);
    expect(dropKnownPhoneAsks([mixed])).toEqual(["Назовите номер объекта."]);
    expect(dropKnownPhoneAsks(["Напишите номер телефона для объекта."])).toEqual([]);
    expect(dropKnownPhoneAsks(["Напишите номер телефона, чтобы согласовать объект."])).toEqual([]);
  });

  it("preserves the separate additional-phone request and existing RU/TG guards", () => {
    const additional = "Назовите дополнительный номер телефона.";
    expect(dropKnownPhoneAsks([additional])).toEqual([additional]);
    expect(dropKnownPhoneAsks(["Напишите номер телефона. Уточните район."])).toEqual(["Уточните район."]);
    expect(dropKnownPhoneAsks(["Рақаматонро нависед. Ноҳияро аниқ кунед."])).toEqual(["Ноҳияро аниқ кунед."]);
  });

  it("a schema-valid model turn keeps its useful question without reasking the CRM phone", async () => {
    model.mockResolvedValue({ reply: ["Назовите номер телефона. Уточните район."], ready: false, confident: true,
      topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const result = await processMessengerTurn({ channel: "WHATSAPP", subscriberId: subscriber, text: "Уточните детали покупки." });
    expect(model.mock.calls.some(([input]) => input.endpoint === "lead-qualify")).toBe(true);
    expect(result.aiUnavailable ?? false).toBe(false);
    expect(result.shouldReply).not.toBe(false);
    // The established reply normalizer removes final full stops.
    expect(result.reply).toBe("Уточните район");
    expect(result.reply2).toBeUndefined();
    const conversation = await prisma.botConversation.findUniqueOrThrow({ where: { channel_subscriberId: { channel: "WHATSAPP", subscriberId: subscriber } } });
    expect(conversation.clientId).toBe(clientId);
    expect(conversation.leadDraft).not.toMatchObject({ stage: "awaiting_phone" });
    expect(await prisma.client.count({ where: { id: clientId, phone: { not: "" } } })).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
