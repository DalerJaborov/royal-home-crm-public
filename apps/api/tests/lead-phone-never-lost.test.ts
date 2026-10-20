import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { processMessengerTurn as actualProcessMessengerTurn } from "../src/messengers/conversation.js";
import { extractVolunteeredPhone, unparsedPhoneAttempt } from "../src/ai/leadQualifier.js";
import { findPhonesWithoutLead } from "../src/lib/phoneLeadWatchdog.js";

/**
 * НОМЕР, ОСТАВЛЕННЫЙ ЧЕЛОВЕКОМ, НЕ ПРОПАДАЕТ НИ ПРИ КАКОМ МОЛЧАНИИ БОТА
 * (03.09.2026, разбор двух живых потерь в Instagram).
 *
 * Что случилось. Разбор номера и приём заявки жили НИЖЕ всех отсечек
 * conversation.ts, а каждая из них написана про ОТВЕТ бота: рубильник канала,
 * пауза оператора, «похоже на рассылку», «не по теме», суточный предел ИИ.
 * Клиент присылал телефон, сообщение честно ложилось в переписку — и всё:
 * карточки не возникало, лид не попадал ни в раздачу, ни в поиск по номеру.
 * Второй случай — «000001008»: местный набор с ведущими нулями не проходил
 * строгий разбор вовсе, и заявки не было даже при говорящем боте. Это же число
 * позже (в тот же день) стало поводом для ВТОРОЙ правки: правило «значащая часть
 * начинается с 3-9» само оказалось неверным (владелец поправил — у MegaFon есть
 * код «01»), а различить «настоящий код с нуля» от «неполного номера» по цифрам
 * нельзя в принципе. Поэтому «000001008» больше не отвергается — теперь он
 * ПРИНИМАЕТСЯ как валидный номер (тест ниже это и проверяет), а разбор
 * ограничивается только ДЛИНОЙ, без догадок о содержании — см. leadQualifier.ts.
 *
 * Три ступени защиты, по одной на каждый провал:
 *  1) разбор номера (ai/leadQualifier.ts) знает местный набор через ноль и
 *     принимает любую девятизначную последовательность, каким бы кодом она ни
 *     начиналась, а непонятную по ДЛИНЕ цепочку честно называет непонятной,
 *     вместо того чтобы выдумать телефон, по которому никто не дозвонится;
 *  2) приём заявки не зависит от разговорчивости бота (messengers/conversation.ts);
 *  3) сторож (lib/phoneLeadWatchdog.ts) ловит ФАКТ «номер есть, карточки нет»
 *     независимо от причины — в том числе причин, которых мы ещё не знаем.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

let messengerFixture: CustomerMessengerFixture;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...messengerFixture.turnInput(input.subscriberId) });
}

const runId = Date.now().toString(36);
const SUB_OFF = `phlost-off-${runId}`;
const SUB_PAUSED = `phlost-paused-${runId}`;
const SUB_WATCH = `phlost-watch-${runId}`;
const clientIds: string[] = [];

type ToggleSnapshot = { botEnabled: boolean; botInstagramEnabled: boolean; botReplyDelaySec: number; botReplyMaxWaitSec: number };
let saved: ToggleSnapshot | null = null;

async function settings(patch: Partial<ToggleSnapshot>): Promise<void> {
  const current = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botEnabled: true, botInstagramEnabled: true, botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  saved ??= current;
  await prisma.settings.update({ where: { id: "singleton" }, data: patch });
}

beforeAll(async () => {
  messengerFixture = await createCustomerMessengerFixture("INSTAGRAM");
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  // Watchdog data is intentionally legacy/raw; remove only this run's row.
  const watched = await prisma.botConversation.findMany({ where: { channel: "INSTAGRAM", subscriberId: SUB_WATCH }, select: { id: true } });
  const watchedInquiries = await prisma.customerInquiry.findMany({ where: { conversationId: { in: watched.map(row => row.id) } }, select: { id: true } });
  await prisma.botConversation.deleteMany({ where: { id: { in: watched.map(row => row.id) } } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: watchedInquiries.map(row => row.id) } } });
  if (clientIds.length) await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await messengerFixture?.dispose();
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
});

beforeEach(() => {
  callAi.mockReset();
});

/** Карточка, к которой привязался диалог (и её же в уборку). */
async function cardOf(subscriberId: string): Promise<{ id: string; phone: string } | null> {
  const conv = await prisma.botConversation.findFirst({
    where: { channel: "INSTAGRAM", subscriberId },
    select: { clientId: true },
  });
  if (!conv?.clientId) return null;
  clientIds.push(conv.clientId);
  return prisma.client.findUnique({ where: { id: conv.clientId }, select: { id: true, phone: true } });
}

describe("ступень 1: разбор номера", () => {
  it("местный набор через ноль — это телефон, а не мусор", () => {
    expect(extractVolunteeredPhone("рақамам 0937001122")).toBe("+992937001122");
    expect(extractVolunteeredPhone("занг занед 0 93 700 11 22")).toBe("+992937001122");
    expect(extractVolunteeredPhone("мой 992 0 93 700 11 22")).toBe("+992937001122");
  });

  it("прежние правила не сдвинулись: цена и площадь номером не становятся", () => {
    expect(extractVolunteeredPhone("бюджет 1 100 000 сомони")).toBeNull();
    expect(extractVolunteeredPhone("96 кв/м, 6 этаж, 2024 год")).toBeNull();
  });

  it("«000001008» больше не отвергается — код оператора может начинаться с нуля", () => {
    // Правку 03.09.2026 отменила правка того же дня: «значащая часть начинается
    // с 3-9» опиралась на список кодов, который оказался неполным (у MegaFon
    // есть «01»). Различить «настоящий код с нуля» и «неполный номер» по одним
    // цифрам нельзя — значит, гадать нельзя, и «000001008» принимается.
    expect(extractVolunteeredPhone("000001008")).toBe("+992000001008");
  });

  it("непонятную по ДЛИНЕ цепочку цифр не выдумываем, а показываем человеку", () => {
    // «99298544494» — код страны есть, а после него только восемь цифр: этого не
    // хватает вне зависимости от того, какой код операторов появится завтра.
    expect(extractVolunteeredPhone("99298544494")).toBeNull();
    expect(unparsedPhoneAttempt("Номер телефона 99298544494")).toBe("99298544494");
  });

  it("разобранный номер тревоги не поднимает, цена — тоже", () => {
    expect(unparsedPhoneAttempt("мой 980001015")).toBeNull();
    expect(unparsedPhoneAttempt("хочу за 100000000 сомони")).toBeNull();
  });
});

describe("ступень 2: бот молчит — заявка всё равно принимается", () => {
  it("рубильник канала выключен, а номер стал карточкой без единого слова клиенту", async () => {
    await settings({ botEnabled: true, botInstagramEnabled: false, botReplyDelaySec: 0, botReplyMaxWaitSec: 5 });

    const result = await processMessengerTurn({
      channel: "INSTAGRAM",
      subscriberId: SUB_OFF,
      text: "980001015 вотс",
    });

    expect(result.accepted).toBe(true);
    expect(result.shouldReply).toBe(false);
    expect(result.reply).toBe("");

    const card = await cardOf(SUB_OFF);
    expect(card?.phone).toBe("+992980001015");
  });

  it("диалог на паузе у оператора — карточка появляется, бот по-прежнему молчит", async () => {
    await settings({ botEnabled: true, botInstagramEnabled: true, botReplyDelaySec: 0, botReplyMaxWaitSec: 5 });
    // Диалог, который оператор забрал себе: ровно та ветка, что потеряла лид.
    await prisma.botConversation.update({
      where: { id: (await messengerFixture.ensureConversation(SUB_PAUSED)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId: SUB_PAUSED,
        name: "Заррина",
        messages: [{ role: "user", content: "Салом, хона мекобам" }],
        pausedUntil: new Date(Date.now() + 60 * 60_000),
        lastMessageAt: new Date(),
      },
    });

    const result = await processMessengerTurn({
      channel: "INSTAGRAM",
      subscriberId: SUB_PAUSED,
      text: "мой номер 900001016",
    });

    expect(result.accepted).toBe(true);
    expect(result.shouldReply).toBe(false);

    const card = await cardOf(SUB_PAUSED);
    expect(card?.phone).toBe("+992900001016");

    // Сообщение клиента с номером обязано быть видно агенту в переписке.
    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: SUB_PAUSED },
      select: { messages: true },
    });
    const messages = (conv?.messages ?? []) as { role: string; content: string }[];
    expect(messages.some((m) => m.role === "user" && m.content.includes("900001016"))).toBe(true);
    // И ни одной реплики бота: пауза оператора не нарушена.
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
  });
});

describe("ступень 3: сторож «номер есть, карточки нет»", () => {
  it("видит свежую переписку с номером и без карточки", async () => {
    await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: SUB_WATCH,
        name: "shadownight_77",
        messages: [
          { role: "assistant", content: "Рақами телефонатонро нависед" },
          { role: "user", content: "980001015 вотс" },
        ],
        lastMessageAt: new Date(),
      },
    });

    const found = await findPhonesWithoutLead();
    const mine = found.find((f) => f.conversationId && f.name === "shadownight_77");
    expect(mine).toBeTruthy();
    expect(mine?.phone).toBe("+992980001015");
  });

  it("непонятный по ДЛИНЕ номер тоже доходит до человека — с тем, что клиент прислал на самом деле", async () => {
    await prisma.botConversation.update({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId: SUB_WATCH } },
      data: {
        messages: [
          { role: "assistant", content: "Рақами телефонатонро нависед" },
          // «000001008» сюда больше не годится — теперь это ПРИНЯТЫЙ номер (см.
          // ступень 1 выше), и сторож нашёл бы `phone`, а не `raw`. Восемь значащих
          // цифр после кода страны — короче на одну вне зависимости от того, какой
          // код операторов появится завтра.
          { role: "user", content: "Номер телефона 99298544494" },
        ],
      },
    });

    const found = await findPhonesWithoutLead();
    const mine = found.find((f) => f.name === "shadownight_77");
    expect(mine?.phone).toBeNull();
    expect(mine?.raw).toBe("99298544494");
  });

  it("диалог с уже заведённой карточкой сторожа не беспокоит", async () => {
    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: SUB_OFF },
      select: { id: true },
    });
    const found = await findPhonesWithoutLead();
    expect(found.some((f) => f.conversationId === conv?.id)).toBe(false);
  });
});
