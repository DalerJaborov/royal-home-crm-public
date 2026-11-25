import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PermissionId } from "@royal-home/shared";

/**
 * Помощница: «от цирка до автоцентра» — полоса между двумя ориентирами (24.11.2026).
 * Реальный случай: покупателю нужна квартира «тарафи цирк то автоцентра», а инструмент искал вокруг
 * одной точки и по-отдельности «Автоцентр» и «Цирк». Ориентира «автоцентр» на карте нет — это надо
 * сказать прямо, а не искать молча «по тексту». Место подменено фиксированными точками.
 */
const WORD = `Кр${String(Date.now()).slice(-6)}`;
const POINTS: Record<string, { name: string; lat: number; lng: number; radiusM: number }> = {
  ЦИРКТЕСТ: { name: "Цирк теста", lat: 38.56, lng: 68.78, radiusM: 500 },
  ПАРКТЕСТ: { name: "Парк теста", lat: 38.56, lng: 68.82, radiusM: 500 },
};

vi.mock("../src/lib/searchPlace.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/searchPlace.js")>();
  return {
    ...real,
    resolveSearchPlace: async (text: string | null | undefined) => {
      const key = Object.keys(POINTS).find((k) => text?.includes(k));
      return { districtName: null, placeDistrictName: null, place: key ? POINTS[key] : null, suburban: false };
    },
  };
});

const { prisma } = await import("../src/db.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

type Actor = Parameters<NonNullable<ReturnType<typeof tool>["run"]>>[1]["actor"];
function tool(name: string) {
  const plugin = findAssistantToolPlugin(name);
  if (!plugin || plugin.level !== "A") throw new Error(`нет инструмента ${name}`);
  return plugin;
}
const call = (args: Record<string, unknown>, a: Actor): Promise<any> => tool("find_properties_by_place").run(args, { actor: a });

let agent = "";
const propertyIds: string[] = [];
const actor = (): Actor =>
  ({ id: agent, role: "AGENT", canViewAllClients: false, canViewPhone: false, canViewReports: false, canViewFinance: false,
    canViewAllDeals: false, canAssignClients: false, canEditForeignProperties: false, canModerate: false, canRequestChange: false,
    permissions: new Set<PermissionId>() }) as Actor;
async function makeProperty(data: Record<string, unknown>) {
  const p = await prisma.property.create({
    data: { title: `Объект ${WORD}`, type: "APARTMENT", areaSqm: 40, price: 50000, currency: "USD", condition: "GOOD", ...data } as never,
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  agent = await createTestAgent(`Агент полосы ${WORD}`);
  // Линия идёт по 38.56 с запада на восток (3,5 км).
  await makeProperty({ lat: 38.5602, lng: 68.8, floor: 1 }); // на линии, в середине
  await makeProperty({ lat: 38.5636, lng: 68.8, floor: 2 }); // ~400 м от линии
  await makeProperty({ lat: 38.6, lng: 68.8, floor: 3 }); // ~4,4 км — вне полосы даже после расширения
  await makeProperty({ lat: 38.56, lng: 68.9, floor: 4 }); // за концом линии
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces([agent]);
  await prisma.$disconnect();
});

describe("find_properties_by_place — «от А до Б»", () => {
  it("два ориентира: объекты в полосе, ближе к линии выше; дальние и за концом не попадают", async () => {
    const res = await call({ landmarkFrom: "ЦИРКТЕСТ", landmarkTo: "ПАРКТЕСТ", scope: "live", type: "APARTMENT" }, actor());
    const floors = res.items.map((i: any) => i.floor);
    expect(floors).toEqual([1, 2]);
    expect(res.items[0].distanceM).toBeLessThan(res.items[1].distanceM);
    expect(res.searched.corridor.widthM).toBeGreaterThanOrEqual(800);
    expect(res.searched.corridor.missing).toEqual([]);
  });

  it("фраза «от X до Y» в landmark разбирается так же", async () => {
    const res = await call({ landmark: "от ЦИРКТЕСТ до ПАРКТЕСТ", scope: "live" }, actor());
    expect(res.items.map((i: any) => i.floor)).toEqual([1, 2]);
  });

  it("одного ориентира нет на карте: прямо сказано какого, поиск только вокруг найденного, не «полоса»", async () => {
    const res = await call({ landmarkFrom: "ЦИРКТЕСТ", landmarkTo: "автоцентра", radiusM: 2500, scope: "live" }, actor());
    expect(res.searched.corridor.missing).toEqual(["автоцентра"]);
    expect(res.searched.corridor.note).toMatch(/нет на карте/);
    expect(res.searched.corridor.note).toMatch(/справочнике/);
    expect(res.searched.corridor.widthM).toBeNull();
    expect(res.items.length).toBeGreaterThan(0);
  });

  it("нет обоих: ошибка с названиями, без молчаливого поиска по тексту", async () => {
    const res = await call({ landmark: "от Нигдетеста до Нигдетеста2", scope: "live" }, actor());
    expect(res.error).toMatch(/нет на карте/);
    expect(res.items).toBeUndefined();
  });
});
