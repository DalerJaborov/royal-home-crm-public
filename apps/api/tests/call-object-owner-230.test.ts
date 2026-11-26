import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ЗВОНОК ПО ОБЪЕКТУ — ХОЗЯИНУ ОБЪЕКТА (владелец 26.11.2026: «каждый должен получить
 * свои объекты»). Регрессия на живой звонок ПК-001086 (26.11.2026, 05:36 UTC):
 * клиент позвонил оператору по ролику Instagram про объект №230 — «ду хонага…
 * масҷиди Мехкалон, Қазоқон… 165 ҳазор… Зайниддин Файзуллоев». В карточке:
 * 2 комнаты, 3 этаж, «возле мечети в Қазоқон», 965 000 сомони, принял
 * Сайфуллоев Илҳом (assignedAgentId пуст). Расшифровка потеряла первую цифру
 * цены, фамилия с ролика пришла искажённой — и прежние правила вычеркнули объект
 * по цене (вето 20 %), назвали фамилию тёзками (Нарзуллоев уволен) и отдали заявку
 * по очереди Миҷгоне. Хозяин объекта о клиенте не узнал.
 *
 * Здесь — этот звонок как есть и таблица соседних случаев: цена в другой валюте,
 * ориентир без номера, два одинаковых объекта рядом (не гадать, но подсказать
 * руководству), хозяин уволен, продавец, рубильник выключен, трубку снял агент
 * (сильное совпадение уступает, слабое — нет).
 *
 * Модель разбора и пуши подменены: проверяются решения вокруг модели, а не она сама.
 */

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents: sendPushToAgent,
}));
const notifyFeedOnly = vi.fn(async () => undefined);
vi.mock("../src/lib/notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/notifications.js")>()),
  notifyFeedOnly,
}));
const extractIncomingCallLead = vi.fn();
vi.mock("../src/ai/incomingCallLead.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/incomingCallLead.js")>()),
  extractIncomingCallLead,
}));
const switchesOff = vi.hoisted(() => new Set<string>());
vi.mock("../src/lib/automationSwitches.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/automationSwitches.js")>();
  return {
    ...actual,
    automationSwitchOn: async (...a: Parameters<typeof actual.automationSwitchOn>) =>
      switchesOff.has(a[0]) ? false : actual.automationSwitchOn(...a),
  };
});

const { prisma } = await import("../src/db.js");
const { autoLeadFromIncomingCall } = await import("../src/lib/telephony/autoLeadFromCall.js");
const { resetIncomingCalls } = await import("../src/lib/telephony/incomingCalls.js");
const { resetKnownAgentsCache } = await import("../src/lib/requestedAgent.js");
const { resetGeoMentionIndex } = await import("../src/ai/geoMentions.js");
const { loadMoneyContext } = await import("../src/lib/money.js");
const { reserveExtensionBase } = await import("./helpers/extensionBase.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
/** Уникальные слова мест — буквы из номера прогона (как в property-identify.test.ts). */
const tag = String(runId)
  .slice(-7)
  .split("")
  .reverse()
  .map((d) => "бвгдзклмнр"[Number(d)])
  .join("");
/** Как в карточке №230 («Қазоқон») и как в карточке №196 («Казакон»): одна буква иначе. */
const PLACE_CARD = `Қазоқон${tag}`;
const PLACE_RIVAL = `Казакон${tag}`;
const PLACE_SAID = `тарафи масҷиди Мехкалон${tag} Қазоқон${tag}`;

let ownerId = ""; // Сайфуллоев Илҳом — принял объект №230, assignedAgentId пуст
let firedId = ""; // Комрон Нарзуллоев — уволен, фамилия похожа
let rivalId = ""; // Умед — хозяин соседнего №196
let districtId = "";
let usdToTjs = 1;
const clientIds: string[] = [];
const callIds: string[] = [];
const interactionIds: string[] = [];
const propertyIds: string[] = [];

const TRANSCRIPT =
  "Агент: Алло.\nКлиент: Алло, салому алейкум.\nАгент: Алейкум салом.\n" +
  "Клиент: Ака барои ҳаму хонаи динанги мондагитон ҳаму 2 хонагае, ки дар тарафи масҷиди мехкалон қазоқон навистагиен 165 ҳазор\n" +
  "Агент: Аха.\nКлиент: ҳамура чихели бинем?\nАгент: Кай шумо метавонед дидан?\n" +
  "Клиент: Вай номери дига да ба Зайниддин Файзуллоев да занг задем вай набардошт.\nАгент: О ҳози планёрка да ҳай ака.";

/** Разбор модели ровно как на проде 26.11: цена 165 000 сомони, 2 комнаты, ориентир, фамилия с ролика. */
function extractAsOnProd(over: Record<string, unknown> = {}) {
  return {
    kind: "BUYER" as const,
    confident: true,
    fullName: "Хушбахт",
    requirementsNotes: "Интересуется 2-комнатной квартирой возле мечети Мехкалон (Казокон) за 165 000 сомони.",
    desiredDistrictId: districtId,
    desiredRooms: 2,
    desiredType: "APARTMENT" as const,
    budgetMin: null,
    budgetMax: 165_000,
    namedAgent: "Зайниддин Файзуллоев",
    propertyHint: null,
    propertyLandmark: PLACE_SAID,
    propertyFloor: null,
    propertyTotalFloors: null,
    propertyAreaSqm: null,
    propertyRooms: 2,
    propertyPrice: 165_000,
    propertyPriceCurrency: "TJS" as const,
    propertyLandSotka: null,
    jobSeeker: false,
    ...over,
  };
}

/** Номера сотрудников — по счётчику, не случайные: случайная цифра на одном хвосте сталкивалась (Agent_phone_key). */
let agentSeq = 0;
async function makeAgent(fullName: string, over: Record<string, unknown> = {}): Promise<string> {
  agentSeq += 1;
  const a = await prisma.agent.create({
    data: { fullName, phone: `+9929${agentSeq}${tail}`, role: "AGENT", passwordHash: "x", isActive: true, ...over } as never,
  });
  return a.id;
}

async function makeProperty(data: Record<string, unknown>) {
  const p = await prisma.property.create({
    data: {
      title: `2-комн · Сино ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      rooms: 2,
      floor: 3,
      totalFloors: 22,
      price: 965_000,
      currency: "TJS",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      districtId,
      address: `сторона белых домов, возле мечети в ${PLACE_CARD}`,
      landmark: "Ориентир напротив Оши Бародарон",
      intakeAgentId: ownerId,
      assignedAgentId: null,
      ownerContact: `+99293${tail}${propertyIds.length}`,
      ...data,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

async function seedCall(phone: string, extra: Record<string, unknown> = {}): Promise<{ callId: string; clientId: string }> {
  const client = await prisma.client.create({
    data: { fullName: `Входящий ${phone}`, phone, source: "PHONE_CALL", kind: "OTHER", status: "NEW", currency: "TJS" },
  });
  clientIds.push(client.id);
  const interaction = await prisma.interaction.create({
    // Запись звонка без агента — актор «клиент» (ограничение Interaction_actor_kind_agent_id_check).
    data: { clientId: client.id, type: "CALL", actorKind: "CLIENT", notes: "Входящий звонок клиента: поговорил с оператором", outcome: "NEUTRAL", transcript: TRANSCRIPT },
  });
  interactionIds.push(interaction.id);
  const call = await prisma.incomingCall.create({
    data: {
      channelId: `call-object-${runId}-${Math.random().toString(36).slice(2)}`,
      phone,
      startedAt: new Date(),
      endedAt: new Date(),
      answered: true,
      talkSeconds: 72,
      clientId: client.id,
      autoCreatedClient: true,
      interactionId: interaction.id,
      routeDecision: "no_client",
      ...extra,
    },
  });
  callIds.push(call.id);
  return { callId: call.id, clientId: client.id };
}

async function clientAfter(clientId: string) {
  return prisma.client.findUnique({
    where: { id: clientId },
    select: { assignedAgentId: true, assignReason: true, matchedPropertyId: true, acceptedAt: true },
  });
}

async function timelineNotes(clientId: string): Promise<string> {
  const rows = await prisma.interaction.findMany({ where: { clientId, type: "SYSTEM" }, select: { notes: true } });
  return rows.map((r) => r.notes ?? "").join("\n");
}

let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `+99267${tail.slice(0, 5)}${String(phoneSeq).padStart(2, "0")}`;
}

beforeAll(async () => {
  usdToTjs = (await loadMoneyContext()).usdToTjs;
  districtId = (await prisma.district.create({ data: { name: `Сино звонка ${runId}` } })).id;
  // Метка прогона — отдельным словом: приклеенная к фамилии, она ломала бы само сравнение имён.
  ownerId = await makeAgent(`Сайфуллоев Илҳом ${tag}`);
  firedId = await makeAgent(`Комрон Нарзуллоев ${tag}`, { isActive: false });
  rivalId = await makeAgent(`Умед Соседний ${runId}`);
  resetKnownAgentsCache();
  resetGeoMentionIndex();
});

beforeEach(() => {
  extractIncomingCallLead.mockReset();
  sendPushToAgent.mockClear();
  notifyFeedOnly.mockClear();
  switchesOff.clear();
  resetKnownAgentsCache();
});

afterEach(async () => {
  resetIncomingCalls();
  await prisma.incomingCall.deleteMany({ where: { id: { in: callIds } } });
  callIds.length = 0;
  await prisma.interaction.deleteMany({ where: { OR: [{ id: { in: interactionIds } }, { clientId: { in: clientIds } }] } });
  interactionIds.length = 0;
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  clientIds.length = 0;
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  propertyIds.length = 0;
});

afterAll(async () => {
  await prisma.agent.updateMany({ where: { id: { in: [ownerId, firedId, rivalId] } }, data: { isActive: false } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownerId, firedId, rivalId] } } }).catch(() => {});
  await prisma.district.deleteMany({ where: { id: districtId } });
  resetKnownAgentsCache();
  await prisma.$disconnect();
});

describe("ПК-001086 → объект №230 → Сайфуллоев Илҳом (26.11.2026)", () => {
  it("звонок как на проде: «165 ҳазор» вместо 965 000, «Файзуллоев» вместо «Сайфуллоев» — заявка хозяину объекта", async () => {
    const target = await makeProperty({});
    // Соседний объект того же района: «улица Казакон», 2 комнаты, 15 этаж, 799 000, трёхнедельной давности, другого агента.
    await makeProperty({
      address: `улица ${PLACE_RIVAL}, 172`,
      floor: 15,
      price: 799_000,
      intakeAgentId: rivalId,
      createdAt: new Date(Date.now() - 20 * 86_400_000),
    });
    extractIncomingCallLead.mockResolvedValue(extractAsOnProd());
    const { callId, clientId } = await seedCall(nextPhone());

    const result = await autoLeadFromIncomingCall(callId);
    expect(result.status).toBe("qualified");
    const client = await clientAfter(clientId);
    expect(client?.assignedAgentId).toBe(ownerId);
    // Названное имя сошлось с хозяином узнанного объекта — это подтверждение, не тёзки.
    const notes = await timelineNotes(clientId);
    expect(notes).not.toContain("однозначно определить не вышло");
    expect(notes).toContain("агент объекта");
    expect(client?.acceptedAt).toBeNull();
    expect(target.id).toBeTruthy();
  });

  it("без имени: ориентир, комнаты и похожая цена узнают объект — заявка хозяину с причиной «свой объект»", async () => {
    const target = await makeProperty({});
    await makeProperty({ address: `улица ${PLACE_RIVAL}, 172`, floor: 15, price: 799_000, intakeAgentId: rivalId, createdAt: new Date(Date.now() - 20 * 86_400_000) });
    extractIncomingCallLead.mockResolvedValue(extractAsOnProd({ namedAgent: null }));
    const { callId, clientId } = await seedCall(nextPhone());

    await autoLeadFromIncomingCall(callId);
    const client = await clientAfter(clientId);
    expect(client?.assignedAgentId).toBe(ownerId);
    expect(client?.assignReason).toBe("own_property_explicit");
    expect(client?.matchedPropertyId).toBe(target.id);
    const notes = await timelineNotes(clientId);
    expect(notes).toContain("Узнан объект");
    expect(notes).toContain("цена похожа");
  });

  it("цена в другой валюте: модель назвала 104 000 «сомони», а это доллары — объект всё равно узнаётся", async () => {
    const target = await makeProperty({});
    extractIncomingCallLead.mockResolvedValue(
      extractAsOnProd({ namedAgent: null, propertyPrice: Math.round(965_000 / usdToTjs), budgetMax: Math.round(965_000 / usdToTjs) })
    );
    const { callId, clientId } = await seedCall(nextPhone());
    await autoLeadFromIncomingCall(callId);
    const client = await clientAfter(clientId);
    expect(client?.assignedAgentId).toBe(ownerId);
    expect(client?.matchedPropertyId).toBe(target.id);
  });

  it("имя с ошибкой, объекта в разговоре нет: похожие — действующий и уволенный — заявка действующему", async () => {
    extractIncomingCallLead.mockResolvedValue(
      extractAsOnProd({ propertyLandmark: null, propertyPrice: null, propertyPriceCurrency: null, propertyRooms: null, budgetMax: null })
    );
    const { callId, clientId } = await seedCall(nextPhone());
    await autoLeadFromIncomingCall(callId);
    const client = await clientAfter(clientId);
    expect(client?.assignedAgentId).toBe(ownerId);
    expect(client?.assignReason).toBe("requested_by_client");
    expect(await timelineNotes(clientId)).toContain("уже не работают");
  });

  it("два одинаковых объекта у одного ориентира — не гадаем: очередь, похожие в хронологии, руководству подсказка", async () => {
    const a = await makeProperty({});
    const b = await makeProperty({ intakeAgentId: rivalId }); // тот же адрес, комнаты, этаж, цена
    extractIncomingCallLead.mockResolvedValue(extractAsOnProd({ namedAgent: null }));
    const { callId, clientId } = await seedCall(nextPhone());
    await autoLeadFromIncomingCall(callId);
    const client = await clientAfter(clientId);
    expect(client?.matchedPropertyId).toBeNull();
    expect(client?.assignReason).not.toBe("own_property_explicit");
    const notes = await timelineNotes(clientId);
    expect(notes).toContain("уверенно не узнан");
    expect(notes).toContain("угадывать нельзя");
    expect(notifyFeedOnly).toHaveBeenCalledTimes(1);
    const body = String((notifyFeedOnly.mock.calls[0] as unknown[])[1] && ((notifyFeedOnly.mock.calls[0] as unknown[])[1] as { body: string }).body);
    expect(body).toContain("похожи");
    expect([a.id, b.id]).toHaveLength(2);
  });

  it("хозяин объекта уволен — заявка обычной раздачей, в хронологии сказано почему, подсказки руководству нет", async () => {
    await prisma.agent.update({ where: { id: ownerId }, data: { isActive: false } });
    try {
      await makeProperty({});
      extractIncomingCallLead.mockResolvedValue(extractAsOnProd({ namedAgent: null }));
      const { callId, clientId } = await seedCall(nextPhone());
      await autoLeadFromIncomingCall(callId);
      const client = await clientAfter(clientId);
      expect(client?.assignedAgentId).not.toBe(ownerId);
      expect(await timelineNotes(clientId)).toContain("агент объекта сейчас не принимает заявки");
      // Руководству уходит прежний сигнал «заявка по объекту без хозяина» (assignment.ts), а не подсказка «не узнан».
      const titles = notifyFeedOnly.mock.calls.map((c) => ((c as unknown[])[1] as { title: string }).title);
      expect(titles.some((t) => t.includes("не узнан уверенно"))).toBe(false);
      expect(titles.some((t) => t.includes("без хозяина"))).toBe(true);
    } finally {
      await prisma.agent.update({ where: { id: ownerId }, data: { isActive: true } });
      resetKnownAgentsCache();
    }
  });

  it("продавец описал своё жильё приметами чужого объекта — хозяину чужого объекта не отдаём", async () => {
    await makeProperty({});
    extractIncomingCallLead.mockResolvedValue(extractAsOnProd({ kind: "SELLER", namedAgent: null }));
    const { callId, clientId } = await seedCall(nextPhone());
    await autoLeadFromIncomingCall(callId);
    const client = await clientAfter(clientId);
    expect(client?.matchedPropertyId).toBeNull();
    expect(client?.assignReason).not.toBe("own_property_explicit");
  });

  it("рубильник выключен — ровно как до 26.11: «165» против 965 000 вычёркивает объект, подсказки нет", async () => {
    switchesOff.add("callObjectToOwnerEnabled");
    const target = await makeProperty({});
    extractIncomingCallLead.mockResolvedValue(extractAsOnProd({ namedAgent: null }));
    const { callId, clientId } = await seedCall(nextPhone());
    await autoLeadFromIncomingCall(callId);
    const client = await clientAfter(clientId);
    expect(client?.matchedPropertyId).not.toBe(target.id);
    expect(notifyFeedOnly).not.toHaveBeenCalled();
  });

  it("рубильник выключен — узнавание по приметам с верной ценой по-прежнему отдаёт хозяину (не хуже, чем до правки, ревью В4)", async () => {
    switchesOff.add("callObjectToOwnerEnabled");
    const target = await makeProperty({});
    extractIncomingCallLead.mockResolvedValue(extractAsOnProd({ namedAgent: null, propertyPrice: 965_000, budgetMax: 965_000 }));
    const { callId, clientId } = await seedCall(nextPhone());
    await autoLeadFromIncomingCall(callId);
    const client = await clientAfter(clientId);
    expect(client?.assignedAgentId).toBe(ownerId);
    expect(client?.matchedPropertyId).toBe(target.id);
  });

  it("с рубильником совсем другая цена не убивает объект, если сошлись ориентир, комнаты и этаж", async () => {
    // Краснеет, если вернуть вычёркивание по цене в путь звонка (ревью 26.11).
    const target = await makeProperty({});
    extractIncomingCallLead.mockResolvedValue(
      extractAsOnProd({ namedAgent: null, propertyPrice: 300_000, budgetMax: 300_000, propertyFloor: 3 })
    );
    const { callId, clientId } = await seedCall(nextPhone());
    await autoLeadFromIncomingCall(callId);
    const client = await clientAfter(clientId);
    expect(client?.assignedAgentId).toBe(ownerId);
    expect(client?.matchedPropertyId).toBe(target.id);
  });

  it("номер объекта словами («объект двести тридцать») — прямое указание (рубильник включён)", async () => {
    const target = await makeProperty({});
    extractIncomingCallLead.mockResolvedValue(
      extractAsOnProd({ namedAgent: null, propertyLandmark: null, propertyPrice: null, propertyPriceCurrency: null, propertyHint: `объект ${numberInWords(target.shortId)}` })
    );
    const { callId, clientId } = await seedCall(nextPhone());
    await autoLeadFromIncomingCall(callId);
    const client = await clientAfter(clientId);
    expect(client?.assignedAgentId).toBe(ownerId);
    expect(client?.matchedPropertyId).toBe(target.id);
  });

  it("трубку снял другой агент: слабое совпадение по приметам его не перебивает, сильное (место + этаж + комнаты + цена) — перебивает", async () => {
    const answererExt = String(await reserveExtensionBase(1));
    const answererId = await makeAgent(`Снявший трубку ${runId}`, { sipExtension: answererExt });
    try {
      const target = await makeProperty({});
      // Слабое: только ориентир и комнаты.
      extractIncomingCallLead.mockResolvedValue(extractAsOnProd({ namedAgent: null, propertyPrice: null, propertyPriceCurrency: null, budgetMax: null }));
      const weak = await seedCall(nextPhone(), { answeredBy: answererExt });
      await autoLeadFromIncomingCall(weak.callId);
      expect((await clientAfter(weak.clientId))?.assignedAgentId).toBe(answererId);

      // Сильное: ориентир, комнаты, этаж, точная цена.
      extractIncomingCallLead.mockResolvedValue(extractAsOnProd({ namedAgent: null, propertyPrice: 965_000, budgetMax: 965_000, propertyFloor: 3 }));
      const strong = await seedCall(nextPhone(), { answeredBy: answererExt });
      await autoLeadFromIncomingCall(strong.callId);
      const client = await clientAfter(strong.clientId);
      expect(client?.assignedAgentId).toBe(ownerId);
      expect(client?.matchedPropertyId).toBe(target.id);
      expect(await timelineNotes(strong.clientId)).toContain("Трубку снял");

      // Покупатель рассказал, ЧТО ИЩЕТ (комнаты, бюджет, район — пожелания), объект
      // назван лишь ориентиром: это не приметы объявления — снявший трубку остаётся
      // (правило 10.10 P0-4, ревью 26.11 В3).
      extractIncomingCallLead.mockResolvedValue(
        extractAsOnProd({
          namedAgent: null,
          propertyRooms: null,
          propertyPrice: null,
          propertyPriceCurrency: null,
          desiredRooms: 2,
          budgetMax: 965_000,
        })
      );
      const wishes = await seedCall(nextPhone(), { answeredBy: answererExt });
      await autoLeadFromIncomingCall(wishes.callId);
      expect((await clientAfter(wishes.clientId))?.assignedAgentId).toBe(answererId);
    } finally {
      await prisma.interaction.deleteMany({ where: { agentId: answererId } });
      await prisma.agent.delete({ where: { id: answererId } }).catch(() => {});
    }
  });
});

/** Номер объекта русскими словами — как его произносит человек оператору. */
function numberInWords(n: number): string {
  const units = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять", "десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
  const tens = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
  const hundreds = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];
  const parts: string[] = [];
  const thousands = Math.floor(n / 1000);
  if (thousands > 0) parts.push(numberInWords(thousands), "тысяч");
  const rest = n % 1000;
  if (hundreds[Math.floor(rest / 100)]) parts.push(hundreds[Math.floor(rest / 100)]);
  const tail2 = rest % 100;
  if (tail2 < 20) {
    if (units[tail2]) parts.push(units[tail2]);
  } else {
    parts.push(tens[Math.floor(tail2 / 10)]);
    if (units[tail2 % 10]) parts.push(units[tail2 % 10]);
  }
  return parts.join(" ");
}
