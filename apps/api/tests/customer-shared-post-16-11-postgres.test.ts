import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture, reply } from "./helpers/customerCoreGoldenFixture.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import * as clientWaitingAlert from "../src/lib/clientWaitingAlert.js";

vi.mock("node:dns/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:dns/promises")>();
  return { ...original, default: { ...original.default, lookup: async (hostname: string, options: unknown) =>
    ["synthetic-core-cdn.invalid", "fixture.cdninstagram.com"].includes(hostname) ? [{ address: "93.184.216.34", family: 4 }] : original.default.lookup(hostname, options as never) } };
});

/**
 * Instagram, 16.11.2026 21:29–21:30 (Dushanbe), on a real database: two image attachments of our post (no caption, no
 * publication id from Meta), then «Хами хонара видеоша дорен» seconds later. Both picture turns are set aside for the
 * newer words; before the fix their «Объект №N» never reached the answer and the bot asked «which object?».
 * Real signed intake / FINAL / principal / outbox; only Meta, the CDN and the model perception are fixtures.
 */
let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { f = await createCustomerCoreGoldenFixture({ media: true }); });
afterEach(() => { vi.restoreAllMocks(); f?.assertIoClean(); });
afterAll(async () => { await f?.cleanup(); });
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4AAAAABJRU5ErkJggg==", "base64");
const perception = (readableText: string) => ({ functionCall: { name: "perceive_customer_media", id: "media-extraction",
  args: { language: "unknown", transcript: "", subject: "other", visible: [], readableText, speech: "none" } } });
const caption = (shortId: number) => `royalhome\n✅Район: Исмоили Сомони\n✅Цена: 601 250 с. ($65 000)\n+992 00 000-00-01 Агент Тестовая\nОбъект №${shortId}`;

async function sharedPostThenVideoQuestion(shortId: number) {
  const owner = await f.owner();
  // The same order as on 16.11: a greeting, two pictures of the post, the question — each a separate Meta event seconds apart.
  const greeting = await f.capture(owner, "Салом Алейкум");
  const first = await f.capture(owner, "", [{ type: "image", payload: { url: f.mediaFixture("image/png", image) } }]);
  const second = await f.capture(owner, "", [{ type: "image", payload: { url: f.mediaFixture("image/png", image) } }]);
  const question = await f.capture(owner, "Хами хонара видеоша дорен");
  f.script([[perception("royalhome · Видео")], [perception(caption(shortId))]]);
  expect(await consumeCustomerInboxTicket(greeting)).toEqual({ status: "held", reason: "newer_input_pending" });
  expect(await consumeCustomerInboxTicket(first)).toEqual({ status: "held", reason: "newer_input_pending" });
  expect(await consumeCustomerInboxTicket(second)).toEqual({ status: "held", reason: "newer_input_pending" });
  return question;
}

it("answers about the object of the shared post with its published reel, without asking «which object?»", { timeout: 120_000 }, async () => {
  const { property } = await f.publicCard();
  await prisma.property.update({ where: { id: property.id }, data: { instagramUrl: "https://www.instagram.com/reel/FICTIONALREEL178/" } });
  const question = await sharedPostThenVideoQuestion(property.shortId);
  const alert = vi.spyOn(clientWaitingAlert, "alertClientWaiting");
  const result = await f.deliver(question);
  expect(result.text).toBe(`Бале, видеои объекти №${property.shortId} ҳаст. Ин ҳавола: https://www.instagram.com/p/FICTIONALREEL178/`);
  expect(result.text).not.toMatch(/кадом объект|Рақами объект/iu);
  expect(alert).not.toHaveBeenCalled();
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: question }, select: { conversationId: true } });
  const conversation = await prisma.botConversation.findUniqueOrThrow({ where: { id: ticket.conversationId! }, select: { customerPropertyFocus: true } });
  expect(conversation.customerPropertyFocus).toMatchObject({ status: "resolved", propertyId: property.id, eventKey: question,
    evidence: [{ kind: "public_selector", origin: "message", reference: `short:${property.shortId}` }] });
});

it("without a video in the CRM it says the agent will send it, and the agent is actually called", { timeout: 120_000 }, async () => {
  const { property } = await f.publicCard(); // a photo post (/p/), no reel
  const question = await sharedPostThenVideoQuestion(property.shortId);
  const alert = vi.spyOn(clientWaitingAlert, "alertClientWaiting").mockResolvedValue("agent");
  const result = await f.deliver(question);
  expect(result.text).toBe(`Видеои объекти №${property.shortId}-ро агенти мо ба шумо мефиристад.`);
  await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(expect.objectContaining({ trigger: "follow_up" })));
});

it("a later object the customer names in his own words is not overridden by the earlier picture", { timeout: 120_000 }, async () => {
  const { property: shown } = await f.publicCard(), { property: named } = await f.publicCard();
  const owner = await f.owner();
  const picture = await f.capture(owner, "", [{ type: "image", payload: { url: f.mediaFixture("image/png", image) } }]);
  const words = await f.capture(owner, `А объект №${named.shortId} где находится?`);
  f.script([[perception(caption(shown.shortId))], [reply(["e0"])]]);
  expect(await consumeCustomerInboxTicket(picture)).toEqual({ status: "held", reason: "newer_input_pending" });
  await consumeCustomerInboxTicket(words); // the model answer itself is not under test here
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: words }, select: { conversationId: true } });
  const conversation = await prisma.botConversation.findUniqueOrThrow({ where: { id: ticket.conversationId! }, select: { customerPropertyFocus: true } });
  expect(conversation.customerPropertyFocus).toMatchObject({ status: "resolved", propertyId: named.id });
});
