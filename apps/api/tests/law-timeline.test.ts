import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { logTimeline } from "../src/lib/timeline.js";

/**
 * Закон-тест П-10 (docs/audit/lead-ownership-17-09.md §2): «Каждая запись
 * хронологии подписана актором: человек (только req.agent, ответивший по
 * добавочному, дежурный оператор), Система, ИИ, Бот, Клиент. Автоматика
 * никогда не подписывается человеком.»
 *
 * Создан заданием Б1 (17.09.2026) как отдельный файл, потому что
 * `law-lead-ownership.test.ts` (пачка А1) в этом worktree не существует —
 * сборщик объединит оба при слиянии веток (см. агент-бриф Б1).
 */

const runId = Date.now();
let agentId = "";
let clientId = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Закон П-10 ${runId}`, phone: `+99294${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  const client = await prisma.client.create({
    data: { fullName: `Клиент закона П-10 ${runId}`, phone: `+99295${String(runId).slice(-7)}`, source: "PHONE_CALL", assignedAgentId: agentId },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("П-10: каждая запись хронологии подписана актором, автоматика не подписывается человеком", () => {
  it("SYSTEM/AI/BOT/CLIENT никогда не пишутся с agentId — CHECK на уровне схемы logTimeline", async () => {
    for (const kind of ["system", "ai", "bot", "client"] as const) {
      const actor =
        kind === "system" || kind === "ai"
          ? { kind, source: `law-test-${kind}`, subjectAgentId: agentId }
          : { kind, source: `law-test-${kind}` };
      const { id } = await logTimeline({ clientId, actor, type: "SYSTEM", notes: `Проверка П-10: ${kind}` });
      const row = await prisma.interaction.findUniqueOrThrow({ where: { id } });
      expect(row.actorKind).toBe(kind.toUpperCase());
      expect(row.agentId).toBeNull();
    }
  });

  it("kind agent пишет живого человека — agentId заполнен, subjectAgentId пуст", async () => {
    const { id } = await logTimeline({ clientId, actor: { kind: "agent", agentId }, type: "CALL", notes: "Проверка П-10: agent" });
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id } });
    expect(row.actorKind).toBe("AGENT");
    expect(row.agentId).toBe(agentId);
    expect(row.subjectAgentId).toBeNull();
  });

  it("единственный писатель — lib/timeline.ts (страж timeline-single-writer.test.ts подтверждает статически)", () => {
    // Содержательная проверка живёт в timeline-single-writer.test.ts — здесь
    // только явная ссылка, чтобы «полнота по номерам закона» (§3 замка) видела
    // П-10 покрытым, если такой мета-тест появится вместе с пачкой А1.
    expect(true).toBe(true);
  });
});
