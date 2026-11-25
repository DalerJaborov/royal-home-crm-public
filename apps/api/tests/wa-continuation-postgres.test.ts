import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { LEAD_ONLY_DEFAULTS } from "../src/ai/leadOnlyMode.js";
import { initialOperatorState } from "../src/ai/operator/decide.js";
import { serializeOperatorState } from "../src/ai/operator/state.js";
import { OPERATOR_CONTACT_BUTTON_TEXTS } from "../src/ai/operator/phrases.js";
import { persistCustomerLeadOnlyExtrasTx, planCustomerLeadOnlyTurn } from "../src/lib/customerLeadOnlyCore.js";
import { runWhatsappContinuationLink, WHATSAPP_CONTINUATION_LINK_JOB, WHATSAPP_CONTINUATION_TTL_MS } from "../src/lib/whatsappContinuation.js";
import { contactButtonKindOfBody, loadContactButtonPolicy, noteContactButtonRejection } from "../src/lib/contactButtonPolicy.js";
import { buildSendRequest } from "../src/messengers/meta.js";
import type { MetaCredentials } from "../src/messengers/metaTypes.js";

/**
 * КНОПКА ЗВОНКА В WHATSAPP И ПРОДОЛЖЕНИЕ ИЗ INSTAGRAM НА НАСТОЯЩЕЙ БАЗЕ (владелец 25.11.2026): ход оператора ядра
 * (lib/customerLeadOnlyCore.ts::planCustomerLeadOnlyTurn) с запасными правилами понимания (модель — null), рубильники и
 * готовность звонков из Настроек, выдача и гашение кода, связь переписок с одной карточкой.
 */
const config = { ...LEAD_ONLY_DEFAULTS, enabled: true, workHoursStart: "00:00", workHoursEnd: "24:00" };
const conversations: string[] = [], clients: string[] = [], eventKeys: string[] = [];
let settingsBefore: Record<string, unknown>;
let waCounter = Math.floor(Math.random() * 900000);

const eventKey = () => { const key = randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64); eventKeys.push(key); return key; };
async function conversation(channel: "WHATSAPP" | "INSTAGRAM", extra: { clientId?: string; leadOnlyPending?: unknown } = {}) {
  const subscriberId = channel === "WHATSAPP" ? `992917${String(++waCounter).padStart(6, "0")}` : `ig-cont-${randomUUID()}`;
  const row = await prisma.botConversation.create({ data: { channel, subscriberId, messages: [], ...(extra.clientId ? { clientId: extra.clientId } : {}),
    ...(extra.leadOnlyPending ? { leadOnlyPending: extra.leadOnlyPending as object } : {}) } });
  conversations.push(row.id);
  return row;
}
const turn = (channel: "WHATSAPP" | "INSTAGRAM", conv: { id: string; subscriberId: string }, inputText: string) =>
  planCustomerLeadOnlyTurn({ config, channel, peer: conv.subscriberId, conversationId: conv.id, eventKey: eventKey(), inputText,
    focusPropertyId: null, turns: [], model: async () => null });
async function settings(patch: Record<string, unknown>) { await prisma.settings.update({ where: { id: "singleton" }, data: patch }); }
async function codeFor(sourceConversationId: string, patch: Record<string, unknown> = {}) {
  const code = `RH-${["2", "3", "4", "5", "6", "7", "8", "9"][Math.floor(Math.random() * 8)]}${randomUUID().replace(/[^A-HJKMNP-Z2-9]/giu, "").toUpperCase().slice(0, 5).padEnd(5, "Z")}`;
  await prisma.whatsappContinuationCode.create({ data: { code, sourceConversationId, sourceChannel: "INSTAGRAM",
    expiresAt: new Date(Date.now() + WHATSAPP_CONTINUATION_TTL_MS), ...patch } });
  return code;
}
const buyerInInstagram = () => serializeOperatorState({ ...initialOperatorState(), role: "buyer", step: "details", language: "ru",
  asked: { role: 1, details: 1, phone: 1 }, spoken: { ask_role: 1, role_details_buyer: 1 } }, new Date());

beforeAll(async () => {
  const row = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botWaCallButton: true, botIgWhatsappLink: true,
    metaWaDisplayPhone: true, waCallingReadyAt: true, workHoursStart: true, workHoursEnd: true } });
  settingsBefore = row;
  await settings({ botWaCallButton: true, botIgWhatsappLink: true, metaWaDisplayPhone: "992446501414", waCallingReadyAt: new Date(),
    workHoursStart: "00:00", workHoursEnd: "23:59" });
});
afterAll(async () => {
  await settings(settingsBefore);
  await prisma.backgroundJob.deleteMany({ where: { OR: eventKeys.map(key => ({ dedupeKey: { endsWith: key } })) } });
  await prisma.whatsappContinuationCode.deleteMany({ where: { sourceConversationId: { in: conversations } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversations } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
});

describe("кнопка «Позвонить» в WhatsApp", () => {
  it("просьба связаться — ответ оператора и кнопка звонка", async () => {
    const plan = await turn("WHATSAPP", await conversation("WHATSAPP"), "Как с вами связаться?");
    expect(plan?.button).toMatchObject({ type: "voice_call", displayText: "Позвонить" });
    expect(OPERATOR_CONTACT_BUTTON_TEXTS.callLine.ru.some(line => plan?.text?.endsWith(line))).toBe(true);
  });
  it("рубильник выключен — обычный текст, как раньше", async () => {
    await settings({ botWaCallButton: false });
    try {
      const plan = await turn("WHATSAPP", await conversation("WHATSAPP"), "Как с вами связаться?");
      expect(plan?.button).toBeUndefined();
      expect(plan?.text).toBe(plan?.operator.text);
    } finally { await settings({ botWaCallButton: true }); }
  });
  it("звонки не готовы (сторож давно не видел AVAILABLE) — обычный текст", async () => {
    await settings({ waCallingReadyAt: new Date(Date.now() - 5 * 60 * 60_000) });
    try {
      expect((await loadContactButtonPolicy()).waCallReady).toBe(false);
      expect((await turn("WHATSAPP", await conversation("WHATSAPP"), "Дайте ваш номер"))?.button).toBeUndefined();
    } finally { await settings({ waCallingReadyAt: new Date() }); }
  });
});

describe("ссылка из Instagram в WhatsApp", () => {
  it("просьба номера — кнопка wa.me с кодом; код пишется вместе с ответом; повторная просьба — тот же код", async () => {
    const ig = await conversation("INSTAGRAM");
    const plan = await turn("INSTAGRAM", ig, "Дайте ваш номер телефона");
    expect(plan?.button?.type).toBe("web_url");
    const code = plan?.continuationCode?.code ?? "";
    expect(code).toMatch(/^RH-[2-9A-HJKMNP-Z]{6}$/u);
    expect(plan?.button?.type === "web_url" && decodeURIComponent(plan.button.url)).toContain(`#${code}`);
    expect(plan?.text).not.toContain(code);
    await prisma.$transaction(tx => persistCustomerLeadOnlyExtrasTx(tx, plan!, new Date()));
    expect(await prisma.whatsappContinuationCode.findUnique({ where: { code } })).toMatchObject({ sourceConversationId: ig.id, usedAt: null });
    const again = await turn("INSTAGRAM", ig, "Как с вами связаться?");
    expect(again?.continuationCode).toMatchObject({ code, create: false });
  });
  it("рубильник выключен — ссылки нет, кода нет", async () => {
    await settings({ botIgWhatsappLink: false });
    try {
      const plan = await turn("INSTAGRAM", await conversation("INSTAGRAM"), "Дайте ваш номер телефона");
      expect(plan?.button).toBeUndefined();
      expect(plan?.continuationCode).toBeUndefined();
    } finally { await settings({ botIgWhatsappLink: true }); }
  });
});

describe("WhatsApp с кодом — продолжение того же разговора", () => {
  it("живой код: без повторного «купить или продать», заявка с пометкой, код не в ответе и не в заметке, код погашен", async () => {
    const ig = await conversation("INSTAGRAM", { leadOnlyPending: buyerInInstagram() });
    const code = await codeFor(ig.id);
    const wa = await conversation("WHATSAPP");
    const plan = await turn("WHATSAPP", wa, `Здравствуйте! Продолжение из Instagram #${code}`);
    expect(plan?.text).toMatch(/^Здравствуйте!/u);
    expect(plan?.text).not.toMatch(/купить или продать|покупаете или продаёте/iu);
    expect(plan?.text).not.toContain(code);
    expect(plan?.operator.state.role).toBe("buyer");
    expect(plan?.intakes[0]).toMatchObject({ scenario: "buyer" });
    expect(plan?.continuationLink).toMatchObject({ waConversationId: wa.id, sourceConversationId: ig.id });
    expect(await prisma.whatsappContinuationCode.findUnique({ where: { code } })).toMatchObject({ usedByConversationId: wa.id });
    // Повтор того же хода (устаревшая память, сбой) — то же продолжение, а не обычный разговор.
    const replay = await turn("WHATSAPP", wa, `Здравствуйте! Продолжение из Instagram #${code}`);
    expect(replay?.operator.state.role).toBe("buyer");
  });
  it("выдуманный код — обычный разговор, из источника ничего", async () => {
    const plan = await turn("WHATSAPP", await conversation("WHATSAPP"), "Салом! #RH-ZZZZZZ");
    expect(plan?.operator.state.role).toBe("unknown");
    expect(plan?.continuationLink).toBeUndefined();
    expect(plan?.text).not.toContain("RH-");
  });
  it("код, погашенный другим разговором, и истёкший код — обычный разговор", async () => {
    const ig = await conversation("INSTAGRAM", { leadOnlyPending: buyerInInstagram() });
    const used = await codeFor(ig.id);
    await turn("WHATSAPP", await conversation("WHATSAPP"), `#${used}`);
    const stranger = await turn("WHATSAPP", await conversation("WHATSAPP"), `Здравствуйте #${used}`);
    expect(stranger?.operator.state.role).toBe("unknown");
    expect(stranger?.continuationLink).toBeUndefined();
    const expired = await codeFor(ig.id, { expiresAt: new Date(Date.now() - 60_000) });
    const late = await turn("WHATSAPP", await conversation("WHATSAPP"), `Здравствуйте #${expired}`);
    expect(late?.operator.state.role).toBe("unknown");
  });
  it("у клиента из Instagram уже есть карточка — новой заявки нет, разговор WhatsApp привязывается к ней", async () => {
    const client = await prisma.client.create({ data: { fullName: "Клиент продолжения", phone: `+99293${String(Date.now()).slice(-7)}`, source: "INSTAGRAM" } });
    clients.push(client.id);
    const ig = await conversation("INSTAGRAM", { clientId: client.id, leadOnlyPending: serializeOperatorState({ ...initialOperatorState(), role: "buyer",
      step: "done", leadAccepted: true, language: "ru" }, new Date()) });
    const code = await codeFor(ig.id);
    const wa = await conversation("WHATSAPP");
    const plan = await turn("WHATSAPP", wa, `Здравствуйте! Продолжение из Instagram #${code}`);
    expect(plan?.intakes.some(intake => intake.scenario !== "note")).toBe(false);
    expect(plan?.continuationLink).toBeDefined();
    await prisma.$transaction(tx => persistCustomerLeadOnlyExtrasTx(tx, plan!, new Date()));
    expect(await prisma.backgroundJob.count({ where: { type: WHATSAPP_CONTINUATION_LINK_JOB, dedupeKey: { endsWith: plan!.continuationLink!.eventKey } } })).toBe(1);
    expect(await runWhatsappContinuationLink({ version: 1, ...plan!.continuationLink! })).toEqual({ status: "linked_whatsapp" });
    const linked = await prisma.botConversation.findUniqueOrThrow({ where: { id: wa.id }, select: { clientId: true } });
    expect(linked.clientId).toBe(client.id);
    // Повтор задания ничего не портит.
    expect((await runWhatsappContinuationLink({ version: 1, ...plan!.continuationLink! })).status).toBe("same_card");
  });
  it("карточка заведена в WhatsApp, у Instagram её нет — переписка Instagram привязывается к ней; нет нигде — ждём", async () => {
    const ig = await conversation("INSTAGRAM");
    const wa = await conversation("WHATSAPP");
    const link = { version: 1 as const, waConversationId: wa.id, sourceConversationId: ig.id, sourceChannel: "INSTAGRAM" as const, eventKey: eventKey() };
    expect(await runWhatsappContinuationLink(link)).toEqual({ status: "wait", reason: "card_pending" });
    expect((await runWhatsappContinuationLink(link, { force: true })).status).toBe("skipped");
    const client = await prisma.client.create({ data: { fullName: "Клиент из WhatsApp", phone: `+99293${String(Date.now() + 1).slice(-7)}`, source: "WHATSAPP" } });
    clients.push(client.id);
    await prisma.botConversation.update({ where: { id: wa.id }, data: { clientId: client.id } });
    expect(await runWhatsappContinuationLink(link)).toEqual({ status: "linked_source" });
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: ig.id }, select: { clientId: true } })).clientId).toBe(client.id);
  });
});

describe("Meta отклонила сообщение с кнопкой — рубильник гаснет сам (защита по умолчанию)", () => {
  const creds = { waPhoneId: "111", waToken: "t", igToken: "i" } as MetaCredentials;
  const callBody = buildSendRequest(creds, "WHATSAPP", "992935554433", "Т", { type: "voice_call", displayText: "Позвонить", ttlMinutes: 60 }).body;
  const linkBody = buildSendRequest(creds, "INSTAGRAM", "p", "Т", { type: "web_url", title: "WA", url: "https://wa.me/992446501414" }).body;
  const err = (code: number | null, subcode: number | null = null) => ({ status: 400, code, subcode, type: null, fbtraceId: null, message: "x" });
  const state = async () => prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botWaCallButton: true, botIgWhatsappLink: true } });
  it("форма тела узнаётся; обычный текст — не кнопка", () => {
    expect(contactButtonKindOfBody(callBody)).toBe("voice_call");
    expect(contactButtonKindOfBody(linkBody)).toBe("web_url");
    expect(contactButtonKindOfBody(buildSendRequest(creds, "WHATSAPP", "992935554433", "Т").body)).toBeNull();
  });
  it("окно 24 ч, недоступный человек, ключ, запрет по правилам, 5xx — рубильник не трогаем", async () => {
    await noteContactButtonRejection(callBody, 400, err(131047), false);
    await noteContactButtonRejection(callBody, 400, err(131026), false);
    await noteContactButtonRejection(callBody, 401, err(190), false);
    await noteContactButtonRejection(linkBody, 400, err(10, 2534022), false);
    await noteContactButtonRejection(callBody, 400, err(368), true);
    await noteContactButtonRejection(callBody, 503, err(null), false);
    expect(await state()).toEqual({ botWaCallButton: true, botIgWhatsappLink: true });
  });
  it("отказ формата (100, неизвестный код) — гаснет только свой рубильник, тревога в журнале", async () => {
    try {
      await noteContactButtonRejection(callBody, 400, err(100), false);
      expect(await state()).toEqual({ botWaCallButton: false, botIgWhatsappLink: true });
      expect(await prisma.errorLog.count({ where: { dedupKey: "contact-button-rejected:voice_call", resolvedAt: null } })).toBeGreaterThan(0);
      await noteContactButtonRejection(linkBody, 400, err(null), false);
      expect(await state()).toEqual({ botWaCallButton: false, botIgWhatsappLink: false });
    } finally {
      await settings({ botWaCallButton: true, botIgWhatsappLink: true });
      await prisma.errorLog.deleteMany({ where: { dedupKey: { startsWith: "contact-button-rejected:" } } });
    }
  });
});
