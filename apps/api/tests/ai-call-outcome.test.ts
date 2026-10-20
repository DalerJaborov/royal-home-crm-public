import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { assessAiOutcomeConfidence, applyAiCallOutcome } = await import("../src/lib/aiCallOutcome.js");

/**
 * АВТОЗАПИСЬ ИСХОДА ЗВОНКА ИИ, БЕЗ ОКНА «КАК ПРОШЁЛ ЗВОНОК» (владелец 17-18.08.2026).
 *
 * Проверяем ровно то, из-за чего эта функция и завелась: короткий/неоднозначный
 * разговор не пишется вслепую, продавец не путается с покупателем, гонка с
 * человеком, заполнившим форму первым, не перезаписывает его ответ, а окно
 * call_result, заведённое сразу после звонка, закрывается само, когда автозапись
 * удалась.
 */

const runId = Date.now();
let agentId: string;
let buyerId: string;
let sellerId: string;
const interactionIds: string[] = [];
const clientIds: string[] = [];

const LONG_TRANSCRIPT = "Разговор о подборе квартиры ".repeat(15); // > 240 символов

async function makeInteraction(clientId: string) {
  const i = await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "Звонок через CRM" },
  });
  interactionIds.push(i.id);
  return i;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент ИИ-итога", phone: `+992951${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  const buyer = await prisma.client.create({
    data: {
      fullName: `Покупатель ИИ-итога ${runId}`,
      phone: `+992952${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  buyerId = buyer.id;
  clientIds.push(buyerId);
  const seller = await prisma.client.create({
    data: {
      fullName: `Продавец ИИ-итога ${runId}`,
      phone: `+992953${runId}`,
      source: "PHONE_CALL",
      kind: "SELLER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  sellerId = seller.id;
  clientIds.push(sellerId);
});

afterEach(() => {
  sendPushToAgent.mockClear();
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } }).catch(() => {});
  await prisma.pendingSummary.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("assessAiOutcomeConfidence", () => {
  it("нет исхода — не уверены", () => {
    const v = assessAiOutcomeConfidence(
      {
        interactionId: "x",
        agentId: "x",
        clientId: "x",
        transcriptLength: 1000,
        outcome: null,
        nextAction: null,
        showingAt: null,
        callbackAt: null,
        summary: "Разговор о подборе",
      },
      "BUYER"
    );
    expect(v.confident).toBe(false);
  });

  it("исход продавца (PROPERTY_ACCEPTED) для покупателя не подходит", () => {
    const v = assessAiOutcomeConfidence(
      {
        interactionId: "x",
        agentId: "x",
        clientId: "x",
        transcriptLength: 1000,
        outcome: "PROPERTY_ACCEPTED",
        nextAction: null,
        showingAt: null,
        callbackAt: null,
        summary: "Разговор о подборе",
      },
      "BUYER"
    );
    expect(v.confident).toBe(false);
  });

  it("короткий разговор — не уверены, даже если исход есть", () => {
    const v = assessAiOutcomeConfidence(
      {
        interactionId: "x",
        agentId: "x",
        clientId: "x",
        transcriptLength: 50,
        outcome: "WAITING_CALL",
        nextAction: null,
        showingAt: null,
        callbackAt: null,
        summary: "Коротко",
      },
      "BUYER"
    );
    expect(v.confident).toBe(false);
  });

  it("«Ждёт показ» без распознанной даты — не уверены", () => {
    const v = assessAiOutcomeConfidence(
      {
        interactionId: "x",
        agentId: "x",
        clientId: "x",
        transcriptLength: 1000,
        outcome: "WAITING_SHOWING",
        nextAction: null,
        showingAt: null,
        callbackAt: null,
        summary: "Договорились о показе",
      },
      "BUYER"
    );
    expect(v.confident).toBe(false);
  });

  it("длинный разговор с понятным исходом — уверены", () => {
    const v = assessAiOutcomeConfidence(
      {
        interactionId: "x",
        agentId: "x",
        clientId: "x",
        transcriptLength: 1000,
        outcome: "WAITING_OPTIONS",
        nextAction: "Отправить подборку",
        showingAt: null,
        callbackAt: null,
        summary: "Клиент ждёт подборку по Сино",
      },
      "BUYER"
    );
    expect(v.confident).toBe(true);
  });
});

describe("applyAiCallOutcome", () => {
  it("уверенный исход пишется в Interaction с outcomeSource=AI_AUTO", async () => {
    const interaction = await makeInteraction(buyerId);
    const applied = await applyAiCallOutcome({
      interactionId: interaction.id,
      agentId,
      clientId: buyerId,
      transcriptLength: LONG_TRANSCRIPT.length,
      outcome: "WAITING_OPTIONS",
      nextAction: "Отправить подборку 2-комн в Сино",
      showingAt: null,
      callbackAt: null,
      summary: "Клиент ждёт подборку 2-комнатных в Сино",
    });
    expect(applied).toBe(true);

    const updated = await prisma.interaction.findUniqueOrThrow({ where: { id: interaction.id } });
    expect(updated.outcome).toBe("WAITING_OPTIONS");
    expect(updated.outcomeSource).toBe("AI_AUTO");
    expect(updated.nextAction).toBe("Отправить подборку 2-комн в Сино");
    expect(updated.notes).toContain("Итог (ИИ)");
  });

  it("неуверенный исход ничего не пишет", async () => {
    const interaction = await makeInteraction(buyerId);
    const applied = await applyAiCallOutcome({
      interactionId: interaction.id,
      agentId,
      clientId: buyerId,
      transcriptLength: 30,
      outcome: "WAITING_CALL",
      nextAction: null,
      showingAt: null,
      callbackAt: null,
      summary: "Алло",
    });
    expect(applied).toBe(false);

    const untouched = await prisma.interaction.findUniqueOrThrow({ where: { id: interaction.id } });
    expect(untouched.outcome).toBeNull();
    expect(untouched.outcomeSource).toBe("HUMAN");
  });

  it("гонка с человеком: исход уже записан — ИИ не перезаписывает", async () => {
    const interaction = await makeInteraction(buyerId);
    await prisma.interaction.update({
      where: { id: interaction.id },
      data: { outcome: "NEGATIVE" },
    });

    const applied = await applyAiCallOutcome({
      interactionId: interaction.id,
      agentId,
      clientId: buyerId,
      transcriptLength: LONG_TRANSCRIPT.length,
      outcome: "WAITING_OPTIONS",
      nextAction: "Отправить подборку",
      showingAt: null,
      callbackAt: null,
      summary: "Клиент ждёт подборку",
    });
    expect(applied).toBe(false);

    const stillHuman = await prisma.interaction.findUniqueOrThrow({ where: { id: interaction.id } });
    expect(stillHuman.outcome).toBe("NEGATIVE");
    expect(stillHuman.outcomeSource).toBe("HUMAN");
  });

  it("заглушка SYSTEM_STUB (отвеченный входящий, incomingCalls.ts) — ИИ имеет право переписать её настоящим исходом", async () => {
    /**
     * Найдено ревью 24.09.2026: incomingCalls.ts ставит отвеченному входящему
     * outcome="NEUTRAL" с outcomeSource="SYSTEM_STUB" ДО разбора (только чтобы
     * clientAutoStatus.ts не читал пустой исход как «связи не было» — см.
     * докстринг там же). Раньше `if (interaction.outcome) return false;` видел
     * эту заглушку как «уже занято» и НИКОГДА не применял разбор для входящих —
     * у всех отвеченных входящих итог/nextAction/callbackAt не долетали.
     */
    const interaction = await makeInteraction(buyerId);
    await prisma.interaction.update({
      where: { id: interaction.id },
      data: { outcome: "NEUTRAL", outcomeSource: "SYSTEM_STUB" },
    });

    const showingAt = new Date(Date.now() + 24 * 3600_000);
    const applied = await applyAiCallOutcome({
      interactionId: interaction.id,
      agentId,
      clientId: buyerId,
      transcriptLength: LONG_TRANSCRIPT.length,
      outcome: "WAITING_SHOWING",
      nextAction: null,
      showingAt,
      callbackAt: null,
      summary: "Договорились о показе завтра",
    });
    expect(applied).toBe(true);

    const updated = await prisma.interaction.findUniqueOrThrow({ where: { id: interaction.id } });
    expect(updated.outcome).toBe("WAITING_SHOWING");
    expect(updated.outcomeSource).toBe("AI_AUTO");
  });

  it("тот же отвеченный входящий, но исход уже поставлен АГЕНТОМ (HUMAN) — ИИ не перезаписывает", async () => {
    const interaction = await makeInteraction(buyerId);
    await prisma.interaction.update({
      where: { id: interaction.id },
      data: { outcome: "NEGATIVE", outcomeSource: "HUMAN" },
    });

    const applied = await applyAiCallOutcome({
      interactionId: interaction.id,
      agentId,
      clientId: buyerId,
      transcriptLength: LONG_TRANSCRIPT.length,
      outcome: "WAITING_SHOWING",
      nextAction: null,
      showingAt: new Date(Date.now() + 24 * 3600_000),
      callbackAt: null,
      summary: "Договорились о показе завтра",
    });
    expect(applied).toBe(false);

    const untouched = await prisma.interaction.findUniqueOrThrow({ where: { id: interaction.id } });
    expect(untouched.outcome).toBe("NEGATIVE");
    expect(untouched.outcomeSource).toBe("HUMAN");
  });

  it("договорились созвониться в понедельник — напоминание ставится на это время", async () => {
    /**
     * Владелец 19.09.2026: «если клиент называл определённое время, когда он сам
     * позвонит или агент ему должен позвонить, то тогда должно ставиться
     * напоминание». До этой правки договорённость оставалась только текстом в
     * nextAction, а nextActionDate у WAITING_CALL был пуст — и к назначенному
     * часу агенту не напоминал ни календарь, ни «Задачи на сегодня» (оба читают
     * именно nextActionDate).
     */
    const interaction = await makeInteraction(buyerId);
    const callbackAt = new Date(Date.now() + 3 * 24 * 3600_000);
    const applied = await applyAiCallOutcome({
      interactionId: interaction.id,
      agentId,
      clientId: buyerId,
      transcriptLength: LONG_TRANSCRIPT.length,
      outcome: "WAITING_CALL",
      nextAction: "Перезвонить в понедельник",
      showingAt: null,
      callbackAt,
      summary: "Клиент попросил перезвонить в понедельник после обеда",
    });
    expect(applied).toBe(true);

    const saved = await prisma.interaction.findUniqueOrThrow({ where: { id: interaction.id } });
    expect(saved.nextAction).toBe("Перезвонить в понедельник");
    expect(saved.nextActionDate?.getTime()).toBe(callbackAt.getTime());
  });

  it("о времени звонка не договаривались — напоминание не выдумывается", async () => {
    const interaction = await makeInteraction(buyerId);
    const applied = await applyAiCallOutcome({
      interactionId: interaction.id,
      agentId,
      clientId: buyerId,
      transcriptLength: LONG_TRANSCRIPT.length,
      outcome: "WAITING_OPTIONS",
      nextAction: "Отправить подборку 3-комн в Сино",
      showingAt: null,
      callbackAt: null,
      summary: "Клиент ждёт подборку объектов",
    });
    expect(applied).toBe(true);

    const saved = await prisma.interaction.findUniqueOrThrow({ where: { id: interaction.id } });
    expect(saved.nextActionDate).toBeNull();
  });

  it("продавец: «Объект принят в работу» ставит propertyAcceptedAt", async () => {
    const interaction = await makeInteraction(sellerId);
    const applied = await applyAiCallOutcome({
      interactionId: interaction.id,
      agentId,
      clientId: sellerId,
      transcriptLength: LONG_TRANSCRIPT.length,
      outcome: "PROPERTY_ACCEPTED",
      nextAction: null,
      showingAt: null,
      callbackAt: null,
      summary: "Продавец согласился сдать объект в работу",
    });
    expect(applied).toBe(true);

    const seller = await prisma.client.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller.propertyAcceptedAt).not.toBeNull();

    /* Обязательного окна «Итог объекта» здесь больше нет: механизм удалён
       13.09.2026. Отметка propertyAcceptedAt осталась — по ней живёт антифрод
       «продавец без объекта», и проверяется именно она. */
  });

});
