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

const { prisma } = await import("../src/db.js");
const { analyzeCall, parseShowingAt } = await import("../src/ai/callAnalysis.js");

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
});

afterAll(async () => {
  await prisma.callAnalysis.deleteMany({ where: { interactionId: { in: interactionIds } } });
  await prisma.pendingSummary.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { OR: [{ agentId }, { clientId: { in: clientIds } }] } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: { in: [districtId, otherDistrictId] } } });
});

/** Локальное время Душанбе, гарантированно в пределах окна допустимых дат
 *  (parseShowingAt), считанное от момента звонка. */
function tomorrowLocal(callAt: Date): string {
  const d = new Date(callAt.getTime() + 24 * 3600_000);
  return `${d.toISOString().slice(0, 10)}T18:00`;
}

describe("Показ по разговору — автоназначение при однозначности", () => {
  it("ровно один подходящий объект — показ назначается сам, окна нет", async () => {
    const property = await makeProperty(districtId, "один");
    const client = await makeBuyer(districtId);
    const callAt = new Date();
    const interaction = await makeCallInteraction(client.id, callAt);
    mockShowingExtract(tomorrowLocal(callAt));

    const result = await analyzeCall(interaction.id);
    expect(result.ok).toBe(true);

    const showing = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SHOWING" },
    });
    expect(showing).not.toBeNull();
    expect(showing?.propertyId).toBe(property.id);
    expect(showing?.agentId).toBe(agentId);

    const window = await prisma.pendingSummary.findFirst({
      where: { kind: "showing_book", subjectId: interaction.id },
    });
    expect(window).toBeNull();
    expect(sendPushToAgent).toHaveBeenCalled();
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
