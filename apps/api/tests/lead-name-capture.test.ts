import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { prisma } from "../src/db.js";
import { processMessengerTurn as actualProcessMessengerTurn } from "../src/messengers/conversation.js";
let fixture: CustomerMessengerFixture | undefined;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...fixture!.turnInput(input.subscriberId) });
}

/**
 * ИМЯ КЛИЕНТА — ОДИН ДОПОЛНИТЕЛЬНЫЙ ВОПРОС, ЗАПАСНОЕ ИМЯ ПО НОМЕРУ КАРТОЧКИ.
 *
 * Владелец 19.08.2026, пересмотр решения от 16-17.08: агенты путают клиентов,
 * когда все карточки называются одинаково («Клиент Instagram»). Теперь без
 * настоящего имени карточка получает «Покупатель ПК-000042»/«Продавец ПР-000042» (номер
 * карточки, тот же, что показан в самой карточке), а закрывающее сообщение
 * один раз дополнительно спрашивает имя — ответит на следующем ходу, оно
 * дописывается в карточку.
 *
 * ОБНОВЛЕНО 30.08.2026, две правки владельца сразу:
 *  — тип лида решает КОД: голый номер без единого слова о покупке или продаже —
 *    это «прочее обращение» (ПО), а не «покупатель» наугад. Раньше любой
 *    неопознанный intent молча становился BUYER и уходил живому агенту;
 *  — номер в заглушке пишется тем же форматом, что в карточке и в поиске
 *    (`ПО-024411`), а не своим «№0058» на четыре знака: заглушка — это ссылка
 *    на номер карточки, и её должно быть видно куда скопировать.
 *
 * ОБНОВЛЕНО 18.09.2026 (разбор пре-существующего падения тестов). Два разных
 * факта сошлись и сломали все три сценария этого файла:
 *
 *  1. Голый номер телефона (или номер, зашитый в первое же сообщение вместе с
 *     именем — «Меня зовут Далер, мой номер …») ловит `extractVolunteeredPhone`
 *     ДО того, как разговор вообще доходит до квалификатора: заявка оформляется
 *     мгновенно, без единого хода модели (`messengers/conversation.ts`, «Ступень
 *     2 защиты от потерянного номера» / ветка `phoneForLead`). Это не побочный
 *     эффект — «голый номер без единого слова о покупке/продаже» именно поэтому
 *     решением от 30.08.2026 остаётся kind=OTHER: `draft.intent` в этот момент
 *     ещё пуст (диалог только начался), и подмена `intent`/`confident` в моковом
 *     ответе модели тут ничего не меняет — до этого ответа дело просто не доходит.
 *  2. С 17.09.2026 (владелец, «НИКАКОГО агент свяжется для любого kind=OTHER»)
 *     закрытие для OTHER — готовый нейтральный текст без звонка модели вовсе:
 *     значит и вопрос «как вас зовут» для НЕЁ больше не звучит никогда. Это не
 *     баг: карточке «Прочего обращения» агент не назначается, спрашивать имя
 *     ради звонка, которого не будет, незачем (отдельно проверено в
 *     other-city-honest-intake.test.ts).
 *
 * «Спроси имя → спроси доп. номер» по-прежнему живо и работает — но только для
 * ПОКУПАТЕЛЯ/ПРОДАВЦА, чей `intent` уже установлен ходом РАНЬШЕ, чем пришёл сам
 * номер (обычный порядок живого диалога: «здравствуйте, ищу квартиру» → … →
 * «вот мой номер»). Поэтому каждый сценарий теперь начинается с отдельного,
 * предшествующего хода с явным покупательским намерением — ровно то, что
 * произошло бы в жизни ДО того, как человек продиктует номер.
 *
 * ДЕБАУНС — РЕАЛЬНАЯ ПАУЗА, А НЕ БАГ ТЕСТА. Предшествующий ход — обычное
 * сообщение без номера, и в отличие от «мгновенного приёма по номеру» оно идёт
 * через debounceAndMerge (окно склейки быстрых сообщений подряд) — по умолчанию
 * 25 секунд реального ожидания. Раньше файл никогда не отправлял такой ход и
 * этой настройки не касался вовсе. Тот же приём, что уже есть в
 * bot-scenarios.test.ts и других файлах с обычным чатом: `botReplyDelaySec: 0`.
 *
 * ТРЕТИЙ ФАКТ, НАЙДЕННЫЙ 18.09.2026 ТЕМ ЖЕ РАЗБОРОМ И ОТМЕНЁННЫЙ В ТОТ ЖЕ ДЕНЬ.
 * Приём заявки по-настоящему НАЗНАЧАЕТ агента (обычная очередь KPI), и с
 * 05.09.2026 по 18.09.2026 здесь стояло `hasActiveAssignedAgent`: бот молчал
 * на любое сообщение клиенту с закреплённым агентом, не дожидаясь первого
 * РЕАЛЬНОГО контакта — из-за чего механика «спроси имя/доп. номер следующим
 * ходом» (19.08.2026) почти никогда не успевала сработать: агент назначается
 * тем же ходом, что и заявка, и следующее сообщение клиента бот уже не видел.
 *
 * Владелец, узнав об этом конфликте, отменил `hasActiveAssignedAgent`
 * целиком (см. `lib/conversationState.ts`, `messengers/conversation.ts`):
 * бот теперь ведёт диалог полноценно, пока агент РЕАЛЬНО не свяжется с
 * клиентом сам — вручную в переписке или по звонку (`callAttempt: "TALKED"`,
 * см. `pauseConversationsAfterRealContact` в `lib/conversationDelivery.ts`).
 * Ниже в файле — как раз тот случай, ради которого это всё затевалось: заявка
 * принята, агент уже назначен, но ещё не позвонил, а «донспросить имя»
 * снова успевает сработать, потому что бот больше не молчит раньше времени.
 */
const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const runId = Date.now().toString(36);
const SUBSCRIBER = `namecap-${runId}`;
const clientIds: string[] = [];
let savedSettings: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  savedSettings = settings;
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 5 },
  });
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  if (clientIds.length) await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await fixture?.dispose();
});

/** Ход, устанавливающий покупательское намерение ДО того, как придёт номер —
 *  как в живом диалоге. Без этого хода decideLeadKind (ai/leadKind.ts) не
 *  видит ничего, кроме голого номера, и законно классифицирует kind=OTHER
 *  (решение 30.08.2026) — а с 17.09.2026 OTHER не задаёт вопросов вовсе. */
async function establishBuyerIntent(subscriberId: string): Promise<void> {
  callAi.mockResolvedValueOnce({ reply: "Салом! Дар кадом ноҳия ҷустуҷӯ мекунед?", intent: "buy", ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
  await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Хочу купить квартиру" });
}

describe("Приём заявки без имени", () => {
  it("карточка получает заглушку с номером (ПК-000042), а бот один раз донспрашивает имя", async () => {
    await establishBuyerIntent(SUBSCRIBER);

    callAi.mockResolvedValue({ reply: "Раҳмат барои рақам! Агенти мо ба зудӣ тамос мегирад. Ростӣ, номатон чӣ?" });

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: SUBSCRIBER, text: "905112240" });
    expect(result.accepted).toBe(true);
    expect(result.reply).toContain("?");

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER },
      select: { clientId: true },
    });
    expect(conv?.clientId).toBeTruthy();
    if (conv?.clientId) clientIds.push(conv.clientId);

    const client = await prisma.client.findUnique({ where: { id: conv!.clientId! }, select: { fullName: true } });
    // Префикс покупателя переименован КЛ → ПК 31.08.2026 (см. lib/placeholderName.ts).
    expect(client?.fullName).toMatch(/^(Покупатель|Продавец|Прочее обращение) (ПК|ПР|ПО)-\d{6}$/);
  });

  it("следующим ходом агент уже назначен, но бот всё равно отвечает и ловит имя (владелец 18.09.2026)", async () => {
    // 18.09.2026: hasActiveAssignedAgent ОТМЕНЕНА владельцем (см.
    // conversationState.ts) — назначенный, но реально ещё не связавшийся
    // агент больше не гасит бота. Разговор идёт обычным квалификатором
    // (lead-qualify), а не коротким «агент свяжется» — и «Ростӣ, номатон чӣ?»
    // из прошлого хода ловится ASKED_FOR_NAME в редакции 18.09.2026.
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: "Хуб, Дилноза! Дар кадом ноҳия ҷустуҷӯ мекунед?", ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: SUBSCRIBER, text: "Дилноза" });
    expect(result.shouldReply).not.toBe(false);
    expect(callAi.mock.calls.some((call) => call[0]?.endpoint === "lead-qualify")).toBe(true);

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER },
      select: { clientId: true },
    });
    const client = await prisma.client.findUnique({ where: { id: conv!.clientId! }, select: { fullName: true } });
    // Имя дописалось: захват имени по-прежнему живёт в ветке «заявка уже
    // принята» (см. conversation.ts) — она теперь выполняется, пока агент
    // реально не связался, а не только пока его не назначили.
    expect(client?.fullName).toBe("Дилноза");
  });

  it("дальнейшее «спасибо» — бот всё ещё отвечает, реального контакта агента ещё не было", async () => {
    // «Не как робот, не повторять агент вам перезвонит» (владелец 18.09.2026) —
    // молчание теперь наступает только после pauseConversationsAfterRealContact.
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: "Пожалуйста! Если появятся вопросы — пишите.", ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: SUBSCRIBER, text: "Спасибо!" });
    expect(result.shouldReply).not.toBe(false);
    expect(callAi.mock.calls.some((call) => call[0]?.endpoint === "lead-qualify")).toBe(true);
  });
});

/**
 * ДОПОЛНИТЕЛЬНЫЕ НОМЕРА — ПЕРВЫЙ РУБЕЖ ЗАЩИТЫ, ПОСЛЕ ИМЕНИ (владелец 19.08.2026,
 * уточнение порядка тем же вечером).
 *
 * Живой случай: клиент позвонил с номера, которого не было в CRM, и расшифровка
 * звонка не смогла разобрать произнесённый номер — карточки не объединились.
 * Вместо того чтобы полагаться на слух ИИ по телефону, бот теперь сам спрашивает
 * про доп. номера, пока клиент печатает текстом — это надёжнее голоса.
 *
 * НО не в одном сообщении с вопросом об имени — владелец явно попросил развести
 * это на разные шаги: если имя ещё неизвестно, сначала спрашиваем ТОЛЬКО имя,
 * про доп. номер — уже следующим ходом, после ответа. Если имя дали сразу
 * вместе с номером (или было известно раньше) — про доп. номер можно спросить
 * в том же ходе, вторым вопросом уже не будет.
 */
describe("Дополнительные номера — только после имени, отдельным шагом", () => {
  const SUBSCRIBER2 = `extraphone-${runId}`;
  afterAll(async () => {
    await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: SUBSCRIBER2 } } });
  });

  it("номер без имени — первый ход спрашивает ТОЛЬКО имя, не доп. номер", async () => {
    await establishBuyerIntent(SUBSCRIBER2);

    callAi.mockResolvedValue({ reply: "Раҳмат барои рақам! Ростӣ, номатон чӣ?" });

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: SUBSCRIBER2, text: "905112241" });
    expect(result.accepted).toBe(true);

    const call = callAi.mock.calls.find((c) => c[0]?.endpoint === "lead-closing");
    expect(call?.[0]?.system).toContain("как его зовут");
    expect(call?.[0]?.system).not.toContain("ещё номера телефона");

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER2 },
      select: { clientId: true },
    });
    expect(conv?.clientId).toBeTruthy();
    if (conv?.clientId) clientIds.push(conv.clientId);
  });

  it("следующим ходом агент уже назначен, но имя из ответа всё равно дописывается (владелец 18.09.2026)", async () => {
    // hasActiveAssignedAgent отменена — назначение агента больше не гасит бота.
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: "Раҳмат, Фаридун! Ва боз рақами дигаре доред?", ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: SUBSCRIBER2, text: "Фаридун" });
    expect(result.shouldReply).not.toBe(false);
    expect(callAi.mock.calls.some((call) => call[0]?.endpoint === "lead-qualify")).toBe(true);

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER2 },
      select: { clientId: true },
    });
    const client = await prisma.client.findUnique({ where: { id: conv!.clientId! }, select: { fullName: true } });
    expect(client?.fullName).toBe("Фаридун");
  });

  it("второй номер, присланный после назначения агента, теперь попадает в extraPhones", async () => {
    // Раньше этот ход не выполнялся вовсе (isPaused = true из-за
    // hasActiveAssignedAgent) — доп. номер захватывается той же логикой блока
    // «заявка уже принята», что и раньше, просто теперь блок доходит до неё.
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: "Приняла, спасибо!", ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const result = await processMessengerTurn({
      channel: "INSTAGRAM",
      subscriberId: SUBSCRIBER2,
      text: "да, вот ещё 930001028",
    });
    expect(result.shouldReply).not.toBe(false);

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER2 },
      select: { clientId: true },
    });
    const client = await prisma.client.findUnique({
      where: { id: conv!.clientId! },
      select: { extraPhones: true },
    });
    expect(client?.extraPhones).toContain("+992930001028");
  });
});

describe("Имя и номер сразу вместе — доп. номер спрашиваем в том же ходе", () => {
  const SUBSCRIBER3 = `phonename-${runId}`;
  afterAll(async () => {
    await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: SUBSCRIBER3 } } });
  });

  it("клиент сразу написал имя и номер — закрывающий ход спрашивает только доп. номер", async () => {
    await establishBuyerIntent(SUBSCRIBER3);

    callAi.mockResolvedValue({ reply: "Рахмат, Далер! Ва боз рақами дигаре доред?" });

    const result = await processMessengerTurn({
      channel: "INSTAGRAM",
      subscriberId: SUBSCRIBER3,
      text: "Меня зовут Далер, мой номер 900001041",
    });
    expect(result.accepted).toBe(true);

    const call = callAi.mock.calls.find((c) => c[0]?.endpoint === "lead-closing");
    expect(call?.[0]?.system).not.toContain("как его зовут");
    expect(call?.[0]?.system).toContain("ещё номера телефона");

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER3 },
      select: { clientId: true },
    });
    if (conv?.clientId) clientIds.push(conv.clientId);
  });
});
