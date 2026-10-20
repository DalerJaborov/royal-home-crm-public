import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * НЕСКОЛЬКО ОБЪЕКТОВ У ОДНОГО ПРОДАВЦА — ЧЕРНОВИК НЕ ЗАПОЛНЯЕТСЯ ВОВСЕ.
 *
 * Разбор поломки 19.09.2026: агент завела подряд две квартиры одного продавца
 * (разные районы, один человек). Обе поехали монтажёру, и оба раза текст на
 * готовом ролике оказался смесью двух квартир — комнаты от одной, место от
 * другой. Объекты удалили, завели заново — смесь получилась другая.
 *
 * Причина не в монтажёре и не в передаче: подпись монтажёру
 * (lib/videoHandoff.ts::buildHandoffCaption) собирается из полей карточки
 * дословно, ничего не сочиняя. Единственное место на всём пути, где факты
 * объекта берутся не из карточки, — ai/propertyDraft.ts: он разбирает ВСЮ
 * переписку с ПРОДАВЦОМ (вход — clientId, не объект) и просит модель заполнить
 * «карточку ЕГО ОБЪЕКТА» в единственном числе. Продавец с двумя квартирами →
 * один набор полей по двум объектам → смесь, которая дальше уезжает точь-в-точь.
 *
 * Здесь проверяется сама починка: оба запрета из шапки ai/propertyDraft.ts
 * должны срабатывать КОДОМ, а не обещанием модели, поэтому модель во всех
 * проверках ниже возвращает как раз полный набор полей — если запрет не
 * сработал, он окажется в предложении.
 */

const aiCalls: { user: string }[] = [];
let aiReply: Record<string, unknown> | null = null;
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: async (params: { user?: string }) => {
    aiCalls.push({ user: params.user ?? "" });
    return aiReply;
  },
}));

const { prisma } = await import("../src/db.js");
const { buildPropertyDraftSuggestion } = await import("../src/ai/propertyDraft.js");

const runId = Date.now();
let agentId = "";
let districtId = "";
const clientIds: string[] = [];
const propertyIds: string[] = [];

/** Полный ответ модели — то, что уехало бы в форму, если бы запрет не сработал. */
function fullAiReply(extra: Record<string, unknown> = {}) {
  return {
    propertyType: "APARTMENT",
    rooms: 2,
    areaSqm: 54,
    floor: 3,
    condition: "NEEDS_REPAIR",
    price: 450000,
    currency: "TJS",
    districtName: `Две-квартиры-${runId}`,
    address: "напротив кинотеатра Зебунисо",
    evidence: ["54 метра", "3 этаж"],
    ...extra,
  };
}

async function makeSeller(name: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9928${clientIds.length}${runId}`,
      status: "NEW",
      kind: "SELLER",
      workStatus: "ACTIVE",
      source: "WEBSITE",
      assignedAgentId: agentId,
      currency: "TJS",
      acceptedAt: new Date(),
    } as never,
  });
  clientIds.push(c.id);
  return c.id;
}

async function attachConversation(clientId: string, messages: { role: "user" | "assistant"; content: string }[]) {
  await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `sub-several-${clientId}`,
      clientId,
      messages: messages as never,
    },
  });
}

/** Объект этого продавца в CRM. deletedAt — чтобы отличить живой от удалённого:
 *  после удаления объекта заводить его заново по переписке законно. */
async function makeSellerProperty(sellerClientId: string, deleted = false) {
  const p = await prisma.property.create({
    data: {
      title: `Квартира продавца ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 48,
      price: 300000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 11",
      condition: "GOOD",
      sellerClientId,
      ...(deleted ? { deletedAt: new Date() } : {}),
    },
  });
  propertyIds.push(p.id);
  return p.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Две-квартиры-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент двух квартир ${runId}`, phone: `+992936${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterEach(() => {
  aiCalls.length = 0;
  aiReply = null;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.botConversation.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Несколько объектов одного продавца — черновик из переписки", () => {
  it("у продавца уже есть объект в CRM: поля не подставляются и платный вызов не делается", async () => {
    const clientId = await makeSeller("Вторая квартира");
    await attachConversation(clientId, [
      { role: "user", content: "Продаю 2-хонага, 54 метра, 3 этаж. И ещё одну есть, в другом районе." },
    ]);
    await makeSellerProperty(clientId);
    aiReply = fullAiReply();

    const suggestion = await buildPropertyDraftSuggestion(clientId);

    // Ни одного факта: в новую карточку не должно уехать НИЧЕГО из разбора
    // переписки, где перемешаны обе квартиры.
    expect(suggestion.rooms).toBeNull();
    expect(suggestion.areaSqm).toBeNull();
    expect(suggestion.floor).toBeNull();
    expect(suggestion.price).toBeNull();
    expect(suggestion.districtId).toBeNull();
    expect(suggestion.address).toBeNull();
    expect(suggestion.type).toBeNull();
    expect(suggestion.condition).toBeNull();
    expect(suggestion.ambiguityReason).toBe("ALREADY_HAS_OBJECTS");
    expect(suggestion.existingObjectsCount).toBe(1);
    // Запрет стоит до вызова модели — за заведомо бесполезный разбор не платим.
    expect(aiCalls).toHaveLength(0);
    // Это не отказ ИИ: форма открылась пустой нарочно, а не потому, что модель молчит.
    expect(suggestion.aiUnavailable).toBe(false);
  });

  it("двадцатый объект того же продавца — запрет тот же, а не «на второй раз пронесёт»", async () => {
    const clientId = await makeSeller("Двадцать квартир");
    await attachConversation(clientId, [{ role: "user", content: "У меня много квартир на продажу" }]);
    for (let i = 0; i < 20; i += 1) await makeSellerProperty(clientId);
    aiReply = fullAiReply();

    const suggestion = await buildPropertyDraftSuggestion(clientId);

    expect(suggestion.ambiguityReason).toBe("ALREADY_HAS_OBJECTS");
    expect(suggestion.existingObjectsCount).toBe(20);
    expect(suggestion.rooms).toBeNull();
    expect(suggestion.price).toBeNull();
    expect(aiCalls).toHaveLength(0);
  });

  it("модель сообщила о двух объектах в переписке: поля обнуляются кодом, цитаты остаются", async () => {
    const clientId = await makeSeller("Две квартиры в переписке");
    await attachConversation(clientId, [
      { role: "user", content: "Продаю две квартиры: одна 2-хонага 54 метра на Сино, вторая 3-хонага 80 метров на Фирдавси" },
    ]);
    // Объектов в CRM ещё нет — первый запрет не сработает, проверяется второй.
    aiReply = fullAiReply({ objectsCount: 2 });

    const suggestion = await buildPropertyDraftSuggestion(clientId);

    expect(suggestion.rooms).toBeNull();
    expect(suggestion.areaSqm).toBeNull();
    expect(suggestion.floor).toBeNull();
    expect(suggestion.price).toBeNull();
    expect(suggestion.currency).toBeNull();
    expect(suggestion.districtId).toBeNull();
    expect(suggestion.address).toBeNull();
    expect(suggestion.type).toBeNull();
    expect(suggestion.condition).toBeNull();
    expect(suggestion.ambiguityReason).toBe("SEVERAL_IN_CHAT");
    // Цитаты — единственное, что остаётся: агент заполняет руками и видит,
    // что именно продавец говорил.
    expect(suggestion.evidence).toEqual(["54 метра", "3 этаж"]);
  });

  it("удалённый объект продавца не блокирует разбор — объект заводят заново именно так", async () => {
    const clientId = await makeSeller("Удалили и заводят заново");
    await attachConversation(clientId, [{ role: "user", content: "2-хонага, 54 метра, 3 этаж, каробка, 450000" }]);
    await makeSellerProperty(clientId, true);
    aiReply = fullAiReply({ objectsCount: 1 });

    const suggestion = await buildPropertyDraftSuggestion(clientId);

    expect(suggestion.ambiguityReason).toBeNull();
    expect(suggestion.existingObjectsCount).toBe(0);
    expect(suggestion.rooms).toBe(2);
    expect(suggestion.areaSqm).toBe(54);
    expect(aiCalls).toHaveLength(1);
  });

  it("одна квартира и ни одного объекта в CRM — заполнение работает как раньше", async () => {
    const clientId = await makeSeller("Одна квартира");
    await attachConversation(clientId, [{ role: "user", content: "2-хонага, 54 метра, 3 этаж, каробка, 450000" }]);
    // objectsCount модель могла не вернуть вовсе — это считается одним объектом,
    // иначе починка тихо выключила бы подсказку всем.
    aiReply = fullAiReply();

    const suggestion = await buildPropertyDraftSuggestion(clientId);

    expect(suggestion.ambiguityReason).toBeNull();
    expect(suggestion.rooms).toBe(2);
    expect(suggestion.areaSqm).toBe(54);
    expect(suggestion.floor).toBe(3);
    expect(suggestion.price).toBe(450000);
    expect(suggestion.districtId).toBe(districtId);
    expect(suggestion.address).toBe("напротив кинотеатра Зебунисо");
  });
});
