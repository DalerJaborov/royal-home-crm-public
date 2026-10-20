import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { pickAgentForPropertyByKpiAscending, pickNextAgentByKpiQueue } from "../src/leads.js";

/**
 * ПЕРЕВЁРНУТАЯ ОЧЕРЕДЬ ДЛЯ ОБЪЕКТОВ (решение владельца 11.08.2026).
 *
 * Объекты уходящего сотрудника раздаются «начиная с тех, у кого низкий KPI»:
 * объект это не начатый разговор, а материал для работы, и он нужнее тому, у кого
 * работы мало. Здесь проверяется, что перевёрнут ТОЛЬКО порядок уровней Royal
 * Score, а кольцо внутри уровня осталось прежним — иначе один слабый агент забрал
 * бы весь освободившийся фонд, и правило превратилось бы в свою противоположность.
 */

const runId = Date.now();
let strongId: string;
let strongId2: string;
let weakId: string;
let savedTierSize: number | null = null;
const clientIds: string[] = [];

beforeAll(async () => {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  savedTierSize = settings?.kpiQueueTierSize ?? null;
  await prisma.settings.update({ where: { id: "singleton" }, data: { kpiQueueTierSize: 10 } });

  strongId = (
    await prisma.agent.create({
      data: { fullName: "Сильный объектный", phone: `+992931${runId}`, role: "AGENT", passwordHash: "x", kpi: 95 },
    })
  ).id;
  strongId2 = (
    await prisma.agent.create({
      data: { fullName: "Сильный объектный 2", phone: `+992932${runId}`, role: "AGENT", passwordHash: "x", kpi: 91 },
    })
  ).id;
  weakId = (
    await prisma.agent.create({
      data: { fullName: "Слабый объектный", phone: `+992933${runId}`, role: "AGENT", passwordHash: "x", kpi: 20 },
    })
  ).id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { kpiQueueTierSize: savedTierSize ?? 10 },
  });
  await prisma.agent.deleteMany({ where: { id: { in: [strongId, strongId2, weakId] } } });
  await prisma.$disconnect();
});

/** В общей базе живут агенты сидов и соседних тестов — без их исключения на выбор
 *  влияет чужой KPI (null = 100, выше любого тестового уровня). */
async function excludeOthers(keep: string[]): Promise<string[]> {
  const others = await prisma.agent.findMany({
    where: { role: "AGENT", isActive: true, id: { notIn: keep } },
    select: { id: true },
  });
  return others.map((a) => a.id);
}

async function assign(agentId: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент очереди ${clientIds.length} ${runId}`,
      phone: `+99293${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      status: "NEW",
    },
  });
  clientIds.push(c.id);
}

describe("Объекты — с низкого Royal Score, клиенты — с высокого", () => {
  it("два правила на одних и тех же агентах дают РАЗНЫХ получателей", async () => {
    const exclude = await excludeOthers([strongId, strongId2, weakId]);
    const forProperty = await pickAgentForPropertyByKpiAscending(exclude);
    const forClient = await pickNextAgentByKpiQueue(exclude);

    // Объект — слабому: у него меньше всего работы, и это его шанс подняться.
    expect(forProperty).toBe(weakId);
    // Клиент — сильному: разговор уже начат, его нельзя ставить на паузу.
    expect([strongId, strongId2]).toContain(forClient);
  });

  it("внутри уровня кольцо сохранилось: один слабый не забирает весь фонд", async () => {
    // Оставляем только двух агентов ОДНОГО уровня (95 и 91 при tierSize=10 → оба 9),
    // чтобы порядок решало исключительно кольцо «кому дольше не назначали».
    const exclude = await excludeOthers([strongId, strongId2]);
    const first = await pickAgentForPropertyByKpiAscending(exclude);
    expect([strongId, strongId2]).toContain(first);
    await assign(first!);
    const second = await pickAgentForPropertyByKpiAscending(exclude);
    expect(second).not.toBe(first);
    expect([strongId, strongId2]).toContain(second);
  });

  it("свободных нет — возвращается пусто, а не случайный агент", async () => {
    const exclude = await excludeOthers([]);
    expect(await pickAgentForPropertyByKpiAscending(exclude)).toBeNull();
  });
});
