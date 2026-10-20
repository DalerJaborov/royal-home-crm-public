import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * АВТОМАТИЧЕСКАЯ КАРТОЧКА ПО ВХОДЯЩЕМУ ЗВОНКУ (решение владельца 18.08.2026).
 *
 * Новая схема приёма: закреплённого клиента станция уводит его агенту, всех
 * остальных — на мобильный оператора, и «оператор просто должен взять максимум
 * информации и далее ничего уже не делает ни в CRM». Значит лида из разговора
 * заводит сама CRM — по расшифровке, которая приходит через минуту после отбоя.
 *
 * ЧТО СТЕРЕГУТ ЭТИ ТЕСТЫ. Не работу модели (она замокана), а решения вокруг неё:
 * заводится ли карточка, уходит ли лид в обычную раздачу, не появляется ли вторая
 * от повторного прогона, не заводится ли карточка на курьера и сотрудника, и —
 * главное — остаётся ли звонок ЧЕЛОВЕКУ, когда автоматика не справилась. Последнее
 * важнее всего: молча потерянный звонок хуже любого неверного поля.
 *
 * Модель подменена целиком: тест про раздачу лидов не должен зависеть ни от ключа
 * поставщика, ни от того, что именно Haiku сегодня ответит.
 */

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const extractIncomingCallLead = vi.fn();
vi.mock("../src/ai/incomingCallLead.js", () => ({ extractIncomingCallLead }));

const { prisma } = await import("../src/db.js");
const { autoLeadFromIncomingCall, autoLeadFromInteraction, sweepIncomingCallsForLeads } = await import(
  "../src/lib/telephony/autoLeadFromCall.js"
);
const { markIncomingBridged, seedLiveIncoming, awaitIncomingReady, resetIncomingCalls } = await import(
  "../src/lib/telephony/incomingCalls.js"
);

const runId = Date.now();
const tail = String(runId).slice(-7);

let agentId = "";
const createdClientIds: string[] = [];
const createdCallIds: string[] = [];
const createdInteractionIds: string[] = [];

/** Расшифровка длиннее порога разбора — короткую модуль отбрасывает не спрашивая ИИ. */
const TRANSCRIPT =
  "Здравствуйте, меня зовут Фируз, я ищу двухкомнатную квартиру в районе Сино, " +
  "бюджет примерно до четырёхсот тысяч сомони, хотел бы посмотреть на выходных.";

const GOOD_EXTRACT = {
  kind: "BUYER" as const,
  confident: true,
  fullName: "Фируз",
  requirementsNotes: "Ищет 2-комнатную в Сино до 400 000 сомони",
  desiredDistrictId: null,
  desiredRooms: 2,
  desiredType: "APARTMENT" as const,
  budgetMin: null,
  budgetMax: 400_000,
};

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент автолида ${runId}`,
      phone: `+99298${tail}`,
      role: "AGENT",
      passwordHash: "x",
      isActive: true,
    },
  });
  agentId = agent.id;
});

beforeEach(() => {
  extractIncomingCallLead.mockReset();
  sendPushToAgent.mockClear();
});

afterEach(async () => {
  resetIncomingCalls();
  await prisma.incomingCall.deleteMany({ where: { id: { in: createdCallIds } } });
  createdCallIds.length = 0;
  await prisma.interaction.deleteMany({ where: { id: { in: createdInteractionIds } } });
  createdInteractionIds.length = 0;
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
  createdClientIds.length = 0;
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

/** Карточка-заглушка, какую заводит сам разговор (createCardForUnknownCaller). */
async function seedStubClient(phone: string): Promise<string> {
  const client = await prisma.client.create({
    data: { fullName: `Входящий ${phone}`, phone, source: "PHONE_CALL", kind: "OTHER", status: "NEW", currency: "TJS" },
  });
  createdClientIds.push(client.id);
  return client.id;
}

/** Отвеченный входящий звонок с записью в хронологии и расшифровкой. */
async function seedAnsweredCall(options: {
  phone: string;
  clientId?: string | null;
  transcript?: string | null;
  startedAt?: Date;
}): Promise<string> {
  let interactionId: string | null = null;
  if (options.clientId) {
    const interaction = await prisma.interaction.create({
      data: {
        clientId: options.clientId,
        agentId,
        type: "CALL",
        notes: "Входящий звонок клиента: поговорил с оператором",
        outcome: "NEUTRAL",
        ...(options.transcript ? { transcript: options.transcript } : {}),
      },
    });
    createdInteractionIds.push(interaction.id);
    interactionId = interaction.id;
  }

  const call = await prisma.incomingCall.create({
    data: {
      channelId: `auto-lead-${runId}-${Math.random().toString(36).slice(2)}`,
      phone: options.phone,
      startedAt: options.startedAt ?? new Date(),
      endedAt: new Date(),
      answered: true,
      talkSeconds: 90,
      clientId: options.clientId ?? null,
      autoCreatedClient: !!options.clientId,
      interactionId,
    },
  });
  createdCallIds.push(call.id);
  return call.id;
}

describe("Автоматическая карточка по входящему звонку", () => {
  it("после разговора с оператором заводит лида и отдаёт его в обычную раздачу", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const phone = `+99271${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("qualified");
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client?.kind).toBe("BUYER");
    expect(client?.fullName).toBe("Фируз");
    expect(client?.desiredRooms).toBe(2);
    expect(client?.desiredType).toBe("APARTMENT");
    expect(Number(client?.budgetMax)).toBe(400_000);
    // Раздача — та же, что у лида из чатов (pickAgentForLead внутри qualifyIncomingCall).
    expect(client?.assignedAgentId).not.toBeNull();

    const call = await prisma.incomingCall.findUnique({ where: { id: callId } });
    // Разобран без человека: qualifiedById пуст, а звонок больше не висит
    // в «Без разбора» — оператору делать с ним нечего.
    expect(call?.qualifiedAt).not.toBeNull();
    expect(call?.qualifiedById).toBeNull();
    expect(call?.autoLeadStatus).toBe("qualified");
  });

  it("повторный прогон не заводит вторую карточку и не платит второй раз за ИИ", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const phone = `+99272${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });

    await autoLeadFromIncomingCall(callId);
    const again = await autoLeadFromIncomingCall(callId);

    expect(again.status).toBe("skipped");
    // Модель спрошена ровно один раз: замок autoLeadAt занимается ДО обращения к ней.
    expect(extractIncomingCallLead).toHaveBeenCalledTimes(1);
    expect(await prisma.client.count({ where: { phone } })).toBe(1);
  });

  it("клиента, которого уже ведёт агент, не трогает и не дублирует", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const phone = `+99273${tail}`;
    const client = await prisma.client.create({
      data: {
        fullName: `Давний клиент ${runId}`,
        phone,
        source: "PHONE_CALL",
        kind: "SELLER",
        assignedAgentId: agentId,
        requirementsNotes: "Продаёт дом в Фирдавси",
      },
    });
    createdClientIds.push(client.id);
    const callId = await seedAnsweredCall({ phone, clientId: client.id, transcript: TRANSCRIPT });

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("known_client");
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.fullName).toBe(`Давний клиент ${runId}`);
    expect(after?.kind).toBe("SELLER");
    expect(after?.requirementsNotes).toBe("Продаёт дом в Фирдавси");
    expect(await prisma.client.count({ where: { phone } })).toBe(1);
    // Звонок ушёл прямо агенту — ИИ на него тратить незачем.
    expect(extractIncomingCallLead).not.toHaveBeenCalled();
  });

  /**
   * Возврат из Неактивных по звонку клиента гасит светофор целиком (23.09.2026),
   * а не только workStatus: иначе прошлый уровень, счётчик попыток и точка
   * отсчёта оставались на живой карточке. Без правки тест красный — inactiveLevel
   * оставался "RED", inactivePingCount = 2.
   */
  it("неактивный клиент позвонил сам — возвращён в работу, поля светофора сброшены", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const phone = `+99265${tail}`;
    const client = await prisma.client.create({
      data: {
        fullName: `Неактивный позвонил ${runId}`,
        phone,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
        workStatus: "INACTIVE",
        inactiveLevel: "RED",
        inactiveReasonKey: "STOPPED_RESPONDING",
        inactiveSince: new Date(Date.now() - 3 * 24 * 3600_000),
        inactivePingCount: 2,
      },
    });
    createdClientIds.push(client.id);
    const callId = await seedAnsweredCall({ phone, clientId: client.id, transcript: TRANSCRIPT });

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("known_client");
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.workStatus).toBe("ACTIVE");
    expect(after.inactiveLevel).toBeNull();
    expect(after.inactiveReasonKey).toBeNull();
    expect(after.inactiveSince).toBeNull();
    expect(after.inactivePingCount).toBe(0);
    expect(after.returnedAt).not.toBeNull();
    // status не тронут: судьбу LOST этот путь не решает.
    expect(after.status).toBe(client.status);
  });

  it("нецелевой звонок карточку не заводит: заглушка удаляется, номер запоминается", async () => {
    extractIncomingCallLead.mockResolvedValue({ ...GOOD_EXTRACT, kind: "IRRELEVANT", fullName: null });
    const phone = `+99274${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("irrelevant");
    expect(await prisma.client.count({ where: { phone, deletedAt: null } })).toBe(0);
    const call = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(call?.irrelevant).toBe(true);
    expect(call?.autoLeadStatus).toBe("irrelevant");
  });

  it("звонок сотрудника лидом не становится", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    // Агентство звонит себе же: карточка на собственного сотрудника не только мусор —
    // она заняла бы его номер уникальностью Client.phone.
    const callId = await seedAnsweredCall({ phone: `+99298${tail}` });

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("irrelevant");
    expect(extractIncomingCallLead).not.toHaveBeenCalled();
    expect(await prisma.client.count({ where: { phone: `+99298${tail}` } })).toBe(0);
  });

  it("живой звонок сотрудника не заводит карточку-заглушку в момент разговора (баг 20.08.2026)", async () => {
    // Раньше заглушку "Входящий +992…" заводил САМ ОТВЕТ на звонок
    // (createCardForUnknownCaller, до всякого разбора), и проверка "это сотрудник?"
    // жила только в decide() выше — то есть срабатывала уже ПОСЛЕ того, как
    // заглушка появилась, и не убирала её за собой. Раз номер сотрудника никогда
    // не помечался irrelevant, счётчик "дважды не по делу → служебный номер" тоже
    // не срабатывал — заглушка плодилась заново на каждый звонок в офис.
    const phone = `+99298${tail}`;
    const channelId = `live-employee-${runId}`;

    seedLiveIncoming({ channelId, phone, recordId: `record-${channelId}` });
    markIncomingBridged(channelId);
    await awaitIncomingReady(channelId);

    expect(await prisma.client.count({ where: { phone } })).toBe(0);
  });

  it("нет расшифровки — карточка по номеру есть, но звонок остаётся человеку", async () => {
    const phone = `+99275${tail}`;
    const clientId = await seedStubClient(phone);
    // Записи разговора не оказалось: у записи хронологии пустой transcript.
    const callId = await seedAnsweredCall({ phone, clientId, transcript: null });

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("no_data");
    expect(result.clientId).toBe(clientId);
    // Модель не спрашивали — разбирать нечего.
    expect(extractIncomingCallLead).not.toHaveBeenCalled();

    const call = await prisma.incomingCall.findUnique({ where: { id: callId } });
    // ГЛАВНОЕ: qualifiedAt остаётся пустым — звонок виден в «Только без разбора»
    // на вкладке «Звонки», и человек дозаполнит карточку сам.
    expect(call?.qualifiedAt).toBeNull();
    expect(call?.autoLeadStatus).toBe("no_data");
    // Но заглушка по номеру цела: человек звонил, это лид, пусть и без подробностей.
    expect(await prisma.client.count({ where: { phone } })).toBe(1);
  });

  it("модель не поняла разговор — звонок тоже остаётся человеку", async () => {
    extractIncomingCallLead.mockResolvedValue({ ...GOOD_EXTRACT, confident: false });
    const phone = `+99276${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("no_data");
    const call = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(call?.qualifiedAt).toBeNull();
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    // Ничего не выдумано: тип обращения остался неизвестным, а не «покупатель».
    expect(client?.kind).toBe("OTHER");
    expect(client?.fullName).toBe(`Входящий ${phone}`);
  });

  it("непринятый звонок автоматику не запускает", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const phone = `+99277${tail}`;
    const call = await prisma.incomingCall.create({
      data: {
        channelId: `auto-lead-missed-${runId}`,
        phone,
        startedAt: new Date(),
        endedAt: new Date(),
        answered: false,
      },
    });
    createdCallIds.push(call.id);

    const result = await autoLeadFromIncomingCall(call.id);

    expect(result.status).toBe("skipped");
    expect(extractIncomingCallLead).not.toHaveBeenCalled();
    expect(await prisma.client.count({ where: { phone } })).toBe(0);
  });

  it("разбор, пришедший по записи хронологии, находит свой входящий звонок", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const phone = `+99278${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });
    const call = await prisma.incomingCall.findUnique({ where: { id: callId } });

    const result = await autoLeadFromInteraction(call!.interactionId!);

    expect(result?.status).toBe("qualified");
  });

  it("разбор звонка АГЕНТА автоматику не трогает вовсе", async () => {
    const phone = `+99279${tail}`;
    const clientId = await seedStubClient(phone);
    const interaction = await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Звонок агента клиенту", transcript: TRANSCRIPT },
    });
    createdInteractionIds.push(interaction.id);

    // Записи в журнале входящих у этой беседы нет — значит звонил агент.
    expect(await autoLeadFromInteraction(interaction.id)).toBeNull();
    expect(extractIncomingCallLead).not.toHaveBeenCalled();
  });

  it("крон добирает звонки, до которых конвейер расшифровки не дошёл", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const phone = `+99270${tail}`;
    const clientId = await seedStubClient(phone);
    // Час назад — старше отсрочки, за которую запись ещё может дойти со станции.
    const callId = await seedAnsweredCall({
      phone,
      clientId,
      transcript: TRANSCRIPT,
      startedAt: new Date(Date.now() - 60 * 60_000),
    });

    await sweepIncomingCallsForLeads();

    const call = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(call?.autoLeadStatus).toBe("qualified");
    expect(call?.qualifiedAt).not.toBeNull();
  });

  /**
   * ЗАМОК, БРОШЕННЫЙ РЕСТАРТОМ (21.09.2026, соседний баг того же класса, что и
   * зависшая стадия расшифровки).
   *
   * `autoLeadAt` ставится ДО обращения к модели — это правильно, второй раз за
   * ИИ платить незачем. Но снять его мог только тот же самый проход, а автовыкат
   * перезапускает контейнеры по каждому мержу в main. Рестарт посреди разбора
   * оставлял звонок с занятым замком и без `autoLeadStatus`: повторный прогон
   * упирался в замок, а ночной подбор искал строго `autoLeadAt: null` и такой
   * звонок не видел НИКОГДА. Заявка не заводилась, и ошибки при этом не было ни
   * одной.
   */
  it("замок, брошенный рестартом, отпускается по возрасту — заявка всё-таки заводится", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const phone = `+99268${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });
    // Разбор начался полчаса назад и не закончился ничем: статуса нет.
    await prisma.incomingCall.update({
      where: { id: callId },
      data: { autoLeadAt: new Date(Date.now() - 30 * 60_000), autoLeadStatus: null },
    });

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("qualified");
    const call = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(call?.autoLeadStatus).toBe("qualified");
  });

  it("свежий замок остаётся замком: параллельный проход за ИИ второй раз не платит", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const phone = `+99267${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });
    // Разбор идёт прямо сейчас, в другом процессе.
    await prisma.incomingCall.update({
      where: { id: callId },
      data: { autoLeadAt: new Date(), autoLeadStatus: null },
    });

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("skipped");
    expect(extractIncomingCallLead).not.toHaveBeenCalled();
  });

  it("ночной подбор видит звонок с брошенным замком, а не проходит мимо", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const phone = `+99266${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({
      phone,
      clientId,
      transcript: TRANSCRIPT,
      startedAt: new Date(Date.now() - 60 * 60_000),
    });
    await prisma.incomingCall.update({
      where: { id: callId },
      data: { autoLeadAt: new Date(Date.now() - 30 * 60_000), autoLeadStatus: null },
    });

    await sweepIncomingCallsForLeads();

    const call = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(call?.autoLeadStatus).toBe("qualified");
    expect(call?.qualifiedAt).not.toBeNull();
  });

  it("трубку снял оператор первой линии — лид уходит агентам, а не оператору (владелец 23.09.2026)", async () => {
    /**
     * Незнакомый номер звонит только оператору (takesUnknownCalls), и прежнее
     * «кто снял — тот и ведёт» отдавало ЕМУ каждого такого клиента уже принятым:
     * агенты не получали ни одного лида со звонков. Оператор только слушает —
     * лид идёт в обычную раздачу.
     */
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const ext = `78${String(runId).slice(-3)}`;
    const operator = await prisma.agent.create({
      data: {
        fullName: `Оператор автолида ${runId}`,
        phone: `+99297${tail}`,
        role: "DIRECTOR",
        passwordHash: "x",
        isActive: true,
        takesUnknownCalls: true,
        sipExtension: ext,
      },
    });
    const phone = `+99268${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });
    await prisma.incomingCall.update({ where: { id: callId }, data: { answeredBy: ext } });

    try {
      const result = await autoLeadFromIncomingCall(callId);
      expect(result.status).toBe("qualified");

      const client = await prisma.client.findUnique({
        where: { id: clientId },
        select: { assignedAgentId: true },
      });
      expect(client?.assignedAgentId).not.toBeNull();
      expect(client?.assignedAgentId).not.toBe(operator.id);
    } finally {
      await prisma.client.updateMany({ where: { id: clientId }, data: { assignedAgentId: null } });
      await prisma.agent.delete({ where: { id: operator.id } });
    }
  });

  it("звонок по объявлению «за 35 000 $ у фабрики Гулдаст» — лид агенту этого объекта (ПК-000475, 24.09.2026)", async () => {
    /**
     * Живой случай: покупательница назвала оператору цену и ориентир объекта
     * Сурайё — ни адреса, ни номера. Лид ушёл общей очередью чужому агенту.
     * Цена + ориентир однозначно указывают на объект — лид уходит его агенту.
     */
    const { loadMoneyContext } = await import("../src/lib/money.js");
    const { usdToTjs } = await loadMoneyContext();
    const district = await prisma.district.upsert({
      where: { name: "Тест-район автолида" },
      update: {},
      create: { name: "Тест-район автолида" },
      select: { id: true },
    });
    const owner = await prisma.agent.create({
      data: { fullName: `Хозяйка объекта ${runId}`, phone: `+99296${tail}`, role: "AGENT", passwordHash: "x", isActive: true },
    });
    // Соперник: квартира другого агента ровно за названную сумму, но в другом
    // месте. Подбор по одному бюджету выбирает её — так лид и ушёл чужому агенту.
    const rival = await prisma.agent.create({
      data: { fullName: `Соперник объекта ${runId}`, phone: `+99294${tail}`, role: "AGENT", passwordHash: "x", isActive: true },
    });
    await prisma.property.deleteMany({ where: { title: { startsWith: "Квартира у Гулдаста" } } });
    await prisma.property.deleteMany({ where: { title: { startsWith: "Квартира соперника" } } });
    const rivalProperty = await prisma.property.create({
      data: {
        title: `Квартира соперника ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        price: 35000,
        currency: "USD",
        districtId: district.id,
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: rival.id,
        assignedAgentId: rival.id,
        ownerContact: `+99293${tail}`,
      },
    });
    const property = await prisma.property.create({
      data: {
        title: `Квартира у Гулдаста ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        price: 36500,
        currency: "USD",
        districtId: district.id,
        landmark: "Фабрика Гулдаст",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: owner.id,
        assignedAgentId: owner.id,
        ownerContact: `+99295${tail}`,
      },
    });
    extractIncomingCallLead.mockResolvedValue({
      ...GOOD_EXTRACT,
      desiredType: null,
      desiredRooms: null,
      budgetMax: Math.round(35000 * usdToTjs),
      propertyHint: null,
      propertyLandmark: "фабрики Гулдаст",
    });
    const phone = `+99267${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });

    try {
      const result = await autoLeadFromIncomingCall(callId);
      expect(result.status).toBe("qualified");
      const client = await prisma.client.findUnique({
        where: { id: clientId },
        select: { assignedAgentId: true, assignReason: true, matchedPropertyId: true },
      });
      expect(client?.assignedAgentId).toBe(owner.id);
      // Не удачей очереди, а по объекту: причина и сам объект записаны в карточку.
      expect(client?.assignReason).toBe("own_property_explicit");
      expect(client?.matchedPropertyId).toBe(property.id);
    } finally {
      await prisma.client.updateMany({ where: { id: clientId }, data: { assignedAgentId: null } });
      await prisma.property.deleteMany({ where: { id: { in: [property.id, rivalProperty.id] } } });
      await prisma.interaction.deleteMany({ where: { OR: [{ clientId }, { agentId: { in: [owner.id, rival.id] } }] } });
      await prisma.agent.deleteMany({ where: { id: { in: [owner.id, rival.id] } } }).catch(() => {});
    }
  });

  it("объект заведён «Участком», клиент назвал его квартирой — лид всё равно агенту объекта, в хронологии видно почему (ОБ-000118, 24.09.2026)", async () => {
    /**
     * Живой случай: клиент назвал оператору всё — 34 м², 300 000 сомони,
     * Исмоили Сомони, Бодомзор, — а лид ушёл раздачей другому агенту. В
     * карточке объект заведён «Участком», и узнавание вычёркивало его за тип.
     */
    const district = await prisma.district.create({ data: { name: `Район ОБ-118 ${runId}` }, select: { id: true } });
    const owner = await prisma.agent.create({
      data: { fullName: `Агент участка ${runId}`, phone: `+99280${tail}`, role: "AGENT", passwordHash: "x", isActive: true },
    });
    const property = await prisma.property.create({
      data: {
        title: `Участок узнавания ${runId}`,
        type: "LAND",
        areaSqm: 34,
        price: 300000,
        currency: "TJS",
        districtId: district.id,
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: owner.id,
        assignedAgentId: owner.id,
        ownerContact: `+99281${tail}`,
      },
    });
    extractIncomingCallLead.mockResolvedValue({
      ...GOOD_EXTRACT,
      desiredType: "APARTMENT",
      desiredRooms: null,
      desiredDistrictId: district.id,
      budgetMax: 300000,
      propertyHint: null,
      propertyLandmark: "Бодомзор",
      propertyAreaSqm: 34,
    });
    const phone = `+99282${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });

    try {
      const result = await autoLeadFromIncomingCall(callId);
      expect(result.status).toBe("qualified");
      const client = await prisma.client.findUnique({
        where: { id: clientId },
        select: { assignedAgentId: true, assignReason: true, matchedPropertyId: true },
      });
      expect(client?.assignedAgentId).toBe(owner.id);
      expect(client?.assignReason).toBe("own_property_explicit");
      expect(client?.matchedPropertyId).toBe(property.id);
      // След узнавания в карточке: какой объект, чей и по каким приметам.
      const note = await prisma.interaction.findFirst({
        where: { clientId, notes: { contains: "Узнан объект" } },
        select: { notes: true },
      });
      expect(note?.notes).toContain(`ОБ-${String(property.shortId).padStart(6, "0")}`);
      expect(note?.notes).toContain("Агент участка");
      expect(note?.notes).toContain("площадь");
    } finally {
      await prisma.client.updateMany({ where: { id: clientId }, data: { assignedAgentId: null } });
      await prisma.property.deleteMany({ where: { id: property.id } });
      await prisma.interaction.deleteMany({ where: { OR: [{ clientId }, { agentId: owner.id }] } });
      await prisma.agent.deleteMany({ where: { id: owner.id } }).catch(() => {});
      await prisma.district.deleteMany({ where: { id: district.id } });
    }
  });

  /** Объект одного агента под три случая ниже — каждый со своей ценой, чтобы не мешать соседу. */
  async function listingOf(ownerPhone: string, data: Record<string, unknown>) {
    const owner = await prisma.agent.create({
      data: { fullName: `Агент приметы ${runId}-${ownerPhone.slice(-3)}`, phone: ownerPhone, role: "AGENT", passwordHash: "x", isActive: true },
    });
    const property = await prisma.property.create({
      data: {
        title: `Объект приметы ${runId}-${ownerPhone.slice(-3)}`,
        type: "APARTMENT",
        areaSqm: 52,
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: owner.id,
        assignedAgentId: owner.id,
        ownerContact: `${ownerPhone}9`,
        ...data,
      } as never,
    });
    return { owner, property };
  }

  async function cleanupListing(clientId: string, owner: { id: string }, property: { id: string }) {
    await prisma.client.updateMany({ where: { id: clientId }, data: { assignedAgentId: null } });
    await prisma.property.deleteMany({ where: { id: property.id } });
    await prisma.interaction.deleteMany({ where: { OR: [{ clientId }, { agentId: owner.id }] } });
    await prisma.agent.deleteMany({ where: { id: owner.id } }).catch(() => {});
  }

  it("«ищу двушку до 400, видел вашу однушку за 25 тысяч долларов у ориентира» — лид агенту объекта (24.09.2026)", async () => {
    /**
     * Проход по классам после ОБ-000118: комнаты и сумма из запроса — это
     * «сколько нужно», а не приметы объявления. Раньше чужие комнаты и цена
     * дальше 20 % от бюджета вычёркивали нужный объект.
     */
    const { loadMoneyContext } = await import("../src/lib/money.js");
    const { usdToTjs } = await loadMoneyContext();
    const place = `Сомонтепа${String(runId).slice(-5)}`;
    const { owner, property } = await listingOf(`+99283${tail}`, { price: 25000, currency: "USD", rooms: 1, landmark: place });
    extractIncomingCallLead.mockResolvedValue({
      ...GOOD_EXTRACT,
      desiredRooms: 2,
      budgetMax: 400_000,
      propertyHint: null,
      propertyLandmark: place,
      propertyRooms: 1,
      propertyPrice: 25000,
      propertyPriceCurrency: "USD",
    });
    const phone = `+99284${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });
    try {
      expect(Math.round(25000 * usdToTjs)).toBeLessThan(400_000 * 0.8);
      const result = await autoLeadFromIncomingCall(callId);
      expect(result.status).toBe("qualified");
      const client = await prisma.client.findUnique({ where: { id: clientId }, select: { assignedAgentId: true, assignReason: true } });
      expect(client?.assignedAgentId).toBe(owner.id);
      expect(client?.assignReason).toBe("own_property_explicit");
    } finally {
      await cleanupListing(clientId, owner, property);
    }
  });

  it("робозвонок узнал объект в разговоре — лид его агенту, даже если по расшифровке не узнать (24.09.2026)", async () => {
    const { owner, property } = await listingOf(`+99285${tail}`, { price: 777777, currency: "TJS" });
    // Расшифровка без единой приметы объекта: заново узнать нечего.
    extractIncomingCallLead.mockResolvedValue({ ...GOOD_EXTRACT, propertyHint: null });
    const phone = `+99286${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });
    try {
      const result = await autoLeadFromIncomingCall(callId, { propertyId: property.id });
      expect(result.status).toBe("qualified");
      const client = await prisma.client.findUnique({ where: { id: clientId }, select: { assignedAgentId: true, assignReason: true } });
      expect(client?.assignedAgentId).toBe(owner.id);
      expect(client?.assignReason).toBe("own_property_explicit");
      const note = await prisma.interaction.findFirst({
        where: { clientId, notes: { contains: "узнал консультант" } },
        select: { notes: true },
      });
      expect(note?.notes).toContain(`ОБ-${String(property.shortId).padStart(6, "0")}`);
    } finally {
      await cleanupListing(clientId, owner, property);
    }
  });

  it("продавец описал своё жильё приметами чужого объекта — лид не уходит агенту чужого объекта (24.09.2026)", async () => {
    const place = `Гипрозем${String(runId).slice(-5)}`;
    const { owner, property } = await listingOf(`+99289${tail}`, { price: 456789, currency: "TJS", landmark: place });
    extractIncomingCallLead.mockResolvedValue({
      ...GOOD_EXTRACT,
      kind: "SELLER",
      propertyHint: null,
      budgetMax: 456789,
      propertyLandmark: place,
      propertyAreaSqm: 52,
    });
    const phone = `+99290${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });
    try {
      await autoLeadFromIncomingCall(callId);
      const client = await prisma.client.findUnique({ where: { id: clientId }, select: { assignReason: true, matchedPropertyId: true } });
      expect(client?.assignReason).not.toBe("own_property_explicit");
      expect(client?.matchedPropertyId).not.toBe(property.id);
    } finally {
      await cleanupListing(clientId, owner, property);
    }
  });

  it("объект узнан, но его агент отключён — в хронологии сказано, почему лид ушёл раздачей (24.09.2026)", async () => {
    const { owner, property } = await listingOf(`+99287${tail}`, { price: 30000, currency: "USD" });
    await prisma.agent.update({ where: { id: owner.id }, data: { isActive: false } });
    extractIncomingCallLead.mockResolvedValue({ ...GOOD_EXTRACT, propertyHint: `объект №${property.shortId}` });
    const phone = `+99288${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });
    try {
      await autoLeadFromIncomingCall(callId);
      const client = await prisma.client.findUnique({ where: { id: clientId }, select: { assignedAgentId: true } });
      expect(client?.assignedAgentId).not.toBe(owner.id);
      const note = await prisma.interaction.findFirst({
        where: { clientId, notes: { contains: "Лид ушёл обычной раздачей" } },
        select: { notes: true },
      });
      expect(note?.notes).toContain("агент объекта сейчас не принимает лиды");
    } finally {
      await cleanupListing(clientId, owner, property);
    }
  });

  it("перевели с офисного телефона агенту объекта — разбор дозаполняет карточку, агент тот же (24.09.2026)", async () => {
    /**
     * Агент взял трубку после перевода, и клиент уже закреплён за ним принятым
     * (deskTransfer.ts). Карточку завёл этот же звонок — в ней один номер, и её
     * дозаполняет разбор разговора. Без правки звонок уходил в «клиента ведёт
     * агент» и карточка оставалась «Входящий +992…» без запроса.
     */
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const phone = `+99268${tail}`;
    const clientId = await seedStubClient(phone);
    await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: agentId, acceptedAt: new Date() } });
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });
    await prisma.incomingCall.update({
      where: { id: callId },
      data: { routeDecision: "desk_transfer_answered", routedToId: agentId },
    });

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("qualified");
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { assignedAgentId: true, fullName: true, requirementsNotes: true, budgetMax: true },
    });
    expect(client?.assignedAgentId).toBe(agentId);
    expect(client?.fullName).toBe("Фируз");
    expect(client?.requirementsNotes).toContain("Сино");
    expect(Number(client?.budgetMax)).toBe(400_000);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("перевод с офисного телефона давнего клиента его карточку не переписывает", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const phone = `+99267${tail}`;
    const client = await prisma.client.create({
      data: { fullName: `Давний ${runId}`, phone, source: "PHONE_CALL", kind: "SELLER", assignedAgentId: agentId },
    });
    createdClientIds.push(client.id);
    const callId = await seedAnsweredCall({ phone, clientId: client.id, transcript: TRANSCRIPT });
    await prisma.incomingCall.update({
      where: { id: callId },
      data: { routeDecision: "desk_transfer_answered", routedToId: agentId, autoCreatedClient: false },
    });

    expect((await autoLeadFromIncomingCall(callId)).status).toBe("known_client");
    expect((await prisma.client.findUnique({ where: { id: client.id } }))?.fullName).toBe(`Давний ${runId}`);
  });

  it("трубку снял сам агент — клиент достаётся ему и сразу принятым", async () => {
    /**
     * Новая схема приёма (решение владельца 18.08.2026): звонок незнакомого
     * человека звонит СРАЗУ ВСЕМ агентам, и кто снял трубку — тот и работает с
     * клиентом. Дословно: «клиент должен попасть именно к этому агенту уже
     * принятым, потому что он в работе будет».
     *
     * Значит ни очереди по KPI, ни окна «Принять/Отклонить»: спрашивать «берёшься?»
     * у того, кто уже поговорил с человеком, поздно. Предел портфеля тем же
     * решением здесь не проверяется — разговор состоялся.
     */
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const ext = `77${String(runId).slice(-3)}`;
    await prisma.agent.update({ where: { id: agentId }, data: { sipExtension: ext } });
    const phone = `+99269${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });
    // Станция сообщила внутренний номер ответившего — это и есть наш агент.
    await prisma.incomingCall.update({ where: { id: callId }, data: { answeredBy: ext } });

    try {
      const result = await autoLeadFromIncomingCall(callId);
      expect(result.status).toBe("qualified");

      const client = await prisma.client.findUnique({
        where: { id: clientId },
        select: { assignedAgentId: true, acceptedAt: true },
      });
      // Клиент у того, кто говорил, а не у того, чья очередь.
      expect(client?.assignedAgentId).toBe(agentId);
      // И уже в работе: окна принятия быть не должно.
      expect(client?.acceptedAt).not.toBeNull();
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { sipExtension: null } });
    }
  });
});

/**
 * ЗАПИСЬ ИЛИ РАСШИФРОВКА ОПОЗДАЛИ ДОЛЬШЕ ОТСРОЧКИ КРОНА (аудит Codex 04.10.2026,
 * находка №10). Крон берёт звонок старше RECORDING_GRACE_MS, текста ещё нет → исход
 * `no_data` («нет расшифровки») записывается как терминальный. Потом расшифровка
 * доезжает, конвейер зовёт `autoLeadFromInteraction` — а она упиралась в «автоматика
 * уже отработала»: направление (покупатель/продавец) и дозаполнение карточки не
 * случались, пока человек не разберёт звонок руками.
 *
 * Конвейер (transcribeAndEnrich) зовёт её с `lateTranscript: true`, когда текста у
 * разговора до этой расшифровки не было вовсе: тогда прежний `no_data` мог быть
 * только про «нет расшифровки», и звонок разбирается заново. «Модель не уверена»
 * заново не гоняется: платный повтор того же разбора ничего бы не изменил.
 */
describe("Поздняя расшифровка после исхода «нет расшифровки»", () => {
  async function interactionOf(callId: string): Promise<string> {
    const call = await prisma.incomingCall.findUniqueOrThrow({ where: { id: callId }, select: { interactionId: true } });
    return call.interactionId!;
  }

  it("крон успел раньше расшифровки — текст доехал позже, звонок всё равно разбирается", async () => {
    const phone = `+99265${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, startedAt: new Date(Date.now() - 60 * 60_000) });
    const interactionId = await interactionOf(callId);

    // 1. Крон: текста нет → терминальный no_data, ИИ не зовётся.
    await sweepIncomingCallsForLeads();
    let call = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(call?.autoLeadStatus).toBe("no_data");
    expect(call?.qualifiedAt).toBeNull();
    expect(extractIncomingCallLead).not.toHaveBeenCalled();

    // 2. Расшифровка доехала, конвейер зовёт автоматику.
    await prisma.interaction.update({ where: { id: interactionId }, data: { transcript: TRANSCRIPT } });
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const result = await autoLeadFromInteraction(interactionId, { lateTranscript: true });

    expect(result?.status).toBe("qualified");
    call = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(call?.autoLeadStatus).toBe("qualified");
    expect(call?.qualifiedAt).not.toBeNull();
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client?.kind).toBe("BUYER");
    expect(client?.fullName).toBe("Фируз");
  });

  it("«модель не уверена» не сбрасывается: тот же текст второй раз за ИИ не платит", async () => {
    const phone = `+99264${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });
    const interactionId = await interactionOf(callId);
    extractIncomingCallLead.mockResolvedValue({ ...GOOD_EXTRACT, confident: false });

    const first = await autoLeadFromIncomingCall(callId);
    expect(first.status).toBe("no_data");
    expect(extractIncomingCallLead).toHaveBeenCalledTimes(1);

    // Конвейер расшифровки без флага (текст у разговора уже был): повтора нет.
    const second = await autoLeadFromInteraction(interactionId);
    expect(second?.status).toBe("skipped");
    expect(extractIncomingCallLead).toHaveBeenCalledTimes(1);
  });

  it("звонок уже разобран человеком — флаг его не трогает", async () => {
    const phone = `+99263${tail}`;
    const clientId = await seedStubClient(phone);
    const callId = await seedAnsweredCall({ phone, clientId, transcript: TRANSCRIPT });
    const interactionId = await interactionOf(callId);
    await prisma.incomingCall.update({
      where: { id: callId },
      data: { autoLeadAt: new Date(), autoLeadStatus: "no_data", qualifiedAt: new Date() },
    });

    const result = await autoLeadFromInteraction(interactionId, { lateTranscript: true });

    expect(result?.status).toBe("skipped");
    expect(extractIncomingCallLead).not.toHaveBeenCalled();
  });
});
