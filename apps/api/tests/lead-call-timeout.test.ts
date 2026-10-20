import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { waitForSettled } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { penalizeMissedFirstCalls } from "../src/leads.js";
import { DEFAULT_EVENT_POINTS } from "../src/lib/scoreJournal.js";

/**
 * «Не позвонил за 15 минут» (спецификация, часть 3) — без телефонии заменён на
 * «первое содержательное действие»: запись звонка в хронологии (Interaction
 * type=CALL, любая — ручная через AddInteractionModal тоже считается).
 *
 * Переработка 12.08.2026: раньше сигналом было закрытое обязательное окно «Итог
 * разговора» (PendingSummary kind="call", заводилось автоматически при принятии
 * лида) — то окно снято вместе со всем механизмом ради единого окна call_result
 * (которое, в свою очередь, заводит только телефония). Без АТС решает
 * collectFirstCallFacts по Interaction type=CALL — она телефонии не требует,
 * recordingDurationSec у ручной записи просто null (см. lib/leads.ts,
 * decideFirstCall).
 */

const runId = Date.now();
let agentAId: string;
let agentBId: string;
const clientIds: string[] = [];
let savedLeadCallMinutes: number;
let savedEscalateAfter: number;
let savedHours: { workHoursStart: string; workHoursEnd: string } | null = null;

async function makeAcceptedLead(fullName: string, minutesAgo: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `${fullName} ${runId}`,
      phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
      source: "PHONE_CALL",
      assignedAgentId: agentAId,
      assignedAt: new Date(Date.now() - minutesAgo * 60_000),
      acceptedAt: new Date(Date.now() - minutesAgo * 60_000),
    },
  });
  clientIds.push(c.id);
  return c;
}

/** Запись звонка в хронологии — тем же способом, что ручной AddInteractionModal,
 *  внутри окна [acceptedAt, acceptedAt + leadCallMinutes]. */
async function recordCallAttempt(clientId: string, agentId: string, createdMinutesAgo: number) {
  return prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "CALL",
      notes: "Позвонил клиенту",
      createdAt: new Date(Date.now() - createdMinutesAgo * 60_000),
    },
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentAId = (
    await prisma.agent.create({
      data: { fullName: "Агент А не звонит", phone: `+992970${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentBId = (
    await prisma.agent.create({
      data: { fullName: "Агент Б свободный", phone: `+992971${runId}`, role: "AGENT", passwordHash },
    })
  ).id;

  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { leadCallMinutes: true, leadEscalateAfter: true },
  });
  savedLeadCallMinutes = s?.leadCallMinutes ?? 15;
  savedEscalateAfter = s?.leadEscalateAfter ?? 3;
  savedHours = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { workHoursStart: true, workHoursEnd: true },
  });
  // Срок первого звонка стоит вне часов раздачи (23.09.2026, closedMsBeforeDue):
  // без круглосуточного окна этот файл зелёный только днём по Душанбе.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { leadCallMinutes: 15, workHoursStart: "00:00", workHoursEnd: "24:00" },
  });
});

afterEach(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: agentAId } });
});

afterAll(async () => {
  // Чистим записи и по клиентам, и по агентам этого файла: агенты лежат в общей базе,
  // и очередь раздачи из соседнего файла (pickByKpiQueue берёт агентов из БД) успевает
  // повесить на них свою запись. Без второго условия уборка падала по внешнему ключу.
  await prisma.interaction.deleteMany({
    where: { OR: [{ clientId: { in: clientIds } }, { agentId: { in: [agentAId, agentBId] } }] },
  });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId] } } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { leadCallMinutes: savedLeadCallMinutes, leadEscalateAfter: savedEscalateAfter, ...(savedHours ?? {}) },
  });
  await prisma.$disconnect();
});

describe("Не позвонил за 15 минут", () => {
  it("звонок записан вовремя — штрафа нет", async () => {
    const lead = await makeAcceptedLead("Позвонил вовремя", 20);
    await recordCallAttempt(lead.id, agentAId, 20);

    // Не привязываемся к глобальному счётчику penalized — в базе теста могут быть
    // и другие просроченные кандидаты из соседних файлов; важно только, что ЭТОТ
    // клиент и этот агент не пострадали.
    await penalizeMissedFirstCalls();
    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentAId);
    const event = await prisma.royalScoreEvent.findFirst({ where: { agentId: agentAId, kind: "call_15min_missed" } });
    expect(event).toBeNull();
  });

  it("звонок не записан — штраф, но лид остаётся у того же агента", async () => {
    const lead = await makeAcceptedLead("Не позвонил", 20);

    const { penalized } = await penalizeMissedFirstCalls();
    expect(penalized).toBeGreaterThanOrEqual(1);

    const event = await prisma.royalScoreEvent.findFirst({
      where: { agentId: agentAId, sourceId: { startsWith: `call-missed-${lead.id}-` } },
    });
    expect(event).not.toBeNull();
    expect(event?.kind).toBe("call_15min_missed");
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.call_15min_missed);

    // Принятый лид больше НИКОГДА не переназначается автоматически (решение
    // владельца 18.08.2026) — штраф остаётся, но карточка не уходит другому
    // агенту и acceptedAt не сбрасывается.
    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentAId);
    expect(after?.acceptedAt).not.toBeNull();
  });

  it("агент заморожен — его принятый лид не трогается и штрафа нет (владелец 23.09.2026)", async () => {
    const lead = await makeAcceptedLead("Заморожен до звонка", 20);
    await prisma.agent.update({ where: { id: agentAId }, data: { frozenAt: new Date(), frozenReason: "Отпуск" } });
    try {
      await penalizeMissedFirstCalls();
      const after = await prisma.client.findUnique({ where: { id: lead.id } });
      expect(after?.assignedAgentId).toBe(agentAId);
      expect(after?.escalatedAt).toBeNull();
      const event = await prisma.royalScoreEvent.findFirst({
        where: { agentId: agentAId, sourceId: { startsWith: `call-missed-${lead.id}-` } },
      });
      expect(event).toBeNull();
    } finally {
      await prisma.agent.update({ where: { id: agentAId }, data: { frozenAt: null, frozenReason: null } });
      // Лид остаётся просроченным — следующие тесты файла его не ждут.
      await prisma.client.update({ where: { id: lead.id }, data: { deletedAt: new Date() } });
    }
  });

  it("принят меньше 15 минут назад — ещё рано, штрафа нет", async () => {
    const lead = await makeAcceptedLead("Только что принял", 5);

    await penalizeMissedFirstCalls();
    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentAId);
  });

  it("SYSTEM-запись о сорванном звонке пишется ОДИН раз, даже при многих тиках подряд", async () => {
    /**
     * Живой случай 13.08.2026: эскалация повторялась на КАЖДОМ тике крона (раз в
     * пять минут), и хронология клиента забивалась часами одинаковых записей.
     * После 18.08.2026 (принятый лид больше не переназначается и не эскалируется
     * автоматически — см. penalizeMissedFirstCalls) кандидат остаётся в выборке
     * на каждом тике бесконечно, так что дедуп теперь держится на sourceId балла:
     * если он уже записан, второй раз ни балл, ни SYSTEM-запись, ни пуш не идут.
     */
    const lead = await makeAcceptedLead("Не звонит долго", 20);

    await penalizeMissedFirstCalls();
    await penalizeMissedFirstCalls();
    await penalizeMissedFirstCalls();

    const notes = await prisma.interaction.count({
      where: { clientId: lead.id, type: "SYSTEM", notes: { contains: "автоматической передачи больше нет" } },
    });
    expect(notes).toBe(1);

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentAId);
    expect(after?.escalatedAt).toBeNull();
  });

  it("карточка с acceptedAt два дня назад не попадает в выборку вовсе — окно кандидатов (17.09.2026)", async () => {
    /**
     * Живой случай 17.09.2026: ручной возврат старой карточки в работу
     * (`revert-orphan-sellers`, `revert-carousel`) переставил `acceptedAt` на
     * «сейчас» месячным карточкам. Нижняя граница окна (`firstCallCandidateWindow`)
     * не даёт карточке ТАКОГО возраста снова попасть в выборку вообще — здесь
     * `acceptedAt` не тронут переносом (это симулирует «до ручного возврата»
     * функция не видит карточку совсем), проверяем именно это, а не решение
     * decideFirstCall.
     */
    const lead = await makeAcceptedLead("Очень старая карточка", 2 * 24 * 60);

    await penalizeMissedFirstCalls();

    const event = await prisma.royalScoreEvent.findFirst({
      where: { agentId: agentAId, sourceId: { startsWith: `call-missed-${lead.id}-` } },
    });
    expect(event).toBeNull();
    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentAId);
    expect(after?.escalatedAt).toBeNull();
  });

  it("карточка с давним разговором ДРУГОГО агента не трогается — первый звонок уже состоялся (17.09.2026)", async () => {
    /**
     * Ровно случай прода 17.09.2026: карточка отработана месяц назад (разговор
     * состоялся), ручной скрипт переставил acceptedAt на «сейчас» (здесь —
     * на 20 минут назад, чтобы попасть под верхнюю границу cutoff). Разговор был
     * ДО этого acceptedAt и с ДРУГИМ агентом (перевод карточки между агентами) —
     * collectPriorConversationClientIds обязана исключить карточку целиком, ещё
     * до decideFirstCall.
     */
    const lead = await makeAcceptedLead("Уже разговаривали, вернули в работу", 20);
    const call = await prisma.interaction.create({
      data: {
        clientId: lead.id,
        agentId: agentBId,
        type: "CALL",
        notes: "Разговор до ручного возврата в работу",
        recordingDurationSec: 90,
      },
    });
    // 80 минут назад — раньше текущего acceptedAt (20 минут назад).
    await prisma.interaction.update({
      where: { id: call.id },
      data: { createdAt: new Date(Date.now() - 80 * 60_000) },
    });

    await penalizeMissedFirstCalls();

    const event = await prisma.royalScoreEvent.findFirst({
      where: { agentId: agentAId, sourceId: { startsWith: `call-missed-${lead.id}-` } },
    });
    expect(event).toBeNull();
    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentAId);
    expect(after?.escalatedAt).toBeNull();
  });

  it("повторный тик по уже снятому лиду не штрафует второй раз", async () => {
    const lead = await makeAcceptedLead("Снят один раз", 20);
    await penalizeMissedFirstCalls();

    const before = await waitForSettled(() => prisma.royalScoreEvent.count({ where: { agentId: agentAId, kind: "call_15min_missed" } }));
    // Штраф уже записан — sourceId (call-missed-<id>-<acceptedAt>) не меняется,
    // раз acceptedAt больше не сбрасывается, поэтому повторный тик не платит второй раз.
    await penalizeMissedFirstCalls();
    const after = await waitForSettled(() => prisma.royalScoreEvent.count({ where: { agentId: agentAId, kind: "call_15min_missed" } }));
    expect(after).toBe(before);
  });
});
