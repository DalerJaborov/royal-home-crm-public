import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * АВАРИЙНЫЙ РУБИЛЬНИК CUSTOMER_AGENT_CHANNEL_OFF (18.11.2026, lib/customerAgentChannelOff.ts): «бот молчит, отвечают люди».
 * На выключенном канале модель не вызывается вообще (ни старый бот, ни ядро, ни тень), клиенту — строка передачи ядра,
 * сотруднику — один сигнал «клиент ждёт ответа» на эпизод. Пусто — поведение прежнее. Модель, ядро, тень и сам пуш —
 * подмены; переписки — настоящие строки базы (по ним считается эпизод).
 */
const f = vi.hoisted(() => ({ qualify: vi.fn(), core: vi.fn(), schedule: vi.fn(), alert: vi.fn(), ai: vi.fn(), log: vi.fn() }));
vi.mock("../src/ai/leadQualifier.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/ai/leadQualifier.js")>()),
  runQualifyTurn: f.qualify }));
vi.mock("../src/lib/customerChannelCore.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerChannelCore.js")>()),
  runChannelCoreTurn: f.core }));
vi.mock("../src/lib/customerAgentLegacyShadow.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentLegacyShadow.js")>()),
  scheduleLegacyCoreShadow: f.schedule }));
vi.mock("../src/lib/clientWaitingAlert.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/clientWaitingAlert.js")>()),
  alertClientWaiting: f.alert }));
vi.mock("../src/ai/client.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: f.ai }));
vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: f.log }));

const { parseCustomerAgentChannelOff, isCustomerAgentChannelOff, customerAgentChannelsOff, isCustomerAgentConversationOff,
  channelOffHandoverAlreadySent, CUSTOMER_AGENT_OFF_CHANNELS } = await import("../src/lib/customerAgentChannelOff.js");
const { runLegacyQualifyTurn } = await import("../src/ai/legacyQualifyDoor.js");
const { customerAgentHandoverLine } = await import("../src/ai/customerAgentRenderer.js");
const { shortAgentReply } = await import("../src/ai/shortAgentReply.js");
const { planLegacyLeadOnlyTurn } = await import("../src/messengers/leadOnlyLegacy.js");
const { LEAD_ONLY_DEFAULTS } = await import("../src/ai/leadOnlyMode.js");
const { leadOnlyIntentFallback } = await import("../src/ai/leadOnlyIntent.js");
const { isCommentsBotEnabled } = await import("../src/messengers/commentIngest.js");
const { isTelegramGroupCommentsEnabled } = await import("../src/messengers/telegramGroupComments.js");

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ids = { bot: [] as string[], tg: [] as string[], td: [] as string[] };
const RU = customerAgentHandoverLine("ru"), TG = customerAgentHandoverLine("tg");
const OLD = { reply: ["старый бот"], ready: false, lead: null };
const at = () => new Date().toISOString();
const user = (content: string) => ({ role: "user" as const, content, at: at() });
const bot = (content: string, kind = "bot") => ({ role: "assistant" as const, content, at: at(), by: { kind } });

type Channel = "WHATSAPP" | "INSTAGRAM" | "FACEBOOK" | "WEBSITE" | "TELEGRAM" | "TELEGRAM_DIRECT";
async function chat(channel: Channel, messages: object[]): Promise<string> {
  const n = ids.bot.length + ids.tg.length + ids.td.length;
  if (channel === "TELEGRAM") {
    const row = await prisma.telegramConversation.create({ data: { chatId: `off-${runId}-${n}`, messages } });
    ids.tg.push(row.id); return row.id;
  }
  if (channel === "TELEGRAM_DIRECT") {
    const row = await prisma.telegramDirectConversation.create({ data: { chatId: `offd-${runId}-${n}`, topicId: "t1", messages } });
    ids.td.push(row.id); return row.id;
  }
  const row = await prisma.botConversation.create({ data: { channel, subscriberId: `off-${runId}-${n}`, messages } });
  ids.bot.push(row.id); return row.id;
}
async function setMessages(channel: Channel, id: string, messages: object[]): Promise<void> {
  if (channel === "TELEGRAM") await prisma.telegramConversation.update({ where: { id }, data: { messages } });
  else if (channel === "TELEGRAM_DIRECT") await prisma.telegramDirectConversation.update({ where: { id }, data: { messages } });
  else await prisma.botConversation.update({ where: { id }, data: { messages } });
}
/** The channel's own call shape: Telegram passes no `options.channel` (ChannelTurnSource.channel says it). */
function turn(channel: Channel, conversationId: string, text: string, extra: { repeat?: "retry" | "regeneration" } = {}) {
  const history = [{ role: "user" as const, content: text }];
  const options = channel === "TELEGRAM" ? { conversationId } : { channel, conversationId };
  return runLegacyQualifyTurn(history, { stage: "chatting" } as never, options as never, { channel, ...extra });
}
const sourceOf = (channel: Channel) => channel === "TELEGRAM" ? "telegram" : channel === "TELEGRAM_DIRECT" ? "telegramDirect" : "bot";
const KEY: Record<Channel, string> = { WHATSAPP: "whatsapp", INSTAGRAM: "instagram", FACEBOOK: "facebook", WEBSITE: "website",
  TELEGRAM: "telegram", TELEGRAM_DIRECT: "telegram_direct" };

beforeEach(() => {
  vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", ""); vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", ""); vi.stubEnv("CUSTOMER_AGENT_CHANNEL_SHADOW", "");
  f.qualify.mockReset().mockResolvedValue(OLD); f.core.mockReset(); f.schedule.mockReset();
  f.alert.mockReset().mockResolvedValue("agent"); f.ai.mockReset().mockResolvedValue(null); f.log.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: ids.bot } } });
  await prisma.telegramConversation.deleteMany({ where: { id: { in: ids.tg } } });
  await prisma.telegramDirectConversation.deleteMany({ where: { id: { in: ids.td } } });
});

describe("значение переменной", () => {
  it("пусто — ничего не выключено; список, регистр и пробелы; `all` — все семь, включая личные Telegram", () => {
    expect(parseCustomerAgentChannelOff(undefined).off.size).toBe(0);
    expect(parseCustomerAgentChannelOff("  ").off.size).toBe(0);
    expect([...parseCustomerAgentChannelOff(" Instagram ,WEBSITE").off].sort()).toEqual(["instagram", "website"]);
    expect([...parseCustomerAgentChannelOff("all").off].sort()).toEqual([...CUSTOMER_AGENT_OFF_CHANNELS].sort());
    expect(parseCustomerAgentChannelOff("all").off.has("telegram_direct")).toBe(true);
  });
  it("неизвестное имя пропускается (не расширяется до всех) и пишется в журнал один раз на значение", () => {
    expect(parseCustomerAgentChannelOff("instagrm,website")).toEqual({ off: new Set(["website"]), unknown: ["instagrm"] });
    const env = { CUSTOMER_AGENT_CHANNEL_OFF: `zzz-${runId}` };
    expect(customerAgentChannelsOff(env).size).toBe(0);
    customerAgentChannelsOff(env); customerAgentChannelsOff(env);
    const calls = f.log.mock.calls.filter(call => String((call[2] as { dedupKey?: string } | undefined)?.dedupKey).includes(`zzz-${runId}`));
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toContain(`zzz-${runId}`);
  });
  it("ключ по каналу переписки: telegram не задевает личные сообщения канала, незнакомый канал не выключается", () => {
    const env = { CUSTOMER_AGENT_CHANNEL_OFF: "telegram,youtube" };
    expect(isCustomerAgentChannelOff("TELEGRAM", env)).toBe(true);
    expect(isCustomerAgentChannelOff("TELEGRAM_DIRECT", env)).toBe(false);
    expect(isCustomerAgentChannelOff("YOUTUBE", env)).toBe(true);
    expect(isCustomerAgentChannelOff("INSTAGRAM", env)).toBe(false);
    expect(isCustomerAgentChannelOff("SMS", { CUSTOMER_AGENT_CHANNEL_OFF: "all" })).toBe(false);
    expect(isCustomerAgentChannelOff("INSTAGRAM", {})).toBe(false);
  });
  it("эпизод: строка передачи — последняя доставленная наша реплика; ответ сотрудника открывает новый эпизод", () => {
    expect(channelOffHandoverAlreadySent([user("а"), bot(RU), user("б")], [RU, TG])).toBe(true);
    expect(channelOffHandoverAlreadySent([user("а"), bot(RU), bot("Здравствуйте, это Ноза", "agent"), user("б")], [RU, TG])).toBe(false);
    expect(channelOffHandoverAlreadySent([user("а"), bot(RU), { ...bot("ушло?"), deliveryStatus: "failed" }, user("б")], [RU, TG])).toBe(true);
    expect(channelOffHandoverAlreadySent([user("а")], [RU, TG])).toBe(false);
    expect(channelOffHandoverAlreadySent(null, [RU, TG])).toBe(false);
  });
});

describe("дверь старого пути: каждый канал", () => {
  for (const channel of ["WHATSAPP", "INSTAGRAM", "FACEBOOK", "WEBSITE", "TELEGRAM", "TELEGRAM_DIRECT"] as const) {
    it(`${channel}: модель не вызвана, клиенту строка передачи, сигнал один на эпизод`, async () => {
      vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", KEY[channel]);
      const id = await chat(channel, [user("Нужна квартира")]);
      const first = await turn(channel, id, "Нужна квартира");
      expect(first).toEqual({ reply: [RU], ready: false, lead: null, verified: true });
      expect(f.qualify).not.toHaveBeenCalled();
      expect(f.core).not.toHaveBeenCalled();
      expect(f.schedule).not.toHaveBeenCalled();
      expect(f.ai).not.toHaveBeenCalled();
      expect(f.alert).toHaveBeenCalledTimes(1);
      expect(f.alert).toHaveBeenCalledWith(expect.objectContaining({ conversationId: id, trigger: "handover", source: sourceOf(channel) }));

      // The channel stored the line; the customer writes again in the same episode: silence, no second push.
      await setMessages(channel, id, [user("Нужна квартира"), bot(RU), user("алло?")]);
      expect(await turn(channel, id, "алло?")).toEqual({ reply: [], ready: false, lead: null, silent: "intended" });
      expect(f.alert).toHaveBeenCalledTimes(1);

      // A person answered, the customer wrote again: a new episode — the line and the signal once more.
      await setMessages(channel, id, [user("Нужна квартира"), bot(RU), bot("Здравствуйте, это агент", "agent"), user("ещё вопрос")]);
      expect((await turn(channel, id, "ещё вопрос"))?.reply).toEqual([RU]);
      expect(f.alert).toHaveBeenCalledTimes(2);
      expect(f.qualify).not.toHaveBeenCalled();
    });
  }

  it("пусто — прежний путь, тот же результат старого бота, без сигнала и без запросов рубильника к базе", async () => {
    const id = await chat("WEBSITE", [user("Нужна квартира")]);
    const read = vi.spyOn(prisma.botConversation, "findUnique");
    const result = await turn("WEBSITE", id, "Нужна квартира");
    expect(result).toBe(OLD);
    expect(f.qualify).toHaveBeenCalledTimes(1);
    expect(f.schedule).toHaveBeenCalledTimes(1);
    expect(f.alert).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("выключен другой канал — этот отвечает как раньше", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "instagram,telegram_direct");
    const id = await chat("WEBSITE", [user("Нужна квартира")]);
    expect(await turn("WEBSITE", id, "Нужна квартира")).toBe(OLD);
    expect(f.alert).not.toHaveBeenCalled();
  });

  it("`all` — выключены все каналы, в том числе личные Telegram; неизвестное имя ничего не выключает", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "all");
    for (const channel of ["INSTAGRAM", "TELEGRAM", "TELEGRAM_DIRECT"] as const) {
      const id = await chat(channel, [user("салом")]);
      expect((await turn(channel, id, "салом"))?.reply?.length).toBe(1);
    }
    expect(f.qualify).not.toHaveBeenCalled();
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "instagrm");
    const id = await chat("INSTAGRAM", [user("салом")]);
    expect(await turn("INSTAGRAM", id, "салом")).toBe(OLD);
  });

  it("рубильник сильнее режима `core`: ядро на выключенном канале не запускается", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "website"); vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "website");
    const id = await chat("WEBSITE", [user("Нужна квартира")]);
    expect((await turn("WEBSITE", id, "Нужна квартира"))?.reply).toEqual([RU]);
    expect(f.core).not.toHaveBeenCalled();
  });

  it("таджикская речь — таджикская строка; повтор хода — тоже строка (не null, иначе канал заведёт повтор ИИ)", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "telegram");
    const id = await chat("TELEGRAM", [user("Ассалому алейкум, хона лозим аст")]);
    expect((await turn("TELEGRAM", id, "Ассалому алейкум, хона лозим аст", { repeat: "retry" }))?.reply).toEqual([TG]);
    expect(await turn("TELEGRAM", id, "Ассалому алейкум", { repeat: "regeneration" })).toBeNull();
    expect(f.qualify).not.toHaveBeenCalled();
  });

  it("сигнала нет намеренно (клиент в корзине) — молчим; сказать некого — строка и запись в журнал на этот чат", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "facebook");
    const gone = await chat("FACEBOOK", [user("вопрос")]);
    f.alert.mockResolvedValueOnce("excluded");
    expect(await turn("FACEBOOK", gone, "вопрос")).toEqual({ reply: [], ready: false, lead: null, silent: "intended" });
    const lonely = await chat("FACEBOOK", [user("вопрос")]);
    f.alert.mockResolvedValueOnce("skipped");
    expect((await turn("FACEBOOK", lonely, "вопрос"))?.reply).toEqual([RU]);
    expect(f.log).toHaveBeenCalledWith("ai", expect.stringContaining(lonely),
      expect.objectContaining({ dedupKey: `channel-off-unalerted:FACEBOOK:${lonely}` }));
  });
});

describe("модель и вне хода не пишет на выключенном канале", () => {
  it("короткие реплики (заявка принята, напоминание, просьба номера): null без вызова модели; другой канал — модель зовётся", async () => {
    const id = await chat("WHATSAPP", [user("Нужна квартира"), bot("Какой район?")]);
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "whatsapp");
    expect(await shortAgentReply([user("Нужна квартира")], "Поблагодари", undefined, id)).toBeNull();
    expect(f.ai).not.toHaveBeenCalled();
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "instagram");
    await shortAgentReply([user("Нужна квартира")], "Поблагодари", undefined, id);
    expect(f.ai).toHaveBeenCalledTimes(1);
  });
  it("переписка Telegram по id: выключен telegram — null; выключен только telegram_direct — модель зовётся", async () => {
    const id = await chat("TELEGRAM", [user("салом")]);
    expect(await isCustomerAgentConversationOff(id, { CUSTOMER_AGENT_CHANNEL_OFF: "telegram" })).toBe(true);
    expect(await isCustomerAgentConversationOff(id, { CUSTOMER_AGENT_CHANNEL_OFF: "telegram_direct" })).toBe(false);
    expect(await isCustomerAgentConversationOff(id, {})).toBe(false);
  });
  it("режим «только заявки» старого пути: ни разбора намерения моделью, ни ответа режима", async () => {
    const base = { config: { ...LEAD_ONLY_DEFAULTS, enabled: true, workHoursStart: "00:00", workHoursEnd: "24:00" }, channel: "INSTAGRAM",
      subscriberId: `off-lead-${runId}`, linked: false, draft: { stage: "chatting" as const }, propertyId: null, propertyInMessage: false,
      language: "ru" as const, text: "Хочу продать дом", history: [] };
    const classify = vi.fn(async (text: string) => leadOnlyIntentFallback(text));
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "instagram");
    expect(await planLegacyLeadOnlyTurn({ ...base, classifyIntent: classify })).toBeNull();
    expect(classify).not.toHaveBeenCalled();
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "whatsapp");
    expect((await planLegacyLeadOnlyTurn({ ...base, classifyIntent: classify }))?.scenario).toBe("seller");
    expect(classify).toHaveBeenCalled();
  });
  it("комментарии Instagram/Facebook/YouTube и под постами Telegram: бот не отвечает", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "instagram,youtube,telegram");
    expect(await isCommentsBotEnabled("INSTAGRAM")).toBe(false);
    expect(await isCommentsBotEnabled("YOUTUBE")).toBe(false);
    expect(await isTelegramGroupCommentsEnabled({ discussionGroupId: "-100" } as never)).toBe(false);
  });
});
