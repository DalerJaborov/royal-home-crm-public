import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «ИИ заполняет карточку сам, агент подтверждает шагами» (пакет владельца 31.07, п. 5).
 *
 * Проверяем серверную половину: что предложение действительно строится из того, что
 * клиент уже рассказал боту, что молчание модели не ломает мастер, и что формат
 * заметок разбирается обратно в поля (иначе мастер, открытый второй раз, терял бы
 * подтверждённые агентом тип и срочность).
 *
 * Сидовые данные не используем: районы, агент и клиенты создаются здесь и удаляются
 * в конце — CI поднимает базу одними миграциями.
 */

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

const { prisma } = await import("../src/db.js");
const { buildCardFillSuggestion } = await import("../src/ai/cardFill.js");
const { composeRequirementsNotes, parseRequirementsNotes, CLIENT_URGENCY_LABELS } = await import(
  "@royal-home/shared"
);

const runId = Date.now();
let agentId: string;
let districtId: string;
const clientIds: string[] = [];

async function makeClient(name: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9925${clientIds.length}${runId}`,
      source: "INSTAGRAM",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c.id;
}

/** Диалог клиента с ботом: черновик квалификатора + сама переписка. */
async function attachConversation(
  clientId: string,
  leadDraft: Record<string, unknown> | null,
  messages: { role: "user" | "assistant"; content: string }[]
) {
  await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `sub-${clientId}`,
      clientId,
      messages: messages as never,
      leadDraft: leadDraft as never,
    },
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Сино-тест-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент мастера", phone: `+992934${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

beforeEach(() => {
  callAiText.mockReset();
  callAiText.mockResolvedValue(null);
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Предложение по заполнению карточки", () => {
  it("берёт бюджет, комнаты, тип и район прямо из черновика бота", async () => {
    const clientId = await makeClient("Из черновика");
    await attachConversation(
      clientId,
      { stage: "done", budgetMin: 400000, budgetMax: 600000, rooms: 2, type: "APARTMENT", districtName: `Сино-тест-${runId}` },
      [{ role: "user", content: "2-хонага дар Сино, то 600 ҳазор" }]
    );

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(suggestion.budgetMin).toBe(400000);
    expect(suggestion.budgetMax).toBe(600000);
    expect(suggestion.rooms).toBe(2);
    expect(suggestion.type).toBe("APARTMENT");
    // Район бот знает названием, карточке нужен id — иначе поле молча не сохранится.
    expect(suggestion.districtId).toBe(districtId);
    expect(suggestion.districtName).toBe(`Сино-тест-${runId}`);
  });

  it("незнакомый район не подставляет чужой id и не роняет разбор", async () => {
    const clientId = await makeClient("Чужой район");
    await attachConversation(clientId, { stage: "chatting", districtName: "Хуҷанд" }, [
      { role: "user", content: "Хона дар Хуҷанд" },
    ]);

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(suggestion.districtId).toBeNull();
    expect(suggestion.districtName).toBeNull();
  });

  it("чего нет в черновике, достаёт из переписки ИИ", async () => {
    const clientId = await makeClient("Срочность из чата");
    await attachConversation(clientId, { stage: "chatting", budgetMax: 500000 }, [
      { role: "user", content: "Квартира нужна срочно, на этой неделе, с ремонтом" },
      { role: "assistant", content: "Кадом ноҳия?" },
    ]);
    callAiText.mockResolvedValue({
      propertyType: "APARTMENT",
      urgency: "ASAP",
      rooms: 3,
      tags: ["Только с ремонтом"],
      notes: "Нужна квартира с ремонтом",
      evidence: ["нужно срочно, на этой неделе"],
    });

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(callAiText).toHaveBeenCalledTimes(1);
    expect(suggestion.source).toBe("chat");
    // Срочность не собираем с 01.08.2026 (решение владельца): даже если модель её
    // вернула по старой памяти, в карточку она не попадает.
    expect(suggestion.urgency).toBeNull();
    expect(suggestion.type).toBe("APARTMENT");
    expect(suggestion.rooms).toBe(3);
    expect(suggestion.tags).toEqual(["Только с ремонтом"]);
    expect(suggestion.evidence).toEqual(["нужно срочно, на этой неделе"]);
    // Бюджет из черновика остаётся: он копился по всему диалогу.
    expect(suggestion.budgetMax).toBe(500000);
  });

  it("выдуманные моделью значения отбрасываются, а не уезжают в карточку", async () => {
    const clientId = await makeClient("Мусор от модели");
    await attachConversation(clientId, { stage: "chatting" }, [{ role: "user", content: "Салом" }]);
    callAiText.mockResolvedValue({
      propertyType: "ЗАМОК",
      urgency: "КОГДА-НИБУДЬ",
      rooms: -2,
      budgetMin: 0,
      districtName: "Несуществующий район",
      tags: ["Только с ремонтом", "Купить самолёт"],
      evidence: [""],
    });

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(suggestion.type).toBeNull();
    expect(suggestion.urgency).toBeNull();
    expect(suggestion.rooms).toBeNull();
    expect(suggestion.budgetMin).toBeNull();
    expect(suggestion.districtId).toBeNull();
    expect(suggestion.tags).toEqual(["Только с ремонтом"]);
    expect(suggestion.evidence).toEqual([]);
  });

  it("перевёрнутый бюджет разворачивает обратно", async () => {
    const clientId = await makeClient("Бюджет наоборот");
    await attachConversation(clientId, { stage: "chatting" }, [{ role: "user", content: "от 300 до 200" }]);
    callAiText.mockResolvedValue({ budgetMin: 300000, budgetMax: 200000 });

    const suggestion = await buildCardFillSuggestion(clientId);

    // Иначе сохранение упало бы на Zod-проверке диапазона, а агент увидел бы
    // «неверные данные» на значениях, которые сам не вводил.
    expect(suggestion.budgetMin).toBe(200000);
    expect(suggestion.budgetMax).toBe(300000);
  });

  it("молчание модели не ломает мастер — остаётся черновик и признак отказа", async () => {
    const clientId = await makeClient("ИИ недоступен");
    await attachConversation(clientId, { stage: "chatting", rooms: 4 }, [
      { role: "user", content: "чор хонага" },
    ]);
    callAiText.mockResolvedValue(null);

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(suggestion.aiUnavailable).toBe(true);
    expect(suggestion.rooms).toBe(4);
    expect(suggestion.source).toBe("draft");
  });

  it("при полном черновике ИИ добавляет только своё и не переписывает собранное", async () => {
    const clientId = await makeClient("Всё собрано");
    await attachConversation(
      clientId,
      {
        stage: "done",
        budgetMin: 400000,
        budgetMax: 600000,
        rooms: 2,
        type: "HOUSE",
        districtName: `Сино-тест-${runId}`,
        notes: "Ищет ҳавлӣ с участком",
      },
      [{ role: "user", content: "ҳавлӣ мекобам, то 600 ҳазор" }]
    );
    // Модель «передумала» по всем собранным полям — верить ей нельзя: черновик
    // копился по всему диалогу и уже пережил уточнения клиента.
    callAiText.mockResolvedValue({
      budgetMin: 1,
      budgetMax: 9_000_000,
      rooms: 9,
      propertyType: "LAND",
      notes: "другая заметка",
      urgency: "QUARTER",
    });

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(suggestion.budgetMin).toBe(400000);
    expect(suggestion.budgetMax).toBe(600000);
    expect(suggestion.rooms).toBe(2);
    expect(suggestion.type).toBe("HOUSE");
    expect(suggestion.notes).toBe("Ищет ҳавлӣ с участком");
    expect(suggestion.urgency).toBeNull();
  });

  it("клиент без переписки даёт пустое предложение, а не ошибку", async () => {
    const clientId = await makeClient("Без диалога");

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(suggestion.source).toBe("none");
    expect(suggestion.budgetMin).toBeNull();
    expect(callAiText).not.toHaveBeenCalled();
  });

  it("битая переписка в базе не роняет разбор", async () => {
    const clientId = await makeClient("Битый Json");
    await attachConversation(clientId, { stage: "chatting" }, [
      { role: "user", content: "" },
      { role: "system" as never, content: "мусор" },
      { role: "user", content: "3 комнаты" },
    ]);
    callAiText.mockResolvedValue({ rooms: 3 });

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(suggestion.rooms).toBe(3);
  });
});

describe("Формат заметок мастера", () => {
  it("собирает и разбирает обратно тип, пожелания и свободный текст", () => {
    const notes = composeRequirementsNotes({
      type: "APARTMENT",
      urgency: "MONTH",
      tags: ["Только с ремонтом", "Первый этаж не предлагать"],
      text: "Смотрел 92 мкр",
    });

    expect(notes).toContain("Тип: Квартира");
    // Срочность больше не пишется, даже если её передали (решение владельца 01.08.2026).
    expect(notes).not.toContain("Срочность");

    const parsed = parseRequirementsNotes(notes);
    expect(parsed.type).toBe("APARTMENT");
    expect(parsed.tags).toEqual(["Только с ремонтом", "Первый этаж не предлагать"]);
    expect(parsed.text).toBe("Смотрел 92 мкр");
  });

  it("старую строку «Срочность» всё ещё узнаёт — в заведённых карточках она есть", () => {
    // Перестать её узнавать нельзя: в уже сохранённых заметках она осталась, и
    // тогда полезла бы агенту в свободный текст при каждой правке.
    const parsed = parseRequirementsNotes(`Тип: Квартира\nСрочность: ${CLIENT_URGENCY_LABELS.MONTH}\nСмотрел 92 мкр`);
    expect(parsed.urgency).toBe("MONTH");
    expect(parsed.text).toBe("Смотрел 92 мкр");
  });

  it("пустой мастер не пишет в базу пустую строку", () => {
    // Пустая строка означала бы «заметки есть», и карточка считалась бы заполненной.
    expect(composeRequirementsNotes({ tags: [], text: "   " })).toBeNull();
  });

  it("заметки, написанные руками до мастера, остаются свободным текстом", () => {
    const parsed = parseRequirementsNotes("Звонить после 18:00\nБрат помогает с деньгами");
    expect(parsed.type).toBeNull();
    expect(parsed.urgency).toBeNull();
    expect(parsed.tags).toEqual([]);
    expect(parsed.text).toBe("Звонить после 18:00\nБрат помогает с деньгами");
  });

  it("строка с меткой, но неизвестным значением остаётся текстом, а не теряется", () => {
    const parsed = parseRequirementsNotes("Тип: Вилла на Луне\nСрочность: когда-нибудь");
    expect(parsed.type).toBeNull();
    expect(parsed.urgency).toBeNull();
    expect(parsed.text).toBe("Тип: Вилла на Луне\nСрочность: когда-нибудь");
  });
});
