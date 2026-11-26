import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * INSTAGRAM: «ОК» ПОСЛЕ «НОМЕР ПОЛУЧИЛ» — НАСТОЯЩАЯ РЕАКЦИЯ, А ПРИ ОТКАЗЕ META — ТИШИНА (владелец 26.11.2026).
 *
 * Сквозь настоящий вебхук (routes/webhooks.ts) и настоящую отправку реакции (messengers/meta.ts::sendCustomerReaction):
 * подменены только подпись, текстовая отправка (шпион — её звать нельзя) и внешний HTTP (fetch). До 26.11 на «Ок» в
 * Instagram уходило ОТДЕЛЬНОЕ сообщение-смайлик («🙏❤️»): комментарий в коде утверждал, что реакции у Meta нет.
 */
const { sendMessage, verifySignature, isMetaEnabled } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => "mid-should-not-be-sent"),
  verifySignature: vi.fn(async () => true),
  isMetaEnabled: vi.fn(async () => true),
}));
const callAi = vi.hoisted(() => vi.fn(async () => { throw new Error("«Ок» не должно доходить до модели"); }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendMessage, verifySignature, isMetaEnabled,
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { waitFor } = await import("./helpers/waitFor.js");

const PROMISE = "Спасибо, номер получил, агент вам позвонит.";
const runId = Date.now().toString(36);
let instagram: CustomerMessengerFixture;
const reactBodies: Array<Record<string, unknown>> = [];
let graphFails = false;
const savedSettings: Record<string, unknown> = {};

function igBody(sender: string, mid: string, text: string) {
  return { object: "instagram", entry: [{ id: instagram.externalId, messaging: [{
    sender: { id: sender }, recipient: { id: instagram.externalId }, timestamp: Date.now(), message: { mid, text } }] }] };
}
async function seedConversation(sender: string): Promise<void> {
  await prisma.botConversation.create({ data: { channel: "INSTAGRAM", accountId: instagram.id, endpointScopeId: instagram.transport.endpointScopeId,
    subscriberId: sender, name: "Клиент", messages: [
      { role: "user", content: "918 22 33 47", at: new Date(Date.now() - 60_000).toISOString() },
      { role: "assistant", content: PROMISE, by: { kind: "bot" }, at: new Date(Date.now() - 50_000).toISOString() },
    ] as object } });
}
async function savedOk(sender: string, text: string): Promise<void> {
  await waitFor(async () => {
    const row = await prisma.botConversation.findFirst({ where: { subscriberId: sender }, select: { messages: true } });
    return ((row?.messages ?? []) as Array<{ role: string; content: string }>).some((m) => m.role === "user" && m.content === text);
  }, { timeoutMs: 10_000, label: `реплика «${text}» сохранена` });
}

beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" },
    select: { botEnabled: true, botInstagramEnabled: true, botReplyDelaySec: true, botReplyMaxWaitSec: true, botLeadOnlyMode: true } });
  Object.assign(savedSettings, settings);
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botInstagramEnabled: true,
    botReplyDelaySec: 0, botReplyMaxWaitSec: 1, botLeadOnlyMode: true } });
  vi.stubEnv("IG_PROXY_URL", "https://synthetic-ack-reaction-instagram.invalid"); vi.stubEnv("IG_PROXY_KEY", "");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (body.sender_action === "react") {
      reactBodies.push(body);
      return graphFails
        ? new Response(JSON.stringify({ error: { message: "synthetic refusal", code: 100, error_subcode: 2018001 } }), { status: 400 })
        : new Response("{}");
    }
    // «Прочитано», профиль отправителя и прочее косметическое — пустой успех.
    return new Response(JSON.stringify({ id: "x", username: "synthetic_customer" }));
  }));
});
afterAll(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await instagram?.dispose();
});
beforeEach(() => { vi.clearAllMocks(); reactBodies.length = 0; graphFails = false; });

describe("Instagram: «Ок» после обещания звонка", () => {
  it("уходит реакция love на это сообщение; текста и смайлика отдельным сообщением нет; модель не звалась", async () => {
    const sender = `ack-ig-${runId}-a`, mid = `mid-ack-${runId}-a`;
    await seedConversation(sender);
    const body = igBody(sender, mid, "Ок");
    const res = await request(app).post("/api/v1/webhooks/meta").set("x-hub-signature-256", instagram.sign(body)).send(body);
    expect(res.status).toBe(200);
    await savedOk(sender, "Ок");
    await waitFor(async () => reactBodies.length > 0, { timeoutMs: 10_000, label: "реакция ушла" });
    expect(reactBodies).toEqual([{ recipient: { id: sender }, sender_action: "react", payload: { message_id: mid, reaction: "love" } }]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(callAi).not.toHaveBeenCalled();
  });

  it("Meta отказала в реакции — клиенту ничего не уходит (ни текста, ни смайлика), вебхук всё равно 200", async () => {
    graphFails = true;
    const sender = `ack-ig-${runId}-b`, mid = `mid-ack-${runId}-b`;
    await seedConversation(sender);
    const body = igBody(sender, mid, "Спасибо, до свидания");
    const res = await request(app).post("/api/v1/webhooks/meta").set("x-hub-signature-256", instagram.sign(body)).send(body);
    expect(res.status).toBe(200);
    await savedOk(sender, "Спасибо, до свидания");
    await waitFor(async () => reactBodies.length > 0, { timeoutMs: 10_000, label: "попытка реакции" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(callAi).not.toHaveBeenCalled();
  });
});
