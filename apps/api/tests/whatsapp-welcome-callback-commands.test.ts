import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import type { MessengerTurnInput, MessengerTurnResult } from "../src/messengers/turnTypes.js";

/**
 * ПРИВЕТСТВИЕ, ОБРАТНЫЙ ЗВОНОК И КОМАНДЫ WHATSAPP НА ОБОИХ НОМЕРАХ (27.11.2026).
 *
 * 1) `request_welcome` — одно приветствие от бренда ЭТОГО номера, без хода бота, без переписки и заявки; повторная
 *    доставка и уже идущая переписка второго приветствия не дают; рубильник WHATSAPP_WELCOME=off глушит.
 * 2) `call_permission_reply` accept от самого человека — просьба о звонке (CallbackRequest) с брендом и номером линии;
 *    повтор того же события и второе разрешение — одна просьба; automatic / reject — ничего; рубильник глушит.
 * 3) Команды «/харидан» — слова человека для ядра; список для Meta укладывается в лимиты.
 */

const { sendMessage, processTurn, pushed } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => "wamid.out-fake"),
  processTurn: vi.fn<(input: MessengerTurnInput) => Promise<MessengerTurnResult>>(async () => ({
    reply: "",
    ready: false,
    accepted: false,
    shouldReply: false,
  })),
  pushed: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendMessage,
}));
vi.mock("../src/messengers/conversation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/conversation.js")>()),
  processMessengerTurn: processTurn,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: pushed,
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { encryptSecret } = await import("../src/crypto.js");
const { drainBackgroundTasks } = await import("../src/lib/shutdownState.js");
const { resetAccountsCache } = await import("../src/messengers/accounts.js");
const { parseIncoming } = await import("../src/messengers/meta.js");
const { clientAskedForOperator } = await import("../src/ai/operatorHandoff.js");
const commands = await import("../src/messengers/whatsappCommands.js");
const { parseWhatsappServiceEvents, callbackTopic, formatBusinessPhone } = await import("../src/messengers/whatsappServiceEvents.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now();
const tail = String(runId).slice(-7);

function waBody(value: Record<string, unknown>, phoneId: string, display = "992877914444") {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "waba-test", changes: [{ field: "messages", value: { messaging_product: "whatsapp",
      metadata: { phone_number_id: phoneId, display_phone_number: display }, ...value } }] }],
  };
}
const welcome = (from: string, mid: string) => ({ from, id: mid, timestamp: "1764000000", type: "request_welcome" });
const permission = (from: string, mid: string, reply: Record<string, unknown>) => ({
  from, id: mid, timestamp: "1764000000", type: "interactive", context: { from, id: "wacid.CALL" },
  interactive: { type: "call_permission_reply", call_permission_reply: reply },
});
const ACCEPT = { response: "accept", is_permanent: false, expiration_timestamp: "1764604800", response_source: "user_action" };

describe("команды: слова человека для ядра", () => {
  it("команда и её написания переводятся, хвост сохраняется, чужое не трогается", () => {
    expect(commands.whatsappCommandText("/харидан")).toBe("Мехоҳам хона харам");
    expect(commands.whatsappCommandText("  /Харидан 3 хонагӣ дар Сино ")).toBe("Мехоҳам хона харам. 3 хонагӣ дар Сино");
    expect(commands.whatsappCommandText("/фурухтан")).toBe("Мехоҳам хонаамро фурӯшам");
    expect(commands.whatsappCommandText("/купить")).toBe("Мехоҳам хона харам");
    expect(commands.whatsappCommandText("/суроға")).toBe("Суроғаи офиси шумо куҷост?");
    expect(commands.whatsappCommandText("/адрес")).toBe("Суроғаи офиси шумо куҷост?");
    expect(commands.whatsappCommandText("/неизвестная")).toBeNull();
    expect(commands.whatsappCommandText("мехоҳам /харидан")).toBeNull();
    expect(commands.whatsappCommandText("1/2 доли")).toBeNull();
    expect(commands.whatsappCommandText("")).toBeNull();
  });

  it("«/агент» ядро узнаёт как просьбу живого человека", () => {
    expect(clientAskedForOperator([commands.whatsappCommandText("/агент")!])).toBe(true);
  });

  it("список для Meta: 3–4 команды, лимиты Meta, без эмодзи и длинного тире, адрес Бухоро 49", () => {
    const list = commands.whatsappCommandsForMeta();
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.length).toBeLessThanOrEqual(4);
    for (const c of list) {
      expect(c.command_name.length).toBeLessThanOrEqual(32);
      expect(c.command_name.startsWith("/")).toBe(false);
      expect(c.command_description.length).toBeLessThanOrEqual(256);
      expect(`${c.command_name} ${c.command_description}`).not.toMatch(/\p{Extended_Pictographic}|—/u);
    }
    expect(new Set(list.map((c) => c.command_name)).size).toBe(list.length);
    expect(list.find((c) => c.command_name === "суроға")?.command_description).toContain("Бухоро 49");
    expect(commands.WHATSAPP_PROMPTS).toEqual(["Мехоҳам хона харам", "Мехоҳам хонаамро фурӯшам"]);
  });

  it("разбор вебхука отдаёт ядру слова команды; рубильник off — текст как есть", () => {
    const body = waBody({ messages: [{ from: "992900000001", id: "wamid.cmd", type: "text", text: { body: "/фурӯхтан" } }] }, "pn-1");
    expect(parseIncoming(body)[0]).toMatchObject({ text: "Мехоҳам хонаамро фурӯшам" });
    vi.stubEnv("WHATSAPP_COMMANDS", "off");
    try {
      expect(parseIncoming(body)[0]).toMatchObject({ text: "/фурӯхтан" });
    } finally {
      vi.unstubAllEnvs();
    }
    // Подпись к фото командой не бывает.
    const photo = waBody({ messages: [{ from: "992900000001", id: "wamid.ph", type: "image", image: { id: "m1", caption: "/харидан" } }] }, "pn-1");
    expect(parseIncoming(photo)[0]).toMatchObject({ text: "/харидан" });
  });
});

describe("приветствие и тексты", () => {
  it("приветствие: бренд, два языка, один вопрос «купить или продать», «шумо», без длинного тире", () => {
    const text = commands.whatsappWelcomeText("Арван");
    expect(text).toContain("Арван");
    expect(text).toContain("Шумо хона харидан мехоҳед ё фурӯхтан?");
    expect(text).toContain("купить");
    expect(text).toContain("продать");
    // \b с кириллицей не работает (CLAUDE.md, «Ловушки») — граница слова через \p{L}.
    expect(text).not.toMatch(/—|(?<!\p{L})(?:ты|ту)(?!\p{L})/iu);
    expect(commands.whatsappWelcomeText("")).toContain("Royal Home");
  });

  it("просьба о звонке называет бренд и номер линии", () => {
    expect(formatBusinessPhone("992877914444")).toBe("+992 87 791 4444");
    const topic = callbackTopic({ brand: "Арван", displayPhone: "992877914444", name: "Фарид", isPermanent: false });
    expect(topic).toContain("WhatsApp «Арван» (+992 87 791 4444)");
    expect(topic).toContain("Фарид");
    expect(topic).not.toContain("—");
  });

  it("разбор: приветствие и разрешение; чужой номер, без wamid и без номера клиента — мимо", () => {
    const body = waBody({ messages: [welcome("992900000002", "wamid.w"), permission("992900000002", "wamid.p", ACCEPT),
      { type: "request_welcome", from: "992900000002" }, { type: "request_welcome", id: "wamid.nofrom" }] }, "pn-ours");
    const events = parseWhatsappServiceEvents(body, ["pn-ours"]);
    expect(events.map((e) => e.kind)).toEqual(["welcome", "call_permission"]);
    expect(events[1]).toMatchObject({ permission: { response: "accept", source: "user_action", isPermanent: false }, contextId: "wacid.CALL" });
    expect(parseWhatsappServiceEvents(body, ["pn-other"])).toEqual([]);
    expect(parseWhatsappServiceEvents({ object: "instagram" })).toEqual([]);
    expect(parseWhatsappServiceEvents(null)).toEqual([]);
  });
});

describe("вебхук целиком на номере бренда «Арван»", () => {
  let wa: CustomerMessengerFixture;
  let agentId = "";
  const clientIds: string[] = [];
  const saved: Record<string, unknown> = {};

  async function post(body: unknown) {
    const res = await request(app).post("/api/v1/webhooks/meta").set("x-hub-signature-256", wa.sign(body)).send(body);
    expect(res.status).toBe(200);
    await drainBackgroundTasks(5_000);
  }
  const requestsOf = (phone: string) => prisma.callbackRequest.findMany({ where: { phone } });

  beforeAll(async () => {
    wa = await createCustomerMessengerFixture("WHATSAPP");
    await prisma.messengerAccount.update({ where: { id: wa.id }, data: { brandName: "Арван" } });
    resetAccountsCache();
    agentId = await createTestAgent(`Агент обратного звонка ${runId}`);
    const row = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" },
      select: { metaEnabled: true, botEnabled: true, botWhatsappEnabled: true, metaVerifyToken: true } });
    Object.assign(saved, row);
    await prisma.settings.update({ where: { id: "singleton" },
      data: { metaEnabled: true, botEnabled: true, botWhatsappEnabled: true, metaVerifyToken: encryptSecret(`verify-${runId}`) } });
  });

  afterAll(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: saved });
    await prisma.callbackRequest.deleteMany({ where: { phone: { contains: tail } } });
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await deleteAgentsWithTraces([agentId]);
    await wa?.dispose();
  });

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("request_welcome: одно приветствие от «Арван» с этого номера; повтор доставки — без второго; ни хода, ни переписки", async () => {
    const from = `99290${tail}1`;
    const body = waBody({ contacts: [{ wa_id: from, profile: { name: "Гость" } }], messages: [welcome(from, `wamid.welcome-${runId}`)] }, wa.externalId);
    await post(body);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [channel, to, text, , outbound] = sendMessage.mock.calls[0]! as [string, string, string, unknown, { transport?: { accountId: string | null }; origin?: string }];
    expect(channel).toBe("WHATSAPP");
    expect(to).toBe(from);
    expect(text).toContain("Арван");
    expect(text).not.toContain("Royal Home");
    expect(outbound.transport?.accountId).toBe(wa.id);
    expect(outbound.origin).toBe("bot");
    expect(processTurn).not.toHaveBeenCalled();
    expect(await prisma.botConversation.count({ where: { channel: "WHATSAPP", subscriberId: from } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { phone: `+${from}` } })).toBe(0);

    await post(body);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("request_welcome, когда переписка на этом номере уже есть — молчим", async () => {
    const from = `99290${tail}2`;
    await wa.ensureConversation(from);
    await post(waBody({ messages: [welcome(from, `wamid.welcome-old-${runId}`)] }, wa.externalId));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("рубильник WHATSAPP_WELCOME=off — приветствия нет", async () => {
    vi.stubEnv("WHATSAPP_WELCOME", "off");
    await post(waBody({ messages: [welcome(`99290${tail}3`, `wamid.welcome-off-${runId}`)] }, wa.externalId));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("разрешение звонить от самого человека: одна просьба с брендом и номером линии, повтор и второе разрешение — без второй", async () => {
    const from = `99290${tail}4`;
    const body = waBody({ contacts: [{ wa_id: from, profile: { name: "Шерзод" } }], messages: [permission(from, `wamid.perm-${runId}`, ACCEPT)] }, wa.externalId);
    await post(body);
    let rows = await requestsOf(`+${from}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "WHATSAPP", doneAt: null, byClientRequest: false });
    expect(rows[0]!.topic).toContain("WhatsApp «Арван» (+992 87 791 4444)");
    expect(rows[0]!.topic).toContain("Шерзод");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(processTurn).not.toHaveBeenCalled();

    await post(body);
    await post(waBody({ messages: [permission(from, `wamid.perm2-${runId}`, ACCEPT)] }, wa.externalId));
    rows = await requestsOf(`+${from}`);
    expect(rows).toHaveLength(1);
  });

  it("клиент с агентом: просьба на его карточку, пуш агенту, запись в истории карточки", async () => {
    const from = `99290${tail}5`;
    const client = await prisma.client.create({ data: { fullName: `Клиент ${runId}`, phone: `+${from}`, source: "WHATSAPP",
      assignedAgentId: agentId, assignedAt: new Date(Date.now() - 60_000) } });
    clientIds.push(client.id);
    await post(waBody({ messages: [permission(from, `wamid.perm-agent-${runId}`, { ...ACCEPT, is_permanent: true })] }, wa.externalId));
    const rows = await requestsOf(`+${from}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientId: client.id });
    expect(rows[0]!.topic).toContain("без срока");
    expect(pushed).toHaveBeenCalledWith(agentId, expect.objectContaining({ url: `/clients/${client.id}` }));
    expect(pushed).toHaveBeenCalledTimes(1);
    const note = await prisma.interaction.findFirst({ where: { clientId: client.id, type: "SYSTEM", notes: { contains: "«Арван»" } } });
    expect(note).not.toBeNull();
  });

  it.each([
    ["automatic (сам факт звонка)", { ...ACCEPT, response_source: "automatic" }],
    ["reject", { response: "reject", response_source: "user_action" }],
  ])("%s — просьба не заводится", async (_name, reply) => {
    const from = `99290${tail}${_name.startsWith("auto") ? "6" : "7"}`;
    await post(waBody({ messages: [permission(from, `wamid.perm-${_name.slice(0, 4)}-${runId}`, reply)] }, wa.externalId));
    expect(await requestsOf(`+${from}`)).toHaveLength(0);
  });

  it("рубильник WHATSAPP_CALLBACK_REQUESTS=off — просьбы нет", async () => {
    vi.stubEnv("WHATSAPP_CALLBACK_REQUESTS", "off");
    const from = `99290${tail}8`;
    await post(waBody({ messages: [permission(from, `wamid.perm-off-${runId}`, ACCEPT)] }, wa.externalId));
    expect(await requestsOf(`+${from}`)).toHaveLength(0);
  });
});
