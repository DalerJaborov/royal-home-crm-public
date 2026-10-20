import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Схлопывание повторных уведомлений от одного повода в одну строку с
 * счётчиком (владелец 20.08.2026) — см. lib/notifications.ts, upsertByTag.
 * Тот же tag, что уже схлопывает push-баннер на устройстве, теперь применён
 * и к самой ленте: повтор события с тем же (agentId, tag) обновляет
 * существующую строку (count++, снова непрочитано), а не плодит новую.
 */

const { prisma } = await import("../src/db.js");
const { createNotification, createNotifications } = await import("../src/lib/notifications.js");

const runId = Date.now();
let agentId: string;
let agent2Id: string;
const createdIds: string[] = [];

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент группировки", phone: `+992937${runId}`, role: "AGENT", passwordHash: "x" } })
  ).id;
  agent2Id = (
    await prisma.agent.create({ data: { fullName: "Агент группировки 2", phone: `+992938${runId}`, role: "AGENT", passwordHash: "x" } })
  ).id;
});

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { agentId: { in: [agentId, agent2Id] } } });
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId: { in: [agentId, agent2Id] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, agent2Id] } } });
  await prisma.$disconnect();
});

describe("createNotification — схлопывание по tag", () => {
  it("два одинаковых tag подряд — одна строка, count=2", async () => {
    await createNotification({ agentId, kind: "task", title: "Показ не отмечен", body: "Первый раз", url: "/clients/1", tag: "no-show-1" });
    await createNotification({ agentId, kind: "task", title: "Показ не отмечен", body: "Второй раз", url: "/clients/1", tag: "no-show-1" });

    const rows = await prisma.notification.findMany({ where: { agentId, tag: "no-show-1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
    expect(rows[0].body).toBe("Второй раз"); // свежий текст поверх старого
  });

  it("повтор сбрасывает read обратно в false", async () => {
    await createNotification({ agentId, kind: "task", title: "X", body: "1", tag: "reset-read" });
    const [row] = await prisma.notification.findMany({ where: { agentId, tag: "reset-read" } });
    await prisma.notification.update({ where: { id: row.id }, data: { read: true } });

    await createNotification({ agentId, kind: "task", title: "X", body: "2", tag: "reset-read" });
    const [after] = await prisma.notification.findMany({ where: { agentId, tag: "reset-read" } });
    expect(after.read).toBe(false);
    expect(after.count).toBe(2);
  });

  it("без tag — каждый раз новая строка, как раньше", async () => {
    await createNotification({ agentId, kind: "score", title: "Royal Score +5", body: "Сделка закрыта" });
    await createNotification({ agentId, kind: "score", title: "Royal Score +5", body: "Другая сделка закрыта" });

    const rows = await prisma.notification.findMany({ where: { agentId, tag: null } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });

  it("разные tag не схлопываются друг с другом", async () => {
    await createNotification({ agentId, kind: "task", title: "A", body: "1", tag: "tag-a" });
    await createNotification({ agentId, kind: "task", title: "B", body: "1", tag: "tag-b" });

    const rows = await prisma.notification.findMany({ where: { agentId, tag: { in: ["tag-a", "tag-b"] } } });
    expect(rows).toHaveLength(2);
  });
});

describe("createNotifications — схлопывание по tag для нескольких получателей", () => {
  it("у каждого агента своя история одного и того же tag", async () => {
    await createNotifications([agentId, agent2Id], { kind: "task", title: "Ключ не вернули", body: "4 ч назад", tag: "key-1" });
    await createNotifications([agentId, agent2Id], { kind: "task", title: "Ключ не вернули", body: "6 ч назад", tag: "key-1" });

    const rowsAgent1 = await prisma.notification.findMany({ where: { agentId, tag: "key-1" } });
    const rowsAgent2 = await prisma.notification.findMany({ where: { agentId: agent2Id, tag: "key-1" } });
    expect(rowsAgent1).toHaveLength(1);
    expect(rowsAgent1[0].count).toBe(2);
    expect(rowsAgent2).toHaveLength(1);
    expect(rowsAgent2[0].count).toBe(2);
  });

  it("без tag — createMany как раньше, по одной строке на агента", async () => {
    await createNotifications([agentId, agent2Id], { kind: "lead", title: "Новый лид", body: "Клиент X" });
    const rows = await prisma.notification.findMany({ where: { agentId: { in: [agentId, agent2Id] }, kind: "lead" } });
    expect(rows).toHaveLength(2);
  });
});
