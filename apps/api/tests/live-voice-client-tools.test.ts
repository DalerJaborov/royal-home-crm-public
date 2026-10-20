import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * РОБОТ РЕШАЕТ ВОПРОС ЗВОНЯЩЕГО (09.10.2026, liveVoiceClientTools.ts).
 *
 * Главное здесь — ГРАНИЦА ДОСТУПА: каждая функция отдаёт модели только поля своего
 * белого списка. Звонящий — незнакомый человек, номер подделывается, поэтому в каждом
 * ответе проверяется, что НЕТ телефонов, ФИО, имён собственников и чужих клиентов, номера
 * дома и квартиры, сумм сделки и комиссии. Плюс: что функция СДЕЛАЛА (показ, перезвон,
 * отправка), видно строкой в расшифровке (toolResultTranscriptLine).
 *
 * СМС и отправка в переписку подменены: важно, КАКОЙ текст и КОМУ, а не ответ провайдера.
 */

const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn() }));
vi.mock("../src/lib/sms/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sms/index.js")>()),
  sendSms,
}));
const { deliverToConversation } = vi.hoisted(() => ({ deliverToConversation: vi.fn() }));
vi.mock("../src/lib/conversationDelivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/conversationDelivery.js")>()),
  deliverToConversation,
}));

const { prisma } = await import("../src/db.js");
const { normalizeGeoText } = await import("@royal-home/shared");
const { handleClientTool, sanitizeClientRequest, clientRequestText, freeShowingSlots, dushanbeMoment, messengerCardText, showingConfirmationText } =
  await import("../src/lib/telephony/liveVoiceClientTools.js");
const { newPropertyCallMemory } = await import("../src/lib/telephony/liveVoicePropertyTools.js");
const { toolResultTranscriptLine } = await import("../src/lib/telephony/liveVoiceGuards.js");
const { dushanbeDateString, dushanbeWallClock } = await import("../src/lib/dushanbeTime.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now().toString(36);
const agentIds: string[] = [];
const clientIds: string[] = [];
const propertyIds: string[] = [];
const landmarkIds: string[] = [];
let agentId = "";
let otherAgentId = "";

// Точка далеко от Душанбе: настоящие ориентиры справочника рядом не окажутся.
const POINT = { lat: 39.91234, lng: 70.91234 };
const rnd = () => `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`;
const CALLER = rnd();
const OWNER_PHONE = rnd();
const OTHER_CLIENT_PHONE = rnd();
const SECRET_ADDRESS = "ул. Айни, д. 45, кв. 12";

let open = { id: "", shortId: 0 };
let closed = { id: "", shortId: 0 };
let clientId = "";
let otherClientId = "";
let savedSettings: { botCanBookShowings: boolean; workHoursStart: string; workHoursEnd: string } | null = null;

/** Следующий будний (не воскресенье) день не раньше, чем через `ahead` суток, по Душанбе. */
function workday(ahead: number): string {
  for (let i = ahead; i < ahead + 7; i++) {
    const at = new Date(Date.now() + i * 86_400_000);
    if (dushanbeWallClock(at).getUTCDay() !== 0) return dushanbeDateString(at);
  }
  throw new Error("нет будня");
}
function sunday(): string {
  for (let i = 1; i < 9; i++) {
    const at = new Date(Date.now() + i * 86_400_000);
    if (dushanbeWallClock(at).getUTCDay() === 0) return dushanbeDateString(at);
  }
  throw new Error("нет воскресенья");
}

/** Всё, что не должно выйти наружу ни из одной функции. */
function expectNoLeak(response: unknown) {
  const json = JSON.stringify(response);
  for (const phone of [CALLER, OWNER_PHONE, OTHER_CLIENT_PHONE]) expect(json).not.toContain(phone.slice(-9));
  expect(json).not.toMatch(/д\.\s*45|кв\.\s*12|\b45\b/);
  expect(json).not.toContain(`Собственник ${runId}`);
  expect(json).not.toContain(`Чужой клиент ${runId}`);
  expect(json).not.toContain(`Свой клиент ${runId}`);
  expect(json).not.toMatch(/77\s?777|1\s?234|комисси/i); // сумма сделки и комиссия
}

async function makeProperty(data: Record<string, unknown>) {
  const p = await prisma.property.create({
    data: {
      title: `Робот-${runId}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 62,
      price: 52_000,
      currency: "USD",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      address: SECRET_ADDRESS,
      lat: POINT.lat,
      lng: POINT.lng,
      assignedAgentId: agentId,
      description: `Собственник ${runId}, звонить ${OWNER_PHONE}`,
      ...data,
    } as never,
    select: { id: true, shortId: true },
  });
  propertyIds.push(p.id);
  return p;
}

function memoryFor(opts: { client?: boolean; discussed?: number[] } = {}) {
  const m = newPropertyCallMemory({ callerPhone: CALLER, clientId: opts.client ? clientId : null, contactProfileId: null });
  m.discussedShortIds.push(...(opts.discussed ?? [open.shortId, closed.shortId]));
  return m;
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: `c-${Math.random()}`, name, args });

beforeAll(async () => {
  agentId = await createTestAgent(`Нозия Роботова ${runId}`);
  otherAgentId = await createTestAgent(`Другой Агент ${runId}`);
  agentIds.push(agentId, otherAgentId);
  open = await makeProperty({});
  closed = await makeProperty({ publishedOnSite: false });

  const seller = await prisma.client.create({
    data: { fullName: `Собственник ${runId}`, phone: OWNER_PHONE, source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() },
    select: { id: true },
  });
  const own = await prisma.client.create({
    data: { fullName: `Свой клиент ${runId}`, phone: CALLER, source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() },
    select: { id: true },
  });
  const other = await prisma.client.create({
    data: { fullName: `Чужой клиент ${runId}`, phone: OTHER_CLIENT_PHONE, source: "PHONE_CALL", assignedAgentId: otherAgentId, acceptedAt: new Date() },
    select: { id: true },
  });
  clientId = own.id;
  otherClientId = other.id;
  clientIds.push(seller.id, own.id, other.id);
  await prisma.property.update({ where: { id: open.id }, data: { sellerClientId: seller.id } });

  // Показ своего клиента — завтрашний будний день, 15:00.
  await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      propertyId: open.id,
      type: "SHOWING",
      notes: `Позвонить собственнику ${OWNER_PHONE}`,
      nextAction: `Показ, ключи у Собственник ${runId}`,
      nextActionDate: dushanbeMoment(workday(2), "15:00"),
    },
  });
  // Показ ЧУЖОГО клиента у того же агента — занимает 11:00 того же дня.
  await prisma.interaction.create({
    data: {
      clientId: otherClientId,
      agentId: null,
      actorKind: "BOT",
      subjectAgentId: agentId,
      propertyId: open.id,
      type: "SHOWING",
      notes: "Показ назначен ботом",
      nextAction: "Показ объекта",
      nextActionDate: dushanbeMoment(workday(2), "11:00"),
    },
  });
  await prisma.deal.create({
    data: { clientId, propertyId: open.id, agentId, stage: "CONTRACT_SIGNED", soldPrice: 77_777, commissionAmount: 1_234, currency: "USD" } as never,
  });

  // Справочник: школа и базар рядом с точкой, и вторая школа (одна на категорию).
  for (const [name, category, dLat] of [
    [`Школа №1 ${runId}`, "Школа", 0.0015],
    [`Школа №2 ${runId}`, "Школа", 0.003],
    [`Базар ${runId}`, "Базар", 0.002],
  ] as const) {
    const l = await prisma.landmark.create({ data: { name, category, lat: POINT.lat + dLat, lng: POINT.lng, weight: 50 } });
    landmarkIds.push(l.id);
  }
  await prisma.geoAlias.create({
    data: { text: `Базар ${runId}`, normalized: normalizeGeoText(`Базар ${runId}`), targetType: "landmark", targetId: landmarkIds[2], source: "agent" },
  });

  savedSettings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { botCanBookShowings: true, workHoursStart: true, workHoursEnd: true },
  });
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "09:30", workHoursEnd: "18:00" } });
});

afterAll(async () => {
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.geoAlias.deleteMany({ where: { targetId: { in: landmarkIds } } });
  await prisma.landmark.deleteMany({ where: { id: { in: landmarkIds } } });
  await prisma.botConversation.deleteMany({ where: { subscriberId: CALLER.replace(/\D/g, "") } });
  await prisma.deal.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
});

beforeEach(() => {
  sendSms.mockReset();
  sendSms.mockResolvedValue({ ok: true });
  deliverToConversation.mockReset();
  deliverToConversation.mockResolvedValue({ ok: true, masked: false, pausedUntil: new Date() });
});

describe("my_status — только своё", () => {
  it("незнакомцу отказ, без единого факта", async () => {
    const r = await handleClientTool(memoryFor(), call("my_status"));
    expect((r!.response as { ok: boolean }).ok).toBe(false);
    expect(JSON.stringify(r!.response)).not.toMatch(/Нозия|договор|показ на/i);
  });

  it("свой клиент: агент, ближайший показ без дома, стадия сделки — и ни телефонов, ни сумм, ни чужих", async () => {
    const r = await handleClientTool(memoryFor({ client: true }), call("my_status"));
    const res = r!.response as Record<string, any>;
    expect(res.ok).toBe(true);
    expect(res.agent).toBe("Нозия");
    expect(res.next_showing.where).toContain("ул. Айни");
    expect(res.next_showing.when).toMatch(/три часа дня/);
    expect(res.deal.stage).toBe("договор подписан");
    expectNoLeak(res);
    // Белый список полей ответа — ровно эти, ничего из строки базы.
    expect(Object.keys(res).sort()).toEqual(["agent", "deal", "next_showing", "note", "ok", "own_properties"]);
    expect(Object.keys(res.next_showing).sort()).toEqual(["rooms", "when", "where"]);
    expect(toolResultTranscriptLine("my_status", res)).toMatch(/^\[статус клиента: агент Нозия; показ \d\d\.\d\d в 15:00/);
  });
});

describe("save_client_request — условия структурно", () => {
  it("белый список: лишние поля и мусор не проходят", () => {
    const r = sanitizeClientRequest({ intent: "buy", district: "Сино", rooms: 2, budget_max: 60000, currency: "usd", phone: OWNER_PHONE, market: "X", timeframe: "к весне" });
    expect(r).toEqual({ intent: "buy", districtName: "Сино", rooms: 2, budgetMax: 60000, currency: "USD", timeframe: "к весне" });
    expect(clientRequestText(r)).toBe("покупает, 2-комн., Сино, бюджет до 60 000 $, срок: к весне");
  });

  it("копится по ходу звонка и пишется в расшифровку", async () => {
    const m = memoryFor();
    await handleClientTool(m, call("save_client_request", { intent: "buy", district: "Сино" }));
    const r = await handleClientTool(m, call("save_client_request", { budget_max: 50000 }));
    expect(m.request).toMatchObject({ intent: "buy", districtName: "Сино", budgetMax: 50000 });
    expect(r!.scheduling).toBe("SILENT");
    expect(toolResultTranscriptLine("save_client_request", r!.response)).toContain("бюджет до 50 000 (валюта не названа)");
  });
});

/** День недели даты «ГГГГ-ММ-ДД» (по Душанбе это та же дата в полдень). */
const weekdayOf = (day: string) => new Date(`${day}T07:00:00Z`).getUTCDay();

describe("request_callback — на время, которое выбрал человек", () => {
  it("общий выходной в воскресенье (Настройки) — отказ, время не ставится", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { companyDaysOff: [0] } });
    try {
      const m = memoryFor();
      const r = await handleClientTool(m, call("request_callback", { day: sunday(), time: "11:00" }));
      expect((r!.response as { ok: boolean }).ok).toBe(false);
      expect(m.callbackAt ?? null).toBeNull();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { companyDaysOff: [] } });
    }
  });

  it("по умолчанию выходных нет (11.10.2026): воскресенье в рабочие часы — время ставится", async () => {
    const m = memoryFor();
    const r = await handleClientTool(m, call("request_callback", { day: sunday(), time: "11:00" }));
    expect((r!.response as { ok: boolean }).ok).toBe(true);
    expect(m.callbackAt).toBeInstanceOf(Date);
  });

  it("личный выходной агента клиента — на этот день перезвон не ставится, у агента без выходного — ставится", async () => {
    const day = workday(2);
    await prisma.agent.update({ where: { id: agentId }, data: { weeklyDaysOff: [weekdayOf(day)] } });
    try {
      const m = memoryFor({ client: true });
      const r = await handleClientTool(m, call("request_callback", { day, time: "15:00" }));
      expect((r!.response as { ok: boolean; error?: string }).ok).toBe(false);
      expect(String((r!.response as { error?: string }).error)).toContain("выходной");
      expect(m.callbackAt ?? null).toBeNull();
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { weeklyDaysOff: [] } });
    }
    const ok = await handleClientTool(memoryFor({ client: true }), call("request_callback", { day, time: "15:00" }));
    expect((ok!.response as { ok: boolean }).ok).toBe(true);
  });

  it("будний день в рабочие часы — задача на это время, речь словами, строка в расшифровке", async () => {
    const m = memoryFor();
    const day = workday(2);
    const r = await handleClientTool(m, call("request_callback", { day, time: "15:00", topic: "про двушку в Сино" }));
    const res = r!.response as Record<string, any>;
    expect(res.ok).toBe(true);
    expect(res.when).toMatch(/в три часа дня$/);
    expect(m.callbackAt?.toISOString()).toBe(dushanbeMoment(day, "15:00").toISOString());
    expect(toolResultTranscriptLine("request_callback", res)).toMatch(/^\[перезвон: задача агенту на \d\d\.\d\d в 15:00 — про двушку в Сино\]$/);
  });

  it("вне рабочих часов (после закрытия) — отказ", async () => {
    const r = await handleClientTool(memoryFor(), call("request_callback", { day: workday(2), time: "19:30" }));
    expect((r!.response as { ok: boolean }).ok).toBe(false);
  });
});

describe("showing_slots / book_showing — личный выходной агента (владелец 11.10.2026)", () => {
  it("на выходной агента время показа не предлагается и не записывается; уже назначенные показы не трогаются", async () => {
    const day = workday(2);
    const before = await freeShowingSlots(agentId, day);
    expect(before.length).toBeGreaterThan(0);
    const booked = await prisma.interaction.count({ where: { OR: [{ agentId }, { subjectAgentId: agentId }], type: "SHOWING" } });
    await prisma.agent.update({ where: { id: agentId }, data: { weeklyDaysOff: [weekdayOf(day)] } });
    try {
      expect(await freeShowingSlots(agentId, day)).toEqual([]);
      // Без названного дня — ближайшие РАБОЧИЕ дни агента, выходной в них не попадает.
      const any = await freeShowingSlots(agentId, undefined);
      expect(any.every((s) => dushanbeDateString(s) !== day)).toBe(true);
      await prisma.settings.update({ where: { id: "singleton" }, data: { botCanBookShowings: true } });
      const r = await handleClientTool(memoryFor({ client: true }), call("book_showing", { number: open.shortId, day, time: "10:00" }));
      expect((r!.response as { ok: boolean }).ok).toBe(false);
      expect(String((r!.response as { error?: string }).error)).toContain("выходной");
      // Уже назначенные показы остаются как были.
      expect(await prisma.interaction.count({ where: { OR: [{ agentId }, { subjectAgentId: agentId }], type: "SHOWING" } })).toBe(booked);
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { weeklyDaysOff: [] } });
    }
  });
});

describe("showing_slots / book_showing", () => {
  it("свободное время — по календарю показов агента: занятое чужим показом (subjectAgentId) не предлагается", async () => {
    const day = workday(2);
    const slots = await freeShowingSlots(agentId, day);
    const labels = slots.map((s) => `${String(dushanbeWallClock(s).getUTCHours()).padStart(2, "0")}:00`);
    expect(labels).not.toContain("11:00"); // чужой показ (бот, subjectAgentId)
    expect(labels).not.toContain("15:00"); // свой показ клиента
    expect(labels).toContain("10:00");
    expect(labeled(slots)).not.toContain("13:00");
  });

  it("показы боту выключены — showing_slots времени не предлагает (тот же тумблер, что у чата, 10.10.2026)", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botCanBookShowings: false } });
    const r = await handleClientTool(memoryFor(), call("showing_slots", { number: open.shortId, day: workday(2) }));
    const res = r!.response as Record<string, any>;
    expect(res.ok).toBe(false);
    expect(res.slots).toBeUndefined();
    expect(String(res.error)).toContain("время показа назовёт агент");
  });

  it("ответ showing_slots — без чужих данных, не больше трёх вариантов", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botCanBookShowings: true } });
    const r = await handleClientTool(memoryFor(), call("showing_slots", { number: open.shortId, day: workday(2) }));
    const res = r!.response as Record<string, any>;
    expect(res.ok).toBe(true);
    expect(res.slots.length).toBeGreaterThan(0);
    expect(res.slots.length).toBeLessThanOrEqual(3);
    expectNoLeak(res);
  });

  it("объект, которого в звонке не обсуждали, — отказ", async () => {
    const r = await handleClientTool(memoryFor({ discussed: [] }), call("showing_slots", { number: open.shortId }));
    expect((r!.response as { ok: boolean }).ok).toBe(false);
  });

  it("незнакомец: показ НЕ записывается — время уходит агенту на подтверждение", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botCanBookShowings: true } });
    const m = memoryFor();
    const before = await prisma.interaction.count({ where: { propertyId: open.id, type: "SHOWING" } });
    const r = await handleClientTool(m, call("book_showing", { number: open.shortId, day: workday(3), time: "16:00" }));
    const res = r!.response as Record<string, any>;
    expect(res).toMatchObject({ ok: true, booked: false, passed_to_agent: true });
    expect(m.showingWish?.shortId).toBe(open.shortId);
    expect(await prisma.interaction.count({ where: { propertyId: open.id, type: "SHOWING" } })).toBe(before);
    expect(toolResultTranscriptLine("book_showing", res)).toContain("передано агенту на подтверждение");
  });

  it("свой клиент, показы боту выключены — тоже только на подтверждение", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botCanBookShowings: false } });
    const m = memoryFor({ client: true });
    const r = await handleClientTool(m, call("book_showing", { number: open.shortId, day: workday(3), time: "16:00" }));
    expect(r!.response).toMatchObject({ booked: false, passed_to_agent: true });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("свой клиент, показы включены — показ в CRM, СМС-подтверждение без номера дома", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botCanBookShowings: true } });
    const m = memoryFor({ client: true });
    const day = workday(4);
    const r = await handleClientTool(m, call("book_showing", { number: open.shortId, day, time: "17:00" }));
    const res = r!.response as Record<string, any>;
    expect(res).toMatchObject({ ok: true, booked: true, agent: "Нозия", sms_confirmation: true });
    expectNoLeak(res);
    const row = await prisma.interaction.findFirst({
      where: { clientId, propertyId: open.id, type: "SHOWING", nextActionDate: dushanbeMoment(day, "17:00") },
    });
    expect(row).not.toBeNull();
    expect(sendSms).toHaveBeenCalledTimes(1);
    const sms = sendSms.mock.calls[0][0];
    expect(sms.purpose).toBe("SHOWING_CONFIRM");
    expect(sms.phone).toBe(CALLER);
    expect(sms.text).toContain("ул. Айни");
    expect(sms.text).not.toMatch(/д\.\s*45|кв\.\s*12/);
    expect(toolResultTranscriptLine("book_showing", res)).toMatch(/^\[показ: записан №\d+ на \d\d\.\d\d в 17:00/);
  });

  it("текст подтверждения: время цифрами по Душанбе, без лишнего", () => {
    expect(showingConfirmationText(dushanbeMoment("2026-10-12", "17:00"), "Сино, ул. Айни", "Нозия")).toBe(
      "Royal Home: показ 12.10 в 17:00, Сино, ул. Айни. Агент Нозия. Точный адрес сообщит агент."
    );
  });
});

describe("send_property_messenger — только в уже открытую переписку", () => {
  const digits = CALLER.replace(/\D/g, "");

  it("переписки нет — отказ, ничего не уходит", async () => {
    const r = await handleClientTool(memoryFor(), call("send_property_messenger"));
    expect((r!.response as { ok: boolean }).ok).toBe(false);
    expect(deliverToConversation).not.toHaveBeenCalled();
  });

  it("WhatsApp молчит дольше суток — окно закрыто, не шлём", async () => {
    await prisma.botConversation.create({
      data: { channel: "WHATSAPP", subscriberId: digits, messages: [{ role: "user", content: "салом", at: new Date(Date.now() - 3 * 86_400_000).toISOString() }] },
    });
    const r = await handleClientTool(memoryFor(), call("send_property_messenger"));
    expect((r!.response as { error: string }).error).toMatch(/первыми туда написать нельзя/);
    expect(deliverToConversation).not.toHaveBeenCalled();
    await prisma.botConversation.deleteMany({ where: { subscriberId: digits } });
  });

  it("окно открыто — уходит карточка открытого объекта: ссылка, улица без дома, без телефонов; закрытый не уходит", async () => {
    await prisma.botConversation.create({
      data: { channel: "WHATSAPP", subscriberId: digits, messages: [{ role: "user", content: "салом", at: new Date().toISOString() }] },
    });
    const m = memoryFor();
    const r = await handleClientTool(m, call("send_property_messenger"));
    expect(r!.response).toMatchObject({ ok: true, sent: 1, channel: "WhatsApp" });
    const text = deliverToConversation.mock.calls[0][1] as string;
    expect(text).toContain("ул. Айни");
    expect(text).not.toMatch(/д\.\s*45|кв\.\s*12/);
    expect(text).not.toContain(OWNER_PHONE.slice(-9));
    expect(text).not.toContain(`Собственник ${runId}`);
    expect(text).toMatch(/https?:\/\//);
    // Второй раз за звонок — нет.
    const again = await handleClientTool(m, call("send_property_messenger"));
    expect((again!.response as { ok: boolean }).ok).toBe(false);
    expect(toolResultTranscriptLine("send_property_messenger", r!.response)).toMatch(/^\[мессенджер: WHATSAPP — отправлено №\d+\]$/);
  });

  it("карточка — только белый список полей", () => {
    const text = messengerCardText([
      { id: "x", siteListingId: null, publishedOnSite: true, rooms: 3, areaSqm: 80, price: 65000, currency: "USD", address: "пр. Рудаки, 15/2, кв. 7", district: { name: "Сино" } },
    ]);
    expect(text).toContain("3-комн., Сино, пр. Рудаки, 80 м², $65 000");
    expect(text).not.toMatch(/15\/2|кв\. 7/);
  });
});

describe("describe_area — что рядом, по справочнику", () => {
  it("по объекту: одно место на категорию, расстояние словами, без адреса и цены", async () => {
    const r = await handleClientTool(memoryFor(), call("describe_area", { number: open.shortId }));
    const res = r!.response as Record<string, any>;
    expect(res.ok).toBe(true);
    const names = res.nearby.map((n: { name: string }) => n.name);
    expect(names).toContain(`Школа №1 ${runId}`);
    expect(names).toContain(`Базар ${runId}`);
    expect(names).not.toContain(`Школа №2 ${runId}`);
    expect(res.nearby.find((n: { name: string }) => n.name === `Школа №1 ${runId}`).distance).toMatch(/метров$/);
    expectNoLeak(res);
    expect(JSON.stringify(res)).not.toMatch(/52\s?000/);
  });

  it("закрытый объект — отказ: что рядом с ним, то и его адрес", async () => {
    const r = await handleClientTool(memoryFor(), call("describe_area", { number: closed.shortId }));
    expect((r!.response as { ok: boolean }).ok).toBe(false);
  });

  it("по месту словами: место из справочника и сколько наших объектов рядом", async () => {
    const r = await handleClientTool(memoryFor(), call("describe_area", { place: `Базар ${runId}` }));
    const res = r!.response as Record<string, any>;
    expect(res.ok).toBe(true);
    expect(res.our_listings_nearby).toBe(1); // открытый; закрытый не в счёт
    expectNoLeak(res);
  });

  it("места нет в справочнике — честный отказ", async () => {
    const r = await handleClientTool(memoryFor(), call("describe_area", { place: `Нигдебург ${runId}` }));
    expect((r!.response as { ok: boolean }).ok).toBe(false);
  });
});

it("чужая функция — не отсюда", async () => {
  expect(await handleClientTool(memoryFor(), call("search_properties"))).toBeNull();
});

function labeled(slots: Date[]): string[] {
  return slots.map((s) => `${String(dushanbeWallClock(s).getUTCHours()).padStart(2, "0")}:00`);
}
