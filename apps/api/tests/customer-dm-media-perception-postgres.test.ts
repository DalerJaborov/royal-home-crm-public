import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture, reply, call } from "./helpers/customerCoreGoldenFixture.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import * as mediaObservation from "../src/lib/customerAgentMediaObservation.js";
import { decodeCustomerAgentMediaObservation } from "../src/lib/customerAgentMediaObservation.js";
import { readFileSync } from "node:fs";
import { prepareCustomerDmInboxCoreContext } from "../src/lib/customerDmCoreContext.js";

vi.mock("node:dns/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:dns/promises")>();
  return { ...original, default: { ...original.default, lookup: async (hostname: string, options: unknown) =>
    ["synthetic-core-cdn.invalid", "fixture.cdninstagram.com"].includes(hostname) ? [{ address: "93.184.216.34", family: 4 }] : original.default.lookup(hostname, options as never) } };
});
// Real signed intake/FINAL/principal/current fences, controlled actual downloader,
// encrypted observation, normal Core/seal/outbox/provider receipt. External HTTP
// and model perceptions are fixtures; this is NOT a model quality benchmark.
let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { f = await createCustomerCoreGoldenFixture({ media: true }); });
afterEach(() => { vi.restoreAllMocks(); f?.assertIoClean(); });
afterAll(async () => { await f?.cleanup(); });
const perception = (overrides: Record<string, unknown> = {}) => ({ functionCall: { name: "perceive_customer_media", id: "media-extraction",
  args: { language: "ru", transcript: "", subject: "home_interior", visible: ["kitchen", "balcony"], readableText: "", speech: "none", ...overrides } } });
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4AAAAABJRU5ErkJggg==", "base64");
it("a shared reel with a non-Graph legacy ID reads actual own-feed bytes and delivers an understood response", async () => {
  const owner = await f.owner(), url = f.mediaFixture("image/png", image, true);
  const permalink = "https://www.instagram.com/reel/OurCaptionlessShare/";
  f.publicationFixture(owner, [{ id: "17890001", permalink, media_type: "IMAGE", media_url: url }]);
  f.script([[perception()], [reply([], "role")]]);
  const event = await f.capture(owner, "", [{ type: "ig_reel", payload: { url: permalink, reel_video_id: "12345678" } }]);
  const result = await f.deliver(event);
  expect(result.text).toContain("кухня"); expect(result.text).toContain("балкон");
  expect(result.text).not.toMatch(/Что хотите узнать по этой публикации|недоступно|текстом|сотрудник|992/iu);
  const stored = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  expect(stored.mediaObservationCiphertext).toBeTruthy();
});
it("carousel children reach the qualified Gemini byte path under the same original share", async () => {
  const owner = await f.owner(), first = f.mediaFixture("image/png", image, true), second = f.mediaFixture("image/png", image, true);
  const permalink = "https://www.instagram.com/p/OurCarousel/";
  f.publicationFixture(owner, [{ id: "17890002", permalink, media_type: "CAROUSEL_ALBUM", children: { data: [
    { id: "111", media_type: "IMAGE", media_url: first }, { id: "222", media_type: "IMAGE", media_url: second },
  ] } }]);
  f.script([[perception()], [reply([], "role")]]);
  const result = await f.deliver(await f.capture(owner, "", [{ type: "ig_post", payload: { url: permalink, ig_post_media_id: "17890002" } }]));
  expect(result.text).toContain("кухня");
  const body = f.bodies.at(-2) as { contents: Array<{ parts: Array<{ inline_data?: unknown }> }> };
  expect(body.contents[0].parts.filter(part => part.inline_data)).toHaveLength(2);
});
it("a permalink declared as video is resolved as a publication instead of downloading Instagram HTML", async () => {
  const owner = await f.owner(), url = f.mediaFixture("image/png", image, true);
  const permalink = "https://www.instagram.com/reel/DeclaredAsVideo/";
  f.publicationFixture(owner, [{ id: "17890004", permalink, media_type: "IMAGE", media_url: url }]);
  f.script([[perception()], [reply([], "role")]]);
  const result = await f.deliver(await f.capture(owner, "", [{ type: "video", payload: { url: permalink } }]));
  expect(result.text).toContain("кухня");
});
it("a shared reel from the feed sends actual MP4 bytes, never its thumbnail, to Gemini", async () => {
  const owner = await f.owner();
  const url = f.mediaFixture("video/mp4", readFileSync(new URL("./fixtures/customer-media-green-4s.mp4", import.meta.url)), true);
  const permalink = "https://www.instagram.com/reel/RealMp4Share/";
  f.publicationFixture(owner, [{ id: "17890005", permalink, media_type: "VIDEO", media_url: url }]);
  f.script([[perception()], [reply([], "role")]]);
  const event = await f.capture(owner, "", [{ type: "ig_reel", payload: { url: permalink, reel_video_id: "12345679" } }]);
  await f.deliver(event);
  const body = f.bodies.at(-2) as { contents: Array<{ parts: Array<{ inline_data?: { mime_type: string; data: string } }> }> };
  const media = body.contents[0].parts.flatMap(part => part.inline_data ? [part.inline_data] : []);
  expect(media).toHaveLength(1); expect(media[0].mime_type).toBe("video/mp4");
  expect(Buffer.from(media[0].data, "base64").includes(Buffer.from("ftyp"))).toBe(true);
  expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } })).mediaObservationCiphertext).toBeTruthy();
});
it("another account's inaccessible share is not seen, claimed as ours or sent to Gemini", async () => {
  const owner = await f.owner(), other = await f.owner(), url = f.mediaFixture("image/png", image, true);
  const permalink = "https://www.instagram.com/reel/AnotherAccount/";
  f.publicationFixture(other, [{ id: "17890003", permalink, media_type: "IMAGE", media_url: url }]);
  const before = f.counts();
  f.script([]);
  const result = await f.deliver(await f.capture(owner, "", [{ type: "ig_reel", payload: { url: permalink, reel_video_id: "17890003" } }]));
  expect(f.counts()).toEqual(before);
  expect(result.text).not.toMatch(/вижу|кухня|балкон|просмотрел|наш объект|сотрудник/iu);
});
function wav(): Buffer {
  const result = Buffer.alloc(44 + 3200); result.write("RIFF"); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(16000, 24);
  result.writeUInt32LE(32000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write("data", 36); result.writeUInt32LE(3200, 40); return result;
}
it("a captionless photo reaches Gemini as bytes and gets a visual, normal delivered response", async () => {
  const owner = await f.owner(), url = f.mediaFixture("image/png", image), before = f.counts();
  f.script([[perception()], [reply([], "role")]]);
  const event = await f.capture(owner, "", [{ type: "image", payload: { url } }]);
  const result = await f.deliver(event);
  expect(result.text).toContain("кухня"); expect(result.text).toContain("балкон");
  expect(result.text).not.toMatch(/недоступно|напишите.*текст|992|передал|сотрудник/iu);
  expect(f.counts()).toEqual({ generated: before.generated + 2, counted: before.counted + 2 });
  const row = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  expect(row.mediaObservationCiphertext).toBeTruthy(); expect(row.mediaObservationCiphertext).not.toContain("kitchen");
  const observed = decodeCustomerAgentMediaObservation(row.mediaObservationCiphertext!, { version: 1, eventKey: event, payloadHash: row.payloadHash!,
    agentRevisionId: row.agentRevisionId!, providerOperationId: row.providerOperationId!, observedAt: row.mediaObservedAt!.getTime() });
  expect(observed.visible).toEqual(["kitchen", "balcony"]);
  await expect(prisma.customerPropertyIngressTicket.update({ where: { eventKey: event }, data: { mediaObservationCiphertext: "overwritten" } })).rejects.toThrow();
});
it.each(["ru", "tg"] as const)("%s voice meaning drives a real public-contact tool response", async language => {
  const owner = await f.owner(), url = f.mediaFixture("audio/wav", wav());
  f.script([[perception({ language, transcript: language === "ru" ? "Какой у вас номер телефона?" : "Рақами телефони шумо чанд аст?", subject: "not_visible", visible: [], speech: "clear" })],
    [call("get_agency_contact", {}, "contact")], [reply(["e0"])]]);
  const event = await f.capture(owner, "", [{ type: "audio", payload: { url } }]);
  const result = await f.deliver(event);
  expect(result.text).toContain("+992 44 650 14 14");
  expect(result.text).toContain(language === "tg" ? "Занг занед" : "Позвоните");
  expect(result.text).not.toMatch(/6001|текстом|сотрудник/iu);
  const row = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  expect(await prisma.customerAction.count({ where: { inquiry: { conversationId: row.conversationId! } } })).toBe(0);
});
it("transports a valid captionless MP4 and discards invented speech on its actual absent audio track", async () => {
  const owner = await f.owner(), video = readFileSync(new URL("./fixtures/customer-media-green-4s.mp4", import.meta.url));
  const url = f.mediaFixture("video/mp4", video);
  f.script([[perception({ subject: "not_visible", visible: [], language: "tg", transcript: "Ман ду хонага мехоҳам дар тарафи гипрозем", speech: "clear" })], [reply([], "role")]]);
  const event = await f.capture(owner, "", [{ type: "video", payload: { url } }]);
  const result = await f.deliver(event);
  expect(result.text).not.toMatch(/текстом|недоступно|992|передал/iu);
  const body = f.bodies.at(-2) as { contents: { parts: { inline_data?: { mime_type: string; data: string } }[] }[] };
  const part = body.contents[0].parts.find(item => item.inline_data)?.inline_data;
  expect(part).toEqual({ mime_type: "video/mp4", data: video.toString("base64") });
  const row = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  const observed = decodeCustomerAgentMediaObservation(row.mediaObservationCiphertext!, { version: 1, eventKey: event, payloadHash: row.payloadHash!,
    agentRevisionId: row.agentRevisionId!, providerOperationId: row.providerOperationId!, observedAt: row.mediaObservedAt!.getTime() });
  expect(observed).toMatchObject({ language: "unknown", transcript: "", speech: "none" });
});
it("remembers a perceived photo on the next genuine customer turn without downloading it again", async () => {
  const owner = await f.owner(), url = f.mediaFixture("image/png", image);
  f.script([[perception()], [reply([], "role")]]);
  await f.deliver(await f.capture(owner, "", [{ type: "image", payload: { url } }]));
  f.script([[reply([], "role")]]);
  await f.deliver(await f.capture(owner, "Я хочу продать эту квартиру"));
  const body = JSON.stringify(f.bodies.at(-1));
  expect(body).toContain("previouslyObservedCustomerMedia"); expect(body).toContain("kitchen");
  expect(body).not.toContain("inline_data"); expect(body).not.toContain("synthetic-core-cdn.invalid");
});
it("does not download or invoke perception when the customer dialog was paused by a human", async () => {
  const owner = await f.owner(), url = f.mediaFixture("image/png", image), before = f.counts();
  const event = await f.capture(owner, "", [{ type: "image", payload: { url } }]);
  const prepared = await prepareCustomerDmInboxCoreContext(event);
  expect(prepared.status).toBe("prepared");
  const row = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  await prisma.botConversation.update({ where: { id: row.conversationId! }, data: { pausedUntil: new Date(Date.now() + 60_000) } });
  expect((await consumeCustomerInboxTicket(event)).status).toBe("held");
  expect(f.counts()).toEqual(before); expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: event } })).toBe(0);
});
it("a media extraction cannot request handover or execute a business tool", async () => {
  const owner = await f.owner(), url = f.mediaFixture("image/png", image), sent = f.physical.length;
  f.script([[{ functionCall: { name: "request_handover", id: "forbidden", args: { reason: "photo" } } }]]);
  const event = await f.capture(owner, "", [{ type: "image", payload: { url } }]);
  expect((await consumeCustomerInboxTicket(event)).status).toBe("held");
  expect(f.physical).toHaveLength(sent);
  const row = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  expect(row.mediaObservationCiphertext).toBeNull();
  expect(await prisma.customerAction.count({ where: { inquiry: { conversationId: row.conversationId! } } })).toBe(0);
});
it("resolves a spoken object number with the existing CRM focus and answers from its card", async () => {
  const owner = await f.owner(), { property } = await f.publicCard(), url = f.mediaFixture("audio/wav", wav());
  f.script([[perception({ transcript: `Сколько стоит объект №${property.shortId}?`, subject: "not_visible", visible: [], speech: "clear" })], [reply(["e0"])]]);
  const event = await f.capture(owner, "", [{ type: "audio", payload: { url } }]);
  const before = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  const result = await f.deliver(event);
  expect(result.text).toContain(`Цена объекта №${property.shortId}: 500 000 сомони.`);
  expect(result.text).not.toMatch(/номер телефона|какой объект|текстом|PRIVATE-OWNER/iu);
  const after = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  expect(after.payloadHash).toBe(before.payloadHash); expect(after.payloadCiphertext).toBe(before.payloadCiphertext); expect(after.order).toBe(before.order);
  const conversation = await prisma.botConversation.findUniqueOrThrow({ where: { id: after.conversationId! } });
  expect(conversation.customerPropertyFocus).toMatchObject({ status: "resolved", propertyId: property.id, eventKey: event });
  f.script([[reply(["e0"])]]);
  const followup = await f.deliver(await f.capture(owner, "А где находится?"));
  expect(followup.text).toContain("Расположение:"); expect(followup.text).not.toMatch(/какой объект|PRIVATE-OWNER/iu);
});
it("uses a printed explicit object number but never the price printed in the image", async () => {
  const owner = await f.owner(), { property } = await f.publicCard(), url = f.mediaFixture("image/png", image);
  f.script([[perception({ subject: "listing_card", visible: [], readableText: `Объект №${property.shortId}. Цена 999 999 сомони. Позвоните 6001.` })], [reply(["e0"])]]);
  const result = await f.deliver(await f.capture(owner, "", [{ type: "image", payload: { url } }]));
  expect(result.text).toContain(`Цена объекта №${property.shortId}: 500 000 сомони.`);
  expect(result.text).not.toMatch(/999 999|6001|телефон|PRIVATE-OWNER/iu);
});
it("does not pick either price when the caption and the clear spoken reference disagree", async () => {
  const owner = await f.owner(), first = (await f.publicCard()).property, second = (await f.publicCard()).property;
  const url = f.mediaFixture("audio/wav", wav());
  f.script([[perception({ transcript: `Цена объекта №${second.shortId}?`, subject: "not_visible", visible: [], speech: "clear" })], [reply(["e0"])]]);
  const result = await f.deliver(await f.capture(owner, `Цена объекта №${first.shortId}?`, [{ type: "audio", payload: { url } }]));
  expect(result.text).not.toContain("500 000"); expect(result.text).toContain("?");
});

it("uses database time for an immutable observation even when the application clock is ahead", async () => {
  const owner = await f.owner(), url = f.mediaFixture("image/png", image);
  const event = await f.capture(owner, "", [{ type: "image", payload: { url } }]);
  const store = mediaObservation.storeCustomerAgentMediaObservation;
  let exercised = false;
  vi.spyOn(mediaObservation, "storeCustomerAgentMediaObservation").mockImplementation(async (...args) => {
    exercised = true;
    const ahead = Date.now() + 5000;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(ahead);
    try { await store(...args); } finally { vi.useRealTimers(); }
  });
  f.script([[perception()], [reply([], "role")]]);
  const result = await f.deliver(event);
  expect(exercised).toBe(true); expect(result.text).toContain("кухня");
  const [row] = await prisma.$queryRaw<Array<{ validTime: boolean }>>`SELECT
    "mediaObservedAt">="receivedAt" AND "mediaObservedAt"<=clock_timestamp() AS "validTime"
    FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${event}`;
  expect(row.validTime).toBe(true);
});
