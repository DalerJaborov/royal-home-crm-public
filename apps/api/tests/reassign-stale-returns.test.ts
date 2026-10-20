import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { reassignStaleReturns } from "../src/leads.js";

/**
 * Таймер возврата (мозговой штурм 21.08.2026, «рубеж 3») — ПЕРЕПИСАНО 17.09.2026
 * (Р-5, закон о владении клиентом, `docs/audit/lead-ownership-17-09.md` §4):
 * передачи по этому таймеру больше нет вовсе. Вернувшийся клиент навсегда
 * остаётся у прежнего агента; по достижении `returnAcceptDueAt` — напоминание
 * ему самому — только задача в делах (пуш и строка в ленте убраны 02.10.2026),
 * а если не тронул ЕЩЁ `lostReturnAcceptMinutes`
 * сверх срока — эскалация руководителю (`escalateInsteadOfTransfer`). `acceptedAt`
 * и `assignedAgentId` таймер теперь не трогает никогда.
 *
 * «Тронул» по-прежнему проверяется адверсариально (21.08.2026): STATUS_CHANGE от
 * автостатуса и CALL от автоответчика (voicemail, «технический автор») пишутся
 * БЕЗ участия агента и не должны сниматься с них.
 */

const runId = Date.now();
let districtId: string;
let agentId: string;
let supervisorId: string;
const clientIds: string[] = [];

async function makeReturnedClient(dueAt: Date) {
  const c = await prisma.client.create({
    data: {
      fullName: `Вернувшийся ${runId}-${clientIds.length}`,
      phone: `+992908${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      returnedAt: new Date(Date.now() - 3 * 60 * 60_000),
      returnAcceptDueAt: dueAt,
    },
  });
  clientIds.push(c.id);
  return c;
}

let savedWorkHours: { workHoursStart: string; workHoursEnd: string } | null = null;

beforeAll(async () => {
  // Срок возврата считается в рабочих минутах (B4, решение владельца 02.10.2026):
  // этот файл проверяет не ночь, а сами пороги — окно раздачи фиксируем на сутки,
  // иначе вечерний прогон не досчитал бы «ещё minutes сверх срока».
  const s = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
  savedWorkHours = { workHoursStart: s.workHoursStart, workHoursEnd: s.workHoursEnd };
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00" } });
  const passwordHash = await bcrypt.hash("x", 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-возврат-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент возврата А", phone: `+992966${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  // Руководитель — получатель эскалации (findAgentsWithPermission("clients.assign")).
  const supervisor = await prisma.agent.create({
    data: { fullName: "Руководитель возврата", phone: `+992968${runId}`, role: "DIRECTOR", passwordHash },
  });
  supervisorId = supervisor.id;
});

afterAll(async () => {
  if (savedWorkHours) await prisma.settings.update({ where: { id: "singleton" }, data: savedWorkHours });
  await prisma.incomingCall.deleteMany({ where: { phone: { contains: `${runId}` } } });
  await prisma.notification.deleteMany({ where: { agentId: { in: [agentId, supervisorId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, supervisorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("reassignStaleReturns — Р-5: клиент остаётся, передачи по таймеру больше нет", () => {
  it("срок наступил, автостатус (STATUS_CHANGE) не в счёт — агенту уходит напоминание, владелец тот же", async () => {
    const client = await makeReturnedClient(new Date(Date.now() - 60_000));
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "STATUS_CHANGE",
        notes: "Статус изменён автоматически: «Новый» → «Холодный»",
      },
    });

    const { reminded } = await reassignStaleReturns();
    expect(reminded).toBeGreaterThanOrEqual(1);

    const after = await prisma.client.findUnique({
      where: { id: client.id },
      select: { assignedAgentId: true, acceptedAt: true },
    });
    // Р-5: владелец НЕ меняется и acceptedAt не трогается — только напоминание.
    expect(after?.assignedAgentId).toBe(agentId);
    expect(after?.acceptedAt).not.toBeNull();

    // 02.10.2026: пуша и строки в ленте нет — только задача в делах.
    const notification = await prisma.notification.findFirst({
      where: { agentId, tag: { contains: client.id } },
    });
    expect(notification).toBeNull();
    const tasks = await prisma.interaction.count({
      where: { clientId: client.id, nextAction: "Связаться с вернувшимся клиентом" },
    });
    expect(tasks).toBe(1);
  });

  it("два тика подряд — задача «Связаться с вернувшимся клиентом» создаётся ОДИН раз", async () => {
    const client = await makeReturnedClient(new Date(Date.now() - 60_000));

    await reassignStaleReturns();
    await reassignStaleReturns();

    const tasks = await prisma.interaction.count({
      where: { clientId: client.id, nextAction: "Связаться с вернувшимся клиентом" },
    });
    expect(tasks).toBe(1);
    const warnings = await prisma.notification.count({ where: { agentId, tag: { contains: client.id } } });
    expect(warnings).toBe(0);
  });

  it("срок ещё не вышел, но прошло больше 75% — предупреждения агенту нет", async () => {
    // returnedAt = -3 ч, срок через 30 мин: раньше тут уходил пуш «Вернувшийся клиент ждёт вас».
    const client = await makeReturnedClient(new Date(Date.now() + 30 * 60_000));

    await reassignStaleReturns();

    const notification = await prisma.notification.findFirst({ where: { agentId, tag: { contains: client.id } } });
    expect(notification).toBeNull();
  });

  it("входящий звонок «технического автора» (voicemail) не в счёт — напоминание всё равно уходит", async () => {
    const client = await makeReturnedClient(new Date(Date.now() - 60_000));
    const interaction = await prisma.interaction.create({
      data: { clientId: client.id, agentId, type: "CALL", notes: "Голосовое от автоответчика" },
    });
    await prisma.incomingCall.create({
      data: { channelId: `test-${runId}-${client.id}`, phone: client.phone, interactionId: interaction.id },
    });

    const { reminded } = await reassignStaleReturns();
    expect(reminded).toBeGreaterThanOrEqual(1);

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { assignedAgentId: true } });
    expect(after?.assignedAgentId).toBe(agentId);
  });

  it("настоящий звонок агента (не входящий) снимает таймер — карточку не эскалирует и не напоминает", async () => {
    const client = await makeReturnedClient(new Date(Date.now() - 60_000));
    await prisma.interaction.create({
      data: { clientId: client.id, agentId, type: "CALL", recordingDurationSec: 40, notes: "Агент позвонил сам" },
    });

    const { cleared } = await reassignStaleReturns();
    expect(cleared).toBeGreaterThanOrEqual(1);

    const after = await prisma.client.findUnique({
      where: { id: client.id },
      select: { assignedAgentId: true, returnAcceptDueAt: true },
    });
    expect(after?.assignedAgentId).toBe(agentId);
    expect(after?.returnAcceptDueAt).toBeNull();
  });

  it("срок ещё не наступил — карточку не трогает", async () => {
    const client = await makeReturnedClient(new Date(Date.now() + 60 * 60_000));
    await reassignStaleReturns();
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { assignedAgentId: true } });
    expect(after?.assignedAgentId).toBe(agentId);
  });

  it("не тронул ещё lostReturnAcceptMinutes сверх срока — эскалация руководителю, владелец тот же", async () => {
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { lostReturnAcceptMinutes: true } });
    const minutes = settings?.lostReturnAcceptMinutes ?? 120;
    // Срок наступил ДАВНО — на minutes+5 минут раньше сейчас, чтобы второй порог
    // (ещё minutes сверх returnAcceptDueAt) тоже был уже пройден.
    const client = await makeReturnedClient(new Date(Date.now() - (minutes + 5) * 60_000));

    const { escalated } = await reassignStaleReturns();
    expect(escalated).toBeGreaterThanOrEqual(1);

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { assignedAgentId: true } });
    expect(after?.assignedAgentId).toBe(agentId); // эскалация, не передача — владелец тот же

    const escalation = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { startsWith: "Автопередача запрещена законом П-3" } },
    });
    expect(escalation).not.toBeNull();
  });

  it("агент ответил клиенту в переписке — таймер снят, без напоминания (23.09.2026, №22)", async () => {
    // Сообщение агента не ложится отдельной записью в хронологию — оно в
    // переписке и в отметке lastAgentAttemptAt. Таймер видел только записи и
    // считал клиента «не тронутым», напоминал и эскалировал каждый день.
    const client = await makeReturnedClient(new Date(Date.now() - 60_000));
    await prisma.client.update({ where: { id: client.id }, data: { lastAgentAttemptAt: new Date(Date.now() - 30 * 60_000) } });

    await reassignStaleReturns();

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { returnAcceptDueAt: true } });
    expect(after?.returnAcceptDueAt).toBeNull();
    const reminder = await prisma.interaction.findFirst({
      where: { clientId: client.id, nextAction: "Связаться с вернувшимся клиентом" },
    });
    expect(reminder).toBeNull();
  });

  it("после эскалации руководителю таймер снят — решение за человеком, а не ежедневный повтор (23.09.2026, №22)", async () => {
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { lostReturnAcceptMinutes: true } });
    const minutes = settings?.lostReturnAcceptMinutes ?? 120;
    const client = await makeReturnedClient(new Date(Date.now() - (minutes + 5) * 60_000));

    await reassignStaleReturns();

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { returnAcceptDueAt: true, assignedAgentId: true } });
    expect(after?.assignedAgentId).toBe(agentId);
    expect(after?.returnAcceptDueAt).toBeNull();
  });
});
