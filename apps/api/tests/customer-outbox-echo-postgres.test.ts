import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture, decision } from "./helpers/customerCoreGoldenFixture.js";
import { handleOutgoingEcho } from "../src/routes/webhooks.js";
import { isOwnCustomerOutboxEcho } from "../src/lib/customerOutboxEcho.js";

let fixture: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { fixture = await createCustomerCoreGoldenFixture(); });
afterAll(async () => { await fixture?.cleanup(); });

it("an actual core text echo arriving before the provider response does not pause its own conversation", async () => {
  const owner = await fixture.owner(), event = await fixture.capture(owner, "Здравствуйте");
  const fakeProvider = globalThis.fetch;
  let earlyEcho = false;
  vi.stubGlobal("fetch", async (raw: RequestInfo | URL, init?: RequestInit) => {
    const response = await fakeProvider(raw, init);
    const url = new URL(String(raw));
    if (init?.method === "POST" && url.origin === "https://synthetic-core-instagram.invalid" && url.pathname === "/v23.0/me/messages") {
      const body = JSON.parse(String(init.body)), receipt = await response.clone().json() as { message_id: string };
      const nativeBefore = await prisma.botConversation.findFirstOrThrow({ where: { accountId: owner.id, subscriberId: owner.peer } });
      const echo = { conversationId: nativeBefore.id, accountId: owner.id, channel: "INSTAGRAM", peer: owner.peer,
        text: body.message.text, messageId: receipt.message_id };
      for (const changed of [{ text: "Сообщение настоящего сотрудника" }, { text: "" }, { accountId: null },
        { peer: "other-customer" }, { channel: "FACEBOOK" }]) {
        expect(await isOwnCustomerOutboxEcho({ ...echo, ...changed })).toBe(false);
      }
      await handleOutgoingEcho({ channel: "INSTAGRAM", accountExternalId: owner.externalId,
        senderId: owner.peer, text: body.message.text, messageId: receipt.message_id });
      const native = await prisma.botConversation.findFirstOrThrow({ where: { accountId: owner.id, subscriberId: owner.peer } });
      expect(native.pausedUntil, "A pre-response echo of the managed outbox text must not become a 12-hour operator pause").toBeNull();
      earlyEcho = true;
    }
    return response;
  });
  try {
    fixture.script([[decision({ kind: "reply", refs: [], social: "greet", question: "none" })]]);
    await fixture.deliver(event); fixture.assertIoClean(); expect(earlyEcho).toBe(true);
  } finally { vi.stubGlobal("fetch", fakeProvider); }
});

it("a real different staff response still pauses the bot after an accepted core answer", async () => {
  const owner = await fixture.owner(), event = await fixture.capture(owner, "Здравствуйте");
  fixture.script([[decision({ kind: "reply", refs: [], social: "greet", question: "none" })]]);
  await fixture.deliver(event); fixture.assertIoClean();
  const native = await prisma.botConversation.findFirstOrThrow({ where: { accountId: owner.id, subscriberId: owner.peer } });
  expect(await isOwnCustomerOutboxEcho({ conversationId: native.id, accountId: owner.id, channel: "INSTAGRAM", peer: owner.peer,
    text: "Я сотрудник, отвечаю лично", messageId: "synthetic-real-staff-mid" })).toBe(false);
  await handleOutgoingEcho({ channel: "INSTAGRAM", accountExternalId: owner.externalId, senderId: owner.peer,
    text: "Я сотрудник, отвечаю лично", messageId: "synthetic-real-staff-mid" });
  expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: native.id } })).pausedUntil!.getTime()).toBeGreaterThan(Date.now());
});
