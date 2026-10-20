import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { kindChangeUpdate } from "../src/services/leads/intake.js";
import { detachAgentForCandidate, CANDIDATE_INTERACTION_NOTE } from "../src/lib/clientToCandidate.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import type { Client } from "../src/generated/prisma/client.js";

/**
 * КАНДИДАТ НА ВАКАНСИЮ НИКОГДА НЕ ОСТАЁТСЯ У АГЕНТА (владелец 17.09.2026).
 *
 * Живые случаи 302/315/319: человек когда-то спрашивал про квартиру, потом
 * написал «барои кор» — kindChangeUpdate менял тип на OTHER, но assignedAgentId
 * НЕ снимал, и тому же агенту улетал push «Клиент вернулся с другим запросом».
 * Агент шёл звонить соискателю как покупателю.
 */

const runId = Date.now();
const clientIds: string[] = [];
const agentIds: string[] = [];

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
});

describe("kindChangeUpdate: смена типа на «прочее» снимает агента", () => {
  /** Ровно те поля, которые читает kindChangeUpdate, — полная строка Client тут не нужна. */
  const buyerWithAgent = {
    kind: "BUYER",
    requirementsNotes: "3 хона, Сино",
    assignedAgentId: "agent-1",
    // Ещё не принята: автоматике можно менять тип только до приёма (lib/kindChangePolicy.ts, 21.09.2026).
    acceptedAt: null,
  } as unknown as Client;

  it("BUYER → OTHER: агент снят, принятие и эскалация обнулены", () => {
    const { data, note } = kindChangeUpdate(buyerWithAgent, { kind: "OTHER" } as never);
    expect(data.kind).toBe("OTHER");
    expect(data.assignedAgentId).toBeNull();
    expect(data.acceptedAt).toBeNull();
    expect(data.escalatedAt).toBeNull();
    // Кто вёл — сохраняем: вдруг человек всё-таки покупатель.
    expect(data.lastAgentId).toBe("agent-1");
    expect(note).toContain("снята с агента");
  });

  it("BUYER → SELLER агента не трогает — это по-прежнему работа агента", () => {
    const { data } = kindChangeUpdate(buyerWithAgent, { kind: "SELLER" } as never);
    expect(data.assignedAgentId).toBeUndefined();
    expect(data.dualIntent).toBe(true);
  });

  it("тип не изменился — правок нет вовсе", () => {
    expect(kindChangeUpdate(buyerWithAgent, { kind: "BUYER" } as never).data).toEqual({});
  });

  it("принятая карточка: автоматика тип не меняет и ничего не пишет — решает агент (21.09.2026)", () => {
    const accepted = { ...buyerWithAgent, acceptedAt: new Date() } as unknown as Client;
    expect(kindChangeUpdate(accepted, { kind: "SELLER" } as never)).toEqual({ data: {}, note: null, changed: false });
  });
});

describe("detachAgentForCandidate: карточка уходит из работы агента", () => {
  it("снимает агента, пишет событие в хронологию, оставляет карточку", async () => {
    // Свой агент, а не первый найденный в базе — см. helpers/ownAgent.ts.
    const agentId = await createTestAgent(`Кандидат-агент ${runId}`);
    agentIds.push(agentId);
    const client = await prisma.client.create({
      data: {
        fullName: `Кандидат ${runId}`,
        phone: `+9929${String(runId).slice(-8)}`,
        source: "WHATSAPP",
        kind: "BUYER",
        currency: "TJS",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    clientIds.push(client.id);

    const result = await detachAgentForCandidate({
      clientId: client.id,
      actorId: null,
      reason: "человек написал по вакансии",
    });

    expect(result.ok).toBe(true);
    expect(result.previousAgentId).toBe(agentId);
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.assignedAgentId).toBeNull();
    expect(after?.acceptedAt).toBeNull();
    expect(after?.kind).toBe("OTHER");
    // Прежний агент записан в lastAgentId — по нему карточку вернут, если
    // окажется, что человек всё-таки покупатель.
    expect(after?.lastAgentId).toBe(agentId);

    const events = await prisma.interaction.findMany({ where: { clientId: client.id } });
    expect(events.some((e) => e.notes.startsWith(CANDIDATE_INTERACTION_NOTE))).toBe(true);
    // Автоматический путь (actorId=null) подписывается БОТОМ, а не прежним
    // агентом: владение карточкой не значит, что действовал именно он (П-10,
    // 17.09.2026). Прежний держатель остаётся в subjectAgentId — чтобы запись
    // попала в его ленту. Подпись дежурным директором по-прежнему запрещена.
    expect(events[0]?.agentId).toBeNull();
    expect(events[0]?.subjectAgentId).toBe(agentId);
  });

  it("карточки нет — отвечает отказом, а не падает", async () => {
    const result = await detachAgentForCandidate({
      clientId: "00000000-0000-0000-0000-000000000000",
      actorId: null,
      reason: "проверка",
    });
    expect(result.ok).toBe(false);
  });
});
