import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PermissionId } from "@royal-home/shared";

/**
 * Помощник «Шабнам»: поиск по ориентиру/радиусу и по Корзине (07.11.2026).
 * Классы провалов с прода: (1) «найди в корзине» — корзина не искалась; (2) «дом в стороне
 * Воданасоса до 2,5 млн» — ориентир и радиус не разбирались; (3) «Не удалось собрать ответ
 * за разумное число шагов»; (4) «ничего нет» без проверки Корзины и карточек продавцов.
 * Gemini не нужен: плагины вызываются напрямую, место подменено фиксированной точкой.
 */

const WORD = `Аш${String(Date.now()).slice(-6)}`;
const POINT = { name: "Точка теста", lat: 38.55, lng: 68.78, radiusM: 800 };

vi.mock("../src/lib/searchPlace.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/searchPlace.js")>();
  return {
    ...real,
    resolveSearchPlace: async (text: string | null | undefined) =>
      text && text.includes("ТОЧКАТЕСТ")
        ? { districtName: null, placeDistrictName: null, place: POINT, suburban: false }
        : { districtName: null, placeDistrictName: null, place: null, suburban: false },
  };
});

const { prisma } = await import("../src/db.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { partialAnswerFromResults } = await import("../src/ai/assistant/partialAnswer.js");
const { MAX_TOOL_ROUNDS } = await import("../src/ai/assistant.js");
const { landmarkTokens } = await import("../src/lib/staffPropertySearch.js");
const { createCardLinkEvidence } = await import("../src/ai/assistant/cardLinkEvidence.js");

type Actor = Parameters<NonNullable<ReturnType<typeof tool>["run"]>>[1]["actor"];
function tool(name: string) {
  const plugin = findAssistantToolPlugin(name);
  if (!plugin || plugin.level !== "A") throw new Error(`нет инструмента ${name}`);
  return plugin;
}
const call = (name: string, args: Record<string, unknown>, actor: Actor): Promise<any> => tool(name).run(args, { actor });

let agent = "";
let director = "";
const propertyIds: string[] = [];
const clientIds: string[] = [];

function actor(id: string, role: string, perms: PermissionId[]): Actor {
  return {
    id, role, canViewAllClients: perms.includes("clients.viewAll"), canViewPhone: false, canViewReports: false,
    canViewFinance: false, canViewAllDeals: false, canAssignClients: false, canEditForeignProperties: false,
    canModerate: false, canRequestChange: false, permissions: new Set<PermissionId>(perms),
  } as Actor;
}
async function makeProperty(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: { title: `Объект ${WORD}`, type: "APARTMENT", areaSqm: 100, price: 100000, currency: "USD", condition: "NEEDS_REPAIR", ...data } as never,
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  agent = await createTestAgent(`Агент места ${WORD}`);
  director = await createTestAgent(`Директор места ${WORD}`, "DIRECTOR");
  await makeProperty({ lat: 38.5505, lng: 68.7805, floor: 9, totalFloors: 16, stage: "SHELL" });
  await makeProperty({ lat: 38.62, lng: 68.9, floor: 3 });
  await makeProperty({ lat: 38.5502, lng: 68.7802, floor: 5, deletedAt: new Date(), deletedById: director, description: "коробка" });
  await makeProperty({ landmark: `рядом с ${WORD}`, floor: 7 });
  await makeProperty({ type: "HOUSE", price: 2_000_000, currency: "TJS", lat: 38.5503, lng: 68.7803, floor: null });
  const sellerId = (await prisma.client.create({ data: { fullName: `Собственник ${WORD}`, phone: `+9927${WORD.slice(2)}3`, source: "WEBSITE", kind: "SELLER", acceptedAt: new Date() } as never })).id;
  clientIds.push(sellerId);
  await makeProperty({ lat: 38.5504, lng: 68.7804, floor: 11, sellerClientId: sellerId, assignedAgentId: director });
  clientIds.push(
    (await prisma.client.create({ data: { fullName: `Продавец ${WORD}`, phone: `+9927${WORD.slice(2)}1`, source: "WEBSITE", kind: "SELLER", address: `около ${WORD}`, acceptedAt: new Date() } as never })).id,
    (await prisma.client.create({ data: { fullName: `Удалённый ${WORD}`, phone: `+9927${WORD.slice(2)}2`, source: "WEBSITE", kind: "SELLER", address: `около ${WORD}`, acceptedAt: new Date(), deletedAt: new Date() } as never })).id,
  );
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces([agent, director]);
  await prisma.$disconnect();
});

const boss = () => actor(director, "DIRECTOR", ["archive.view", "clients.viewAll", "properties.delete"]);
const rank = () => actor(agent, "AGENT", []);

describe("find_properties_by_place — ориентир и радиус", () => {
  it("ближний объект находится по радиусу, дальний — нет; расстояние в ответе", async () => {
    const res = await call("find_properties_by_place", { landmark: "около ТОЧКАТЕСТ", scope: "live" }, boss());
    expect(res.searched.placeResolved).toBe(true);
    const nearItem = res.items.find((i: any) => i.floor === 9);
    expect(nearItem?.distanceM).toBeLessThan(100);
    expect(res.items.some((i: any) => i.floor === 3)).toBe(false);
  });

  it("объект без координат находится по слову ориентира в тексте карточки", async () => {
    const res = await call("find_properties_by_place", { landmark: `у ${WORD}`, scope: "live" }, boss());
    expect(res.items.map((i: any) => i.landmark).join(" ")).toContain(WORD);
  });

  it("хавли до 2,5 млн (сомони): дом находится по ориентиру и цене", async () => {
    const res = await call("find_properties_by_place", { landmark: "в стороне ТОЧКАТЕСТ", type: "HOUSE", maxPrice: 2_500_000, currency: "TJS", scope: "live" }, boss());
    expect(res.items.length).toBe(1);
    expect(res.items[0].priceTjs).toBe(2_000_000);
  });

  it("малая сумма без валюты — вопрос о валюте, а не «ничего нет»", async () => {
    const res = await call("find_properties_by_place", { landmark: "около ТОЧКАТЕСТ", maxPrice: 2000 }, boss());
    expect(res.error).toMatch(/валюта/i);
  });

  it("«коробка»: находит стадию SHELL и слово в описании (в том числе в Корзине)", async () => {
    const res = await call("find_properties_by_place", { landmark: "около ТОЧКАТЕСТ", shell: true, scope: "both" }, boss());
    expect(res.items.some((i: any) => i.inTrash === true)).toBe(true);
    expect(res.items.some((i: any) => i.floor === 9)).toBe(true);
  });
});

// Правило Корзины изменено решением владельца 07.11.2026 (lib/trashAccess.ts): удалённые объекты —
// справка для всех; удалённые клиенты — хозяину карточки и руководству. Подробно —
// tests/ai-assistant-trash-parity.test.ts.
describe("Корзина объектов — справка для всех; клиентов — хозяину и руководству", () => {
  it("руководство видит удалённый объект в Корзине, с пометкой и датой", async () => {
    const res = await call("find_properties_by_place", { landmark: "около ТОЧКАТЕСТ", scope: "trash" }, boss());
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((i: any) => i.inTrash === true && i.deletedAt)).toBe(true);
    expect(res.searched.trashFound).toBeGreaterThan(0);
  });

  it("агент: scope=trash тоже видит удалённый объект, но вернуть чужой не может (canRestore=false)", async () => {
    const res = await call("find_properties_by_place", { landmark: "около ТОЧКАТЕСТ", scope: "trash" }, rank());
    expect(res.error).toBeUndefined();
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((i: any) => i.inTrash === true && i.canRestore === false)).toBe(true);
  });

  it("агент: scope=both ищет и в живых, и в Корзине", async () => {
    const res = await call("find_properties_by_place", { landmark: "около ТОЧКАТЕСТ", scope: "both" }, rank());
    expect(res.items.some((i: any) => i.inTrash === true)).toBe(true);
    expect(res.items.some((i: any) => i.inTrash === false)).toBe(true);
    expect(res.searched.trashNotChecked).toBeUndefined();
  });

  it("клиенты-продавцы: руководство видит всю Корзину; агент — только свои удалённые (чужих нет); по умолчанию живые", async () => {
    const live = await call("find_clients", { q: WORD, kind: "SELLER" }, boss());
    expect(live.items.every((i: any) => i.inTrash === false)).toBe(true);
    const both = await call("find_clients", { q: WORD, kind: "SELLER", scope: "both" }, boss());
    expect(both.items.some((i: any) => i.inTrash)).toBe(true);
    expect(both.items.some((i: any) => !i.inTrash)).toBe(true);
    const own = await call("find_clients", { q: WORD, scope: "trash" }, rank());
    expect(own.error).toBeUndefined();
    expect(own.items).toEqual([]);
  });
});

describe("честный ответ при нехватке шагов", () => {
  it("раундов шесть, а не четыре", () => {
    expect(MAX_TOOL_ROUNDS).toBe(6);
  });

  it("частичный результат содержит найденное и вопрос, а не «разумное число шагов»", () => {
    const text = partialAnswerFromResults([
      { name: "find_properties_by_place", result: { items: [{ code: "ОБ-000130", href: "/properties/130", address: "Ашан", price: 122000, currency: "USD", inTrash: true }] } },
    ]);
    expect(text).toContain("ОБ-000130");
    expect(text).toContain("в Корзине");
    expect(text).not.toMatch(/разумное/);
    expect(text).toMatch(/точнее/);
  });

  it("совсем пусто — просит ориентир и цену, а не отписывается", () => {
    const text = partialAnswerFromResults([{ name: "x", result: { error: "no" } }]);
    expect(text).toMatch(/ориентир/);
    expect(text).not.toMatch(/разумное/);
  });
});

describe("правки ревью 07.11", () => {
  it("«82 мкр» оставляет число и не превращается в слово «мкр», совпадающее со всем городом", () => {
    expect(landmarkTokens("около 82 мкр")).toEqual(["82"]);
    expect(landmarkTokens("91 микрорайон")).toEqual(["91"]);
    expect(landmarkTokens("в стороне Воданасоса")).toEqual(["Воданасоса"]);
  });

  it("падежная форма «у ${WORD}а» находит карточку со словом без окончания", async () => {
    const res = await call("find_properties_by_place", { landmark: `у ${WORD}а`, scope: "live" }, boss());
    expect(res.items.map((i: any) => i.landmark).join(" ")).toContain(WORD);
  });

  it("ссылки на карточки из find_properties_by_place засчитываются как подтверждённые (ответ не заменяется отпиской)", async () => {
    const res = await call("find_properties_by_place", { landmark: "около ТОЧКАТЕСТ", scope: "live" }, boss());
    const evidence = createCardLinkEvidence();
    evidence.observe("find_properties_by_place", res);
    const first = res.items[0];
    expect(evidence.validate(`Нашла: [${first.code}](${first.href})`).ok).toBe(true);
    expect(evidence.validate("Нашла: [ОБ-999999](/properties/999999)").ok).toBe(false);
  });

  it("собственник виден только тому, кому открыт контакт собственника (properties.viewOwners)", async () => {
    const withRight = await call("find_properties_by_place", { landmark: "около ТОЧКАТЕСТ", scope: "live" },
      actor(director, "DIRECTOR", ["archive.view", "properties.viewOwners", "properties.delete"]));
    expect(withRight.items.some((i: any) => i.seller?.code)).toBe(true);
    const without = await call("find_properties_by_place", { landmark: "около ТОЧКАТЕСТ", scope: "live" }, rank());
    expect(without.items.some((i: any) => i.seller)).toBe(false);
  });

  it("счётчики Корзины считаются по всему найденному, а не по обрезанной выдаче", async () => {
    const res = await call("find_properties_by_place", { landmark: "около ТОЧКАТЕСТ", scope: "both", limit: 1 }, boss());
    expect(res.items.length).toBe(1);
    expect(res.total).toBeGreaterThan(1);
    expect(res.searched.trashFound).toBeGreaterThan(0);
  });
});
