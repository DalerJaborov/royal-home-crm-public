import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture, decision } from "./helpers/customerCoreGoldenFixture.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { hasNewerCustomerInboxInput } from "../src/lib/customerNewerInboxInput.js";
import { decryptCustomerIngressEnvelope } from "../src/lib/customerIngressPayload.js";

vi.mock("node:dns/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:dns/promises")>();
  return { ...original, default: { ...original.default, lookup: async (hostname: string, options: unknown) =>
    hostname === "synthetic-core-cdn.invalid" ? [{ address: "93.184.216.34", family: 4 }] : original.default.lookup(hostname, options as never) } };
});
let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { f = await createCustomerCoreGoldenFixture({ media: true, publicEnvelope: true }); });
afterEach(() => { f?.assertIoClean(); });
afterAll(async () => { await f?.cleanup(); });
it("a genuine settings-secret signed caption stops the older media reply before FINAL without accepting it or granting an action", async () => {
  const owner = await f.owner(), image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4AAAAABJRU5ErkJggg==", "base64");
  const url = f.mediaFixture("image/png", image);
  const first = await f.capture(owner, "", [{ type: "image", payload: { url } }]);
  const caption = await f.capture(owner, "Что на фото?");
  const stored = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: caption } });
  const envelope = decryptCustomerIngressEnvelope({ version: 1, eventKey: caption, order: stored.order.toString(),
    scopeKey: stored.scopeKey, endpointScopeId: stored.endpointScopeId!, payloadHash: stored.payloadHash! }, stored.payloadCiphertext!);
  expect(envelope.verification).toMatchObject({ provenance: "meta_signature", assurance: "public_envelope", issuerSource: "verified_public_envelope" });
  expect(envelope.verification.verifierCredential?.source).toBe("settings_meta_ig_app_secret");
  expect(stored.inputRecordedAt).toBeNull();
  // The observation is read-only even on the actual DB path, not a FINAL grant.
  expect(await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return hasNewerCustomerInboxInput(first, tx);
  })).toBe(true);
  expect(await hasNewerCustomerInboxInput(caption)).toBe(false);
  f.script([[{ functionCall: { name: "perceive_customer_media", id: "image", args: {
    language: "unknown", transcript: "", subject: "home_interior", visible: ["kitchen"], readableText: "SYNTHETIC_PRIVATE_OCR_SENTINEL", speech: "none" } } }],
  [decision({ kind: "reply", refs: [], social: "acknowledge", question: "none" })]]);
  expect(await consumeCustomerInboxTicket(first)).toEqual({ status: "held", reason: "newer_input_pending" });
  expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: first } })).toBe(0);
  const before = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: caption } });
  expect(before.inputRecordedAt).toBeNull();
  const reply = await f.deliver(caption);
  expect(reply.text).toContain("кухня"); expect(f.physical).toEqual([reply.text]);
  expect(JSON.stringify(f.bodies.at(-1))).not.toContain("SYNTHETIC_PRIVATE_OCR_SENTINEL");
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: caption } });
  expect(await prisma.customerAction.count({ where: { inquiry: { conversationId: ticket.conversationId! } } })).toBe(0);
});
it("does not reuse an already answered image as current media in public-envelope history", async () => {
  const owner = await f.owner(), url = f.mediaFixture("image/png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4AAAAABJRU5ErkJggg==", "base64"));
  const first = await f.capture(owner, "", [{ type: "image", payload: { url } }]);
  f.script([[{ functionCall: { name: "perceive_customer_media", id: "image", args: {
    language: "unknown", transcript: "", subject: "home_interior", visible: ["kitchen"], readableText: "", speech: "none" } } }],
  [decision({ kind: "reply", refs: [], social: "acknowledge", question: "none" })]]);
  expect((await f.deliver(first)).text).toContain("кухня");
  const next = await f.capture(owner, "Спасибо");
  f.script([[decision({ kind: "reply", refs: [], social: "thank", question: "none" })]]);
  expect((await f.deliver(next)).text).not.toContain("кухня");
});
it("does not reach past an intervening message for visual content", async () => {
  const owner = await f.owner(), url = f.mediaFixture("image/png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4AAAAABJRU5ErkJggg==", "base64"));
  const first = await f.capture(owner, "", [{ type: "image", payload: { url } }]);
  const middle = await f.capture(owner, "Забудьте, другой вопрос");
  const last = await f.capture(owner, "Спасибо");
  f.script([[{ functionCall: { name: "perceive_customer_media", id: "image", args: {
    language: "unknown", transcript: "", subject: "home_interior", visible: ["kitchen"], readableText: "", speech: "none" } } }]]);
  expect(await consumeCustomerInboxTicket(first)).toEqual({ status: "held", reason: "newer_input_pending" });
  expect(await consumeCustomerInboxTicket(middle)).toEqual({ status: "held", reason: "newer_input_pending" });
  f.script([[decision({ kind: "reply", refs: [], social: "thank", question: "none" })]]);
  expect((await f.deliver(last)).text).not.toContain("кухня");
});
it("a newer signed message in another installed account does not supersede this customer's last input", async () => {
  const original = await f.capture(await f.owner(), "Сколько стоит?");
  const separate = await f.capture(await f.owner(), "Можно подробнее?");
  expect(await hasNewerCustomerInboxInput(original)).toBe(false);
  expect(await hasNewerCustomerInboxInput(separate)).toBe(false);
});
