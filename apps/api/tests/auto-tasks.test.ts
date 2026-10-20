import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { upsertAutoTask, claimAutoTaskSlot, closeAutoTasks, CALLBACK_AUTO_TASK_KINDS } from "../src/lib/autoTasks.js";
import { logTimeline } from "../src/lib/timeline.js";

/**
 * lib/autoTasks.ts — дедуп и автозакрытие автозадач (21.09.2026, docs/TASKS.md
 * «Автозадачи не видят состоявшегося контакта»). Проверяем ровно то, от чего
 * зависела жалоба владельца: повторный прогон генератора не плодит вторую
 * задачу, а состоявшийся контакт снимает открытые «перезвонить»/«окно
 * закрыто» — но НИКОГДА не трогает задачу, заведённую агентом руками.
 */

const runId = Date.now();
let agentId = "";
let clientId = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент автозадач ${runId}`, phone: `+99291${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент автозадач ${runId}`,
      phone: `+99293${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
    },
  });
  clientId = client.id;
});

// Каждый тест сам заводит свои Interaction — чистим между тестами, иначе
// открытая задача одного теста (например no_answer_supervisor_check из первого
// describe) попадает в выборку closeAutoTasks(..., CALLBACK_AUTO_TASK_KINDS)
// следующего и портит счётчик.
afterEach(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("upsertAutoTask — дедуп при создании", () => {
  it("повторный вызов с тем же видом обновляет существующую запись, а не создаёт вторую", async () => {
    const first = await upsertAutoTask({
      clientId,
      kind: "no_answer_supervisor_check",
      actor: { kind: "system", source: "test", subjectAgentId: agentId },
      notes: "Проверить контакт — 3 недозвона подряд",
      nextAction: "Проверить контакт с клиентом — 3 недозвона подряд",
      nextActionDate: new Date(Date.now() + 1000),
    });
    expect(first.created).toBe(true);

    const second = await upsertAutoTask({
      clientId,
      kind: "no_answer_supervisor_check",
      actor: { kind: "system", source: "test", subjectAgentId: agentId },
      notes: "Проверить контакт — 6 недозвонов подряд",
      nextAction: "Проверить контакт с клиентом — 6 недозвонов подряд",
      nextActionDate: new Date(Date.now() + 2000),
    });
    expect(second.created).toBe(false);
    expect(second.interactionId).toBe(first.interactionId);

    const openCount = await prisma.interaction.count({
      where: { clientId, autoTaskKind: "no_answer_supervisor_check", nextAction: { not: null }, completedAt: null },
    });
    expect(openCount).toBe(1);

    const row = await prisma.interaction.findUniqueOrThrow({ where: { id: first.interactionId } });
    expect(row.nextAction).toBe("Проверить контакт с клиентом — 6 недозвонов подряд");
  });
});

describe("claimAutoTaskSlot — дедуп, когда новую запись создаёт вызывающий код сам", () => {
  it("первый недозвон получает слот, второй — обновляет существующий и не получает свой", async () => {
    const c1 = await claimAutoTaskSlot(clientId, "inbound_missed_callback", "Перезвонить — клиент звонил сам и не дозвонился", new Date());
    expect(c1.assignToNewRecord).toBe(true);
    // Своя запись звонка — как это делает lib/telephony/incomingCalls.ts.
    const call1 = await logTimeline({
      clientId,
      actor: { kind: "system", source: "test-call", subjectAgentId: agentId },
      type: "CALL",
      notes: "Входящий звонок клиента: до оператора не дозвонился",
      nextAction: "Перезвонить — клиент звонил сам и не дозвонился",
      nextActionDate: new Date(),
      autoTaskKind: "inbound_missed_callback",
    });

    const c2 = await claimAutoTaskSlot(clientId, "inbound_missed_callback", "Перезвонить — клиент звонил сам и не дозвонился", new Date());
    expect(c2.assignToNewRecord).toBe(false);
    const call2 = await logTimeline({
      clientId,
      actor: { kind: "system", source: "test-call", subjectAgentId: agentId },
      type: "CALL",
      notes: "Входящий звонок клиента: до оператора не дозвонился",
      // assignToNewRecord=false — call2 своего nextAction не получает.
    });

    const openCount = await prisma.interaction.count({
      where: { clientId, autoTaskKind: "inbound_missed_callback", nextAction: { not: null }, completedAt: null },
    });
    expect(openCount).toBe(1);

    await prisma.interaction.deleteMany({ where: { id: { in: [call1.id, call2.id] } } });
  });
});

describe("closeAutoTasks — автозакрытие по факту", () => {
  it("состоявшийся разговор снимает открытые «перезвонить» всех видов сразу", async () => {
    const a = await upsertAutoTask({
      clientId,
      kind: "no_answer_retry",
      actor: { kind: "system", source: "test", subjectAgentId: agentId },
      notes: "Перезвонить — попытка 1 из 3",
      nextAction: "Перезвонить — клиент не ответил (попытка 1 из 3)",
      nextActionDate: new Date(),
    });
    const b = await upsertAutoTask({
      clientId,
      kind: "voicemail_callback",
      actor: { kind: "system", source: "test", subjectAgentId: agentId },
      notes: "Оставил сообщение",
      nextAction: "Перезвонить: клиент оставил сообщение на автоответчике",
      nextActionDate: new Date(),
    });

    const closed = await closeAutoTasks(clientId, CALLBACK_AUTO_TASK_KINDS);
    expect(closed).toBe(2);

    const [rowA, rowB] = await Promise.all([
      prisma.interaction.findUniqueOrThrow({ where: { id: a.interactionId } }),
      prisma.interaction.findUniqueOrThrow({ where: { id: b.interactionId } }),
    ]);
    expect(rowA.nextAction).toBeNull();
    expect(rowA.nextActionDate).toBeNull();
    expect(rowA.completedAt).not.toBeNull();
    expect(rowB.nextAction).toBeNull();
  });

  it("ушедшее сообщение снимает «окно закрыто»", async () => {
    const task = await upsertAutoTask({
      clientId,
      kind: "chat_window_closed",
      actor: { kind: "system", source: "test", subjectAgentId: agentId },
      notes: "[agentUnansweredAlarm] Написать в чат нельзя, окно закрыто — позвоните",
      nextAction: "Написать в чат нельзя, окно закрыто — позвоните: клиент ждёт 2 раб. дн.",
      nextActionDate: new Date(),
    });

    const closed = await closeAutoTasks(clientId, ["chat_window_closed"]);
    expect(closed).toBe(1);

    const row = await prisma.interaction.findUniqueOrThrow({ where: { id: task.interactionId } });
    expect(row.nextAction).toBeNull();
  });

  it("появившийся объект снимает «добавьте объект по заявке» у продавца", async () => {
    const task = await upsertAutoTask({
      clientId,
      kind: "deal_stale_seller_add_property",
      actor: { kind: "system", source: "test", subjectAgentId: agentId },
      notes: "Добавьте объект по заявке ПК-000001 — уже 10 дн. без объекта",
      nextAction: "Добавьте объект по заявке ПК-000001 — уже 10 дн. без объекта с момента первого контакта",
      nextActionDate: new Date(),
    });

    const closed = await closeAutoTasks(clientId, ["deal_stale_seller_add_property"]);
    expect(closed).toBe(1);

    const row = await prisma.interaction.findUniqueOrThrow({ where: { id: task.interactionId } });
    expect(row.nextAction).toBeNull();
  });

  it("НЕ снимает задачу, которую агент завёл руками (autoTaskKind пуст)", async () => {
    const manual = await logTimeline({
      clientId,
      actor: { kind: "agent", agentId },
      type: "CALL",
      notes: "Перезвонить клиенту — сам договорился на четверг",
      nextAction: "Перезвонить — клиент не ответил (попытка 1 из 3)",
      nextActionDate: new Date(),
      // autoTaskKind НЕ передан — ручная задача.
    });

    const closed = await closeAutoTasks(clientId, CALLBACK_AUTO_TASK_KINDS);
    expect(closed).toBe(0);

    const row = await prisma.interaction.findUniqueOrThrow({ where: { id: manual.id } });
    expect(row.nextAction).not.toBeNull();
    expect(row.completedAt).toBeNull();

    await prisma.interaction.deleteMany({ where: { id: manual.id } });
  });

  it("не трогает клиента без id и не падает на пустом списке видов", async () => {
    await expect(closeAutoTasks(null, CALLBACK_AUTO_TASK_KINDS)).resolves.toBe(0);
    await expect(closeAutoTasks(clientId, [])).resolves.toBe(0);
  });
});
