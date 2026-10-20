import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * СМЕНА ТИПА КЛИЕНТА ПРИ ПОВТОРНОМ ОБРАЩЕНИИ (владелец 19.08.2026).
 *
 * Телефон уникален и всегда находит ОДНУ и ту же карточку — но раньше kind
 * никогда не трогался при повторном обращении. Продавец полгода назад, теперь
 * пишет как покупатель — карточка молча оставалась «Продавец».
 */

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент смены типа", phone: `+992${runId}891`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

beforeEach(() => {
  sendPushToAgent.mockClear();
  sendPushToAgents.mockClear();
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Смена типа клиента (продавец → покупатель) при повторном обращении", () => {
  it("kind обновляется, ставится dualIntent, новые предпочтения покупателя применяются", async () => {
    const phone = `+992${runId}892`;
    const first = await createLeadFromChannel({
      fullName: "Экс-продавец",
      phone,
      source: "INSTAGRAM",
      kind: "SELLER",
      requirementsNotes: "Продаю квартиру на Сино, 3 комнаты",
    });
    clientIds.push(first.clientId);
    await prisma.client.update({ where: { id: first.clientId }, data: { assignedAgentId: agentId } });
    await settle();
    sendPushToAgent.mockClear();

    const district = await prisma.district.create({ data: { name: `Тест-район-смена-${runId}` } });
    const second = await createLeadFromChannel({
      fullName: "Экс-продавец",
      phone,
      source: "WHATSAPP",
      kind: "BUYER",
      budgetMin: 30000,
      budgetMax: 40000,
      desiredDistrictId: district.id,
      desiredRooms: 2,
      requirementsNotes: "Хочу купить 2-комнатную",
    });
    expect(second.created).toBe(false);
    expect(second.clientId).toBe(first.clientId);

    const updated = await prisma.client.findUnique({ where: { id: first.clientId } });
    expect(updated?.kind).toBe("BUYER");
    expect(updated?.dualIntent).toBe(true);
    expect(Number(updated?.budgetMin)).toBe(30000);
    expect(Number(updated?.budgetMax)).toBe(40000);
    expect(updated?.desiredDistrictId).toBe(district.id);
    expect(updated?.desiredRooms).toBe(2);
    expect(updated?.requirementsNotes).toBe("Хочу купить 2-комнатную");

    const note = await prisma.interaction.findFirst({
      where: { clientId: first.clientId, type: "SYSTEM", notes: { contains: "Тип обращения изменён" } },
      orderBy: { createdAt: "desc" },
    });
    expect(note).not.toBeNull();
    expect(note?.notes).toContain("Продавец");
    expect(note?.notes).toContain("Покупатель");
    expect(note?.notes).toContain("Продаю квартиру на Сино");

    await settle();
    const call = sendPushToAgent.mock.calls.find(([id]) => id === agentId);
    expect(call).toBeDefined();
    const payload = call![1] as Record<string, string>;
    expect(payload.title).toContain("другим запросом");

    await prisma.district.delete({ where: { id: district.id } });
  });

  it("обратный переход (покупатель → продавец) НЕ стирает поля покупателя, ставит dualIntent (владелец 06.09.2026)", async () => {
    const phone = `+992${runId}893`;
    const district = await prisma.district.create({ data: { name: `Тест-район-обратно-${runId}` } });
    const first = await createLeadFromChannel({
      fullName: "Экс-покупатель",
      phone,
      source: "INSTAGRAM",
      kind: "BUYER",
      budgetMin: 20000,
      budgetMax: 25000,
      desiredDistrictId: district.id,
      desiredRooms: 1,
    });
    clientIds.push(first.clientId);

    await createLeadFromChannel({
      fullName: "Экс-покупатель",
      phone,
      source: "WHATSAPP",
      kind: "SELLER",
      requirementsNotes: "Хочу продать дом",
    });

    const updated = await prisma.client.findUnique({ where: { id: first.clientId } });
    expect(updated?.kind).toBe("SELLER");
    // Живой случай: продаёт старую квартиру и одновременно всё ещё хочет купить
    // новую — данные покупателя больше не стираются молча, только ставится dualIntent.
    expect(updated?.dualIntent).toBe(true);
    expect(Number(updated?.budgetMin)).toBe(20000);
    expect(Number(updated?.budgetMax)).toBe(25000);
    expect(updated?.desiredDistrictId).toBe(district.id);
    expect(updated?.desiredRooms).toBe(1);

    await prisma.district.delete({ where: { id: district.id } });
  });

  it("тот же тип обращения — kind не трогается, обычная заметка без смены типа", async () => {
    const phone = `+992${runId}894`;
    const first = await createLeadFromChannel({
      fullName: "Постоянный покупатель",
      phone,
      source: "INSTAGRAM",
      kind: "BUYER",
      budgetMin: 10000,
    });
    clientIds.push(first.clientId);

    await createLeadFromChannel({
      fullName: "Постоянный покупатель",
      phone,
      source: "WHATSAPP",
      kind: "BUYER",
    });

    const updated = await prisma.client.findUnique({ where: { id: first.clientId } });
    expect(updated?.kind).toBe("BUYER");
    expect(updated?.dualIntent).toBe(false);
    // budgetMin не был передан во втором обращении — остаётся прежним, не обнуляется.
    expect(Number(updated?.budgetMin)).toBe(10000);

    const note = await prisma.interaction.findFirst({
      where: { clientId: first.clientId, type: "SYSTEM", notes: { contains: "Тип обращения изменён" } },
    });
    expect(note).toBeNull();
  });
});
