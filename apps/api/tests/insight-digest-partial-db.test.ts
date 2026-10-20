import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * Статус PARTIAL на РЕАЛЬНОЙ базе (ревью 03.09.2026, review-C-insights.md §5).
 *
 * insight-digest-runner.test.ts мокает prisma.insightCase.count и потому не
 * ловил баг `NOT: { verdict: undefined }` — Prisma выбрасывал условие, считались
 * все кейсы, и при отказе Gemini диджест получал READY с пустыми разборами.
 * Здесь мокается ТОЛЬКО ИИ (callAiText → null, как при 429 «кредиты кончились»)
 * и сбор кандидатов; кейсы создаются, считаются и читаются настоящим Prisma.
 */

vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: vi.fn().mockResolvedValue(null) }));

const runId = Date.now();
let agentId = "";
let clientId = "";

vi.mock("../src/lib/insightDigest.js", () => ({
  collectCandidates: async () => [
    { kind: "call_low_score", sourceKey: `partial-db-${runId}:a`, agentId, clientId, severity: 4, rankScore: 80, raw: { transcript: "Алло" } },
    { kind: "score_penalty", sourceKey: `partial-db-${runId}:b`, agentId, clientId, severity: 3, rankScore: 10, raw: { reason: "Просрочено окно" } },
  ],
  rankAndPick: async (c: unknown[]) => c,
  snapshotTimeline: async (c: { kind: string; raw: Record<string, unknown> }) => ({ kind: c.kind, content: c.raw.transcript ?? c.raw.reason ?? null, meta: {} }),
}));

import { prisma } from "../src/db.js";
import { generateInsightDigest } from "../src/lib/insightDigestRunner.js";

const periodStart = new Date(Date.UTC(2031, 0, 1) + (runId % 1000) * 86_400_000);
const periodEnd = new Date(periodStart.getTime() + 14 * 86_400_000);

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (await prisma.agent.create({ data: { fullName: "Агент PARTIAL", phone: `+992957${runId}`, role: "AGENT", passwordHash } })).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент PARTIAL ${runId}`, phone: `+992958${runId}`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: agentId },
    })
  ).id;
});

afterAll(async () => {
  await prisma.insightCase.deleteMany({ where: { sourceKey: { startsWith: `partial-db-${runId}:` } } });
  await prisma.insightDigest.deleteMany({ where: { periodStart } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("generateInsightDigest на реальной БД", () => {
  it("ИИ не ответил ни по одному кейсу → статус PARTIAL, вердикты null, кейсы созданы", async () => {
    const id = await generateInsightDigest(periodStart, periodEnd, periodEnd);
    expect(id).not.toBe("DISABLED");

    const digest = await prisma.insightDigest.findUniqueOrThrow({ where: { id }, include: { cases: true } });
    expect(digest.cases).toHaveLength(2);
    expect(digest.cases.every((c) => c.verdict === null)).toBe(true);
    expect(digest.status).toBe("PARTIAL");
  });

  it("повторный вызов на тот же период идемпотентен — возвращает тот же id", async () => {
    const first = await prisma.insightDigest.findUniqueOrThrow({ where: { periodStart }, select: { id: true } });
    const again = await generateInsightDigest(periodStart, periodEnd, periodEnd);
    expect(again).toBe(first.id);
    expect(await prisma.insightCase.count({ where: { digestId: first.id } })).toBe(2);
  });
});
