import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ПОЗВОНИЛ В ОФИС НАСЧЁТ РАБОТЫ — АНКЕТА В «ВАКАНСИЯХ», А НЕ ЛИД (Dan 02.10.2026).
 *
 * «Если человек звонит в офис насчёт работы, он сам попадает в «Вакансии» и
 * снимается с агента». До правки разбор звонка (ai/incomingCallLead.ts) признака
 * соискателя не знал: работа становилась «Другим», а звонок клиента, у которого
 * уже есть агент, не разбирался вовсе (`known_client`).
 *
 * Модель подменена на уровне callAiText, а не разбора целиком: словесный признак
 * соискателя и отсечка «явная сделка с жильём старше» — код, их и проверяем.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));
// Подмена ДОПОЛНЯЕТ модуль (importOriginal): снятие агента остаётся настоящим.
const { notify } = vi.hoisted(() => ({ notify: vi.fn(async () => {}) }));
vi.mock("../src/lib/clientToCandidate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientToCandidate.js")>()),
  notifyCandidateOwners: notify,
}));

const { prisma } = await import("../src/db.js");
const { autoLeadFromIncomingCall } = await import("../src/lib/telephony/autoLeadFromCall.js");
const { callSoundsLikeJobSeeker, isJobSeekerCall } = await import("../src/ai/jobSeekerCall.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now();
let agentId = "";
const phones: string[] = [];
const clientIds: string[] = [];
const callIds: string[] = [];
const propertyIds: string[] = [];
const districtIds: string[] = [];

const JOB_CALL =
  "Оператор: Royal Home, ассалому алейкум. Звонивший: Ассалому алейкум, ман кор мехоҳам, вакансия ҳаст? " +
  "Номам Фаррух. Оператор: Ҳа, мо агентҳоро ба кор қабул мекунем.";

const BUYER_CALL =
  "Оператор: Royal Home, здравствуйте. Звонивший: Здравствуйте, меня зовут Фируз, ищу двухкомнатную " +
  "квартиру в Сино, бюджет до четырёхсот тысяч сомони, хотел бы посмотреть на выходных.";

const SELLER_MENTIONS_JOB =
  "Оператор: Royal Home, здравствуйте. Звонивший: Здравствуйте, я продаю квартиру, она у вашего агента. " +
  "И ещё спрошу про работу: у вас есть вакансия? Ищу работу для себя.";

function freshPhone(): string {
  const phone = `+99290${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  phones.push(phone);
  return phone;
}

beforeAll(async () => {
  agentId = await createTestAgent(`Агент звонка-кандидата ${runId}`);
});

beforeEach(() => {
  callAi.mockReset();
  notify.mockClear();
});

afterEach(async () => {
  await prisma.jobApplication.deleteMany({ where: { phone: { in: phones } } });
  await prisma.incomingCall.deleteMany({ where: { id: { in: callIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  callIds.length = 0;
  propertyIds.length = 0;
  clientIds.length = 0;
});

afterAll(async () => {
  await prisma.district.deleteMany({ where: { id: { in: districtIds } } });
  await deleteAgentsWithTraces([agentId]);
  await prisma.$disconnect();
});

async function seedClient(phone: string, data: Record<string, unknown>): Promise<string> {
  const client = await prisma.client.create({
    data: { fullName: `Входящий ${phone}`, phone, source: "PHONE_CALL", kind: "OTHER", status: "NEW", currency: "TJS", ...data },
  });
  clientIds.push(client.id);
  return client.id;
}

/** Отвеченный входящий с расшифровкой в хронологии карточки. */
async function seedCall(phone: string, clientId: string, transcript: string, autoCreated: boolean): Promise<string> {
  const interaction = await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "Входящий звонок", outcome: "NEUTRAL", transcript },
  });
  const call = await prisma.incomingCall.create({
    data: {
      channelId: `cand-call-${runId}-${Math.random().toString(36).slice(2)}`,
      phone,
      startedAt: new Date(),
      endedAt: new Date(),
      answered: true,
      talkSeconds: 60,
      clientId,
      autoCreatedClient: autoCreated,
      interactionId: interaction.id,
    },
  });
  callIds.push(call.id);
  return call.id;
}

describe("Словесный признак соискателя в звонке", () => {
  it("ловит таджикскую и русскую просьбу о работе", () => {
    expect(callSoundsLikeJobSeeker("Ассалому алейкум, ман кор мехоҳам, вакансия ҳаст?")).toBe(true);
    expect(callSoundsLikeJobSeeker("Здравствуйте, я насчёт вакансии агента")).toBe(true);
    expect(callSoundsLikeJobSeeker("Хочу работать у вас риелтором, резюме могу прислать")).toBe(true);
  });

  it("слово «работа» мимоходом и явная сделка с жильём — не соискатель", () => {
    expect(callSoundsLikeJobSeeker(BUYER_CALL)).toBe(false);
    expect(callSoundsLikeJobSeeker("Хочу купить квартиру, звоните после работы, я работаю рядом")).toBe(false);
    expect(callSoundsLikeJobSeeker(SELLER_MENTIONS_JOB)).toBe(false);
    expect(callSoundsLikeJobSeeker("Не, кор лозим нест, хона мефурӯшам")).toBe(false);
  });

  it("уверенный покупатель от модели перебивает её же признак работы", () => {
    expect(isJobSeekerCall({ modelSaysJobSeeker: true, modelKind: "BUYER", transcript: "кор ҳам мехоҳам" })).toBe(false);
    expect(isJobSeekerCall({ modelSaysJobSeeker: false, modelKind: "OTHER", transcript: JOB_CALL })).toBe(true);
  });
});

describe("Звонок соискателя уходит в «Вакансии»", () => {
  it("незнакомый номер: анкета заведена, лида у агента нет, звонок разобран", async () => {
    // Модель признак не поставила — слова расшифровки решают сами.
    callAi.mockResolvedValue({ kind: "OTHER", confident: true, fullName: "Фаррух", summary: "Спрашивает про вакансию" });
    const phone = freshPhone();
    const stubId = await seedClient(phone, {});
    const callId = await seedCall(phone, stubId, JOB_CALL, true);

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("candidate");
    const app = await prisma.jobApplication.findFirst({ where: { phone } });
    expect(app?.channel).toBe("PHONE_CALL");
    expect(app?.name).toBe("Фаррух");
    expect(app?.rawText).toContain("вакансию");
    // Ни одной карточки этого номера у агента.
    expect(await prisma.client.count({ where: { phone, assignedAgentId: { not: null } } })).toBe(0);
    const call = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(call?.qualifiedAt).not.toBeNull();
    expect(call?.autoLeadStatus).toBe("candidate");
    // Руководство позвали один раз.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ channel: "PHONE_CALL", name: "Фаррух" });
  });

  it("номер покупателя у агента без сделок: снят с агента, анкета заведена", async () => {
    callAi.mockResolvedValue({ kind: "OTHER", confident: true, jobSeeker: true, summary: "Ищет работу агентом" });
    const phone = freshPhone();
    const clientId = await seedClient(phone, {
      fullName: `Покупатель ${runId}`,
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    });
    const callId = await seedCall(phone, clientId, JOB_CALL, false);

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("candidate");
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client?.assignedAgentId).toBeNull();
    expect(client?.kind).toBe("OTHER");
    expect(client?.lastAgentId).toBe(agentId);
    const app = await prisma.jobApplication.findFirst({ where: { phone } });
    expect(app?.clientId).toBe(clientId);
    expect(notify).toHaveBeenCalledTimes(1);
    // В хронологии карточки — почему её сняли.
    const note = await prisma.interaction.findFirst({ where: { clientId, notes: { contains: "насчёт работы" } } });
    expect(note).not.toBeNull();
  });

  it("второй звонок того же кандидата дополняет анкету и руководство второй раз не зовёт", async () => {
    callAi.mockResolvedValue({ kind: "OTHER", confident: true, jobSeeker: true, summary: "Перезвонил про вакансию" });
    const phone = freshPhone();
    const stubId = await seedClient(phone, {});
    await autoLeadFromIncomingCall(await seedCall(phone, stubId, JOB_CALL, true));
    expect(notify).toHaveBeenCalledTimes(1);
    await autoLeadFromIncomingCall(await seedCall(phone, stubId, JOB_CALL, false));

    expect(await prisma.jobApplication.count({ where: { phone } })).toBe(1);
    const app = await prisma.jobApplication.findFirst({ where: { phone } });
    expect(app?.rawText).toContain("Перезвонил");
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("Обычные звонки клиентов не меняются", () => {
  it("продавец с объектом в работе, спросивший и про работу, — ничего не меняется", async () => {
    callAi.mockResolvedValue({ kind: "OTHER", confident: true, jobSeeker: true });
    const phone = freshPhone();
    const clientId = await seedClient(phone, {
      fullName: `Продавец ${runId}`,
      kind: "SELLER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    });
    const districtId = (await prisma.district.create({ data: { name: `Звонок-кандидат-${runId}-${phone}` } })).id;
    districtIds.push(districtId);
    const property = await prisma.property.create({
      data: {
        title: `Объект продавца ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 450_000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        assignedAgentId: agentId,
        sellerClientId: clientId,
      },
    });
    propertyIds.push(property.id);
    const callId = await seedCall(phone, clientId, SELLER_MENTIONS_JOB, false);

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("known_client");
    // Явная продажа своего жилья — разбор даже не заказан.
    expect(callAi).not.toHaveBeenCalled();
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client?.assignedAgentId).toBe(agentId);
    expect(client?.kind).toBe("SELLER");
    expect(await prisma.jobApplication.count({ where: { phone } })).toBe(0);
  });

  it("продавец с объектом в работе даже при признаке модели с агента не снимается", async () => {
    callAi.mockResolvedValue({ kind: "OTHER", confident: true, jobSeeker: true });
    const phone = freshPhone();
    const clientId = await seedClient(phone, {
      fullName: `Продавец-2 ${runId}`,
      kind: "SELLER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    });
    const districtId = (await prisma.district.create({ data: { name: `Звонок-кандидат-2-${runId}-${phone}` } })).id;
    districtIds.push(districtId);
    const property = await prisma.property.create({
      data: {
        title: `Объект продавца-2 ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 450_000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 2",
        condition: "GOOD",
        status: "AVAILABLE",
        assignedAgentId: agentId,
        sellerClientId: clientId,
      },
    });
    propertyIds.push(property.id);
    const callId = await seedCall(phone, clientId, JOB_CALL, false);

    await autoLeadFromIncomingCall(callId);

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client?.assignedAgentId).toBe(agentId);
    expect(client?.kind).toBe("SELLER");
    // Анкета (если есть) к карточке со сделкой/объектом не привязана.
    const app = await prisma.jobApplication.findFirst({ where: { phone } });
    expect(app?.clientId ?? null).toBeNull();
  });

  it("обычный звонок покупателя, которого ведёт агент: без разбора и без анкеты", async () => {
    const phone = freshPhone();
    const clientId = await seedClient(phone, {
      fullName: `Давний покупатель ${runId}`,
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    });
    const callId = await seedCall(phone, clientId, BUYER_CALL, false);

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("known_client");
    expect(callAi).not.toHaveBeenCalled();
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client?.assignedAgentId).toBe(agentId);
    expect(client?.kind).toBe("BUYER");
    expect(await prisma.jobApplication.count({ where: { phone } })).toBe(0);
  });

  it("обычный звонок покупателя с незнакомого номера — лид, как раньше", async () => {
    callAi.mockResolvedValue({ kind: "BUYER", confident: true, fullName: "Фируз", summary: "Ищет 2-комнатную в Сино", rooms: 2 });
    const phone = freshPhone();
    const stubId = await seedClient(phone, {});
    const callId = await seedCall(phone, stubId, BUYER_CALL, true);

    const result = await autoLeadFromIncomingCall(callId);

    expect(result.status).toBe("qualified");
    const client = await prisma.client.findUnique({ where: { id: stubId } });
    expect(client?.kind).toBe("BUYER");
    expect(await prisma.jobApplication.count({ where: { phone } })).toBe(0);
  });
});
