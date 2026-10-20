import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { runDealStalePipeline } from "../src/lib/dealStalePipeline.js";

/**
 * КОРЕНЬ ЗАВИСШИХ КАРТОЧЕК «МОЙ ФОКУС» (владелец 18.09.2026, по фото).
 *
 * Раньше `escalateStaleDeal` не смотрела, дойдёт ли до клиента написанное
 * сообщение — задача «закройте сделку» уходила агенту одинаково и когда
 * WhatsApp-окно открыто, и когда клиент не писал уже сутки и Meta молча
 * отклонит любой свободный текст. Агент читал «напишите», пробовал, узнавал о
 * запрете только после отказа сервера — и не мог понять, почему подсказка
 * вообще была именно такой.
 *
 * Здесь проверяется РЕЗУЛЬТАТ прогона пайплайна (не внутренняя функция
 * escalateStaleDeal — она не экспортируется), потому что важен именно текст,
 * который в итоге видит агент в `Interaction.nextAction` на карточке фокуса.
 */
describe("dealStalePipeline: подсказка называет рабочий канал", () => {
  const runId = Date.now();
  const agentIds: string[] = [];
  const clientIds: string[] = [];
  const OLD = new Date(Date.now() - 40 * 86_400_000); // старше любого правдоподобного порога

  afterAll(async () => {
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.botConversation.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  });

  async function makeAgent(tag: string) {
    const agent = await prisma.agent.create({
      data: {
        fullName: `Агент застоя ${tag} ${runId}`,
        phone: `+9929${tag === "A" ? "3" : "4"}${String(runId).slice(-7)}`,
        role: "AGENT",
        passwordHash: "x",
      },
    });
    agentIds.push(agent.id);
    return agent.id;
  }

  it("окно WhatsApp закрыто (клиент не писал сутки) — подсказка говорит звонить", async () => {
    const agentId = await makeAgent("A");
    const client = await prisma.client.create({
      data: {
        fullName: `Покупатель без окна ${runId}`,
        phone: `+99295${String(runId).slice(-7)}`,
        kind: "BUYER",
        source: "WEBSITE",
        assignedAgentId: agentId,
        createdAt: OLD,
      },
    });
    clientIds.push(client.id);
    // Диалог был, но клиент не писал больше суток — окно закрыто.
    await prisma.botConversation.create({
      data: {
        channel: "WHATSAPP",
        subscriberId: `sub-closed-${runId}`,
        clientId: client.id,
        lastMessageAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
      },
    });

    await runDealStalePipeline(new Date());

    const task = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM" },
      orderBy: { createdAt: "desc" },
    });
    expect(task?.nextAction).toContain("Написать нельзя");
    expect(task?.nextAction).toContain("звоните");
  });

  it("окно WhatsApp открыто (клиент писал недавно) — подсказка молчит про звонок", async () => {
    const agentId = await makeAgent("B");
    const client = await prisma.client.create({
      data: {
        fullName: `Покупатель с окном ${runId}`,
        phone: `+99296${String(runId).slice(-7)}`,
        kind: "BUYER",
        source: "WEBSITE",
        assignedAgentId: agentId,
        createdAt: OLD,
      },
    });
    clientIds.push(client.id);
    await prisma.botConversation.create({
      data: {
        channel: "WHATSAPP",
        subscriberId: `sub-open-${runId}`,
        clientId: client.id,
        lastMessageAt: new Date(Date.now() - 60 * 60 * 1000), // час назад — окно открыто
      },
    });

    await runDealStalePipeline(new Date());

    const task = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM" },
      orderBy: { createdAt: "desc" },
    });
    expect(task?.nextAction).not.toContain("Написать нельзя");
  });
});
