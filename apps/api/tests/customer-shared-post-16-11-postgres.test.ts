import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture, reply } from "./helpers/customerCoreGoldenFixture.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { decodeCustomerOutboxPayload } from "../src/lib/customerOutbox.js";
import * as clientWaitingAlert from "../src/lib/clientWaitingAlert.js";
import { readCustomerPropertyVideoAnswer } from "../src/lib/customerPropertyVideoAnswer.js";
import { resetCustomerOwnBrandMarksCache } from "../src/lib/customerOwnBrandMarks.js";

// «Only leads» mode is led by the lead operator (ai/operator, stage 1.2 of 19.11.2026), which asks its own small understanding
// model once per turn. That call is not under test here, and the synthetic core fixture rejects any unscripted model call: the
// operator answers by its own fallback rules (the model-unavailable path).
vi.mock("../src/ai/operator/understand.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/ai/operator/understand.js")>();
  return { ...actual, understandTurn: (input: Parameters<typeof actual.understandTurn>[0], state: Parameters<typeof actual.understandTurn>[1],
    ctx: Parameters<typeof actual.understandTurn>[2]) => actual.understandTurn(input, state, ctx, async () => null) };
});
vi.mock("node:dns/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:dns/promises")>();
  return { ...original, default: { ...original.default, lookup: async (hostname: string, options: unknown) =>
    ["synthetic-core-cdn.invalid", "fixture.cdninstagram.com"].includes(hostname) ? [{ address: "93.184.216.34", family: 4 }] : original.default.lookup(hostname, options as never) } };
});

/**
 * Instagram, 16.11.2026 21:29–21:30 (Dushanbe), on a real database: a greeting, two pictures of our post (no caption,
 * no publication id from Meta), then «Хами хонара видеоша дорен». Plus every scenario of review #225 (17.11).
 * Real signed intake / FINAL / principal / outbox; only Meta, the CDN and the model are fixtures.
 */
let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { f = await createCustomerCoreGoldenFixture({ media: true }); resetCustomerOwnBrandMarksCache(); });
afterEach(() => { vi.restoreAllMocks(); f?.assertIoClean(); });
afterAll(async () => { await f?.cleanup(); });
const T = { timeout: 180_000 };
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4AAAAABJRU5ErkJggg==", "base64");
const perception = (readableText: string, subject = "other") => ({ functionCall: { name: "perceive_customer_media", id: "media-extraction",
  args: { language: "unknown", transcript: "", subject, visible: [], readableText, speech: "none" } } });
/** Our caption as our reels template prints it: company line with the public company phone, the card's fields, the number.
 * The synthetic public card has 2 rooms and 65 m². */
const ours = (shortId: number, rooms = 2) =>
  `✅Количество комнат: ${rooms}\n✅Площадь: 65м²\n✅Цена: 601 250 с.\n+992 44 650-14-14 Royal Home\nОбъект №${shortId}`;
const foreign = (shortId: number) => `agentstvo_dom.tj\n✅Количество комнат: 2\n📲 +992 90 123-45-67\nОбъект №${shortId}`;
const picture = (owner: Awaited<ReturnType<typeof f.owner>>) =>
  f.capture(owner, "", [{ type: "image", payload: { url: f.mediaFixture("image/png", image) } }]);
const conversationOf = async (eventKey: string) => {
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey }, select: { conversationId: true } });
  return prisma.botConversation.findUniqueOrThrow({ where: { id: ticket.conversationId! }, select: { customerPropertyFocus: true } });
};
const outText = async (eventKey: string) => {
  const parts = await prisma.customerOutboxPart.findMany({ where: { ticketEventKey: eventKey } });
  return parts.map(part => { const payload = decodeCustomerOutboxPayload(part); return payload.kind === "text" ? payload.text : ""; }).join("\n");
};
/** Pictures (each set aside for the next input), then the words; returns the words' event. */
async function burst(owner: Awaited<ReturnType<typeof f.owner>>, readable: string[], words: string, greeting = true) {
  const keys = [...(greeting ? [await f.capture(owner, "Салом Алейкум")] : [])];
  for (let i = 0; i < readable.length; i++) keys.push(await picture(owner));
  const question = await f.capture(owner, words);
  f.script(readable.map(text => [perception(text)]));
  for (const key of keys) expect(await consumeCustomerInboxTicket(key)).toEqual({ status: "held", reason: "newer_input_pending" });
  return question;
}
/** The model (not the server video answer) handles the words: one scripted model round, no video reply. */
async function expectModelPath(question: string) {
  f.script([[reply(["e0"])]]);
  await consumeCustomerInboxTicket(question);
  expect(await outText(question)).not.toMatch(/видео|ҳавола|Вот ссылка/iu);
}

it("16.11: answers about the object of the pictures with its published reel, in Tajik, without «which object?»", T, async () => {
  const { property } = await f.publicCard();
  await prisma.property.update({ where: { id: property.id }, data: { instagramUrl: "https://www.instagram.com/reel/FICTIONALREEL178/" } });
  const owner = await f.owner();
  const question = await burst(owner, ["royalhome · Видео", ours(property.shortId)], "Хами хонара видеоша дорен");
  const alert = vi.spyOn(clientWaitingAlert, "alertClientWaiting");
  const result = await f.deliver(question);
  expect(result.text).toBe(`Бале, видеои объекти №${property.shortId} ҳаст. Ин ҳавола: https://www.instagram.com/p/FICTIONALREEL178/`);
  expect(alert).not.toHaveBeenCalled();
  expect((await conversationOf(question)).customerPropertyFocus).toMatchObject({ status: "resolved", propertyId: property.id, eventKey: question });
});

it("M3: the bare Tajik phrase without a greeting is answered in Tajik", T, async () => {
  const { property } = await f.publicCard();
  await prisma.property.update({ where: { id: property.id }, data: { instagramUrl: "https://www.instagram.com/reel/FICTIONALREELM3/" } });
  const question = await burst(await f.owner(), [ours(property.shortId)], "Хами хонара видеоша дорен", false);
  expect((await f.deliver(question)).text).toMatch(/^Бале, видеои объекти/u);
});

const setLinks = (botCanSendLinks: boolean) => prisma.settings.upsert({ where: { id: "singleton" }, update: { botCanSendLinks }, create: { id: "singleton", botCanSendLinks } });

it("M4/N2: no reel, but the CRM card has a ready clip — «there is a video, the agent will send it», no CRM/token link, the agent is called", T, async () => {
  const previous = process.env.CRM_PUBLIC_URL; process.env.CRM_PUBLIC_URL = "https://crm.fictional.test";
  try {
    await setLinks(true);
    const { property } = await f.publicCard();
    await prisma.property.update({ where: { id: property.id }, data: { clipVideoStatus: "READY", clipVideoUrl: "/uploads/video/fictional-clip.mp4" } });
    const question = await burst(await f.owner(), [ours(property.shortId)], "Видео есть?");
    const alert = vi.spyOn(clientWaitingAlert, "alertClientWaiting").mockResolvedValue("agent");
    const result = await f.deliver(question);
    expect(result.text).toBe(`Да, видео объекта №${property.shortId} есть. Наш агент пришлёт его вам.`);
    expect(result.text).not.toMatch(/https?:|uploads|\?t=/u);
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(expect.objectContaining({ trigger: "follow_up" })));
  } finally { if (previous === undefined) delete process.env.CRM_PUBLIC_URL; else process.env.CRM_PUBLIC_URL = previous; }
});

it("N1: the company switch «bot may send links» governs the video answer — the one door, read from the CRM", T, async () => {
  const { property } = await f.publicCard();
  await prisma.property.update({ where: { id: property.id }, data: { instagramUrl: "https://www.instagram.com/reel/FICTIONALREELN1/" } });
  try {
    await setLinks(true);
    expect(await readCustomerPropertyVideoAnswer(property.id, "ru", "INSTAGRAM")).toEqual({ agentPromised: false,
      text: `Да, видео объекта №${property.shortId} есть. Вот ссылка: https://www.instagram.com/p/FICTIONALREELN1/` });
    await setLinks(false);
    const ru = await readCustomerPropertyVideoAnswer(property.id, "ru", "INSTAGRAM");
    expect(ru).toEqual({ agentPromised: true, text: `Да, видео объекта №${property.shortId} есть. Наш агент пришлёт его вам.` });
    const tg = await readCustomerPropertyVideoAnswer(property.id, "tg", "INSTAGRAM");
    expect(tg).toEqual({ agentPromised: true, text: `Бале, видеои объекти №${property.shortId} ҳаст. Агенти мо онро ба шумо мефиристад.` });
    expect(`${ru?.text}${tg?.text}`).not.toMatch(/https?:/u);
    // A price question beside it: the facts are rendered by the core door under the same switch, never a link from here.
    expect((await readCustomerPropertyVideoAnswer(property.id, "ru", "INSTAGRAM", ["price"]))?.text).not.toMatch(/instagram\.com/u);
  } finally { await setLinks(true); }
});

it("«Видео бор?» is answered in Tajik, on «шумо»", T, async () => {
  await setLinks(true);
  const { property } = await f.publicCard();
  await prisma.property.update({ where: { id: property.id }, data: { instagramUrl: "https://www.instagram.com/reel/FICTIONALREELTG/" } });
  const question = await burst(await f.owner(), [ours(property.shortId)], "Видео бор?", false);
  expect((await f.deliver(question)).text).toBe(`Бале, видеои объекти №${property.shortId} ҳаст. Ин ҳавола: https://www.instagram.com/p/FICTIONALREELTG/`);
});

it("no video in the CRM: «the agent will send it», and the agent is actually called", T, async () => {
  const { property } = await f.publicCard(); // a photo post (/p/), no clip
  const question = await burst(await f.owner(), [ours(property.shortId)], "Хами хонара видеоша дорен");
  const alert = vi.spyOn(clientWaitingAlert, "alertClientWaiting").mockResolvedValue("agent");
  expect((await f.deliver(question)).text).toBe(`Видеои объекти №${property.shortId}-ро агенти мо ба шумо мефиристад.`);
  await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(expect.objectContaining({ trigger: "follow_up" })));
});

it("M2: video + price in one message → both answered from the CRM", T, async () => {
  const { property } = await f.publicCard();
  await prisma.property.update({ where: { id: property.id }, data: { instagramUrl: "https://www.instagram.com/reel/FICTIONALREELM2/" } });
  const question = await burst(await f.owner(), [ours(property.shortId)], "Видео есть? И сколько стоит?");
  const text = (await f.deliver(question)).text;
  expect(text).toContain("https://www.instagram.com/p/FICTIONALREELM2/");
  expect(text).toContain("500 000");
});

it("H1: the customer's words are not a video request — the service marker of a picture does not make them one", T, async () => {
  const { property } = await f.publicCard();
  await prisma.property.update({ where: { id: property.id }, data: { instagramUrl: "https://www.instagram.com/reel/FICTIONALREELH1/" } });
  await expectModelPath(await burst(await f.owner(), [ours(property.shortId)], "Такой вариант есть?"));
});

it("M2: «видео не нужно» never gets a link", T, async () => {
  const { property } = await f.publicCard();
  await prisma.property.update({ where: { id: property.id }, data: { instagramUrl: "https://www.instagram.com/reel/FICTIONALREELNO/" } });
  await expectModelPath(await burst(await f.owner(), [ours(property.shortId)], "Видео не нужно, сколько комнат?"));
});

it("H2: an object of an earlier burst never answers a new picture that names nothing", T, async () => {
  const { property } = await f.publicCard();
  await prisma.property.update({ where: { id: property.id }, data: { instagramUrl: "https://www.instagram.com/reel/FICTIONALREELH2/" } });
  const owner = await f.owner();
  const first = await burst(owner, [ours(property.shortId)], "Видео есть?");
  expect((await f.deliver(first)).text).toContain("FICTIONALREELH2");
  // Later: another picture whose text names no object of ours, then the same words.
  const second = await burst(owner, ["квартира, вид из окна"], "Видео есть?", false);
  expect((await conversationOf(first)).customerPropertyFocus).toMatchObject({ status: "resolved", eventKey: first });
  await expectModelPath(second);
});

it("H3: «Объект №N» on a foreign agency's post is not our №N", T, async () => {
  const { property } = await f.publicCard();
  await prisma.property.update({ where: { id: property.id }, data: { instagramUrl: "https://www.instagram.com/reel/FICTIONALREELH3/" } });
  const question = await burst(await f.owner(), [foreign(property.shortId)], "Видео есть?");
  await expectModelPath(question);
  expect((await conversationOf(question)).customerPropertyFocus).not.toMatchObject({ status: "resolved" });
});

it("M1: our mark, but the card says 2 rooms and the picture 5 — not resolved", T, async () => {
  const { property } = await f.publicCard();
  const question = await burst(await f.owner(), [ours(property.shortId, 5)], "Видео есть?");
  await expectModelPath(question);
  expect((await conversationOf(question)).customerPropertyFocus).not.toMatchObject({ status: "resolved" });
});

it("two pictures of two of our objects: ambiguous, the model asks", T, async () => {
  const { property: a } = await f.publicCard(), { property: b } = await f.publicCard();
  const question = await burst(await f.owner(), [ours(a.shortId), ours(b.shortId)], "Видео есть?");
  await expectModelPath(question);
  expect((await conversationOf(question)).customerPropertyFocus).toMatchObject({ status: "ambiguous" });
});

it("a sold object: no video answer, the model handles it", T, async () => {
  const { property } = await f.publicCard();
  await prisma.property.update({ where: { id: property.id }, data: { status: "SOLD", instagramUrl: "https://www.instagram.com/reel/FICTIONALSOLD/" } });
  await expectModelPath(await burst(await f.owner(), [ours(property.shortId)], "Видео есть?"));
});

it("«only leads» mode on: the lead-only answer, never a video link", T, async () => {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botLeadOnlyMode: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: true } });
  try {
    const { property } = await f.publicCard();
    await prisma.property.update({ where: { id: property.id }, data: { instagramUrl: "https://www.instagram.com/reel/FICTIONALLEAD/" } });
    const question = await burst(await f.owner(), [ours(property.shortId)], "Видео есть?");
    await consumeCustomerInboxTicket(question);
    expect(await outText(question)).not.toMatch(/FICTIONALLEAD|ҳавола|Вот ссылка/iu);
  } finally { await prisma.settings.update({ where: { id: "singleton" }, data: settings }); }
});

it("a later object the customer names in his own words is not overridden by the earlier picture", T, async () => {
  const { property: shown } = await f.publicCard(), { property: named } = await f.publicCard();
  const question = await burst(await f.owner(), [ours(shown.shortId)], `А объект №${named.shortId} где находится?`, false);
  f.script([[reply(["e0"])]]);
  await consumeCustomerInboxTicket(question); // the model answer itself is not under test here
  expect((await conversationOf(question)).customerPropertyFocus).toMatchObject({ status: "resolved", propertyId: named.id });
});
