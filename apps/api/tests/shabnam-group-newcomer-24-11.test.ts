import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * НОВИЧОК В РАБОЧЕЙ ГРУППЕ И ПРИВЯЗКА ПО НОМЕРУ (24.11.2026, жалоба владельца «новички пишут, она не
 * отвечает»). На настоящей базе: одно предложение на Telegram-аккаунт, тишина для привязанных, для
 * неподключённой группы, при «помолчи» и выключенном рубильнике; в личке — привязка только своим
 * контактом, только в окне после `/start staff`, только к одному действующему сотруднику без другого Telegram.
 */
const sent = vi.hoisted(() => ({ buttons: [] as unknown[][], contact: [] as unknown[][], removed: [] as unknown[][] }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  getBotUsername: async () => "royal_test_bot",
  sendMessageWithButtons: async (...args: unknown[]) => { sent.buttons.push(args); return { message_id: 1 }; },
  requestContact: async (...args: unknown[]) => { sent.contact.push(args); return {}; },
  removeKeyboard: async (...args: unknown[]) => { sent.removed.push(args); return {}; },
}));
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => true,
}));
const switchesOff = vi.hoisted(() => new Set<string>());
vi.mock("../src/lib/automationSwitches.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/automationSwitches.js")>();
  return { ...actual, automationSwitchOn: async (...a: Parameters<typeof actual.automationSwitchOn>) => (switchesOff.has(a[0]) ? false : actual.automationSwitchOn(...a)) };
});
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: async () => 1,
}));

const { prisma } = await import("../src/db.js");
const { offerTelegramLinkToNewcomer, resetNewcomerMemoryForTests } = await import("../src/telegram/assistantGroupNewcomer.js");
const { askStaffContactForLink, tryLinkAgentByContact } = await import("../src/lib/telegramAgentLink.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = String(Date.now()).slice(-9);
const chatId = `-100${runId}`;
const agentIds: string[] = [];
const telegramIds: string[] = [];
let directorId = "";
let seq = 0;
const newTelegramId = () => { const id = `77${runId}${++seq}`; telegramIds.push(id); return id; };
const randomPhoneTail = () => String(Math.floor(Math.random() * 90_000_000) + 910_000_000);

const groupMsg = (fromId: string, text = "Салом, ман нав омадам") => ({
  chat: { id: Number(chatId), type: "supergroup" as const }, from: { id: Number(fromId), is_bot: false }, message_id: 10 + seq, text,
});
const privateMsg = (fromId: string, extra: Record<string, unknown> = {}) => ({
  chat: { id: Number(fromId), type: "private" as const }, from: { id: Number(fromId), is_bot: false }, message_id: 1, ...extra,
});

beforeAll(async () => {
  directorId = await createTestAgent(`Директор новичков ${runId}`, "DIRECTOR");
  agentIds.push(directorId);
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  await prisma.assistantTelegramGroup.create({ data: { chatId, registeredByAgentId: directorId } });
});

beforeEach(async () => {
  sent.buttons.length = 0; sent.contact.length = 0; sent.removed.length = 0;
  switchesOff.clear();
  resetNewcomerMemoryForTests();
  await prisma.assistantTelegramGroup.update({ where: { chatId }, data: { proactiveMutedUntil: null } });
});

afterAll(async () => {
  await prisma.assistantTelegramLinkOffer.deleteMany({ where: { telegramUserId: { in: telegramIds } } });
  await prisma.assistantTelegramGroup.deleteMany({ where: { chatId } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("предложение привязки новичку в группе", () => {
  it("один раз на Telegram-аккаунт, кнопкой в личку", async () => {
    const id = newTelegramId();
    expect(await offerTelegramLinkToNewcomer(groupMsg(id) as never, "ambient")).toBe(true);
    expect(sent.buttons).toHaveLength(1);
    const [toChat, text, buttons] = sent.buttons[0] as [string, string, { text: string; url: string }[][]];
    expect(toChat).toBe(chatId);
    expect(text).toContain("Шабнам");
    expect(text).toContain("Ассалому алейкум");
    expect(buttons[0][0].url).toBe("https://t.me/royal_test_bot?start=staff");
    resetNewcomerMemoryForTests(); // как после перезапуска: решает строка в базе
    expect(await offerTelegramLinkToNewcomer(groupMsg(id, "ещё раз") as never, "ambient")).toBe(false);
    expect(await offerTelegramLinkToNewcomer(groupMsg(id, "/start") as never, "start")).toBe(false);
    expect(sent.buttons).toHaveLength(1);
  });

  it("позвал по имени — отвечает и после первого раза", async () => {
    const id = newTelegramId();
    await offerTelegramLinkToNewcomer(groupMsg(id) as never, "ambient");
    expect(await offerTelegramLinkToNewcomer(groupMsg(id, "Шабнам, ты где?") as never, "addressed")).toBe(true);
    expect(sent.buttons).toHaveLength(2);
  });

  it("привязанного сотрудника не трогает", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Агент новичков ${runId}-${seq}`);
    agentIds.push(agentId);
    await prisma.agent.update({ where: { id: agentId }, data: { telegramUserId: id } });
    expect(await offerTelegramLinkToNewcomer(groupMsg(id) as never, "ambient")).toBe(false);
    expect(sent.buttons).toHaveLength(0);
  });

  it("неподключённая группа, бот, пересылка — мимо", async () => {
    const id = newTelegramId();
    expect(await offerTelegramLinkToNewcomer({ ...groupMsg(id), chat: { id: -1009, type: "supergroup" } } as never, "ambient")).toBe(false);
    expect(await offerTelegramLinkToNewcomer({ ...groupMsg(id), from: { id: Number(id), is_bot: true } } as never, "ambient")).toBe(false);
    expect(await offerTelegramLinkToNewcomer({ ...groupMsg(id), forward_origin: { type: "user" } } as never, "ambient")).toBe(false);
    expect(sent.buttons).toHaveLength(0);
  });

  it("«помолчи» и выключенный рубильник глушат реплику, но не /start", async () => {
    const id = newTelegramId();
    await prisma.assistantTelegramGroup.update({ where: { chatId }, data: { proactiveMutedUntil: new Date(Date.now() + 60_000) } });
    expect(await offerTelegramLinkToNewcomer(groupMsg(id) as never, "ambient")).toBe(false);
    await prisma.assistantTelegramGroup.update({ where: { chatId }, data: { proactiveMutedUntil: null } });
    switchesOff.add("shabnamGroupUnaddressedEnabled");
    expect(await offerTelegramLinkToNewcomer(groupMsg(id) as never, "ambient")).toBe(false);
    expect(sent.buttons).toHaveLength(0);
    expect(await offerTelegramLinkToNewcomer(groupMsg(id, "/start") as never, "start")).toBe(true);
  });
});

describe("привязка по номеру в личке", () => {
  it("свой контакт в окне после /start staff привязывает Telegram к сотруднику", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Новичок ${runId}-${seq}`);
    agentIds.push(agentId);
    const tail = randomPhoneTail();
    await prisma.agent.update({ where: { id: agentId }, data: { phone: `+992${tail}` } });
    expect(await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never)).toBe(true);
    expect(sent.contact).toHaveLength(1);
    expect(await tryLinkAgentByContact(privateMsg(id, { contact: { phone_number: `992${tail}`, user_id: Number(id) } }) as never)).toBe(true);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.telegramUserId).toBe(id);
    expect(agent.telegramChatId).toBe(id);
    expect(String(sent.removed.at(-1)?.[1])).toContain("Готово");
    // Окно закрыто: повтор того же контакта уже не привязка, а обычный путь.
    expect(await tryLinkAgentByContact(privateMsg(id, { contact: { phone_number: `992${tail}`, user_id: Number(id) } }) as never)).toBe(false);
  });

  it("без окна контакт идёт клиентским путём (false)", async () => {
    const id = newTelegramId();
    expect(await tryLinkAgentByContact(privateMsg(id, { contact: { phone_number: "+992900000000", user_id: Number(id) } }) as never)).toBe(false);
  });

  it("чужая визитка не привязывает, окно остаётся", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Визитка ${runId}-${seq}`);
    agentIds.push(agentId);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    expect(await tryLinkAgentByContact(privateMsg(id, { contact: { phone_number: agent.phone, user_id: 123 } }) as never)).toBe(true);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).telegramUserId).toBeNull();
    const offer = await prisma.assistantTelegramLinkOffer.findUniqueOrThrow({ where: { telegramUserId: id } });
    expect(offer.contactRequestedAt).not.toBeNull();
  });

  it("номера нет у сотрудников — отказ простыми словами", async () => {
    const id = newTelegramId();
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    expect(await tryLinkAgentByContact(privateMsg(id, { contact: { phone_number: `+7999${randomPhoneTail().slice(2)}`, user_id: Number(id) } }) as never)).toBe(true);
    expect(String(sent.removed.at(-1)?.[1])).toContain("Не нашла этот номер");
  });

  it("номер записан у двоих — не привязывает", async () => {
    const id = newTelegramId();
    const tail = randomPhoneTail();
    const a = await createTestAgent(`Двойник А ${runId}-${seq}`);
    const b = await createTestAgent(`Двойник Б ${runId}-${seq}`);
    agentIds.push(a, b);
    await prisma.agent.update({ where: { id: a }, data: { phone: `+992${tail}` } });
    await prisma.agent.update({ where: { id: b }, data: { phone: tail } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    await tryLinkAgentByContact(privateMsg(id, { contact: { phone_number: `+992${tail}`, user_id: Number(id) } }) as never);
    expect(String(sent.removed.at(-1)?.[1])).toContain("у нескольких сотрудников");
    const rows = await prisma.agent.findMany({ where: { id: { in: [a, b] } }, select: { telegramUserId: true } });
    expect(rows.every(r => r.telegramUserId === null)).toBe(true);
  });

  it("к учётке уже привязан другой Telegram — смена только через профиль", async () => {
    const id = newTelegramId();
    const other = newTelegramId();
    const agentId = await createTestAgent(`Занятый ${runId}-${seq}`);
    agentIds.push(agentId);
    const tail = randomPhoneTail();
    await prisma.agent.update({ where: { id: agentId }, data: { phone: `+992${tail}`, telegramUserId: other } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    await tryLinkAgentByContact(privateMsg(id, { contact: { phone_number: `+992${tail}`, user_id: Number(id) } }) as never);
    expect(String(sent.removed.at(-1)?.[1])).toContain("уже привязан другой Telegram");
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).telegramUserId).toBe(other);
  });

  it("уже привязанному /start staff отвечает «вы уже привязаны», номер не просит", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Привязанный ${runId}-${seq}`);
    agentIds.push(agentId);
    await prisma.agent.update({ where: { id: agentId }, data: { telegramUserId: id, telegramChatId: id } });
    expect(await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never)).toBe(true);
    expect(sent.contact).toHaveLength(0);
    expect(String(sent.removed.at(-1)?.[1])).toContain("уже привязаны");
  });
});
