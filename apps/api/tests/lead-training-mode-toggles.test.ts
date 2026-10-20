import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { reassignStaleLeads, penalizeMissedFirstCalls } from "../src/leads.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * «Режим обучения» (Settings.leadEscalationEnabled) УДАЛЁН ИЗ КОДА 25.09.2026
 * решением владельца — колонка в БД осталась (старый контейнер во время
 * выката читает Settings целиком), но код её больше не читает нигде. Карусель
 * теперь ВСЕГДА ведёт себя так, как раньше обещал выключенный тумблер: не
 * эскалирует руководителю по одному только числу кругов, а бесконечно
 * крутится между доступными агентами (владелец 17.09.2026, «пусть крутится») —
 * см. describe ниже. Единственный оставшийся рабочий тумблер —
 * leadReassignOnMissedCallEnabled (не позвонил вовремя → лид сразу дальше).
 */

const runId = Date.now();
let agentIds: string[] = [];
const clientIds: string[] = [];
let saved: {
  leadAcceptMinutes: number;
  leadCallMinutes: number;
  leadEscalateAfter: number;
  leadEscalationEnabled: boolean;
  leadReassignOnMissedCallEnabled: boolean;
  leadPoolAfterMinutes: number;
  workHoursStart: string;
  workHoursEnd: string;
};

async function makeAgent(name: string) {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  const a = await prisma.agent.create({
    data: { fullName: name, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role: "AGENT", passwordHash },
  });
  agentIds.push(a.id);
  return a.id;
}

async function makeUnacceptedLead(assignedAgentId: string, minutesAgo: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `Обучение-непринят ${runId}-${clientIds.length}`,
      phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
      source: "PHONE_CALL",
      assignedAgentId,
      assignedAt: new Date(Date.now() - minutesAgo * 60_000),
      acceptedAt: null,
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeAcceptedLead(assignedAgentId: string, minutesAgo: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `Обучение-непрозвон ${runId}-${clientIds.length}`,
      phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
      source: "PHONE_CALL",
      assignedAgentId,
      assignedAt: new Date(Date.now() - (minutesAgo + 5) * 60_000),
      acceptedAt: new Date(Date.now() - minutesAgo * 60_000),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      leadAcceptMinutes: true,
      leadCallMinutes: true,
      leadEscalateAfter: true,
      leadEscalationEnabled: true,
      leadReassignOnMissedCallEnabled: true,
      leadPoolAfterMinutes: true,
      workHoursStart: true,
      workHoursEnd: true,
    },
  });
  saved = {
    leadAcceptMinutes: s?.leadAcceptMinutes ?? 15,
    leadCallMinutes: s?.leadCallMinutes ?? 15,
    leadEscalateAfter: s?.leadEscalateAfter ?? 3,
    leadEscalationEnabled: s?.leadEscalationEnabled ?? true,
    leadReassignOnMissedCallEnabled: s?.leadReassignOnMissedCallEnabled ?? false,
    leadPoolAfterMinutes: s?.leadPoolAfterMinutes ?? 25,
    workHoursStart: s?.workHoursStart ?? "09:30",
    workHoursEnd: s?.workHoursEnd ?? "18:00",
  };
  // Только два агента в пуле — эскалация/wraparound проверяется быстрее: один
  // круг переназначений уже исчерпывает обоих.
  await makeAgent(`Обучение А ${runId}`);
  await makeAgent(`Обучение Б ${runId}`);
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      leadAcceptMinutes: 15,
      leadCallMinutes: 15,
      leadEscalateAfter: 1,
      // Этот файл проверяет тумблеры «режима обучения», а не пул «ничьих»
      // (см. agent-occupancy-shield.test.ts и leads.ts::penalizeMissedFirstCalls) —
      // 0 держит поведение прежним: передача при сорванном звонке остаётся
      // мгновенной, без промежуточной фазы «в пуле».
      leadPoolAfterMinutes: 0,
      // Срок первого звонка стоит вне часов раздачи (23.09.2026, closedMsBeforeDue):
      // без круглосуточного окна этот файл зелёный только днём по Душанбе.
      // Круглые сутки — это "00:00"–"24:00", а НЕ "00:00"–"23:59": минута 23:59 у
      // второго остаётся закрытой, и closedMsBeforeDue добавляет к сроку паузу —
      // тест падает одну минуту в сутки. "00:00"–"00:00" паузу тоже убирает, но
      // для isWithinDushanbeWindow пустое окно значит «никогда», и раздача лидов
      // в таком файле молча перестанет случаться. Разбор — docs/journal/2026-09-24-krugolosutochnoe-okno-24-00.md.
      workHoursStart: "00:00",
      workHoursEnd: "24:00",
    },
  });
});

afterEach(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: agentIds } } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  // По самому агенту, а не по списку его клиентов: раздача лидов могла отдать
  // нашему агенту карточку, которую этот файл не заводил (см. helpers).
  await deleteAgentsWithTraces(agentIds);
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      leadAcceptMinutes: saved.leadAcceptMinutes,
      leadCallMinutes: saved.leadCallMinutes,
      leadEscalateAfter: saved.leadEscalateAfter,
      leadEscalationEnabled: saved.leadEscalationEnabled,
      leadReassignOnMissedCallEnabled: saved.leadReassignOnMissedCallEnabled,
      leadPoolAfterMinutes: saved.leadPoolAfterMinutes,
      workHoursStart: saved.workHoursStart,
      workHoursEnd: saved.workHoursEnd,
    },
  });
  await prisma.$disconnect();
});

describe("карусель не эскалирует, пока есть кому предложить (единственное поведение с 25.09.2026)", () => {
  /**
   * Владелец 17.09.2026, дословно: «даже если клиента никто не принял — не
   * надо, пусть крутится, может кто-то да и примет». Эскалация руководителю
   * по одному только числу кругов убрана — карусель сбрасывает список уже
   * предложенных агентов и идёт на новый круг, пока хоть один агент способен
   * принимать лиды. Эскалация осталась только на настоящий тупик — см. тест
   * ниже.
   */
  it("после исчерпания кругов лид не эскалируется, а уходит на новый круг", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadEscalationEnabled: true } });
    const lead = await makeUnacceptedLead(agentIds[0], 20);
    await reassignStaleLeads();
    await prisma.client.update({ where: { id: lead.id }, data: { assignedAt: new Date(Date.now() - 20 * 60_000) } });
    await reassignStaleLeads();
    await prisma.client.update({ where: { id: lead.id }, data: { assignedAt: new Date(Date.now() - 20 * 60_000) } });
    await reassignStaleLeads();

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.escalatedAt).toBeNull();
    expect(after?.assignedAgentId).not.toBeNull();
  });
  /**
   * ОШИБКА НА ЕДИНИЦУ В ПОТОЛКЕ КАРУСЕЛИ (найдено 20.09.2026 — этот файл падал
   * в общем прогоне на чистом main). Самое первое назначение агента уже вносит
   * его в `triedAgentIds`, но `reassignCount` не увеличивает: при двух агентах
   * после одного переназначения пробованы оба, а счётчик равен единице —
   * `reassignCount >= availableAgentsCount` не срабатывает, список исключений не
   * сбрасывается, подбор агента возвращает пусто, и лид уходил руководителю с
   * текстом «свободных агентов, принимающих лиды, не осталось вовсе» при живых
   * свободных агентах. Проверяем именно ЭТОТ текст, а не только `escalatedAt`:
   * ложная причина в хронологии — половина находки.
   */
  it("все агенты уже пробованы — новый круг, а не жалоба «некому отдать»", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadEscalationEnabled: true } });
    const lead = await makeUnacceptedLead(agentIds[0], 20);
    await reassignStaleLeads();
    await prisma.client.update({ where: { id: lead.id }, data: { assignedAt: new Date(Date.now() - 20 * 60_000) } });
    await reassignStaleLeads();

    const notes = await prisma.interaction.findMany({
      where: { clientId: lead.id },
      select: { notes: true },
    });
    expect(notes.map((n) => n.notes ?? "").join("\n")).not.toContain("не осталось вовсе");
    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.escalatedAt).toBeNull();
    expect(after?.reassignCount).toBeGreaterThanOrEqual(2);
  });

  // Ветка «агентов, принимающих лиды, не осталось вовсе» (reassignment.ts,
  // !nextAgentId) не проверяется здесь отдельным тестом: база тестов общая на
  // полторы сотни файлов, поставить на паузу вообще ВСЕХ агентов в ней нельзя,
  // не сломав параллельно идущие прогоны. Ветка простая (тот же приём, что и
  // раньше при !nextAgentId) и покрыта косвенно уже существующими проверками
  // claimLead/notifyStuck в соседних файлах.
});

describe("leadReassignOnMissedCallEnabled", () => {
  it("выключено (по умолчанию) — принятый лид остаётся у того же агента", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadReassignOnMissedCallEnabled: false } });
    const lead = await makeAcceptedLead(agentIds[0], 20);
    await penalizeMissedFirstCalls();
    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentIds[0]);
    expect(after?.acceptedAt).not.toBeNull();
  });

  it("включено — лид снимается и уходит следующему агенту", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadReassignOnMissedCallEnabled: true } });
    const lead = await makeAcceptedLead(agentIds[0], 20);
    await penalizeMissedFirstCalls();
    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).not.toBe(agentIds[0]);
    expect(after?.acceptedAt).toBeNull();
  });

  it("включено + эскалация выключена — уже оштрафованный застрявший лид тоже уходит по кругу на следующем тике", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { leadReassignOnMissedCallEnabled: false, leadEscalationEnabled: false },
    });
    const lead = await makeAcceptedLead(agentIds[0], 20);
    // Сначала штрафуется и замирает по старому правилу (тумблер ещё выключен).
    await penalizeMissedFirstCalls();
    let after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentIds[0]);

    // Владелец включает тумблер задним числом — на следующем тике лид обязан
    // уйти дальше, а не остаться висеть до нового срыва звонка.
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadReassignOnMissedCallEnabled: true } });
    await penalizeMissedFirstCalls();
    after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).not.toBe(agentIds[0]);
    expect(after?.acceptedAt).toBeNull();
  });
});
