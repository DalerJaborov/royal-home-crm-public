import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { agentsOnShowingOrCall } from "../src/lib/agentOccupancyShield.js";
import { resetCalls } from "../src/lib/telephony/callTracker.js";

/**
 * E4 глубокой проверки 02.10.2026: щит занятости в раздаче из worker (раздача,
 * переназначение протухших лидов) смотрел только в карту живых звонков — а в
 * worker она пуста. Агент 20 минут говорит с покупателем через CRM, тик
 * переназначения отдаёт ему новый лид с таймером первого касания.
 *
 * Теперь признак живого звонка есть и в базе: заготовка звонка из CRM без
 * итога (её текст finishCall заменяет исходом) — свежая, значит разговор идёт.
 * Карта процесса здесь пуста (resetCalls) — ровно как в worker.
 */

const runId = Date.now();
let agentId: string;
let clientId: string;
let savedEnabled: boolean | null = null;

beforeAll(async () => {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { agentOccupancyShieldEnabled: true } });
  savedEnabled = s?.agentOccupancyShieldEnabled ?? true;
  await prisma.settings.update({ where: { id: "singleton" }, data: { agentOccupancyShieldEnabled: true } });
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент в разговоре ${runId}`, phone: `+992973${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент разговора ${runId}`, phone: `+992974${runId}`, source: "PHONE_CALL" },
    })
  ).id;
  resetCalls();
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { agentOccupancyShieldEnabled: savedEnabled ?? true } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

async function stub(notes: string, minutesAgo: number) {
  return prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes, createdAt: new Date(Date.now() - minutesAgo * 60_000) },
  });
}

describe("щит занятости видит живой звонок из базы, а не только из памяти процесса", () => {
  it("заготовка «Звонок инициирован из CRM» 15 минут назад — агент занят", async () => {
    const i = await stub("Звонок инициирован из CRM", 15);
    try {
      expect((await agentsOnShowingOrCall([agentId])).has(agentId)).toBe(true);
    } finally {
      await prisma.interaction.delete({ where: { id: i.id } });
    }
  });

  it("автоматический обратный звонок без итога — агент занят", async () => {
    const i = await stub("Обратный звонок по просьбе клиента: цена квартиры", 5);
    try {
      expect((await agentsOnShowingOrCall([agentId])).has(agentId)).toBe(true);
    } finally {
      await prisma.interaction.delete({ where: { id: i.id } });
    }
  });

  it("звонок с итогом — агент свободен", async () => {
    const i = await stub("Звонок через CRM, разговор 3:10", 5);
    try {
      expect((await agentsOnShowingOrCall([agentId])).has(agentId)).toBe(false);
    } finally {
      await prisma.interaction.delete({ where: { id: i.id } });
    }
  });

  it("заготовка многочасовой давности — не держит агента занятым вечно", async () => {
    const i = await stub("Звонок инициирован из CRM", 5 * 60);
    try {
      expect((await agentsOnShowingOrCall([agentId])).has(agentId)).toBe(false);
    } finally {
      await prisma.interaction.delete({ where: { id: i.id } });
    }
  });
});
