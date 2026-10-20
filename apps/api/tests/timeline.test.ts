import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { logTimeline, logTimelineMany } from "../src/lib/timeline.js";
import { waitForSettled } from "./helpers/waitFor.js";

/**
 * lib/timeline.ts — единственная точка записи Interaction (задание Б1,
 * 17.09.2026, П-10, docs/audit/lead-ownership-17-09.md §2). Проверяем ровно
 * то, от чего зависит закон: actorKind/agentId/subjectAgentId сочетаются
 * правильно для каждого вида актора, и `[source]` не дублируется.
 */

const runId = Date.now();
let agentAId = "";
let agentBId = "";
let clientId = "";

beforeAll(async () => {
  const [a, b] = await Promise.all([
    prisma.agent.create({
      data: { fullName: `Агент А ${runId}`, phone: `+99291${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
    }),
    prisma.agent.create({
      data: { fullName: `Агент Б ${runId}`, phone: `+99292${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
    }),
  ]);
  agentAId = a.id;
  agentBId = b.id;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент таймлайна ${runId}`,
      phone: `+99293${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agentAId,
    },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId] } } });
});

describe("logTimeline — actorKind/agentId/subjectAgentId", () => {
  it("kind agent: agentId заполнен, subjectAgentId пуст, notes без префикса", async () => {
    const { id } = await logTimeline({
      clientId,
      actor: { kind: "agent", agentId: agentAId },
      type: "CALL",
      notes: "Позвонил клиенту",
    });
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id } });
    expect(row.actorKind).toBe("AGENT");
    expect(row.agentId).toBe(agentAId);
    expect(row.subjectAgentId).toBeNull();
    expect(row.notes).toBe("Позвонил клиенту");
  });

  it("human author and explicit task assignee remain distinct without impersonating the assignee", async () => {
    const { id } = await logTimeline({ clientId, actor: { kind: "agent", agentId: agentAId, subjectAgentId: agentBId },
      type: "SYSTEM", notes: "Agree another showing date", nextAction: "Contact client", nextActionDate: new Date() });
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id } });
    expect(row.actorKind).toBe("AGENT");
    expect(row.agentId).toBe(agentAId);
    expect(row.subjectAgentId).toBe(agentBId);
    expect(row.subjectAgentId ?? row.agentId).toBe(agentBId);
  });

  it("kind system: agentId ВСЕГДА null, subjectAgentId — держатель, notes идёт как передано (без автопрефикса)", async () => {
    // Автопрефикс `[source]` убран из logTimeline 17.09.2026 (живой регресс:
    // ломал дедуп-проверки notes.startsWith(...) в других модулях — см.
    // docstring над `logTimeline` в lib/timeline.ts). Кто хочет тег в тексте,
    // пишет его сам — так и делает services/leads/firstCall.ts.
    const { id } = await logTimeline({
      clientId,
      actor: { kind: "system", source: "first-call-missed", subjectAgentId: agentBId },
      type: "SYSTEM",
      notes: "Первый звонок не совершён за 15 мин",
    });
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id } });
    expect(row.actorKind).toBe("SYSTEM");
    expect(row.agentId).toBeNull();
    expect(row.subjectAgentId).toBe(agentBId);
    expect(row.notes).toBe("Первый звонок не совершён за 15 мин");
  });

  it("kind ai: agentId null, subjectAgentId заполнен", async () => {
    const { id } = await logTimeline({
      clientId,
      actor: { kind: "ai", source: "card-suggestion", subjectAgentId: agentAId },
      type: "SYSTEM",
      notes: "ИИ уточнил карточку по разговору: бюджет",
    });
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id } });
    expect(row.actorKind).toBe("AI");
    expect(row.agentId).toBeNull();
    expect(row.subjectAgentId).toBe(agentAId);
  });

  it("kind bot / kind client: agentId null, subjectAgentId опционален", async () => {
    const bot = await logTimeline({
      clientId,
      actor: { kind: "bot", source: "showing-bot", subjectAgentId: agentAId, channel: "whatsapp" },
      type: "SHOWING",
      notes: "Показ назначен ботом по договорённости с клиентом",
    });
    const botRow = await prisma.interaction.findUniqueOrThrow({ where: { id: bot.id } });
    expect(botRow.actorKind).toBe("BOT");
    expect(botRow.agentId).toBeNull();

    const client_ = await logTimeline({
      clientId,
      actor: { kind: "client", source: "auto-lead-from-call" },
      type: "SYSTEM",
      notes: "Клиент позвонил сам — возвращён в работу из Неактивных",
    });
    const clientRow = await prisma.interaction.findUniqueOrThrow({ where: { id: client_.id } });
    expect(clientRow.actorKind).toBe("CLIENT");
    expect(clientRow.agentId).toBeNull();
    expect(clientRow.subjectAgentId).toBeNull();
  });

  it("notes с уже вписанным вручную префиксом идёт как есть (logTimeline его не трогает)", async () => {
    const { id } = await logTimeline({
      clientId,
      actor: { kind: "system", source: "manual.fix", subjectAgentId: agentAId },
      type: "SYSTEM",
      notes: "[manual.fix] уже с префиксом",
    });
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id } });
    expect(row.notes).toBe("[manual.fix] уже с префиксом");
  });

  it("задача (nextAction) без subjectAgentId у не-агента — пишется (легитимный случай), но оставляет след в журнале ошибок", async () => {
    const before = await prisma.errorLog.count({ where: { source: "timeline" } });
    const { id } = await logTimeline({
      clientId,
      actor: { kind: "system", source: "broken-caller" },
      type: "SYSTEM",
      notes: "Задача без адресата",
      nextAction: "Позвонить",
      nextActionDate: new Date(),
    });
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id } });
    expect(row.subjectAgentId).toBeNull();
    expect(row.nextAction).toBe("Позвонить");
    /**
     * ЖДЁМ СВОЮ СТРОКУ, А НЕ СРАВНИВАЕМ СЧЁТЧИК СРАЗУ (21.09.2026).
     *
     * `logTimeline` пишет диагностику намеренно без ожидания
     * (`void logSystemError(...)`, lib/timeline.ts): задача важнее следа в
     * журнале, и ронять запись хронологии из-за диагностики нельзя. Значит к
     * моменту возврата строки в журнале может ещё не быть — на нагруженной
     * машине её и не было: «expected 3 to be greater than 3» в прогоне
     * 21.09.2026. Прежнее ожидание было не проверкой, а гонкой, зелёной
     * ровно тогда, когда вставка успевала лечь первой.
     *
     * Ищем ИМЕННО свою строку (в тексте стоит clientId), а не прирост общего
     * счётчика: соседи по базе пишут в тот же `source` и могут нарастить его
     * сами. Ожидание ограничено — если строки нет и через секунду, это
     * настоящая поломка, и тест обязан покраснеть.
     */
    let ours = 0;
    for (let attempt = 0; attempt < 20 && ours === 0; attempt += 1) {
      ours = await prisma.errorLog.count({
        where: { source: "timeline", message: { contains: clientId } },
      });
      if (ours === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ours).toBeGreaterThan(0);
    expect(await prisma.errorLog.count({ where: { source: "timeline" } })).toBeGreaterThanOrEqual(before);
  });

  it("намеренно общая задача (sharedTask, эскалация недозвона руководству) — без ложной тревоги в журнале (25.09.2026)", async () => {
    const source = `shared-${runId}`;
    const { id } = await logTimeline({
      clientId,
      actor: { kind: "system", source, sharedTask: true },
      type: "SYSTEM",
      notes: "Проверить контакт с клиентом — 3 недозвона подряд",
      nextAction: "Проверить контакт с клиентом",
      nextActionDate: new Date(),
    });
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id } });
    expect(row.subjectAgentId).toBeNull();
    expect(row.nextAction).toBe("Проверить контакт с клиентом");
    // Проверка «ничего не записали» — через waitForSettled: запись идёт без await.
    const count = await waitForSettled(() =>
      prisma.errorLog.count({ where: { source: "timeline", message: { contains: `source=${source}` } } })
    );
    expect(count).toBe(0);
  });

  it("logTimelineMany пишет пачку записей одному клиенту", async () => {
    const count = await logTimelineMany([
      { clientId, actor: { kind: "system", source: "backfill-check", subjectAgentId: agentAId }, type: "SYSTEM", notes: "Пакетная запись 1" },
      { clientId, actor: { kind: "system", source: "backfill-check", subjectAgentId: agentAId }, type: "SYSTEM", notes: "Пакетная запись 2" },
    ]);
    expect(count).toBe(2);
    const rows = await prisma.interaction.findMany({ where: { clientId, notes: { contains: "Пакетная запись" } } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.actorKind).toBe("SYSTEM");
      expect(row.agentId).toBeNull();
      expect(row.subjectAgentId).toBe(agentAId);
    }
  });
});
