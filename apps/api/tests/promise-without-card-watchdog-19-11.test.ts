import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { promisesAgentContact } from "../src/ai/callbackPromiseGuard.js";
import { lastAgentContactPromise, PROMISE_GRACE_MS, runPhoneLeadWatchdogTick } from "../src/lib/phoneLeadWatchdog.js";

/**
 * ОБЕЩАЛ ЗВОНОК — КАРТОЧКИ НЕТ (19.11.2026, владелец: «нужно чтобы такое никогда больше не повторилось»).
 *
 * 17–18.11 четыре клиента WhatsApp услышали «агент позвонит» / «Передал вашу просьбу», а карточки
 * не было ни у одного (#2f2c7d, #53de5e, #2caf75, #b7a090; заведены руками 19.11 как №857, 868–870).
 * Сторож лидов искал только номер в ТЕКСТЕ, а в WhatsApp номер известен без слов клиента.
 * Фразы ниже — дословно из прода.
 */

describe("promisesAgentContact — словарь обещаний (живые фразы)", () => {
  it.each([
    "Передал вашу просьбу.",
    "Передаю ваш вопрос агенту, он свяжется с вами.",
    "Агенти мо дар вақти корӣ ба шумо занг мезанад.",
    "Это точно подскажет наш агент. Он позвонит вам в рабочее время.",
    "Агент позвонит вам на этот номер завтра утром, с 10:00.",
    "Записали, с вами свяжутся завтра после 10:00.",
    "Саволатонро ба агент мерасонам, ӯ бо шумо тамос мегирад.",
    "Ҳамаи ин шартҳоро ба агент расондам.",
    "Бале, видео ё расмҳои хонаро ба ҳамин ҷо партоед. Мо ба агент мерасонем",
    "Ташаккур, аризаатонро барои ҳавлии 5-ҳуҷрагӣ дар Сино қабул кардем",
    "Ваш запрос передаю агенту.",
    "Спасибо, по объекту №208 передаю агенту.",
    "Я передал ваше сообщение сотруднику.",
    "Ваша заявка принята.",
    "Мы приняли вашу заявку.",
    "Дархости шумо қабул шуд.",
  ])("обещание: %s", (text) => {
    const sentences = text.split(/(?<=[.!?])\s+/u);
    expect(sentences.some(promisesAgentContact)).toBe(true);
  });

  it.each([
    "Если удобно, напишите номер, и агент позвонит сам.",
    "Дар ин савол агент ба шумо кӯмак мекунад. Агар мувофиқ бошад, рақаматонро нависед, агент худаш занг мезанад.",
    "Здравствуйте. Дайте пожалуйста ваши контакты мы с вами свяжемся",
    "Вы хотите, чтобы сотрудник вам позвонил?",
    "Мехоҳед корманд ба шумо занг занад?",
    "Позвоните пожалуйста по номеру +992 777070100",
    "Кормандон аз 10:00 то 22:30 бо вақти Душанбе дар тамосанд.",
    "Чем могу помочь?",
    "Агент не позвонит без вашего согласия.",
    "Передам вашу благодарность команде.",
  ])("не обещание: %s", (text) => {
    const sentences = text.split(/(?<=[.!?])\s+/u);
    expect(sentences.some(promisesAgentContact)).toBe(false);
  });
});

const NOW = new Date("2026-11-19T10:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

describe("lastAgentContactPromise — когда обещание считается потерянным", () => {
  const chat = (promiseAt: string, after: Array<{ role: "user" | "assistant"; content: string }> = []) => [
    { role: "user", content: "Позвоните мне через воцтап сейчас", at: ago(60) },
    { role: "assistant", content: "Передал вашу просьбу.", at: promiseAt },
    ...after.map((m) => ({ ...m, at: ago(1) })),
  ] as never;

  it("обещание старше десяти минут — потеряно, реплика клиента перед ним берётся для приёма", () => {
    const found = lastAgentContactPromise(chat(ago(20)), null, NOW);
    expect(found?.clientText).toBe("Позвоните мне через воцтап сейчас");
  });

  it("отказ не целым сообщением («Не звоните, я передумал») — обещание есть, но решает человек", () => {
    const found = lastAgentContactPromise(chat(ago(30), [{ role: "user", content: "Не звоните, я передумал" }]), null, NOW);
    expect(found?.refusalUnclear).toBe(true);
  });

  it("клиент сказал «Работа», бот перечислил вакансии — это соискатель, не заявка", () => {
    const messages = [
      { role: "user", content: "Работа", at: ago(60) },
      { role: "assistant", content: "Сейчас открыты вакансии: Менеджер по продажам недвижимости.", at: ago(59) },
      { role: "assistant", content: "Это точно подскажет наш агент. Он позвонит вам в рабочее время.", at: ago(30) },
    ] as never;
    expect(lastAgentContactPromise(messages, null, NOW)).toBeNull();
  });

  it("бот зачем-то упомянул вакансии, а клиент покупает — обещание остаётся заявкой", () => {
    const messages = [
      { role: "user", content: "Хочу купить квартиру", at: ago(60) },
      { role: "assistant", content: "Сейчас открыты вакансии: Менеджер по продажам недвижимости.", at: ago(59) },
      { role: "assistant", content: "Агент позвонит вам на этот номер завтра утром, с 10:00.", at: ago(30) },
    ] as never;
    expect(lastAgentContactPromise(messages, null, NOW)).not.toBeNull();
  });

  it("свежее обещание (приём ядра ещё работает) — не трогаем", () => {
    expect(PROMISE_GRACE_MS).toBe(10 * 60_000);
    expect(lastAgentContactPromise(chat(ago(3)), null, NOW)).toBeNull();
  });

  it("обещание до прошлой попытки сторожа — уже разбирали", () => {
    expect(lastAgentContactPromise(chat(ago(30)), new Date(ago(25)), NOW)).toBeNull();
  });

  it("после обещания клиент отказался от звонка — заявку не заводим", () => {
    expect(lastAgentContactPromise(chat(ago(30), [{ role: "user", content: "Не звоните мне" }]), null, NOW)).toBeNull();
  });

  it("разговор о вакансии — обещание специалиста про работу, не про сделку", () => {
    const messages = [
      { role: "user", content: "SMM-специалист нужен?", at: ago(60) },
      { role: "assistant", content: "Сейчас открыты вакансии: Менеджер по продажам недвижимости.", at: ago(59) },
      { role: "assistant", content: "Подробную информацию вам даст наш специалист Ноза, позвонит вам.", at: ago(30) },
    ] as never;
    expect(lastAgentContactPromise(messages, null, NOW)).toBeNull();
  });

  it("без обещания — ничего", () => {
    const messages = [
      { role: "user", content: "Салом", at: ago(60) },
      { role: "assistant", content: "Чӣ хизмат кунам?", at: ago(59) },
    ] as never;
    expect(lastAgentContactPromise(messages, null, NOW)).toBeNull();
  });
});

const conversationIds: string[] = [];
const clientIds: string[] = [];
const jobIds: string[] = [];
const alarmsFor = (conversationId: string) =>
  prisma.pendingDirectorAlert.count({ where: { tag: `alarm-phone-without-lead-${conversationId}` } });
const randomTajikWa = () => `9929${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const minutesAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function seed(input: { channel: "WHATSAPP" | "INSTAGRAM"; subscriberId: string; messages: Array<{ role: string; content: string; at: string }>; leadDraft?: Record<string, unknown> }) {
  const conv = await prisma.botConversation.create({
    data: {
      channel: input.channel,
      subscriberId: input.subscriberId,
      name: "Тест обещания",
      messages: input.messages as never,
      leadDraft: (input.leadDraft ?? { stage: "chatting" }) as never,
      lastMessageAt: new Date(),
    },
    select: { id: true },
  });
  conversationIds.push(conv.id);
  return conv.id;
}

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
});

afterAll(async () => {
  const convs = await prisma.botConversation.findMany({ where: { id: { in: conversationIds } }, select: { clientId: true } });
  for (const c of convs) if (c.clientId && !clientIds.includes(c.clientId)) clientIds.push(c.clientId);
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  if (clientIds.length > 0) {
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  }
  await prisma.notification.deleteMany({ where: { url: { in: conversationIds.map((id) => `/messages?open=${id}`) } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: conversationIds.map((id) => `alarm-phone-without-lead-${id}`) } } });
  if (jobIds.length) await prisma.backgroundJob.deleteMany({ where: { id: { in: jobIds } } });
});

describe("Сторож лидов: обещал звонок — карточки нет (база)", () => {
  it("WhatsApp: покупатель услышал «Передал вашу просьбу» — карточка заводится сама, без сообщения клиенту", async () => {
    const id = await seed({
      channel: "WHATSAPP",
      subscriberId: randomTajikWa(),
      messages: [
        { role: "user", content: "Мне нужна квартира в районе молодёжного театра. До 1 млн сомони", at: minutesAgo(40) },
        { role: "assistant", content: "Какой район вам подходит?", at: minutesAgo(39) },
        { role: "user", content: "Позвоните мне через воцтап сейчас", at: minutesAgo(30) },
        { role: "assistant", content: "Передал вашу просьбу.", at: minutesAgo(30) },
      ],
    });

    await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true, messages: true } });
    expect(conv?.clientId).toBeTruthy();
    const client = await prisma.client.findUnique({ where: { id: conv!.clientId! }, select: { kind: true, whatsappPhone: true } });
    expect(client?.kind).toBe("BUYER");
    expect(client?.whatsappPhone).toBeTruthy();
    // Клиенту ничего не дописано: тихий приём по сохранённой переписке.
    expect((conv?.messages as unknown[]).length).toBe(4);
  });

  it("WhatsApp: карточка по номеру уже есть, но «Прочее» без агента (входящий звонок) — приём делает её покупателем, дубля нет", async () => {
    const wa = randomTajikWa();
    const existing = await prisma.client.create({
      data: { fullName: "Входящий тест", phone: `+${wa}`, kind: "OTHER", source: "PHONE_CALL" } as never,
      select: { id: true },
    });
    clientIds.push(existing.id);
    const id = await seed({
      channel: "WHATSAPP",
      subscriberId: wa,
      messages: [
        { role: "user", content: "Хочу купить 2-комнатную квартиру", at: minutesAgo(40) },
        { role: "assistant", content: "Агент позвонит вам на этот номер завтра утром, с 10:00.", at: minutesAgo(39) },
      ],
    });

    await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true } });
    expect(conv?.clientId).toBe(existing.id);
    const client = await prisma.client.findUnique({ where: { id: existing.id }, select: { kind: true } });
    expect(client?.kind).toBe("BUYER");
    expect(await prisma.client.count({ where: { phone: `+${wa}` } })).toBe(1);
  });

  it("WhatsApp: обещание свежее — сторож ждёт приём ядра и ничего не делает", async () => {
    const id = await seed({
      channel: "WHATSAPP",
      subscriberId: randomTajikWa(),
      messages: [
        { role: "user", content: "Мехоҳам хонаамро фурӯшам", at: minutesAgo(3) },
        { role: "assistant", content: "Агенти мо дар вақти корӣ ба шумо занг мезанад.", at: minutesAgo(2) },
      ],
    });

    await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true, watchdogAttemptedAt: true } });
    expect(conv?.clientId).toBeNull();
    // Попытка не отмечена: следующий тик, когда пройдёт десять минут, разберёт этот диалог.
    expect(conv?.watchdogAttemptedAt).toBeNull();
  });

  it("WhatsApp: модель записала намерение «прочее», а клиент ищет квартиру — карточка покупателя, не «Прочие»", async () => {
    const id = await seed({
      channel: "WHATSAPP",
      subscriberId: randomTajikWa(),
      leadDraft: { stage: "awaiting_phone", intent: "other", whoIsThis: "BUYER" },
      messages: [
        { role: "user", content: "Салом. Мне нужна квартира в районе молодёжного театра. До 1 млн сомони.", at: minutesAgo(40) },
        { role: "user", content: "Позвоните мне через воцтап сейчас", at: minutesAgo(31) },
        { role: "assistant", content: "Передал вашу просьбу.", at: minutesAgo(30) },
      ],
    });

    await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true } });
    expect(conv?.clientId).toBeTruthy();
    const client = await prisma.client.findUnique({ where: { id: conv!.clientId! }, select: { kind: true } });
    expect(client?.kind).toBe("BUYER");
  });

  it("WhatsApp: модель уверенно сказала «прочее» (электрик), слов о сделке нет — лидом агенту не становится, руководство знает", async () => {
    const id = await seed({
      channel: "WHATSAPP",
      subscriberId: randomTajikWa(),
      leadDraft: { stage: "chatting", intent: "other", confident: true },
      messages: [
        { role: "user", content: "Я электрик, делаю проводку в новостройках. Нужны услуги?", at: minutesAgo(40) },
        { role: "assistant", content: "Передаю ваш вопрос агенту, он свяжется с вами.", at: minutesAgo(39) },
      ],
    });

    await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { client: { select: { kind: true, assignedAgentId: true } } } });
    expect(conv?.client?.kind ?? "OTHER").toBe("OTHER");
    expect(conv?.client?.assignedAgentId ?? null).toBeNull();
    expect(await alarmsFor(id)).toBeGreaterThan(0);
  });

  it("WhatsApp: после обещания «Не звоните, я передумал» — карточку тихо не заводим, зовём человека", async () => {
    const id = await seed({
      channel: "WHATSAPP",
      subscriberId: randomTajikWa(),
      messages: [
        { role: "user", content: "Хочу купить 2-комнатную квартиру", at: minutesAgo(40) },
        { role: "assistant", content: "Агент позвонит вам на этот номер завтра утром, с 10:00.", at: minutesAgo(39) },
        { role: "user", content: "Не звоните, я передумал", at: minutesAgo(35) },
      ],
    });

    await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true } });
    expect(conv?.clientId).toBeNull();
    expect(await alarmsFor(id)).toBeGreaterThan(0);
  });

  it("WhatsApp: задание приёма ядра ещё в очереди — сторож его не перебивает", async () => {
    const id = await seed({
      channel: "WHATSAPP",
      subscriberId: randomTajikWa(),
      messages: [
        { role: "user", content: "Хочу купить 2-комнатную квартиру", at: minutesAgo(40) },
        { role: "assistant", content: "Агент позвонит вам на этот номер завтра утром, с 10:00.", at: minutesAgo(39) },
      ],
    });
    const job = await prisma.backgroundJob.create({
      data: { type: "customer-lead-only-intake", status: "PENDING", payload: { conversationId: id }, maxAttempts: 1, runAt: new Date(Date.now() + 3600_000) } as never,
      select: { id: true },
    });
    jobIds.push(job.id);

    await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true } });
    expect(conv?.clientId).toBeNull();
  });

  it("WhatsApp: номер у карточки в Корзине — сторож её не воскрешает, решает человек", async () => {
    const wa = randomTajikWa();
    const trashed = await prisma.client.create({
      data: { fullName: "Из Корзины тест", phone: `+${wa}`, kind: "BUYER", source: "WHATSAPP", deletedAt: new Date() } as never,
      select: { id: true },
    });
    clientIds.push(trashed.id);
    const id = await seed({
      channel: "WHATSAPP",
      subscriberId: wa,
      messages: [
        { role: "user", content: "Хочу купить 2-комнатную квартиру", at: minutesAgo(40) },
        { role: "assistant", content: "Агент позвонит вам на этот номер завтра утром, с 10:00.", at: minutesAgo(39) },
      ],
    });

    await runPhoneLeadWatchdogTick();

    const card = await prisma.client.findUnique({ where: { id: trashed.id }, select: { deletedAt: true } });
    expect(card?.deletedAt).not.toBeNull();
    expect(await alarmsFor(id)).toBeGreaterThan(0);
  });

  it("WhatsApp: аренда с обещанием — карточки нет (аренду не берём)", async () => {
    const id = await seed({
      channel: "WHATSAPP",
      subscriberId: randomTajikWa(),
      messages: [
        { role: "user", content: "Хочу снять квартиру на длительный срок", at: minutesAgo(40) },
        { role: "assistant", content: "Передал вашу просьбу.", at: minutesAgo(39) },
      ],
    });

    await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true } });
    expect(conv?.clientId).toBeNull();
  });

  it("Instagram: бот обещал звонок, а номера нет — карточку не выдумываем, зовём руководство", async () => {
    const id = await seed({
      channel: "INSTAGRAM",
      subscriberId: `ig-promise-${Math.random().toString(36).slice(2, 9)}`,
      messages: [
        { role: "user", content: "Документы на квартиру в порядке?", at: minutesAgo(40) },
        { role: "assistant", content: "Это точно подскажет наш агент. Он позвонит вам в рабочее время.", at: minutesAgo(39) },
      ],
    });

    await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true, watchdogAttemptedAt: true } });
    expect(conv?.clientId).toBeNull();
    expect(await alarmsFor(id)).toBe(1);
    // Попытка отмечена: тревога по тем же репликам не повторяется на следующих тиках.
    expect(conv?.watchdogAttemptedAt).not.toBeNull();
    await runPhoneLeadWatchdogTick();
    expect(await alarmsFor(id)).toBe(1);
  });
});
