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

type PublicAttachmentFixture = {
  shortId: number; districtName: string; city: string; privateAddress: string; ownerContact: string;
};
function expectRecognizedPublicationReply(text: string, fixture: PublicAttachmentFixture) {
  // Independent test oracle: literal contract plus saved PUBLIC fixture fields,
  // never the production renderer/projector that this integration test exercises.
  const priceLine = `Цена объекта №${fixture.shortId}: 500 000 сомони.`;
  const locationLine = `Расположение: ${fixture.districtName}, ${fixture.city}.`;
  expect(text).toBe([priceLine, locationLine, "Что хотите узнать об этом объекте?"].join("\n"));
  expect(text).not.toContain(fixture.privateAddress);
  expect(text).not.toContain(fixture.ownerContact);
  // Only these exact known public lines may contain a public number such as992.
  // Keep the existing guard intact on everything else; no generic digit scrub.
  const residual = text.replace(priceLine, "").replace(locationLine, "");
  expect(residual).not.toMatch(/PRIVATE-OWNER|Какой объект|телефон|992|сотрудник/u);
}

it.each(["ig_reel", "image", "audio", "video", "file", "unsupported"])("%s without text is answered once through normal outbox without model/fallback/handover", async type => {
  const owner = await f.owner(), before = f.counts();
  const event = await f.capture(owner, "", [{ type, payload: { url: type === "ig_reel" ? "https://www.instagram.com/reel/Unknown123/" : "https://synthetic.invalid/unavailable" } }]);
  expect(await prepareCustomerDmInboxCoreContext(event)).toMatchObject({ status: "prepared" });
  const original = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  expect(original.originCiphertext).not.toBeNull();
  const result = await f.deliver(event);
  expect(result.text).toContain("?"); expect(result.text).not.toMatch(/992|сотрудник|записал|передал|ссылка не открылась|Вижу|прослушал/iu);
  if (type === "ig_reel") expect(result.text).toContain("публикации");
  const after = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  expect(after.payloadHash).toBe(original.payloadHash); expect(after.payloadCiphertext).toBe(original.payloadCiphertext);
  expect(after.order).toBe(original.order); expect(after.originCiphertext).toBe(original.originCiphertext);
  expect(f.counts()).toEqual(before);
  expect(await prisma.customerAction.count({ where: { inquiry: { conversationId: after.conversationId! } } })).toBe(0);
});

it.each([
  { name: "ordinary public facts", districtName: "Synthetic public district alpha", numericShortId: false },
  { name: "public district containing 992", districtName: "Synthetic public district 992", numericShortId: false },
  { name: "public shortId containing 992", districtName: "Synthetic public district beta", numericShortId: true },
])("uses actual facts for a recognized shared publication: $name", async ({ districtName, numericShortId }) => {
  const owner = await f.owner(), card = await f.publicCard(), before = f.counts();
  const district = await prisma.district.update({ where: { id: card.district.id }, data: { name: `${districtName}-${card.district.id}` } });
  const ownerContact = "+992000000777";
  // Reserve only a free synthetic ID; never reset the sequence or modify an
  // existing fixture merely to obtain a public number containing the digits.
  let shortId = card.property.shortId;
  if (numericShortId) {
    shortId = 1_992_000_000;
    for (let attempt = 0; attempt < 100; attempt++, shortId++) {
      if (!await prisma.property.findUnique({ where: { shortId }, select: { id: true } })) break;
      if (attempt === 99) throw new Error("Synthetic public shortId range is occupied");
    }
  }
  const property = await prisma.property.update({ where: { id: card.property.id }, data: { ownerContact, shortId } });
  const event = await f.capture(owner, "", [{ type: "ig_reel", payload: { url: property.instagramUrl! } }]);
  const prepared = await prepareCustomerDmInboxCoreContext(event);
  expect(prepared).toMatchObject({ status: "prepared", attachmentInput: { kinds: ["share"] }, attachmentPropertyReference: true });
  const result = await f.deliver(event);
  expectRecognizedPublicationReply(result.text, { shortId: property.shortId, districtName: district.name,
    city: district.city, privateAddress: property.address!, ownerContact });
  expect(f.counts()).toEqual(before);
});

it.each(["extra owner contact", "substituted private address"])("the recognized-publication oracle rejects %s", variant => {
  const fixture = { shortId: 123, districtName: "Synthetic public district alpha", city: "Душанбе",
    privateAddress: "Synthetic PRIVATE-OWNER-HOUSE-SENTINEL", ownerContact: "+992000000777" };
  const publicLines = [`Цена объекта №123: 500 000 сомони.`, `Расположение: ${fixture.districtName}, ${fixture.city}.`, "Что хотите узнать об этом объекте?"];
  const invalid = variant === "extra owner contact" ? `${publicLines.join("\n")}\n${fixture.ownerContact}`
    : [publicLines[0], `Расположение: ${fixture.privateAddress}.`, publicLines[2]].join("\n");
  expect(() => expectRecognizedPublicationReply(invalid, fixture)).toThrow();
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
