import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ДОБОР АНКЕТ КАНДИДАТОВ ИЗ СТАРЫХ ПЕРЕПИСОК: до 25.09.2026 тестов не было.
 *
 * `lib/backfillJobApplications.ts` — из списка файлов сервера, до которых не
 * дотягивается ни один тест (CLAUDE.md, замер 22.09.2026). Разовый он только по
 * замыслу: владелец просит прогнать его снова после каждой починки бота, и
 * ошибка в нём тихая — «кандидатов нет» читается как хорошая новость.
 *
 * Модель подменена: настоящий разбор архива в прогоне не нужен и стоил бы денег.
 *
 * ПОЧЕМУ ДАТЫ 2031 ГОДА. Проход берёт свежайшие переписки (`orderBy:
 * lastMessageAt desc`, `take: limit`) по ВСЕЙ таблице, а переписок в базе
 * прогона полно от соседних тестов. Свои датируются 2031 годом и с `limit` по
 * числу своих оказываются ровно теми, кого проход и посмотрит: чужие строки
 * остаются за пределом выборки, и удалять их не приходится. Телеграм добивается
 * пустыми диалогами по той же причине — у него свой `take: limit`.
 *
 * ОДНОЙ ДАТЫ БЫЛО МАЛО, и это нашлось только на общем прогоне 29.09.2026: файл
 * давал 12 из 12 в одиночку и 10 падений из 12 вместе со всеми. В Postgres
 * `ORDER BY ... DESC` ставит NULL ПЕРВЫМИ, а `lastMessageAt` необязательное —
 * десятки соседних тестов заводят переписку без него. Пустые даты выигрывали у
 * 2031 года и съедали окно целиком: `scanned: 8`, `candidates: 0`.
 *
 * Лечение — в коде прохода (`nulls: "last"`), а не в тесте: на проде диалог без
 * единого ответа тоже заводится без даты (`whatsappFirstContact.ts`), и проход
 * так же смотрел бы пустые переписки вместо настоящих. Сторож этого — тест
 * «переписка без даты не съедает окно» ниже.
 */

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

const { prisma } = await import("../src/db.js");
const { backfillJobApplications } = await import("../src/lib/backfillJobApplications.js");

/** Импорт модуля НЕ запускает разбор архива (защита `import.meta.url`, 03.09.2026). */
const calledOnImport = callAiText.mock.calls.length;

const runId = Date.now().toString(36).slice(-6);
const botIds: string[] = [];
const tgIds: string[] = [];
let dated = Date.UTC(2031, 5, 1, 12, 0, 0);

type Msg = { role: string; content: unknown } | unknown;

async function botDialog(messages: Msg[], extra: Record<string, unknown> = {}) {
  dated += 60_000; // каждая следующая переписка свежее предыдущей
  const row = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `sub-${runId}-${botIds.length}`,
      name: `Кандидат ${runId}-${botIds.length}`,
      messages,
      lastMessageAt: new Date(dated),
      ...extra,
    },
  });
  botIds.push(row.id);
  return row;
}

/** Телеграм добивается своими пустыми диалогами: у него отдельный предел выборки. */
async function padTelegram(count: number) {
  for (let i = 0; i < count; i++) {
    dated += 60_000;
    const row = await prisma.telegramConversation.create({
      data: {
        chatId: `tg-${runId}-${tgIds.length}`,
        username: `сосед${tgIds.length}`,
        messages: [{ role: "user", content: "Здравствуйте, ищу двухкомнатную квартиру" }],
        lastMessageAt: new Date(dated),
      },
    });
    tgIds.push(row.id);
  }
}

/** Ответ модели: разговор о работе и анкета. */
function jobReply(application: Record<string, unknown>) {
  return { isJobConversation: true, jobApplication: application };
}

async function myApplications() {
  return prisma.jobApplication.findMany({ where: { conversationId: { in: botIds } } });
}

beforeEach(async () => {
  callAiText.mockReset();
  await prisma.jobApplication.deleteMany({ where: { conversationId: { in: [...botIds, ...tgIds] } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: botIds } } });
  await prisma.telegramConversation.deleteMany({ where: { id: { in: tgIds } } });
  botIds.length = 0;
  tgIds.length = 0;
});

afterAll(async () => {
  await prisma.jobApplication.deleteMany({ where: { conversationId: { in: [...botIds, ...tgIds] } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: botIds } } });
  await prisma.telegramConversation.deleteMany({ where: { id: { in: tgIds } } });
  await prisma.$disconnect();
});

describe("что вообще попадает в разбор", () => {
  it("импорт файла не запускает разбор архива", () => {
    expect(calledOnImport).toBe(0);
  });

  it("слово о работе сказал только бот — переписка не разбирается", async () => {
    await botDialog([
      { role: "user", content: "Здравствуйте, сколько стоит двушка в Сино?" },
      { role: "assistant", content: "У нас открыта вакансия риелтора, но сейчас про квартиру: цена 45000" },
    ]);
    await padTelegram(1);

    const stats = await backfillJobApplications({ limit: 1 });
    expect(stats.candidates).toBe(0);
    expect(callAiText).not.toHaveBeenCalled();
  });

  it("таджикская и узбекская формы ловятся предфильтром", async () => {
    /**
     * Формы подобраны так, чтобы их ловили ИМЕННО свои куски предфильтра.
     * «Ҷои кор ҳаст?» проверкой не была бы: там после «кор» стоит пробел, и
     * строку ловит общее `кор\s` — таджикские куски при этом можно удалить,
     * и ничего не покраснеет (проверено подменой 25.09.2026, см. запись
     * журнала). Поэтому «кор» стоит в конце фразы, а узбекское — в форме
     * «ishga», которую `ish\s` не берёт.
     */
    await botDialog([{ role: "user", content: "Ассалом, ман ҷустуҷӯи ҷои кор" }]);
    await botDialog([{ role: "user", content: "Assalomu alaykum, ishga olasizmi?" }]);
    await padTelegram(2);
    callAiText.mockResolvedValue({ isJobConversation: false });

    const stats = await backfillJobApplications({ limit: 2 });
    expect(stats.candidates).toBe(2);
    expect(callAiText).toHaveBeenCalledTimes(2);
  });

  it("переписка без даты не съедает окно выборки", async () => {
    /**
     * Регресс 29.09.2026. `ORDER BY lastMessageAt DESC` в Postgres ставит NULL
     * первыми, а диалог без единого ответа заводится именно без даты (оба
     * боевых пути: `messengers/conversation.ts`, `lib/whatsappFirstContact.ts`).
     * Без `nulls: "last"` такой диалог считается самым свежим, занимает весь
     * `take: limit` — и проход отвечает «кандидатов нет» вместо настоящего
     * кандидата. Проверено подменой: верните в проходе `lastMessageAt: "desc"`,
     * и этот тест краснеет, а остальные одиннадцать остаются зелёными.
     */
    await botDialog([{ role: "user", content: "Здравствуйте, я по поводу вакансии риелтора" }]);
    await botDialog([{ role: "user", content: "Добрый день" }], { lastMessageAt: null });
    await padTelegram(2);
    callAiText.mockResolvedValue({ isJobConversation: false });

    const stats = await backfillJobApplications({ limit: 1 });
    expect(stats.candidates).toBe(1);
    expect(callAiText).toHaveBeenCalledTimes(1);
  });

  it("переписка с уже записанной анкетой пропускается целиком", async () => {
    const dialog = await botDialog([{ role: "user", content: "Хочу работать риелтором" }]);
    await prisma.jobApplication.create({
      data: { conversationId: dialog.id, channel: "INSTAGRAM", status: "NEW", name: "Уже разобран" },
    });
    await padTelegram(1);

    const stats = await backfillJobApplications({ limit: 1, apply: true });
    expect(stats.alreadyRecorded).toBe(1);
    expect(stats.candidates).toBe(0);
    expect(callAiText).not.toHaveBeenCalled();
    // Чужой статус не переписан.
    expect((await myApplications())[0]).toMatchObject({ name: "Уже разобран" });
  });

  it("мусор в истории переписки не роняет разбор и не уходит в запрос", async () => {
    await botDialog([
      null,
      "просто строка",
      { role: "system", content: "служебное" },
      { role: "user", content: 42 },
      { role: "user", content: "   " },
      { role: "user", content: "Ищу работу риелтором, есть опыт продаж" },
    ]);
    await padTelegram(1);
    callAiText.mockResolvedValue(jobReply({ name: "Далер", experience: "продажи" }));

    const stats = await backfillJobApplications({ limit: 1, apply: true });
    expect(stats.written).toBe(1);
    const { user } = callAiText.mock.calls[0][0];
    expect(user).toContain("КАНДИДАТ: Ищу работу риелтором");
    expect(user).not.toContain("служебное");
    expect(user).not.toContain("просто строка");
  });
});

describe("запись анкеты", () => {
  it("анкета из архива ложится тем же путём, что у бота", async () => {
    const dialog = await botDialog([{ role: "user", content: "Здравствуйте, у вас есть вакансия риелтора?" }]);
    await padTelegram(1);
    callAiText.mockResolvedValue(
      jobReply({ name: "Нигина", age: 22, phone: "918020304", studyingNow: true, employedNow: false })
    );

    const stats = await backfillJobApplications({ limit: 1, apply: true });
    expect(stats).toMatchObject({ candidates: 1, written: 1, notJob: 0, aiFailed: 0, stoppedOnAiFailures: false });

    const [application] = await myApplications();
    expect(application).toMatchObject({
      conversationId: dialog.id,
      channel: "INSTAGRAM",
      name: "Нигина",
      age: 22,
      studyingNow: true,
      employedNow: false,
    });
    expect(application.phone).toContain("918020304".slice(-6));
    // Допуск считает тот же код, что у живой анкеты, — поле заполнено.
    expect(application.eligible === null).toBe(false);
  });

  it("HELPER-FINAL02: запись анкеты упала — в «записано» не считается, сбой виден отдельным счётчиком", async () => {
    await botDialog([{ role: "user", content: "Здравствуйте, у вас есть вакансия риелтора?" }]);
    await padTelegram(1);
    callAiText.mockResolvedValue(jobReply({ name: "Сбойная", age: 28 }));
    // recordJobApplication глотает исключение: раньше проход всё равно считал анкету записанной.
    const spy = vi.spyOn(prisma.jobApplication, "upsert").mockRejectedValueOnce(new Error("временный сбой базы"));
    let stats;
    try {
      stats = await backfillJobApplications({ limit: 1, apply: true });
    } finally {
      spy.mockRestore();
    }

    expect(stats).toMatchObject({ candidates: 1, written: 0, writeFailed: 1 });
    expect(await myApplications()).toEqual([]);
  });
  it("режим просмотра базу не трогает", async () => {
    await botDialog([{ role: "user", content: "Ищу работу, хочу быть агентом по недвижимости" }]);
    await padTelegram(1);
    callAiText.mockResolvedValue(jobReply({ name: "Фаррух", age: 25 }));

    const stats = await backfillJobApplications({ limit: 1 });
    expect(stats).toMatchObject({ candidates: 1, written: 0 });
    expect(await myApplications()).toEqual([]);
  });

  it("модель говорит «не про работу» — анкеты нет", async () => {
    await botDialog([{ role: "user", content: "А работает ли у вас лифт? ищу работу мужа рядом" }]);
    await padTelegram(1);
    callAiText.mockResolvedValue({ isJobConversation: false, jobApplication: { name: "Покупатель" } });

    const stats = await backfillJobApplications({ limit: 1, apply: true });
    expect(stats).toMatchObject({ notJob: 1, written: 0 });
    expect(await myApplications()).toEqual([]);
  });

  it("анкета из одного неразборчивого телефона не заводится", async () => {
    await botDialog([{ role: "user", content: "Хочу подработку у вас" }]);
    await padTelegram(1);
    /**
     * Модель сказала «это про работу», но в анкете — только «позвоните мне»
     * вместо номера. `parseJobApplication` такой черновик считает пустым и
     * отдаёт null, поэтому переписка уходит в «не про работу», а не в счётчик
     * `empty`: пустая карточка в очереди найма хуже её отсутствия, и обе дороги
     * ведут к «не записали».
     */
    callAiText.mockResolvedValue(jobReply({ phone: "позвоните мне" }));

    const stats = await backfillJobApplications({ limit: 1, apply: true });
    expect(stats).toMatchObject({ candidates: 1, written: 0, notJob: 1 });
    expect(await myApplications()).toEqual([]);
  });

  it("повторный прогон анкету не задваивает", async () => {
    await botDialog([{ role: "user", content: "Вакансия риелтора ещё открыта?" }]);
    await padTelegram(1);
    callAiText.mockResolvedValue(jobReply({ name: "Сомон", age: 30 }));

    await backfillJobApplications({ limit: 1, apply: true });
    const second = await backfillJobApplications({ limit: 1, apply: true });

    expect(second.alreadyRecorded).toBe(1);
    expect(second.candidates).toBe(0);
    expect(await myApplications()).toHaveLength(1);
  });
});

describe("ИИ не отвечает", () => {
  it("три отказа подряд останавливают разбор, а не выдают «кандидатов нет»", async () => {
    for (let i = 0; i < 4; i++) await botDialog([{ role: "user", content: `Ищу работу риелтором, вариант ${i}` }]);
    await padTelegram(4);
    callAiText.mockResolvedValue(null);

    const stats = await backfillJobApplications({ limit: 4, apply: true });
    expect(stats).toMatchObject({ candidates: 4, aiFailed: 3, written: 0, notJob: 0, stoppedOnAiFailures: true });
    expect(callAiText).toHaveBeenCalledTimes(3); // четвёртую переписку уже не трогали
  });

  it("одиночный отказ не считается ответом «не про работу»", async () => {
    await botDialog([{ role: "user", content: "Ищу работу риелтором, первый" }]);
    await botDialog([{ role: "user", content: "Ищу работу риелтором, второй" }]);
    await padTelegram(2);
    callAiText.mockResolvedValueOnce(null).mockResolvedValueOnce(jobReply({ name: "Мадина", age: 24 }));

    const stats = await backfillJobApplications({ limit: 2, apply: true });
    expect(stats).toMatchObject({ aiFailed: 1, notJob: 0, written: 1, stoppedOnAiFailures: false });
  });
});
