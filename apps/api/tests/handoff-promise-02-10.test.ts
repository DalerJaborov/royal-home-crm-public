import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { callWhenPhrase, handoffInstruction } from "../src/lib/handoffPromise.js";

/**
 * Решение Dan 02.10.2026 («Имя и срок»): при передаче заявки бот называет агента
 * и реальный срок звонка; ночью честно говорит «завтра», а не «скоро».
 * Время задаём в UTC: Душанбе = UTC+5.
 */
const at = (dushanbeHHMM: string) => {
  const [h, m] = dushanbeHHMM.split(":").map(Number);
  return new Date(Date.UTC(2026, 9, 2, h - 5, m));
};

describe("срок звонка по рабочему окну", () => {
  // С 10.10.2026 срок — общее решение чата и голоса (ai/agencyFacts.ts::callbackPromise):
  // «сегодня» без минут (по данным 10.10 «в течение часа» держалось в половине случаев).
  it("днём, когда до конца дня больше часа, — сегодня", () => {
    expect(callWhenPhrase("09:30", "18:00", at("11:00")).ru).toBe("сегодня");
  });
  it("рано утром — сегодня после начала работы", () => {
    expect(callWhenPhrase("09:30", "18:00", at("07:10")).ru).toBe("сегодня после 09:30");
  });
  it("вечером и ночью — завтра, а не «скоро»", () => {
    expect(callWhenPhrase("09:30", "18:00", at("22:40")).ru).toBe("завтра после 09:30");
    expect(callWhenPhrase("09:30", "18:00", at("17:30")).tg).toBe("пагоҳ баъд аз соати 09:30");
  });
});

describe("указание модели называет агента, которому ушла заявка", () => {
  const runId = Date.now();
  let agentId: string;
  let clientId: string;
  let noAgentClientId: string;
  beforeAll(async () => {
    agentId = (
      await prisma.agent.create({
        data: { fullName: `Фарход Тест${runId}`, phone: `+99290${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
      })
    ).id;
    clientId = (await prisma.client.create({ data: { fullName: `Клиент ${runId}`, phone: `+99291${String(runId).slice(-7)}`, source: "INSTAGRAM", assignedAgentId: agentId } })).id;
    noAgentClientId = (await prisma.client.create({ data: { fullName: `Клиент2 ${runId}`, phone: `+99292${String(runId).slice(-7)}`, source: "INSTAGRAM" } })).id;
  });
  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: { in: [clientId, noAgentClientId] } } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
  });

  it("с агентом — его имя и срок, без «скоро»", async () => {
    const text = await handoffInstruction(clientId, at("11:00"));
    expect(text).toContain("Фарход");
    expect(text).toContain("клиенту позвонит наш агент Фарход сегодня");
    expect(text).toContain("«скоро», «прямо сейчас» и минуты не пиши");
  });

  it("ночью без агента — без имени, срок «завтра»", async () => {
    const text = await handoffInstruction(noAgentClientId, at("23:00"));
    expect(text).not.toContain("Фарход");
    expect(text).toMatch(/завтра после \d\d:\d\d/);
  });
});
