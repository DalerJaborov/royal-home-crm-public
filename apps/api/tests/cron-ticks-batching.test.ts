import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { AUTO_THINKING_MARKER, runBuyerThinkingSlowTrackTick } = await import("../src/lib/buyerThinkingSlowTrack.js");
const { processNoAnswerTailAnchors } = await import("../src/lib/noAnswerStreak.js");

/**
 * Инцидент 11-12.09.2026: buyer-thinking-slow-track и no-answer-tail «молчали
 * 75 мин» после 04:30 UTC (09:30 Душанбе, начало рабочего дня) — оба делали
 * `findMany(take: 200)` и затем последовательный `for … await` с 2-4 запросами
 * на строку (до 600-800 круговых запросов за прогон), без таймаута; в час пик
 * пул `connection_limit=15` насыщался, тик зависал, следующие срабатывания
 * терялись молча (см. lib/cronHeartbeat.ts::scheduleTracked). Три вещи
 * проверяются здесь: оба тика на пачке из 250 due-строк отрабатывают и
 * создают ожидаемые Interaction, параллелизм (mapWithConcurrency, лимит 5) не
 * даёт дублей, и cron.ts действительно передаёт timeoutMs обоим тикам.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiRoot = path.resolve(__dirname, "..");

const SECOND_TIER_MARKER = "Связаться с клиентом — думает над показом (авто-подстраховка, шаг 2)";

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];

async function makeClient(i: number, overrides: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Пачка ${runId}-${i}`,
      phone: `+992900${runId}${i}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      ...overrides,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: "Агент пачечного теста", phone: `+992901${runId}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("cron.ts — timeoutMs передан обоим тикам-виновникам инцидента", () => {
  it("scheduleTracked(\"buyer-thinking-slow-track\", …) и scheduleTracked(\"no-answer-tail\", …) получают timeoutMs", () => {
    const src = fs.readFileSync(path.join(apiRoot, "src/cron.ts"), "utf8");

    const buyerThinkingBlock = src.slice(src.indexOf('"buyer-thinking-slow-track"'), src.indexOf('"buyer-thinking-slow-track"') + 1000);
    expect(buyerThinkingBlock).toMatch(/timeoutMs:\s*5\s*\*\s*60_000/);

    const noAnswerTailBlock = src.slice(src.indexOf('"no-answer-tail"'), src.indexOf('"no-answer-tail"') + 1000);
    expect(noAnswerTailBlock).toMatch(/timeoutMs:\s*5\s*\*\s*60_000/);
  });
});

describe("buyer-thinking-slow-track — пачка 250 due-строк", () => {
  it("продвигает пачку (до take:200 за один тик) на шаг 2 ровно по одному разу, без дублей", async () => {
    const BATCH = 250;
    // findMany(take: 200) — существующий постраничный лимит выборки, не часть
    // этой правки; при 250 due-строках одним тиком обрабатывается ровно 200,
    // остаток дожидается следующего срабатывания расписания (*/30 мин) — это
    // и проверяется ниже (still-open ровно BATCH-200).
    const PER_TICK = 200;
    const now = new Date();
    for (let i = 0; i < BATCH; i++) {
      const client = await makeClient(i);
      await prisma.interaction.create({
        data: {
          clientId: client.id,
          agentId,
          type: "SYSTEM",
          notes: "тест — пачка",
          nextAction: AUTO_THINKING_MARKER,
          nextActionDate: new Date(now.getTime() - 3600_000),
        },
      });
    }

    const { advanced } = await runBuyerThinkingSlowTrackTick(now);
    expect(advanced).toBe(PER_TICK);

    const secondTier = await prisma.interaction.findMany({
      where: { clientId: { in: clientIds }, nextAction: SECOND_TIER_MARKER },
    });
    // Не больше одного шага-2 на клиента — параллелизм (лимит 5) не породил дублей.
    const byClient = new Map<string, number>();
    for (const row of secondTier) byClient.set(row.clientId, (byClient.get(row.clientId) ?? 0) + 1);
    expect(byClient.size).toBe(PER_TICK);
    for (const count of byClient.values()) expect(count).toBe(1);

    // Ровно take:200 маячков закрыты этим тиком, остаток (50) ждёт следующего.
    const stillOpen = await prisma.interaction.count({
      where: { clientId: { in: clientIds }, nextAction: AUTO_THINKING_MARKER, completedAt: null },
    });
    expect(stillOpen).toBe(BATCH - PER_TICK);
  }, 60_000);
});

describe("no-answer-tail — пачка 250 due-маячков", () => {
  const tailClientIds: string[] = [];

  afterAll(async () => {
    await prisma.interaction.deleteMany({ where: { clientId: { in: tailClientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: tailClientIds } } });
  });

  it("заводит ровно по одной задаче «перезвонить» на каждый из 250 актуальных маячков (до take:200 за тик)", async () => {
    const BATCH = 250;
    const PER_TICK = 200; // findMany(take: 200) — существующий постраничный лимит, см. комментарий выше
    const now = new Date();
    for (let i = 0; i < BATCH; i++) {
      const client = await prisma.client.create({
        data: {
          fullName: `Хвост пачка ${runId}-${i}`,
          phone: `+992902${runId}${i}`,
          source: "PHONE_CALL",
          assignedAgentId: agentId,
          workStatus: "ACTIVE",
        },
      });
      tailClientIds.push(client.id);
      // Маячок — системная запись (П-10, 17.09.2026): держатель карточки живёт
      // в subjectAgentId, а agentId у таких записей всегда null (CHECK в БД).
      // processNoAnswerTailAnchors сверяет владельца именно с subjectAgentId —
      // со старой формой (agentId) ни один маячок не считался актуальным.
      await prisma.interaction.create({
        data: {
          clientId: client.id,
          actorKind: "SYSTEM",
          subjectAgentId: agentId,
          type: "SYSTEM",
          notes: `noAnswerTail:${runId}`,
          nextActionDate: new Date(now.getTime() - 60_000),
        },
      });
    }

    const created = await processNoAnswerTailAnchors(now);
    expect(created).toBe(PER_TICK);

    const followUps = await prisma.interaction.findMany({
      where: { clientId: { in: tailClientIds }, nextAction: { startsWith: "Ещё раз попробовать дозвониться" } },
    });
    const byClient = new Map<string, number>();
    for (const row of followUps) byClient.set(row.clientId, (byClient.get(row.clientId) ?? 0) + 1);
    expect(byClient.size).toBe(PER_TICK);
    for (const count of byClient.values()) expect(count).toBe(1);

    // Ровно take:200 маячков закрыты этим тиком, остаток (50) ждёт следующего.
    const stillOpenAnchors = await prisma.interaction.count({
      where: { clientId: { in: tailClientIds }, notes: { startsWith: "noAnswerTail:" }, completedAt: null },
    });
    expect(stillOpenAnchors).toBe(BATCH - PER_TICK);
  }, 60_000);
});
