import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * НОВИЧОК В РАБОЧЕЙ ГРУППЕ И ПРИВЯЗКА ПО НОМЕРУ (24.11.2026, жалоба владельца «новички пишут, она не
 * отвечает»). На настоящей базе: одно предложение на Telegram-аккаунт, тишина для привязанных, для
 * неподключённой группы, при «помолчи» и выключенном рубильнике; в личке — привязка только своим
 * контактом, только в окне после `/start staff`, только к одному действующему сотруднику без другого Telegram.
 */
const sent = vi.hoisted(() => ({ buttons: [] as unknown[][], contact: [] as unknown[][], removed: [] as unknown[][], failNext: false }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  getBotUsername: async () => "royal_test_bot",
  sendMessageWithButtons: async (...args: unknown[]) => {
    if (sent.failNext) { sent.failNext = false; throw new Error("telegram down"); }
    sent.buttons.push(args);
    return { message_id: 1 };
  },
  requestContact: async (...args: unknown[]) => { sent.contact.push(args); return {}; },
  removeKeyboard: async (...args: unknown[]) => { sent.removed.push(args); return {}; },
}));
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => true,
}));
const switchesOff = vi.hoisted(() => new Set<string>());
const switchesOn = vi.hoisted(() => new Set<string>());
vi.mock("../src/lib/automationSwitches.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/automationSwitches.js")>();
  return { ...actual, automationSwitchOn: async (...a: Parameters<typeof actual.automationSwitchOn>) =>
    (switchesOn.has(a[0]) ? true : switchesOff.has(a[0]) ? false : actual.automationSwitchOn(...a)) };
});
// СМС с кодом подтверждения: ловим текст, провайдера нет.
const sms = vi.hoisted(() => ({ texts: [] as { phone: string; text: string }[] }));
vi.mock("../src/lib/sms/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sms/index.js")>()),
  sendSms: async (p: { phone: string; text: string }) => { sms.texts.push({ phone: p.phone, text: p.text }); return { ok: true, id: "t", parts: 1 }; },
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: async () => 1,
}));

const { prisma } = await import("../src/db.js");
const { offerTelegramLinkToNewcomer, claimNewMemberWelcome, NEWCOMER_HINT_COOLDOWN_MS } = await import("../src/telegram/assistantGroupNewcomer.js");
const { askStaffContactForLink, tryLinkAgentByContact, tryConfirmStaffLinkCode } = await import("../src/lib/telegramAgentLink.js");
const { cleanupTelegramLinkOffers, LINK_OFFER_RETENTION_MS } = await import("../src/telegram/assistantGroupNewcomer.js");
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
  sent.buttons.length = 0; sent.contact.length = 0; sent.removed.length = 0; sms.texts.length = 0;
  switchesOff.clear();
  switchesOn.clear();
  switchesOn.add("telegramPhoneLinkEnabled"); // сценарии привязки по номеру; выключенный — отдельным тестом
  sent.failNext = false;
  await prisma.assistantGroupPerson.deleteMany({ where: { chatId } });
  await prisma.assistantTelegramGroup.update({ where: { chatId }, data: { proactiveMutedUntil: null } });
});

afterAll(async () => {
  await prisma.assistantTelegramLinkOffer.deleteMany({ where: { telegramUserId: { in: telegramIds } } });
  await prisma.assistantGroupPerson.deleteMany({ where: { chatId } });
  await prisma.assistantTelegramGroup.deleteMany({ where: { chatId } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

const groupMsgAs = (fromId: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ ...groupMsg(fromId, text), from: { id: Number(fromId), is_bot: false, first_name: "Бехруз" }, ...extra }) as never;

describe("подсказка непривязанному в группе (26.11.2026: на обращение, раз в 6 часов, одним языком)", () => {
  it("5 обращений подряд от непривязанного — не больше одного ответа", async () => {
    const id = newTelegramId();
    const replies: boolean[] = [];
    for (const text of ["Шабнам, салом", "Шабнам?", "Манро пайваст кун", "Иҷро шуд", "Салом алейкум"]) {
      replies.push(await offerTelegramLinkToNewcomer(groupMsgAs(id, text), "addressed"));
    }
    expect(replies.filter(Boolean)).toHaveLength(1);
    expect(sent.buttons).toHaveLength(1);
    const [toChat, text, buttons] = sent.buttons[0] as [string, string, { text: string; url: string }[][]];
    expect(toChat).toBe(chatId);
    expect(text.startsWith("Бехруз, ")).toBe(true);
    expect(text).not.toMatch(/не узнаю|намешиносам|—|\n/u);
    expect(buttons[0][0].url).toBe("https://t.me/royal_test_bot?start=staff");
  });

  it("одновременные обращения — один ответ (победитель гонки один)", async () => {
    const id = newTelegramId();
    const results = await Promise.all([1, 2, 3].map(() => offerTelegramLinkToNewcomer(groupMsgAs(id, "Шабнам, ёрӣ деҳ"), "addressed")));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sent.buttons).toHaveLength(1);
  });

  it("фото, стикер, голосовое без подписи — тишина, даже ответом на её сообщение", async () => {
    const id = newTelegramId();
    const reply_to_message = { chat: { id: Number(chatId) }, from: { id: 1, is_bot: true, username: "royal_test_bot" } };
    for (const extra of [{ photo: [{ file_id: "p" }] }, { sticker: { file_id: "s" } }, { voice: { file_id: "v", duration: 4 } }]) {
      expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "", { text: undefined, reply_to_message, ...extra }), "addressed")).toBe(false);
    }
    expect(sent.buttons).toHaveLength(0);
    // Тишина не тратит его подсказку.
    expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "Шабнам, салом"), "addressed")).toBe(true);
  });

  it("таджикский — ответ и кнопка только по-таджикски", async () => {
    const id = newTelegramId();
    expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "Шабнамчун, хонаҳои заминиро равон кунед"), "addressed")).toBe(true);
    const [, text, buttons] = sent.buttons[0] as [string, string, { text: string; url: string }[][]];
    expect(text).toMatch(/чати шахсӣ/u);
    expect(text).not.toMatch(/напишите|привяжу|личку|Здравствуйте/iu);
    expect(buttons[0][0].text).toMatch(/чати шахсӣ/u);
    expect(buttons[0][0].text).not.toMatch(/Написать|\//u);
  });

  it("русский — ответ только по-русски", async () => {
    const id = newTelegramId();
    expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "Шабнам, привяжи меня пожалуйста"), "addressed")).toBe(true);
    const [, text, buttons] = sent.buttons[0] as [string, string, { text: string; url: string }[][]];
    expect(text).not.toMatch(/[ҳҷқғӯӣ]/iu);
    expect(buttons[0][0].text).toBe("Написать Шабнам в личку");
  });

  it("через 6 часов можно ещё раз — и уже другой фразой", async () => {
    const id = newTelegramId();
    const start = new Date();
    expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "Шабнам, салом"), "addressed", start)).toBe(true);
    expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "Шабнам, салом"), "addressed", new Date(start.getTime() + NEWCOMER_HINT_COOLDOWN_MS - 60_000))).toBe(false);
    expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "Шабнам, салом"), "addressed", new Date(start.getTime() + NEWCOMER_HINT_COOLDOWN_MS + 1_000))).toBe(true);
    expect(sent.buttons).toHaveLength(2);
    expect(sent.buttons[1][1]).not.toBe(sent.buttons[0][1]);
  });

  it("сбой отправки — подсказка не потрачена", async () => {
    const id = newTelegramId();
    sent.failNext = true;
    expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "Шабнам, салом"), "addressed")).toBe(false);
    expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "Шабнам, салом"), "addressed")).toBe(true);
  });

  it("привязанного сотрудника не трогает", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Агент новичков ${runId}-${seq}`);
    agentIds.push(agentId);
    await prisma.agent.update({ where: { id: agentId }, data: { telegramUserId: id } });
    expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "Шабнам, салом"), "addressed")).toBe(false);
    expect(sent.buttons).toHaveLength(0);
  });

  it("неподключённая группа, бот, пересылка — мимо", async () => {
    const id = newTelegramId();
    const base = groupMsg(id, "Шабнам, салом");
    expect(await offerTelegramLinkToNewcomer({ ...base, chat: { id: -1009, type: "supergroup" } } as never, "addressed")).toBe(false);
    expect(await offerTelegramLinkToNewcomer({ ...base, from: { id: Number(id), is_bot: true } } as never, "addressed")).toBe(false);
    expect(await offerTelegramLinkToNewcomer({ ...base, forward_origin: { type: "user" } } as never, "addressed")).toBe(false);
    expect(sent.buttons).toHaveLength(0);
  });

  it("/start — тот же лимит", async () => {
    const id = newTelegramId();
    expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "/start"), "start")).toBe(true);
    expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "Шабнам, салом"), "addressed")).toBe(false);
  });
});

describe("приветствие нового участника — один раз на человека в группе", () => {
  it("тот же человек приглашён второй раз — 0 новых; боты не считаются", async () => {
    const a = newTelegramId();
    const b = newTelegramId();
    expect(await claimNewMemberWelcome(chatId, [{ id: Number(a), is_bot: false }, { id: 1, is_bot: true }])).toBe(1);
    expect(await claimNewMemberWelcome(chatId, [{ id: Number(a), is_bot: false }])).toBe(0);
    expect(await claimNewMemberWelcome(chatId, [{ id: Number(a), is_bot: false }, { id: Number(b), is_bot: false }])).toBe(1);
  });

  it("строка уже была от подсказки — приветствие всё равно один раз", async () => {
    const id = newTelegramId();
    expect(await offerTelegramLinkToNewcomer(groupMsgAs(id, "Шабнам, салом"), "addressed")).toBe(true);
    expect(await claimNewMemberWelcome(chatId, [{ id: Number(id), is_bot: false }])).toBe(1);
    expect(await claimNewMemberWelcome(chatId, [{ id: Number(id), is_bot: false }])).toBe(0);
  });
});

describe("рубильник «Привязка Telegram по номеру» выключен (по умолчанию)", () => {
  it("по умолчанию в базе выключен", async () => {
    const { automationSwitchOn } = await vi.importActual<typeof import("../src/lib/automationSwitches.js")>("../src/lib/automationSwitches.js");
    const row = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { telegramPhoneLinkEnabled: true } });
    expect(row.telegramPhoneLinkEnabled).toBe(false);
    expect(await automationSwitchOn("telegramPhoneLinkEnabled")).toBe(false);
  });

  it("в группе — путь через профиль, без кнопки ?start=staff", async () => {
    switchesOn.clear();
    const id = newTelegramId();
    expect(await offerTelegramLinkToNewcomer(groupMsg(id, "Шабнам, ёрӣ деҳ") as never, "addressed")).toBe(true);
    const [, text, buttons] = sent.buttons[0] as [string, string, { text: string; url: string }[][]];
    expect(text).toMatch(/Профил → Telegram|профили CRM/u);
    expect(JSON.stringify(buttons)).not.toContain("start=staff");
  });

  it("«привяжи меня» — путь: профиль или ссылка «Подключить к Шабнам» от руководителя, без срока цифрой", async () => {
    switchesOn.clear();
    const id = newTelegramId();
    expect(await offerTelegramLinkToNewcomer(groupMsg(id, "Шабнам, привяжи меня") as never, "addressed")).toBe(true);
    const text = String(sent.buttons[0][1]);
    expect(text).toContain("Профиль → Telegram");
    expect(text).toContain("«Подключить к Шабнам»");
    expect(text).not.toMatch(/\d/u);
  });

  it("/start staff в личке номер не просит, контакт в старом окне не привязывает", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Выключено ${runId}-${seq}`);
    agentIds.push(agentId);
    const tail = randomPhoneTail();
    await prisma.agent.update({ where: { id: agentId }, data: { phone: `+992${tail}` } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never); // окно открыто при ВКЛ
    switchesOn.clear();
    expect(await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never)).toBe(true);
    expect(sent.contact).toHaveLength(1);
    expect(String(sent.removed.at(-1)?.[1])).toContain("Привязка по номеру сейчас выключена");
    expect(await tryLinkAgentByContact(privateMsg(id, { contact: { phone_number: `992${tail}`, user_id: Number(id) } }) as never)).toBe(true);
    expect(sms.texts).toHaveLength(0);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).telegramUserId).toBeNull();
  });
});

describe("привязка по номеру в личке", () => {
  const contactOf = (id: string, phone: string) => privateMsg(id, { contact: { phone_number: phone, user_id: Number(id) } });
  const lastCode = () => /(\d{6})/.exec(sms.texts.at(-1)?.text ?? "")?.[1] ?? "";

  it("свой контакт → код в СМС на номер учётки → верный код привязывает", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Новичок ${runId}-${seq}`);
    agentIds.push(agentId);
    const tail = randomPhoneTail();
    await prisma.agent.update({ where: { id: agentId }, data: { phone: `+992${tail}` } });
    expect(await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never)).toBe(true);
    expect(sent.contact).toHaveLength(1);
    expect(await tryLinkAgentByContact(contactOf(id, `992${tail}`) as never)).toBe(true);
    // Только контакт — ещё не привязка.
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).telegramUserId).toBeNull();
    expect(sms.texts).toHaveLength(1);
    expect(sms.texts[0].phone).toBe(`+992${tail}`);
    expect(sms.texts[0].text).toContain("код привязки Telegram");
    expect(String(sent.removed.at(-1)?.[1])).toContain("Отправила код в СМС");
    // Неверный код — не привязка, окно живо.
    const wrong = lastCode() === "000000" ? "111111" : "000000";
    expect(await tryConfirmStaffLinkCode(privateMsg(id, { text: wrong }) as never)).toBe(true);
    expect(String(sent.removed.at(-1)?.[1])).toContain("Код не подошёл");
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).telegramUserId).toBeNull();
    expect(await tryConfirmStaffLinkCode(privateMsg(id, { text: lastCode() }) as never)).toBe(true);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.telegramUserId).toBe(id);
    expect(agent.telegramChatId).toBe(id);
    expect(String(sent.removed.at(-1)?.[1])).toContain("Готово");
    // Окно закрыто: тот же контакт и те же цифры идут обычным путём.
    expect(await tryLinkAgentByContact(contactOf(id, `992${tail}`) as never)).toBe(false);
    expect(await tryConfirmStaffLinkCode(privateMsg(id, { text: lastCode() }) as never)).toBe(false);
  });

  it("шесть цифр без отправленного кода — не наше (клиент), false", async () => {
    const id = newTelegramId();
    expect(await tryConfirmStaffLinkCode(privateMsg(id, { text: "123456" }) as never)).toBe(false);
  });

  it("код просрочен — не привязывает, просит начать заново", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Просрочка ${runId}-${seq}`);
    agentIds.push(agentId);
    const tail = randomPhoneTail();
    await prisma.agent.update({ where: { id: agentId }, data: { phone: `+992${tail}` } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    await tryLinkAgentByContact(contactOf(id, `+992${tail}`) as never);
    await prisma.assistantTelegramLinkOffer.update({ where: { telegramUserId: id }, data: { codeSentAt: new Date(Date.now() - 6 * 60_000) } });
    expect(await tryConfirmStaffLinkCode(privateMsg(id, { text: lastCode() }) as never)).toBe(true);
    expect(String(sent.removed.at(-1)?.[1])).toContain("Код истёк");
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).telegramUserId).toBeNull();
  });

  it("окно для контакта просрочено — контакт идёт клиентским путём, кода нет", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Окно ${runId}-${seq}`);
    agentIds.push(agentId);
    const tail = randomPhoneTail();
    await prisma.agent.update({ where: { id: agentId }, data: { phone: `+992${tail}` } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    await prisma.assistantTelegramLinkOffer.update({ where: { telegramUserId: id }, data: { contactRequestedAt: new Date(Date.now() - 31 * 60_000) } });
    expect(await tryLinkAgentByContact(contactOf(id, `+992${tail}`) as never)).toBe(false);
    expect(sms.texts).toHaveLength(0);
  });

  it("контакт без user_id — не свой, кода нет", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Без user_id ${runId}-${seq}`);
    agentIds.push(agentId);
    const tail = randomPhoneTail();
    await prisma.agent.update({ where: { id: agentId }, data: { phone: `+992${tail}` } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    expect(await tryLinkAgentByContact(privateMsg(id, { contact: { phone_number: `+992${tail}` } }) as never)).toBe(true);
    expect(String(sent.contact.at(-1)?.[1])).toContain("собственный номер");
    expect(sms.texts).toHaveLength(0);
  });

  it.each(["DIRECTOR", "ADMIN"] as const)("%s по номеру не привязывается никогда, код не уходит", async (role) => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Владелец ${role} ${runId}-${seq}`);
    agentIds.push(agentId);
    const tail = randomPhoneTail();
    await prisma.agent.update({ where: { id: agentId }, data: { phone: `+992${tail}`, role } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    expect(await tryLinkAgentByContact(contactOf(id, `992${tail}`) as never)).toBe(true);
    expect(String(sent.removed.at(-1)?.[1])).toContain("Директора и администратора по номеру не привязываю");
    expect(sms.texts).toHaveLength(0);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).telegramUserId).toBeNull();
  });

  it("иностранный номер с теми же девятью цифрами не находит таджикскую учётку", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Девять цифр ${runId}-${seq}`);
    agentIds.push(agentId);
    const tail = randomPhoneTail();
    await prisma.agent.update({ where: { id: agentId }, data: { phone: `+992${tail}` } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    expect(await tryLinkAgentByContact(contactOf(id, `998${tail}`) as never)).toBe(true);
    expect(String(sent.removed.at(-1)?.[1])).toContain("Не нашла этот номер");
    expect(sms.texts).toHaveLength(0);
  });

  it("номер, записанный с нулём (0XXXXXXXXX), находится", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`С нулём ${runId}-${seq}`);
    agentIds.push(agentId);
    const tail = randomPhoneTail();
    await prisma.agent.update({ where: { id: agentId }, data: { phone: `0${tail}` } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    expect(await tryLinkAgentByContact(contactOf(id, `992${tail}`) as never)).toBe(true);
    expect(sms.texts).toHaveLength(1);
  });

  it("чат уже привязан к другой учётке — захват не перезаписывает чужой чат", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Чужой чат ${runId}-${seq}`);
    agentIds.push(agentId);
    const tail = randomPhoneTail();
    await prisma.agent.update({ where: { id: agentId }, data: { phone: `+992${tail}` } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    await tryLinkAgentByContact(contactOf(id, `992${tail}`) as never);
    // Пока код шёл, к учётке привязали другой чат (из профиля).
    const otherChat = newTelegramId();
    await prisma.agent.update({ where: { id: agentId }, data: { telegramChatId: otherChat } });
    await tryConfirmStaffLinkCode(privateMsg(id, { text: lastCode() }) as never);
    expect(String(sent.removed.at(-1)?.[1])).toContain("уже привязан другой Telegram");
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.telegramChatId).toBe(otherChat);
    expect(agent.telegramUserId).toBeNull();
  });

  it("код прислан дважды одновременно: привязка одна, второе сообщение код не тратит и не пугает ошибкой", async () => {
    const id = newTelegramId();
    const agentId = await createTestAgent(`Дважды ${runId}-${seq}`);
    agentIds.push(agentId);
    const tail = randomPhoneTail();
    await prisma.agent.update({ where: { id: agentId }, data: { phone: `+992${tail}` } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    await tryLinkAgentByContact(contactOf(id, `992${tail}`) as never);
    sent.removed.length = 0;
    const code = lastCode();
    const results = await Promise.all([
      tryConfirmStaffLinkCode(privateMsg(id, { text: code }) as never),
      tryConfirmStaffLinkCode(privateMsg(id, { text: code, message_id: 2 }) as never),
    ]);
    // Второе либо застало занятое окно (true, без ответа), либо уже закрытое (false — не наше сообщение).
    expect(results).toContain(true);
    const texts = sent.removed.map(call => String(call[1]));
    expect(texts.filter(t => t.includes("Готово"))).toHaveLength(1);
    expect(texts.some(t => t.includes("Код не подошёл") || t.includes("Код истёк"))).toBe(false);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).telegramUserId).toBe(id);
    const row = await prisma.loginSmsCode.findFirstOrThrow({ where: { agentId, purpose: "telegram-link" } });
    expect(row.attempts).toBe(0);
  });

  it("/start staff освежает отметку: уборка не снесёт окно посреди привязки", async () => {
    const id = newTelegramId();
    await prisma.assistantTelegramLinkOffer.create({ data: { telegramUserId: id, chatId, offeredAt: new Date(Date.now() - LINK_OFFER_RETENTION_MS + 60_000) } });
    await askStaffContactForLink(privateMsg(id, { text: "/start staff" }) as never);
    const offer = await prisma.assistantTelegramLinkOffer.findUniqueOrThrow({ where: { telegramUserId: id } });
    expect(Date.now() - offer.offeredAt.getTime()).toBeLessThan(60_000);
    await cleanupTelegramLinkOffers(new Date(Date.now() + 120_000));
    expect(await prisma.assistantTelegramLinkOffer.findUnique({ where: { telegramUserId: id } })).not.toBeNull();
  });

  it("отметки старше 90 дней убираются", async () => {
    const id = newTelegramId();
    await prisma.assistantTelegramLinkOffer.create({ data: { telegramUserId: id, chatId, offeredAt: new Date(Date.now() - LINK_OFFER_RETENTION_MS - 60_000) } });
    await cleanupTelegramLinkOffers();
    expect(await prisma.assistantTelegramLinkOffer.findUnique({ where: { telegramUserId: id } })).toBeNull();
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
