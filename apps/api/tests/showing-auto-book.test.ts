import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

// Выключатель автоматики (19.11.2026): подмена только в этом файле, строку Settings тест не трогает.
const switchesOff = vi.hoisted(() => new Set<string>());
vi.mock("../src/lib/automationSwitches.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/automationSwitches.js")>();
  return { ...actual, automationSwitchOn: async (...a: Parameters<typeof actual.automationSwitchOn>) => (switchesOff.has(a[0]) ? false : actual.automationSwitchOn(...a)) };
});

const { prisma } = await import("../src/db.js");
const { analyzeCall, parseShowingAt } = await import("../src/ai/callAnalysis.js");
const { loadQuestionDetails } = await import("../src/lib/showingQuestions.js");

/**
 * ПОКАЗ НАЗНАЧАЕТСЯ САМ, НО ТОЛЬКО КОГДА ОДНОЗНАЧНО (владелец 18.08.2026).
 *
 * Это тот самый функционал, который владелец уже дважды отменял (05.08 — вернул
 * обязательное окно вместо мягкого баннера; 17.08 — живой сбой на продавце,
 * см. seller-no-showing-windows.test.ts). Условие сузили: строгий подбор
 * (без резервного «весь каталог») должен вернуть РОВНО один объект, иначе
 * решение остаётся за агентом — окно «Назначьте показ» никуда не делось,
 * просто больше не блокирует экран.
 */

const runId = Date.now();
let agentId: string;
let districtId: string;
let otherDistrictId: string;
let offDistrictId: string;
let legacyDistrictId: string;
let provenDistrictId: string;
let soldDistrictId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const interactionIds: string[] = [];

const LONG_TRANSCRIPT = "Разговор о показе квартиры завтра вечером ".repeat(10);

async function makeBuyer(desiredDistrictId: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Покупатель показа ${runId}-${clientIds.length}`,
      phone: `+992971${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      desiredDistrictId,
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(inDistrictId: string, suffix: string) {
  const p = await prisma.property.create({
    data: {
      title: `Показ-объект ${runId}-${suffix}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 45000,
      currency: "TJS",
      districtId: inDistrictId,
      address: `Тестовая показа, ${suffix}`,
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: agentId,
      createdById: agentId,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

async function makeCallInteraction(clientId: string, createdAt = new Date()) {
  const i = await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "Звонок через CRM", createdAt, transcript: LONG_TRANSCRIPT },
  });
  interactionIds.push(i.id);
  return i;
}

function mockShowingExtract(showingAtLocal: string) {
  callAiText.mockResolvedValueOnce({
    score: 70,
    summary: "Договорились о показе завтра вечером",
    outcome: "WAITING_SHOWING",
    nextAction: null,
    showingAt: showingAtLocal,
  });
}

beforeAll(async () => {
  const passwordHash = "x";
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент показа ${runId}`, phone: `+992972${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  districtId = (await prisma.district.create({ data: { name: `Тест-район-показ-${runId}` } })).id;
  otherDistrictId = (await prisma.district.create({ data: { name: `Тест-район-показ-другой-${runId}` } })).id;
  // Свой район для проверки выключателя: объект в общем районе ломал бы тест «дубль не создаётся» (нужен ровно один подходящий).
  offDistrictId = (await prisma.district.create({ data: { name: `Тест-район-показ-выкл-${runId}` } })).id;
  // Свои районы у новых проверок (22.11.2026): в каждом — ровно тот подбор, который проверка ждёт.
  legacyDistrictId = (await prisma.district.create({ data: { name: `Тест-район-показ-прежний-${runId}` } })).id;
  provenDistrictId = (await prisma.district.create({ data: { name: `Тест-район-показ-доказан-${runId}` } })).id;
  soldDistrictId = (await prisma.district.create({ data: { name: `Тест-район-показ-продан-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.callAnalysis.deleteMany({ where: { interactionId: { in: interactionIds } } });
  await prisma.showingQuestion.deleteMany({ where: { agentId } });
  await prisma.pendingSummary.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { OR: [{ agentId }, { clientId: { in: clientIds } }] } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: { in: [districtId, otherDistrictId, offDistrictId, legacyDistrictId, provenDistrictId, soldDistrictId] } } });
});

/** Локальное время Душанбе, гарантированно в пределах окна допустимых дат
 *  (parseShowingAt), считанное от момента звонка. */
function tomorrowLocal(callAt: Date): string {
  const d = new Date(callAt.getTime() + 24 * 3600_000);
  return `${d.toISOString().slice(0, 10)}T18:00`;
}

describe("Показ по разговору — автоназначение при однозначности", () => {
  it("ровно один подходящий объект, но в разговоре он не доказан — показ сам не ставится, Шабнам спросит агента (22.11.2026)", async () => {
    const property = await makeProperty(districtId, "один");
    const client = await makeBuyer(districtId);
    const callAt = new Date();
    const interaction = await makeCallInteraction(client.id, callAt);
    mockShowingExtract(tomorrowLocal(callAt));

    expect((await analyzeCall(interaction.id)).ok).toBe(true);

    expect(await prisma.interaction.count({ where: { clientId: client.id, type: "SHOWING" } })).toBe(0);
    const question = await prisma.showingQuestion.findUnique({ where: { dedupKey: `agreement:CALL:${interaction.id}` } });
    expect(question?.kind).toBe("AGREEMENT");
    expect(question?.propertyId).toBeNull();
    expect(question?.proposedAt?.toISOString()).toBe(parseShowingAt(tomorrowLocal(callAt), callAt)!.toISOString());
    // Объект из подбора — только кнопкой на выбор, не сам.
    const details = await loadQuestionDetails(question!);
    expect(details?.options.map((o) => o.id)).toContain(property.id);
  });

  it("рубильник «Шабнам переспрашивает» выключен — прежнее поведение: единственный подходящий объект ставится сам", async () => {
    const property = await makeProperty(legacyDistrictId, "прежний");
    const client = await makeBuyer(legacyDistrictId);
    const callAt = new Date();
    const interaction = await makeCallInteraction(client.id, callAt);
    mockShowingExtract(tomorrowLocal(callAt));

    switchesOff.add("showingAgreementAskEnabled");
    try {
      expect((await analyzeCall(interaction.id)).ok).toBe(true);
    } finally {
      switchesOff.delete("showingAgreementAskEnabled");
    }
    const showing = await prisma.interaction.findFirst({ where: { clientId: client.id, type: "SHOWING" } });
    expect(showing?.propertyId).toBe(property.id);
    expect(showing?.agentId).toBe(agentId);
    expect(await prisma.showingQuestion.count({ where: { clientId: client.id } })).toBe(0);
    expect(sendPushToAgent).toHaveBeenCalled();
  });

  it("объект доказан (клиент пришёл по нему) — показ ставится на НЕГО, а не на единственный объект из подбора", async () => {
    // В районе клиента подбор даёт один объект — «не тот»; клиент пришёл по объекту из другого района.
    const wrong = await makeProperty(provenDistrictId, "из-подбора");
    const proven = await makeProperty(otherDistrictId, "доказанный");
    const client = await makeBuyer(provenDistrictId);
    await prisma.client.update({ where: { id: client.id }, data: { matchedPropertyId: proven.id } });
    const callAt = new Date();
    const interaction = await makeCallInteraction(client.id, callAt);
    mockShowingExtract(tomorrowLocal(callAt));

    expect((await analyzeCall(interaction.id)).ok).toBe(true);

    const showings = await prisma.interaction.findMany({ where: { clientId: client.id, type: "SHOWING" } });
    expect(showings).toHaveLength(1);
    expect(showings[0].propertyId).toBe(proven.id);
    expect(showings[0].propertyId).not.toBe(wrong.id);
    expect(await prisma.showingQuestion.count({ where: { clientId: client.id } })).toBe(0);
  });

  it("доказанный объект уже продан — показ сам не ставится, агента спрашивают без объекта", async () => {
    const sold = await makeProperty(soldDistrictId, "продан");
    await prisma.property.update({ where: { id: sold.id }, data: { status: "SOLD" } });
    const client = await makeBuyer(soldDistrictId);
    await prisma.client.update({ where: { id: client.id }, data: { matchedPropertyId: sold.id } });
    const callAt = new Date();
    const interaction = await makeCallInteraction(client.id, callAt);
    mockShowingExtract(tomorrowLocal(callAt));

    await analyzeCall(interaction.id);

    expect(await prisma.interaction.count({ where: { clientId: client.id, type: "SHOWING" } })).toBe(0);
    const question = await prisma.showingQuestion.findUnique({ where: { dedupKey: `agreement:CALL:${interaction.id}` } });
    expect(question?.propertyId).toBeNull();
  });

  it("время не названо, но цитата о показе есть в расшифровке — вопрос без времени; выдуманная цитата — ничего", async () => {
    const client = await makeBuyer(soldDistrictId);
    const callAt = new Date();
    const first = await makeCallInteraction(client.id, callAt);
    callAiText.mockResolvedValueOnce({
      score: 60, summary: "Договорились съездить посмотреть", outcome: "WAITING_SHOWING",
      showingAt: null, showingAgreementQuote: "Разговор о показе квартиры завтра вечером",
    });
    await analyzeCall(first.id);
    const question = await prisma.showingQuestion.findUnique({ where: { dedupKey: `agreement:CALL:${first.id}` } });
    expect(question?.proposedAt).toBeNull();
    expect(question?.quote).toContain("показе квартиры");

    const second = await makeCallInteraction(client.id, callAt);
    callAiText.mockResolvedValueOnce({
      score: 60, summary: "Договорились съездить посмотреть", outcome: "WAITING_SHOWING",
      showingAt: null, showingAgreementQuote: "Этой фразы в разговоре не было вовсе",
    });
    await analyzeCall(second.id);
    expect(await prisma.showingQuestion.findUnique({ where: { dedupKey: `agreement:CALL:${second.id}` } })).toBeNull();
  });

  it("выключатель «ИИ сам назначает показ по разговору агента»: выключен — показ по звонку не назначается (агента спрашивают)", async () => {
    const proven = await makeProperty(offDistrictId, "выключатель");
    const client = await makeBuyer(offDistrictId);
    await prisma.client.update({ where: { id: client.id }, data: { matchedPropertyId: proven.id } });
    const callAt = new Date();
    const interaction = await makeCallInteraction(client.id, callAt);
    mockShowingExtract(tomorrowLocal(callAt));

    switchesOff.add("aiAgentShowingAutoBookEnabled");
    try {
      const result = await analyzeCall(interaction.id);
      // Остальной разбор звонка идёт как обычно.
      expect(result.ok).toBe(true);
    } finally {
      switchesOff.delete("aiAgentShowingAutoBookEnabled");
    }
    expect(await prisma.interaction.count({ where: { clientId: client.id, type: "SHOWING" } })).toBe(0);
    // Сам ИИ не ставит — но и договорённость не теряется: вопрос агенту с доказанным объектом.
    const question = await prisma.showingQuestion.findUnique({ where: { dedupKey: `agreement:CALL:${interaction.id}` } });
    expect(question?.propertyId).toBe(proven.id);

    // Включён (умолчание) — тот же звонок с доказанным объектом назначает показ: без этого
    // проверка выше проходила бы и без выключателя.
    await prisma.showingQuestion.deleteMany({ where: { clientId: client.id } });
    const second = await makeCallInteraction(client.id, callAt);
    mockShowingExtract(tomorrowLocal(callAt));
    expect((await analyzeCall(second.id)).ok).toBe(true);
    expect(await prisma.interaction.count({ where: { clientId: client.id, type: "SHOWING" } })).toBe(1);
  });

  it("два подходящих объекта — решение остаётся агенту, показ сам не создаётся", async () => {
    await makeProperty(otherDistrictId, "первый-из-двух");
    await makeProperty(otherDistrictId, "второй-из-двух");
    const client = await makeBuyer(otherDistrictId);
    const callAt = new Date();
    const interaction = await makeCallInteraction(client.id, callAt);
    mockShowingExtract(tomorrowLocal(callAt));

    const result = await analyzeCall(interaction.id);
    expect(result.ok).toBe(true);

    const showing = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SHOWING" },
    });
    expect(showing).toBeNull();

    /* Окно «Назначить показ» здесь больше не заводится: механизм обязательных
       окон удалён 13.09.2026. Проверяемое осталось прежним — сам показ при
       неоднозначности не создаётся, решение остаётся агенту. */
  });

  it("подходящий объект есть, но у клиента уже есть показ рядом по времени — дубль не создаётся", async () => {
    const client = await makeBuyer(districtId);
    const callAt = new Date();
    // Тот же разбор строки, что использует сам код (parseShowingAt) — иначе
    // «через 24 часа ровно» и «завтра в 18:00 по Душанбе» разъезжаются на часы,
    // и проверка на дубль сравнивала бы разное время само с собой.
    const showingAt = parseShowingAt(tomorrowLocal(callAt), callAt)!;
    // Показ назначен агентом РАНЬШЕ (например, вчера, по предыдущему звонку) —
    // createdAt заведомо старше interaction.createdAt ниже, иначе сработал бы
    // другой, более старый щит (alreadyBooked в callAnalysis.ts: «этот звонок уже
    // назначил показ»), а не тот, что здесь проверяется (hasNearbyShowing).
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "SHOWING",
        notes: "Показ, назначенный агентом вручную",
        // nextAction обязателен — это признак ЖИВОЙ задачи, а не любой строки
        // типа SHOWING: отмена показа снимает именно его (lib/showingBooking.ts,
        // cancelShowing), и по нему же показ виден в задачах (lib/tasks.ts).
        // Настоящее ручное назначение всегда его ставит (lib/scheduleShowing.ts:70),
        // а фикстура его не ставила — до унификации проверки дубля 22.08.2026 это
        // не замечалось, потому что прежний запрос смотрел только на дату и
        // declinedAt и считал дублем в том числе отменённый и уже прошедший показ.
        nextAction: "Показ объекта",
        nextActionDate: showingAt,
        createdAt: new Date(callAt.getTime() - 2 * 24 * 3600_000),
      },
    });
    const interaction = await makeCallInteraction(client.id, callAt);
    mockShowingExtract(tomorrowLocal(callAt));

    await analyzeCall(interaction.id);

    const showings = await prisma.interaction.findMany({ where: { clientId: client.id, type: "SHOWING" } });
    expect(showings.length).toBe(1);

    /* Окно «Назначить показ» здесь больше не заводится: механизм обязательных
       окон удалён 13.09.2026. Проверяемое осталось прежним — сам показ при
       неоднозначности не создаётся, решение остаётся агенту. */
  });
});
