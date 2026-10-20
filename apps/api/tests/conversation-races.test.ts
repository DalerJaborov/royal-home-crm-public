import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { processMessengerTurn } from "../src/messengers/conversation.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * Гонки в диалоге: клиент пишет быстрее, чем бот успевает ответить.
 *
 * Проверяется главное свойство — НИ ОДНО СЛОВО КЛИЕНТА НЕ ПРОПАДАЕТ. Оба случая
 * найдены проверкой кода 02.08.2026 и оба уже случались бы на живых клиентах:
 *
 * 1. «Сино, 3 хона», через пять секунд — номер телефона. Ветка приёма заявки не
 *    трогала буфер дебаунса: в переписку уходил один телефон, а требования клиента
 *    исчезали. Агент их не видел, и всплывали они позже, приклеенными к следующему
 *    сообщению как только что сказанные.
 *
 * 2. Сбой между сливом буфера и ответом модели (отказ базы, падение ИИ, перезапуск).
 *    Реплика записывалась только ПОСЛЕ успешного ответа — значит при сбое пропадала
 *    совсем: ни ответа, ни следа в переписке, а Meta уже получила 200 и повтора не
 *    будет.
 *
 * Модель подменена: тест не должен ни платить за токены, ни зависеть от сети.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const runId = Date.now().toString(36);
const SUBSCRIBER = `race-${runId}`;
const PHONE = "918001122";

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;
let instagram: CustomerMessengerFixture;
let whatsapp: CustomerMessengerFixture;

beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  // Окно дебаунса в ноль: тест проверяет потерю данных, а не ожидание.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 0 },
  });
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (settingsBefore) {
    await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  }
  // Убираем ВСЕ диалоги прогона, а не только основного собеседника: оставленный
  // «...-burst» — диалог с последней репликой клиента и сегодняшней датой, то есть
  // ровно «зависший». На общей базе его подхватывал чужой тест повтора зависших и
  // падал на чужом канале.
  const convs = await prisma.botConversation.findMany({
    where: { endpointScopeId: { in: [instagram.transport.endpointScopeId, whatsapp.transport.endpointScopeId] }, subscriberId: { startsWith: SUBSCRIBER } },
    select: { id: true, clientId: true },
  });
  if (convs.length > 0) {
    // Отказ модели ставит в очередь ai-reply-retry (conversation.ts). Задание
    // переживает файл и разбирается ПЕРВЫМ тиком любого следующего теста, который
    // двигает очередь, — чужой ответ в чужом моке. Снимаем вместе с диалогами.
    await prisma.backgroundJob.deleteMany({
      where: { dedupeKey: { in: convs.map((c) => `ai-reply-retry:${c.id}`) } },
    });
    const clientIds = convs.map((c) => c.clientId).filter((id): id is string => Boolean(id));
    if (clientIds.length > 0) await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  }
  await instagram.dispose();
  await whatsapp.dispose();
});

// Мок модели живёт на весь файл, поэтому сбрасывается перед каждым тестом: без
// этого `mockResolvedValue` предыдущего теста доигрывал в следующем и подменял
// собой его собственный сценарий.
beforeEach(() => {
  callAi.mockReset();
});

/** Реплики клиента, сохранённые в переписке диалога. */
async function clientLines(): Promise<string[]> {
  const conv = await prisma.botConversation.findFirst({
    where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER },
    select: { messages: true },
  });
  const messages = (Array.isArray(conv?.messages) ? conv!.messages : []) as { role: string; content: string }[];
  return messages.filter((m) => m.role === "user").map((m) => m.content);
}

describe("Клиент пишет требования, следом телефон", () => {
  it("сказанное перед номером попадает в переписку, а не пропадает", async () => {
    callAi.mockResolvedValue({ reply: ["Раҳмат!"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    // ХОДЫ ОБЯЗАНЫ НАЛОЖИТЬСЯ — в этом вся суть. При нулевом окне первый ход успевает
    // закончиться до второго, буфер пуст, и гонки не происходит: тест был бы зелёным
    // и без правки. Поэтому окно ожидания настоящее, а телефон приходит, пока первый
    // вызов ещё спит в нём.
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { botReplyDelaySec: 3, botReplyMaxWaitSec: 6 },
    });

    const first = processMessengerTurn({ ...instagram.turnInput(SUBSCRIBER), text: "Сино, 3 хона" });
    await new Promise((r) => setTimeout(r, 400));
    const accepted = await processMessengerTurn({ ...instagram.turnInput(SUBSCRIBER), text: PHONE });
    const firstResult = await first;

    expect(accepted.accepted).toBe(true);
    // Отвечает ровно один ход: проигравший молчит, иначе клиент получил бы «оставьте
    // номер» одновременно с «заявка принята».
    expect(firstResult.shouldReply).toBe(false);

    const lines = await clientLines();
    expect(lines.join("\n")).toContain("Сино, 3 хона");
    expect(lines.join("\n")).toContain(PHONE);

    await prisma.settings.update({
      where: { id: "singleton" },
      data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 0 },
    });
  });
});

describe("Первые сообщения нового собеседника приходят пачкой", () => {
  it("три одновременных хода на несуществующий диалог не роняют обработку", async () => {
    // Meta доставляет вебхуки пачкой, и все три хода заводят диалог одновременно.
    // `upsert` не атомарен: раньше двое из троих получали P2002 «Unique constraint
    // failed on the fields: (channel, subscriberId)» — то есть первые же слова
    // человека терялись, а повтора от Meta не будет.
    const subscriber = `${SUBSCRIBER}-burst`;
    callAi.mockResolvedValue({ reply: ["Салом!"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    const texts = ["Салом", "хона мекобум", "дар Сино"];
    const settled = await Promise.allSettled(
      texts.map((text) => processMessengerTurn({ ...instagram.turnInput(subscriber), text }))
    );

    const failed = settled.filter((r) => r.status === "rejected");
    expect(failed.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);

    // Диалог ровно один, и ни одно слово клиента не потеряно.
    const rows = await prisma.botConversation.findMany({
      where: { channel: "INSTAGRAM", subscriberId: subscriber },
      select: { id: true, messages: true, clientId: true },
    });
    expect(rows).toHaveLength(1);
    const messages = (Array.isArray(rows[0].messages) ? rows[0].messages : []) as { role: string; content: string }[];
    const said = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    for (const text of texts) expect(said).toContain(text);

  });
});

describe("После приёма заявки бот отвечает коротко, а не ведёт разговор", () => {
  it("на вопрос после приёма приходит короткая отбивка, а не разговор о вариантах", async () => {
    /**
     * Решение владельца 17.08.2026 уточнялось в тот день ДВАЖДЫ, и тест стережёт
     * СЕРЕДИНУ между двумя крайностями:
     *  - сначала бот после приёма вёл полный диалог (предлагал районы, спрашивал
     *    бюджет) параллельно с уже назначенным агентом — «не надо больше общаться»;
     *  - потом замолчал совсем — и человек, написавший через день, не получал ни
     *    строчки: «пусть бот не молчит навсегда… скажет, что у нас есть ваши
     *    контакты, мы перезвоним».
     * Итог: ОДНА короткая вежливая фраза. Ответ есть, разговора нет.
     */
    const subscriber = `${SUBSCRIBER}-brief`;
    const phone = "935002211";

    callAi.mockResolvedValue({ reply: "Раҳмат! Контактҳои Шумо дар мо ҳастанд, агент тамос мегирад", ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const accepted = await processMessengerTurn({ ...instagram.turnInput(subscriber), text: phone });
    expect(accepted.accepted).toBe(true);

    const after = await processMessengerTurn({
      ...instagram.turnInput(subscriber),
      text: "а какие ещё варианты есть в центре?",
    });
    // Ответ ЕСТЬ — тишины после приёма быть не должно.
    expect(after.reply).not.toBe("");
    expect(after.shouldReply).not.toBe(false);
    expect(after.accepted).toBe(true);

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: subscriber },
      select: { id: true, clientId: true, messages: true },
    });
    const messages = (Array.isArray(conv?.messages) ? conv!.messages : []) as { role: string; content: string }[];
    // Слова клиента сохранены — агенту нужно видеть, о чём он спрашивал.
    expect(messages.some((m) => m.role === "user" && m.content.includes("центре"))).toBe(true);
    // И ответ бота тоже лёг в переписку, а не ушёл в никуда.
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toBeTruthy();

  });
});

describe("Тот же телефон уже привязан к другой переписке", () => {
  it("вторая переписка того же клиента принимается, а не падает в заглушку", async () => {
    // 17.08.2026, живой случай: клиент назвал в WhatsApp номер, карточка завелась
    // и привязалась к ТОЙ переписке (BotConversation.clientId уникален). Тот же
    // человек написал позже в Instagram и продиктовал тот же номер — createLeadFromChannel
    // корректно нашёл существующую карточку (дедуп по телефону), но привязка её
    // ко ВТОРОЙ переписке падала P2002 "Unique constraint failed on the fields:
    // (clientId)", и клиент вместо тёплого подтверждения получал заглушку
    // «позвоните нам» — заявка формально не пропадала (карточка и так одна на
    // клиента), но диалог ломался и не отмечался принятым.
    callAi.mockResolvedValue({ reply: ["Раҳмат!"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const phone = "935001199";
    const subA = `${SUBSCRIBER}-dupA`;
    const subB = `${SUBSCRIBER}-dupB`;

    const first = await processMessengerTurn({ ...whatsapp.turnInput(subA), text: phone });
    expect(first.accepted).toBe(true);

    const second = await processMessengerTurn({ ...instagram.turnInput(subB), text: phone });
    expect(second.accepted).toBe(true);
    expect(second.reply).not.toContain("занг занед");

    const convs = await prisma.botConversation.findMany({
      where: {
        OR: [
          { channel: "WHATSAPP", subscriberId: subA },
          { channel: "INSTAGRAM", subscriberId: subB },
        ],
      },
      select: { id: true, clientId: true },
    });
    expect(convs).toHaveLength(2);
    expect(new Set(convs.map((c) => c.clientId)).size).toBe(1);
  });
});

describe("Приём заявки дважды почти одновременно", () => {
  it("отвечает клиенту ровно один раз, а не два подряд", async () => {
    /**
     * 19.08.2026, живой случай: клиент прислал номер телефона, следом почти
     * одновременно — клик по шаблону Instagram (quick-reply). Оба хода идут В
     * ОБХОД дебаунса (acceptLead — решительное действие, ждать окно нельзя), а
     * значит и без его защиты от гонки: клиент получил ДВА «спасибо, агент
     * свяжется» подряд, местами дословно повторённых. Здесь гонка
     * воспроизводится напрямую — два параллельных хода с одним и тем же
     * телефоном на свежий диалог.
     */
    const subscriber = `${SUBSCRIBER}-doubleaccept`;
    const phone = "905112233";
    callAi.mockResolvedValue({ reply: "Раҳмат! Агенти мо ба зудӣ тамос мегирад", ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    const [a, b] = await Promise.all([
      processMessengerTurn({ ...instagram.turnInput(subscriber), text: phone }),
      processMessengerTurn({ ...instagram.turnInput(subscriber), text: phone }),
    ]);

    const replied = [a, b].filter((r) => r.shouldReply !== false);
    expect(replied).toHaveLength(1);
    expect(replied[0].accepted).toBe(true);

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: subscriber },
      select: { id: true, clientId: true, messages: true },
    });
    const messages = (Array.isArray(conv?.messages) ? conv!.messages : []) as { role: string; content: string }[];
    // Ровно одна наша реплика в переписке — не две одинаковых закрывающих подряд.
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);

  });
});

describe("Сбой между приёмом сообщения и ответом", () => {
  it("реплика клиента остаётся в переписке, даже если модель не ответила", async () => {
    const subscriber = `${SUBSCRIBER}-fail`;
    // Отказ поставщика больше не отвечает мгновенной заглушкой «занят» — ход уходит
    // в фоновый повтор (ai/aiRetryQueue.ts), а клиент пока не получает ничего.
    // Проверяем не исключение, а главное — его слова уже в переписке, потому что
    // записываются ДО обращения к модели, а не после успешного ответа.
    // Отказ модели — на ВЕСЬ ход, а не на первый её вызов: ходов к модели за один
    // приём сообщения может быть несколько, и `...Once` оставлял бы остальные на
    // ответе из соседнего теста.
    callAi.mockResolvedValue(null);

    const result = await processMessengerTurn({
      ...instagram.turnInput(subscriber),
      text: "хонаи 2-хонага дар Фирдавсӣ",
    });
    expect(result.shouldReply).toBe(false);

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: subscriber },
      select: { id: true, messages: true },
    });
    const messages = (Array.isArray(conv?.messages) ? conv!.messages : []) as { role: string; content: string }[];
    expect(messages.some((m) => m.role === "user" && m.content.includes("Фирдавсӣ"))).toBe(true);

    if (conv) {
      // Ход ушёл в очередь повтора (ai-reply-retry) — снимаем задание вместе с
      // диалогом: иначе его разберёт первый же тик очереди в соседнем тесте.
      await prisma.backgroundJob.deleteMany({ where: { dedupeKey: `ai-reply-retry:${conv.id}` } });
    }
  });
});
