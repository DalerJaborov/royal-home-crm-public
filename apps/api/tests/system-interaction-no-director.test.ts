import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { changeClientAgent } from "../src/lib/changeClientAgent.js";
import { reactivateClientFromLost } from "../src/lib/clientLifecycle.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * СИСТЕМНОЕ СОБЫТИЕ БОЛЬШЕ НЕ ПОДПИСЫВАЕТСЯ «ДЕЖУРНЫМ ДИРЕКТОРОМ» — ДОВЕДЕНО ДО
 * КОНЦА ЗАДАНИЕМ Б1 (17.09.2026, П-10, docs/audit/lead-ownership-17-09.md §2).
 *
 * Утренняя версия этого файла (та же дата) проверяла промежуточное решение:
 * запись без явного актора уходила на ПЕРВОГО АКТИВНОГО ДИРЕКТОРА — и в
 * хронологии выглядела так, будто действие совершил директор лично, поэтому
 * тогда решили просто НЕ писать запись, если причастных нет («отсутствующая
 * запись честнее выдуманной»).
 *
 * Задание Б1 добавило `actorKind`/nullable `agentId`/`subjectAgentId`, и
 * жертва больше не нужна: запись пишется ВСЕГДА, как SYSTEM/CLIENT с
 * `agentId: null` — держатель карточки (если есть) виден через
 * `subjectAgentId`, а не через выдуманную человеческую подпись.
 */

const runId = Date.now();
const clientIds: string[] = [];
/** Свой агент, а не первый найденный в базе — см. helpers/ownAgent.ts. */
const agentIds: string[] = [];

async function ownAgentId(): Promise<string> {
  if (agentIds.length === 0) agentIds.push(await createTestAgent(`Без-директора ${runId}`));
  return agentIds[0];
}

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
});

async function seedOrphanClient(tag: string, over: Record<string, unknown> = {}) {
  const client = await prisma.client.create({
    data: {
      fullName: `Без агента ${runId} ${tag}`,
      phone: `+9929${String(runId).slice(-7)}${tag}`,
      source: "WEBSITE",
      kind: "BUYER",
      currency: "TJS",
      assignedAgentId: null,
      lastAgentId: null,
      ...over,
    },
  });
  clientIds.push(client.id);
  return client;
}

describe("changeClientAgent без причастных", () => {
  it("пишет SYSTEM без agentId вместо того, чтобы подписать директором", async () => {
    const client = await seedOrphanClient("7");
    const agentId = await ownAgentId();

    const result = await changeClientAgent({
      clientId: client.id,
      toAgentId: agentId,
      reason: "автоматическая раздача",
      // Ни actorId, ни прежнего агента, ни последнего — причастных нет вовсе.
      actorId: null,
      source: "test.auto",
    });

    expect(result.ok).toBe(true);
    const events = await prisma.interaction.findMany({ where: { clientId: client.id } });
    expect(events).toHaveLength(1);
    expect(events[0].actorKind).toBe("SYSTEM");
    expect(events[0].agentId).toBeNull();
    // Причастных не было и до события (assignedAgentId/lastAgentId оба null) —
    // subjectAgentId тоже пуст: адресовать некому, но след честно остался.
    expect(events[0].subjectAgentId).toBeNull();

    // И ни одного активного директора эта операция не трогала.
    const directors = await prisma.agent.findMany({ where: { role: "DIRECTOR" }, select: { id: true } });
    const directorIds = new Set(directors.map((d) => d.id));
    expect(events.some((e) => e.agentId && directorIds.has(e.agentId))).toBe(false);
  });

  it("причастный есть — событие пишется SYSTEM, держатель виден через subjectAgentId, а не выдуманной подписью", async () => {
    const agentId = await ownAgentId();
    const client = await seedOrphanClient("8", { assignedAgentId: agentId });

    await changeClientAgent({
      clientId: client.id,
      toAgentId: null,
      reason: "снятие с агента",
      actorId: null,
      source: "test.detach",
    });

    const events = await prisma.interaction.findMany({ where: { clientId: client.id } });
    expect(events).toHaveLength(1);
    expect(events[0].actorKind).toBe("SYSTEM");
    expect(events[0].agentId).toBeNull();
    expect(events[0].subjectAgentId).toBe(agentId);
  });
});

describe("reactivateClientFromLost без причастных", () => {
  it("возвращает клиента в работу, а не отказывает из-за отсутствия директора", async () => {
    /**
     * Раньше здесь стоял `return { ok: false }`: карточка, заведённая вручную и
     * никому не назначавшаяся, не могла вернуться из «Неактивных» вовсе, если
     * директора не нашлось. Отсутствие подписи не должно отменять действие.
     */
    const client = await seedOrphanClient("9", { status: "LOST", workStatus: "INACTIVE" });

    const result = await reactivateClientFromLost({
      clientId: client.id,
      reason: "клиент написал сам",
    });

    expect(result.ok).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.status).not.toBe("LOST");
    // Задание Б1: запись пишется всегда (kind "client" — вернул клиент сам),
    // просто без agentId и без subjectAgentId — причастных как не было, так и нет.
    const events = await prisma.interaction.findMany({ where: { clientId: client.id } });
    expect(events).toHaveLength(1);
    expect(events[0].actorKind).toBe("CLIENT");
    expect(events[0].agentId).toBeNull();
    expect(events[0].subjectAgentId).toBeNull();
  });
});
