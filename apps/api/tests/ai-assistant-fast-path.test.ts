import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Быстрый путь ИИ-помощника без модели (ai/assistantFastPath.ts, п. 1.5 плана
 * docs/design/internal-assistant-architecture-2026-10-31.md).
 *
 * Две части. Разбор фразы — чистая функция, без базы: что считаем «целиком
 * номером/телефоном/ссылкой», а что отдаём модели. Выдача — из базы под ПРАВАМИ
 * вызвавшего: те же правила, что у инструментов помощника (runTool), нового права
 * быстрый путь не заводит. Модель здесь не мокается, потому что она не зовётся.
 */

const { prisma } = await import("../src/db.js");
const { parseFastPathIntent, tryAssistantFastPath, toCrmPhone } = await import("../src/ai/assistantFastPath.js");

const runId = String(Date.now()).slice(-8);
// 9 цифр после +992 — формат, в котором CRM хранит номера; «7» + runId — свой префикс на этот файл.
const phoneOf = (n: number) => `+9927${n}${runId.slice(-7)}`;

let agentAId: string;
let agentBId: string;
let directorId: string;
let districtId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];

const actor = (id: string, over: Partial<{ canViewAllClients: boolean; canViewPhone: boolean }> = {}) => ({
  id,
  role: "AGENT",
  canViewAllClients: false,
  canViewPhone: false,
  canViewReports: false,
  canViewFinance: false,
  canViewAllDeals: false,
  ...over,
});

async function makeClient(n: number, assignedAgentId: string, acceptedAt: Date | null = new Date()) {
  const c = await prisma.client.create({
    data: {
      fullName: `Быстрый путь ${n} ${runId}`,
      phone: phoneOf(n),
      source: "WEBSITE",
      assignedAgentId,
      acceptedAt,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Быстрый-путь-${runId}` } })).id;
  const mk = async (label: string, role: "AGENT" | "DIRECTOR", n: number) =>
    (
      await prisma.agent.create({
        data: { fullName: `${label} ${runId}`, phone: `+9926${n}${runId.slice(-7)}`, role, passwordHash: "x" },
      })
    ).id;
  agentAId = await mk("Агент А", "AGENT", 1);
  agentBId = await mk("Агент Б", "AGENT", 2);
  directorId = await mk("Директор", "DIRECTOR", 3);
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function makeProperty(extra: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Быстрый объект ${propertyIds.length} ${runId}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 450000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      assignedAgentId: agentAId,
      ...extra,
    },
  });
  propertyIds.push(p.id);
  return p;
}

describe("parseFastPathIntent — что берём без модели", () => {
  it.each([
    ["ОБ-000088", { kind: "property-code", shortId: 88 }],
    ["об 88", { kind: "property-code", shortId: 88 }],
    ["ОБ №88", { kind: "property-code", shortId: 88 }],
    ["ob-88", { kind: "property-code", shortId: 88 }],
    ["объект 88", { kind: "property-code", shortId: 88 }],
    ["покажи ОБ-000088", { kind: "property-code", shortId: 88 }],
    ["Найди объект №88?", { kind: "property-code", shortId: 88 }],
    ["ПК-000042", { kind: "client-code", shortId: 42 }],
    ["ПР-42", { kind: "client-code", shortId: 42 }],
    ["клиент 42", { kind: "client-code", shortId: 42 }],
    ["+992 90 123-45-67", { kind: "phone", phone: "+992901234567" }],
    ["0901234567", { kind: "phone", phone: "+992901234567" }],
    ["номер 901234567", { kind: "phone", phone: "+992901234567" }],
    ["https://www.instagram.com/reel/Cx1_aB-9z/?igsh=abc", { kind: "instagram", code: "Cx1_aB-9z" }],
    ["вот ссылка https://instagram.com/p/AbC123/", { kind: "instagram", code: "AbC123" }],
  ])("%s", (text, expected) => {
    expect(parseFastPathIntent(text)).toEqual(expected);
  });

  it.each([
    "88",
    "сколько стоит ОБ-88 и когда показ?",
    "какие клиенты у Умеды",
    "найди клиентов с Пахтакор",
    "ОБ-",
    "123456",
    "",
    "https://www.instagram.com/some_account/",
    "посмотри https://www.instagram.com/reel/Cx1_aB-9z/ и расскажи, подходит ли он клиенту Умеде под бюджет",
  ])("отдаёт модели: %j", (text) => {
    expect(parseFastPathIntent(text)).toBeNull();
  });

  it("toCrmPhone приводит три формы к хранимому виду и отвергает остальное", () => {
    expect(toCrmPhone("+992 (90) 123-45-67")).toBe("+992901234567");
    expect(toCrmPhone("0901234567")).toBe("+992901234567");
    expect(toCrmPhone("901234567")).toBe("+992901234567");
    expect(toCrmPhone("1234567")).toBeNull();
  });
});

describe("tryAssistantFastPath — выдача под правами", () => {
  it("объект по номеру виден любой роли; карточка несёт код, цену и ссылку", async () => {
    const p = await makeProperty();
    const res = await tryAssistantFastPath(`ОБ-${String(p.shortId).padStart(6, "0")}`, actor(agentBId));
    expect(res?.cards).toHaveLength(1);
    const card = res!.cards[0];
    expect(card).toMatchObject({ kind: "property", id: p.id, price: 450000, currency: "TJS", href: `/properties/${p.id}` });
    expect(card.kind === "property" && card.code).toBe(`ОБ-${String(p.shortId).padStart(6, "0")}`);
    expect(res!.reply).toContain(`(/properties/${p.id})`);
    expect(res!.tool).toBe("fast_path.property-code");
  });

  it("объект из Корзины и несуществующий номер — null (идёт обычным путём)", async () => {
    const p = await makeProperty({ deletedAt: new Date() });
    expect(await tryAssistantFastPath(`объект ${p.shortId}`, actor(agentAId))).toBeNull();
    expect(await tryAssistantFastPath("объект 999999999", actor(agentAId))).toBeNull();
  });

  it("ссылка Instagram: точный код, а не просто общее начало", async () => {
    const p = await makeProperty({ instagramUrl: `https://www.instagram.com/reel/Fp${runId}/` });
    await makeProperty({ instagramUrl: `https://www.instagram.com/reel/Fp${runId}Z/` });
    const res = await tryAssistantFastPath(`https://www.instagram.com/reel/Fp${runId}/?igsh=1`, actor(agentAId));
    expect(res?.cards.map((c) => c.id)).toEqual([p.id]);
  });

  it("клиент по номеру: агент видит своего принятого, чужого и непринятого — нет", async () => {
    const own = await makeClient(1, agentAId);
    const foreign = await makeClient(2, agentBId);
    const pending = await makeClient(3, agentAId, null);
    const code = (c: { shortId: number }) => `ПК-${c.shortId}`;

    const ownRes = await tryAssistantFastPath(code(own), actor(agentAId));
    expect(ownRes?.cards[0]).toMatchObject({ kind: "client", id: own.id });
    expect(await tryAssistantFastPath(code(foreign), actor(agentAId))).toBeNull();
    expect(await tryAssistantFastPath(code(pending), actor(agentAId))).toBeNull();
  });

  it("телефон в карточке: маска без права clients.viewPhone, целиком — с правом", async () => {
    const c = await makeClient(4, agentAId);
    const noPhoneRight = await tryAssistantFastPath(`ПК-${c.shortId}`, actor(agentAId));
    expect(noPhoneRight?.cards[0]).toMatchObject({ kind: "client" });
    const masked = noPhoneRight!.cards[0].kind === "client" ? noPhoneRight!.cards[0].phone : "";
    expect(masked).not.toBe(c.phone);

    const director = actor(directorId, { canViewAllClients: true, canViewPhone: true });
    const full = await tryAssistantFastPath(`ПК-${c.shortId}`, director);
    expect(full!.cards[0].kind === "client" && full!.cards[0].phone).toBe(c.phone);
  });

  it("непринятая заявка: даже директор с правом на телефон получает номер в маске", async () => {
    const c = await makeClient(5, agentAId, null);
    const director = actor(directorId, { canViewAllClients: true, canViewPhone: true });
    const res = await tryAssistantFastPath(`ПК-${c.shortId}`, director);
    expect(res?.cards[0].kind === "client" && res.cards[0].phone).not.toBe(c.phone);
  });

  it("поиск по телефону: без права на номер — null, с правом — карточка", async () => {
    const c = await makeClient(6, agentAId);
    expect(await tryAssistantFastPath(c.phone, actor(agentAId))).toBeNull();

    const withRight = await tryAssistantFastPath(c.phone.replace("+992", "0"), actor(agentAId, { canViewPhone: true }));
    expect(withRight?.cards[0]).toMatchObject({ kind: "client", id: c.id });
    expect(withRight!.tool).toBe("fast_path.phone");
    // В журнал уходит id карточки, а не сам номер.
    expect(withRight!.argsSummary).not.toContain(c.phone);

    // Чужой клиент по телефону — тоже нет, даже с правом на номер, если нет права видеть всех.
    const foreign = await makeClient(7, agentBId);
    expect(await tryAssistantFastPath(foreign.phone, actor(agentAId, { canViewPhone: true }))).toBeNull();
  });
});
