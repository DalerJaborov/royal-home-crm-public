import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { calculateDailyKPI } from "../src/kpi.js";

/** «Личный лид»: агент привёл клиента сам и заполнил карточку — KPI в плюс
 *  отдельной метрикой personalLeads (решение владельца 30.07). */

const runId = Date.now();

let agentId: string;
let emptyAgentId: string;
let districtId: string;
const clientIds: string[] = [];

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-кпи-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент личных лидов", phone: `+992958${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  emptyAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент без личных", phone: `+992957${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;

  // Личный лид с ЗАПОЛНЕННОЙ карточкой: бюджет + район + комнаты.
  clientIds.push(
    (
      await prisma.client.create({
        data: {
          fullName: `Личный заполненный ${runId}`,
          phone: `+992956${runId}`,
          source: "WALK_IN",
          assignedAgentId: agentId,
          acceptedAt: new Date(),
          isPersonalLead: true,
          budgetMax: 500000,
          desiredDistrictId: districtId,
          desiredRooms: 2,
        },
      })
    ).id
  );
  // Личный лид с ПУСТОЙ карточкой: галочка есть, данных нет — баллов не приносит.
  clientIds.push(
    (
      await prisma.client.create({
        data: {
          fullName: `Личный пустой ${runId}`,
          phone: `+992955${runId}`,
          source: "WALK_IN",
          assignedAgentId: agentId,
          acceptedAt: new Date(),
          isPersonalLead: true,
        },
      })
    ).id
  );
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, emptyAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("KPI-метрика «личные лиды»", () => {
  it("активна в день создания и считает долю заполненных карточек", async () => {
    const { breakdown } = await calculateDailyKPI(agentId, new Date());
    // Из двух личных лидов заполнен один — половина от веса 10.
    expect(breakdown.personalLeads).toEqual({ earned: 5, max: 10 });
  });

  it("у агента без личных лидов метрика не участвует в расчёте", async () => {
    const { breakdown } = await calculateDailyKPI(emptyAgentId, new Date());
    expect(breakdown.personalLeads).toBeUndefined();
  });
});
