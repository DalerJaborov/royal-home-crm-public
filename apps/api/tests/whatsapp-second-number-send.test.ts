import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { ensureCustomerEndpoint, type CustomerTransportReference } from "../src/lib/customerConversationScope.js";
import {
  accountTokenById,
  findTokenCollision,
  resetAccountsCache,
  resolveIncomingAccount,
} from "../src/messengers/accounts.js";
import {
  getWaPhoneId,
  parseIncoming,
  sendAudio,
  sendFile,
  sendImage,
  sendLocation,
  sendMessage,
  sendReaction,
  sendVideo,
  showReadAndTyping,
  whatsAppMediaSource,
  whatsappNumberIdentity,
} from "../src/messengers/meta.js";
import { rememberBusinessAccountFromWebhook, resetWaTemplateCaches } from "../src/lib/whatsappFirstContact.js";
import { checkMetaWhatsappTokenHealth, checkWhatsappAccountsHealth } from "../src/lib/integrationHealth.js";

// Чтение Graph API при обрыве сети повторяется с паузами 1/2/4 с — в тесте ждать их незачем.
vi.mock("../src/ai/geminiTransport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiTransport.js")>()),
  GEMINI_RETRY_DELAYS_MS: [0],
  sleep: async () => {},
}));

/**
 * ВТОРОЙ НОМЕР WHATSAPP: ОТВЕТ УХОДИТ С ЕГО phone_number_id И ЕГО МАРКЕРОМ (12.11.2026).
 *
 * Основной номер лежит в Настройках (диалоги с accountId = null), второй — строка
 * MessengerAccount. Проверяем настоящую цепочку отправки (сценарий и база настоящие,
 * сеть — заглушка): какой адрес и какой маркер увидит Meta для каждого из номеров, на
 * каждом пути отправки. Рядом — то, что ломалось вокруг неё при появлении второго номера.
 */
const run = randomUUID().replaceAll("-", "").slice(0, 8);
const MAIN_ID = `5500${Date.now()}`.slice(0, 15);
const SECOND_ID = `5501${Date.now()}`.slice(0, 15);
const MAIN_TOKEN = `EAA-main-${run}`;
const SECOND_TOKEN = `EAA-second-${run}`;
const PEER_MAIN = `99290${run.replace(/\D/g, "").padEnd(7, "1").slice(0, 7)}`;
const PEER_SECOND = `99291${run.replace(/\D/g, "").padEnd(7, "2").slice(0, 7)}`;

type Call = { url: string; method: string; auth: string | null; body: unknown };
let calls: Call[] = [];
let settingsBefore: { metaWaPhoneId: string | null; metaWaToken: string | null; metaWaBusinessAccountId: string | null } | null = null;
let secondAccountId = "";
let mainTransport: CustomerTransportReference;
let secondTransport: CustomerTransportReference;

function stubGraph(handler?: (url: string) => Response | undefined) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: u,
        method: init?.method ?? "GET",
        auth: headers.Authorization ?? null,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return (
        handler?.(u) ??
        new Response(JSON.stringify({ messages: [{ id: `wamid.${randomUUID()}` }], id: "ok", url: "https://cdn.example/media" }), { status: 200 })
      );
    })
  );
}

beforeAll(async () => {
  settingsBefore = await prisma.settings.findUniqueOrThrow({
    where: { id: "singleton" },
    select: { metaWaPhoneId: true, metaWaToken: true, metaWaBusinessAccountId: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { metaWaPhoneId: MAIN_ID, metaWaToken: encryptSecret(MAIN_TOKEN), metaWaBusinessAccountId: null },
  });
  const second = await prisma.messengerAccount.create({
    data: {
      channel: "WHATSAPP",
      externalId: SECOND_ID,
      title: `Арван WhatsApp ${run}`,
      token: encryptSecret(SECOND_TOKEN),
      enabled: true,
      isDefault: false,
      brandName: "Арван",
    },
  });
  secondAccountId = second.id;
  resetAccountsCache();
  // Пространства отправки создаёт первое входящее (ensureCustomerEndpoint) — делаем то же самое.
  mainTransport = await prisma.$transaction((tx) =>
    ensureCustomerEndpoint(tx, { channel: "WHATSAPP", subscriberId: PEER_MAIN, accountExternalId: MAIN_ID })
  );
  secondTransport = await prisma.$transaction((tx) =>
    ensureCustomerEndpoint(tx, { channel: "WHATSAPP", subscriberId: PEER_SECOND, accountExternalId: SECOND_ID })
  );
});

beforeEach(() => stubGraph());
afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  if (secondAccountId) await prisma.messengerAccount.deleteMany({ where: { id: secondAccountId } });
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  resetAccountsCache();
  resetWaTemplateCaches();
});

const posts = () => calls.filter((c) => c.method === "POST");

describe("основной и второй номер по отдельности: у каждого свой адрес и свой маркер", () => {
  it("пространства отправки разные: у основного нет аккаунта, у второго — его строка", () => {
    expect(mainTransport.accountId).toBeNull();
    expect(secondTransport.accountId).toBe(secondAccountId);
    expect(mainTransport.endpointScopeId).not.toBe(secondTransport.endpointScopeId);
  });

  // Все пути отправки в WhatsApp. Если один из них возьмёт phone_number_id из Настроек, ответ
  // клиента второго номера уйдёт с ОСНОВНОГО номера — клиенты «Арван» увидят чужую компанию.
  const senders: Array<[string, (peer: string, transport: CustomerTransportReference) => Promise<unknown>]> = [
    ["текст", (peer, t) => sendMessage("WHATSAPP", peer, "Здравствуйте", undefined, { origin: "staff", transport: t })],
    ["фото", (peer, t) => sendImage("WHATSAPP", peer, "https://crm.example/uploads/a.jpg", undefined, t)],
    ["видео", (peer, t) => sendVideo("WHATSAPP", peer, "https://crm.example/uploads/a.mp4", undefined, t)],
    ["голосовое", (peer, t) => sendAudio("WHATSAPP", peer, "https://crm.example/uploads/a.ogg", undefined, t)],
    ["документ", (peer, t) => sendFile("WHATSAPP", peer, "https://crm.example/uploads/a.pdf", undefined, "a.pdf", t)],
    ["геоточка", (peer, t) => sendLocation(peer, 38.56, 68.78, "Офис", "Душанбе", undefined, t)],
    ["реакция", (peer, t) => sendReaction(peer, "wamid.in-1", "👍", undefined, t)],
    ["«прочитано» и «печатает»", (peer, t) => showReadAndTyping("WHATSAPP", peer, "wamid.in-2", true, undefined, t)],
  ];

  it.each(senders)("%s: второй номер — его phone_number_id и его маркер", async (_name, send) => {
    await send(PEER_SECOND, secondTransport);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toContain(`/${SECOND_ID}/messages`);
    expect(posts()[0].url).not.toContain(MAIN_ID);
    expect(posts()[0].auth).toBe(`Bearer ${SECOND_TOKEN}`);
  });

  it.each(senders)("%s: основной номер по-прежнему — из Настроек", async (_name, send) => {
    await send(PEER_MAIN, mainTransport);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toContain(`/${MAIN_ID}/messages`);
    expect(posts()[0].url).not.toContain(SECOND_ID);
    expect(posts()[0].auth).toBe(`Bearer ${MAIN_TOKEN}`);
  });

  it("старый путь без сохранённого пространства (маркер аккаунта в параметре): тоже на номер второго", async () => {
    await sendImage("WHATSAPP", PEER_SECOND, "https://crm.example/uploads/a.jpg", SECOND_TOKEN);
    expect(posts()[0].url).toContain(`/${SECOND_ID}/messages`);
    expect(posts()[0].auth).toBe(`Bearer ${SECOND_TOKEN}`);
  });

  it("старый путь основного номера (маркер не передан): основной phone_number_id, маркер из Настроек", async () => {
    // Ради этого сценария accountTokenById и менялся: он отдавал маркер второго номера.
    await sendImage("WHATSAPP", PEER_MAIN, "https://crm.example/uploads/a.jpg", undefined);
    expect(posts()[0].url).toContain(`/${MAIN_ID}/messages`);
    expect(posts()[0].auth).toBe(`Bearer ${MAIN_TOKEN}`);
  });

  it("маркер основного номера нельзя подсунуть диалогу второго — отправка отбивается, а не уходит не оттуда", async () => {
    await expect(sendImage("WHATSAPP", PEER_SECOND, "https://crm.example/uploads/a.jpg", MAIN_TOKEN, secondTransport)).rejects.toMatchObject({
      reason: "account_mismatch",
    });
    expect(posts()).toHaveLength(0);
  });
});

describe("входящее на каждый из двух номеров принимается и привязывается к своему аккаунту", () => {
  const waBody = (phoneId: string, from: string) => ({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: phoneId },
              contacts: [{ wa_id: from, profile: { name: "Клиент" } }],
              messages: [{ id: `wm-${phoneId}`, from, type: "text", text: { body: "Здравствуйте" } }],
            },
          },
        ],
      },
    ],
  });

  it("список «своих» номеров для разбора вебхука содержит оба; чужой номер песочницы отсеивается", async () => {
    const ids = await getWaPhoneId();
    expect(ids).toEqual(expect.arrayContaining([MAIN_ID, SECOND_ID]));
    expect(parseIncoming(waBody(MAIN_ID, PEER_MAIN), ids)[0]?.accountExternalId).toBe(MAIN_ID);
    expect(parseIncoming(waBody(SECOND_ID, PEER_SECOND), ids)[0]?.accountExternalId).toBe(SECOND_ID);
    expect(parseIncoming(waBody("999000111222", PEER_MAIN), ids)).toHaveLength(0);
  });

  it("получатель основного номера — маркер Настроек (без аккаунта), второго — его аккаунт и его маркер", async () => {
    const main = await resolveIncomingAccount("WHATSAPP", MAIN_ID, PEER_MAIN);
    expect(main).toMatchObject({ id: null, token: MAIN_TOKEN, certain: true });
    const second = await resolveIncomingAccount("WHATSAPP", SECOND_ID, PEER_SECOND);
    expect(second).toMatchObject({ id: secondAccountId, token: SECOND_TOKEN, certain: true });
  });
});

describe("маркер диалога без аккаунта (напоминания, повтор зависших, просьба о номере)", () => {
  it("диалог основного номера получает маркер Настроек, а не маркер второго номера", async () => {
    const token = await accountTokenById(null, "WHATSAPP");
    expect(token.token).toBe(MAIN_TOKEN);
    expect(token.disabled).toBe(false);
    // …и с ним фоновая отправка проходит: раньше уходил маркер второго номера, и она отбивалась.
    await sendMessage("WHATSAPP", PEER_MAIN, "Напоминание", token.token, { origin: "staff", transport: mainTransport });
    expect(posts()[0].url).toContain(`/${MAIN_ID}/messages`);
    expect(posts()[0].auth).toBe(`Bearer ${MAIN_TOKEN}`);
  });

  it("диалог второго номера получает его маркер", async () => {
    const token = await accountTokenById(secondAccountId, "WHATSAPP");
    expect(token.token).toBe(SECOND_TOKEN);
  });
});

describe("одинаковый маркер у двух номеров", () => {
  it("отправка по маркеру не отличает номера — поэтому такой маркер не принимается при сохранении", async () => {
    // Доказательство причины запрета: ставим второму номеру маркер основного напрямую в базу.
    const row = await prisma.messengerAccount.findUniqueOrThrow({ where: { id: secondAccountId }, select: { token: true } });
    await prisma.messengerAccount.update({ where: { id: secondAccountId }, data: { token: encryptSecret(MAIN_TOKEN) } });
    resetAccountsCache();
    try {
      await expect(sendImage("WHATSAPP", PEER_MAIN, "https://crm.example/uploads/a.jpg", undefined)).rejects.toMatchObject({
        reason: "account_mismatch",
      });
      await expect(sendImage("WHATSAPP", PEER_SECOND, "https://crm.example/uploads/a.jpg", MAIN_TOKEN)).rejects.toMatchObject({
        reason: "account_mismatch",
      });
      expect(posts()).toHaveLength(0);
      // Сторож, не пускающий такое состояние через интерфейс:
      expect(await findTokenCollision("WHATSAPP", MAIN_TOKEN)).toEqual({ with: "settings" });
    } finally {
      await prisma.messengerAccount.update({ where: { id: secondAccountId }, data: { token: row.token } });
      resetAccountsCache();
    }
  });

  it("findTokenCollision: свой же маркер при правке не считается совпадением, чужой — считается", async () => {
    expect(await findTokenCollision("WHATSAPP", SECOND_TOKEN)).toMatchObject({ with: "account" });
    expect(await findTokenCollision("WHATSAPP", SECOND_TOKEN, secondAccountId)).toBeNull();
    expect(await findTokenCollision("WHATSAPP", `EAA-unique-${run}`)).toBeNull();
    // Instagram основным из Настроек не занят — у него другая схема выбора маркера.
    expect(await findTokenCollision("INSTAGRAM", MAIN_TOKEN)).toBeNull();
  });
});

describe("входящее: файл клиента второго номера читается маркером второго номера", () => {
  it("whatsAppMediaSource с маркером аккаунта идёт с ним, без — с маркером Настроек", async () => {
    stubGraph();
    await whatsAppMediaSource("media-1", SECOND_TOKEN);
    expect(calls[0].auth).toBe(`Bearer ${SECOND_TOKEN}`);
    stubGraph();
    await whatsAppMediaSource("media-2");
    expect(calls[0].auth).toBe(`Bearer ${MAIN_TOKEN}`);
  });
});

describe("кабинет WhatsApp для шаблонов запоминается только по основному номеру", () => {
  const webhookFor = (phoneId: string, wabaId: string) => ({
    object: "whatsapp_business_account",
    entry: [{ id: wabaId, changes: [{ value: { metadata: { phone_number_id: phoneId }, messages: [{ id: "m1" }] } }] }],
  });
  const stored = async () =>
    (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { metaWaBusinessAccountId: true } }))
      .metaWaBusinessAccountId;

  it("вебхук второго номера не записывает свой кабинет как кабинет шаблонов, вебхук основного — записывает", async () => {
    resetWaTemplateCaches();
    // Вебхук вызывает функцию со списком только ОСНОВНЫХ номеров (routes/webhooks.ts).
    await rememberBusinessAccountFromWebhook(webhookFor(SECOND_ID, `waba-second-${run}`), [MAIN_ID]);
    expect(await stored()).toBeNull();
    await rememberBusinessAccountFromWebhook(webhookFor(MAIN_ID, `waba-main-${run}`), [MAIN_ID]);
    expect(await stored()).toBe(`waba-main-${run}`);
  });
});

describe("«Здоровье системы»: проверяются оба номера", () => {
  it("основной номер проверяется своим маркером, второй — отдельной строкой со своим", async () => {
    stubGraph();
    const main = await checkMetaWhatsappTokenHealth();
    expect(main).toMatchObject({ name: "WhatsApp", ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/${MAIN_ID}?`);
    expect(calls[0].url).toContain(encodeURIComponent(MAIN_TOKEN));

    stubGraph();
    const others = await checkWhatsappAccountsHealth();
    // В общей базе у параллельных тестов бывают свои номера WhatsApp — смотрим только на свой.
    const mine = others.find((o) => o.name === `WhatsApp «Арван WhatsApp ${run}»`);
    expect(mine).toMatchObject({ ok: true });
    // Основной номер второй строкой не повторяется.
    expect(others.some((o) => o.name === "WhatsApp")).toBe(false);
    const secondCalls = calls.filter((c) => c.url.includes(`/${SECOND_ID}?`));
    expect(secondCalls).toHaveLength(1);
    expect(secondCalls[0].url).toContain(encodeURIComponent(SECOND_TOKEN));
    expect(calls.some((c) => c.url.includes(`/${MAIN_ID}?`))).toBe(false);
  });

  it("смерть маркера основного номера видна, даже когда второй жив", async () => {
    stubGraph((url) =>
      url.includes(encodeURIComponent(MAIN_TOKEN))
        ? new Response(JSON.stringify({ error: { message: "Session has expired" } }), { status: 401 })
        : undefined
    );
    expect(await checkMetaWhatsappTokenHealth()).toMatchObject({ name: "WhatsApp", ok: false });
    const others = await checkWhatsappAccountsHealth();
    expect(others.find((o) => o.name === `WhatsApp «Арван WhatsApp ${run}»`)).toMatchObject({ ok: true });
  });
});

describe("whatsappNumberIdentity: разбор ответа Graph API", () => {
  it("успех: возвращает номер и проверенное имя; запрос идёт с Bearer-маркером на нужный идентификатор", async () => {
    stubGraph(() =>
      new Response(JSON.stringify({ id: SECOND_ID, display_phone_number: "+992 90 111 22 33", verified_name: "Арван" }), { status: 200 })
    );
    const res = await whatsappNumberIdentity(SECOND_TOKEN, SECOND_ID);
    expect(res).toEqual({ ok: true, id: SECOND_ID, displayPhoneNumber: "+992 90 111 22 33", verifiedName: "Арван" });
    expect(calls[0].url).toContain(`/${SECOND_ID}?fields=id,display_phone_number,verified_name`);
    expect(calls[0].auth).toBe(`Bearer ${SECOND_TOKEN}`);
  });

  it("маркер мёртв (190 / 401) — kind token", async () => {
    stubGraph(() => new Response(JSON.stringify({ error: { message: "Error validating access token", code: 190 } }), { status: 400 }));
    expect(await whatsappNumberIdentity("dead", SECOND_ID)).toMatchObject({ ok: false, kind: "token" });
    stubGraph(() => new Response("{}", { status: 401 }));
    expect(await whatsappNumberIdentity("dead", SECOND_ID)).toMatchObject({ ok: false, kind: "token" });
  });

  it("номера нет или нет доступа (400, код 100) — kind number", async () => {
    stubGraph(() => new Response(JSON.stringify({ error: { message: "Unsupported get request", code: 100 } }), { status: 400 }));
    expect(await whatsappNumberIdentity(SECOND_TOKEN, "1")).toMatchObject({ ok: false, kind: "number" });
  });

  it("Meta лежит (500, 429) и обрыв сети — kind network, а не «неверный маркер»", async () => {
    stubGraph(() => new Response("oops", { status: 503 }));
    expect(await whatsappNumberIdentity(SECOND_TOKEN, SECOND_ID)).toMatchObject({ ok: false, kind: "network" });
    stubGraph(() => new Response("slow down", { status: 429 }));
    expect(await whatsappNumberIdentity(SECOND_TOKEN, SECOND_ID)).toMatchObject({ ok: false, kind: "network" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }));
    expect(await whatsappNumberIdentity(SECOND_TOKEN, SECOND_ID)).toMatchObject({ ok: false, kind: "network" });
  });
});
