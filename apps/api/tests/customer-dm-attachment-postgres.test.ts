import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture, reply } from "./helpers/customerCoreGoldenFixture.js";
import { prepareCustomerDmInboxCoreContext } from "../src/lib/customerDmCoreContext.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";

// Genuine signed durable intake, real FINAL/lease/seal and P12/Graph receipt.
// Provider I/O only is synthetic; no forced principal or prepared mock.
let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { f = await createCustomerCoreGoldenFixture(); });
afterEach(() => { vi.restoreAllMocks(); f?.assertIoClean(); });
afterAll(async () => { await f?.cleanup(); });

it.each(["ig_reel", "image", "audio", "video", "file", "unsupported"])("%s without text is answered once through normal outbox without model/fallback/handover", async type => {
  const owner = await f.owner(), before = f.counts();
  const event = await f.capture(owner, "", [{ type, payload: { url: type === "ig_reel" ? "https://www.instagram.com/reel/Unknown123/" : "https://synthetic.invalid/unavailable" } }]);
  expect(await prepareCustomerDmInboxCoreContext(event)).toMatchObject({ status: "prepared" });
  const original = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  expect(original.originCiphertext).not.toBeNull();
  const result = await f.deliver(event);
  // An unknown reel is somebody else's publication (30.10.2026): one short line, not a question about it. An unopenable file gets a human sentence.
  if (type === "ig_reel") expect(result.text).toBe("Эта публикация не наша. Если ищете жильё, напишите, что нужно.");
  else if (type === "unsupported") expect(result.text).toBe("Вложение не открылось. Напишите текстом, что вас интересует.");
  else expect(result.text).toContain("?");
  expect(result.text).not.toMatch(/992|сотрудник|записал|передал|ссылка не открылась|Вижу|прослушал/iu);
  const after = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  expect(after.payloadHash).toBe(original.payloadHash); expect(after.payloadCiphertext).toBe(original.payloadCiphertext);
  expect(after.order).toBe(original.order); expect(after.originCiphertext).toBe(original.originCiphertext);
  expect(f.counts()).toEqual(before);
  expect(await prisma.customerAction.count({ where: { inquiry: { conversationId: after.conversationId! } } })).toBe(0);
});

it("uses actual facts for a recognized shared publication instead of asking for the same property again", async () => {
  const owner = await f.owner(), { property } = await f.publicCard(), before = f.counts();
  const event = await f.capture(owner, "", [{ type: "ig_reel", payload: { url: property.instagramUrl! } }]);
  const prepared = await prepareCustomerDmInboxCoreContext(event);
  expect(prepared).toMatchObject({ status: "prepared", attachmentInput: { kinds: ["share"] }, attachmentPropertyReference: true });
  const result = await f.deliver(event);
  expect(result.text).toContain(`Цена объекта №${property.shortId}: 500 000 сомони.`);
  expect(result.text).toContain("Что хотите узнать об этом объекте?");
  expect(result.text).not.toMatch(/PRIVATE-OWNER|Какой объект|телефон|992|сотрудник/u);
  expect(f.counts()).toEqual(before);
});

it("retains the actual customer's Tajik language for an attachment-only follow-up", async () => {
  const owner = await f.owner(); f.script([[reply([], "role")]]);
  await f.deliver(await f.capture(owner, "Салом, хона харидан мехоҳам"));
  const before = f.counts();
  const result = await f.deliver(await f.capture(owner, "", [{ type: "audio", payload: { url: "https://synthetic.invalid/voice" } }]));
  expect(result.text).toContain("Паёми овозиро гирифтам"); expect(result.text).not.toContain("Получил");
  expect(f.counts()).toEqual(before);
  const modelStart = f.bodies.length; f.script([[reply([], "budget")]]);
  await f.deliver(await f.capture(owner, "Хонаи дуҳуҷрагӣ мехоҳам"));
  const memory = JSON.stringify(f.bodies.slice(modelStart));
  expect(memory).toContain("incomingAttachments"); expect(memory).toContain("Паёми овозиро гирифтам");
  expect(memory).not.toContain("https://synthetic.invalid/voice");
});

it("keeps a real caption as the customer's current words rather than a file-failure placeholder", async () => {
  const owner = await f.owner(), caption = "Салом, хона харидан мехоҳам", start = f.bodies.length;
  f.script([[reply([], "budget")]]);
  const result = await f.deliver(await f.capture(owner, caption, [{ type: "unsupported", payload: {} }]));
  expect(result.text).not.toMatch(/содержимое|недоступно|не открылась|рақами телефон/iu);
  const body = f.bodies[start] as { contents: { parts: unknown[] }[] };
  expect(body.contents.at(-1)!.parts[0]).toEqual({ text: caption });
});

it("a native human pause still prevents an attachment clarification from sending", async () => {
  const owner = await f.owner(), before = f.counts();
  const event = await f.capture(owner, "", [{ type: "image", payload: { url: "https://synthetic.invalid/photo" } }]);
  const prepared = await prepareCustomerDmInboxCoreContext(event); expect(prepared.status).toBe("prepared");
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  await prisma.botConversation.update({ where: { id: ticket.conversationId! }, data: { pausedUntil: new Date(Date.now() + 60_000) } });
  expect(await consumeCustomerInboxTicket(event)).toMatchObject({ status: "held" });
  expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: event } })).toBe(0);
  expect(f.counts()).toEqual(before);
});

it.each(["image", "ig_reel"])("an unrelated %s never borrows property A merely because it was the previous focus", async type => {
  const owner = await f.owner(), { property } = await f.publicCard();
  f.script([[reply(["e0"])]]); await f.deliver(await f.capture(owner, `Какая цена объекта №${property.shortId}?`));
  const before = f.counts();
  const output = await f.deliver(await f.capture(owner, "", [{ type, payload: {
    url: type === "image" ? "https://synthetic.invalid/unrelated-photo" : "https://www.instagram.com/reel/NotInRegistry123/",
  } }]));
  expect(output.text).not.toMatch(/500 000|Цена объекта|Расположение|992/u);
  expect(f.counts()).toEqual(before);
});
