import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { prisma } = await import("../src/db.js");
const { collectCandidates, rankAndPick, snapshotTimeline } = await import(
  "../src/lib/insightDigest.js"
);

/**
 * Тесты серверной логики отбора кейсов для «Инсайтов от ИИ» (аудит 02.09 §4.2).
 *
 * Проверяем:
 *   1. collectCandidates возвращает кандидатов из всех четырёх источников
 *   2. rankAndPick соблюдает квоты (≤3 на агента, ≥3 голосовых, ≥1 положительный)
 *   3. snapshotTimeline маскирует телефоны в тексте и метаданных
 */

const runId = Date.now();
let agent1Id: string;
let agent2Id: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];
const callAnalysisIds: string[] = [];
const scoreEventIds: string[] = [];
const botFindingIds: string[] = [];
let botConvId: string;
const extraBotConvIds: string[] = [];
const extraTgConvIds: string[] = [];

async function makeClient(agentId: string, suffix: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент инсайт ${runId}-${suffix}`,
      phone: `+992963${runId}${suffix}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      workStatus: "ACTIVE",
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeCallInteraction(
  clientId: string,
  agentId: string,
  transcript: string,
) {
  const i = await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "CALL",
      notes: "Звонок для инсайта",
      transcript,
      recordingDurationSec: 120,
    },
  });
  interactionIds.push(i.id);
  return i;
}

beforeAll(async () => {
  // Создаём двух агентов
  const a1 = await prisma.agent.create({
    data: {
      fullName: `Агент инсайт А ${runId}`,
      phone: `+992964${runId}A`,
      role: "AGENT",
      passwordHash: "x",
    },
  });
  agent1Id = a1.id;

  const a2 = await prisma.agent.create({
    data: {
      fullName: `Агент инсайт Б ${runId}`,
      phone: `+992964${runId}B`,
      role: "AGENT",
      passwordHash: "x",
    },
  });
  agent2Id = a2.id;

  // --- Источник A: CallAnalysis с низким скором (5 штук) ---
  for (let i = 0; i < 5; i++) {
    const client = await makeClient(agent1Id, i);
    const interaction = await makeCallInteraction(
      client.id,
      agent1Id,
      `Клиент говорит что не interested в покупке +99291884455${i} и просит не звонить `.repeat(
        4,
      ),
    );
    const ca = await prisma.callAnalysis.create({
      data: {
        interactionId: interaction.id,
        agentId: agent1Id,
        score: 15 + i * 5, // 15, 20, 25, 30, 35 — все <= 40
        greeted: true,
        foundNeed: false,
        presentedValue: false,
        handledObjection: false,
        agreedNextStep: false,
        objections: ["дорого"],
        agreements: [],
        summary: `Разговор ${i}: клиент отказался`,
        coaching: "Нужно выявить потребность до презентации",
      },
    });
    callAnalysisIds.push(ca.id);
  }

  // --- Источник D: Положительные кейсы (2 штуки) ---
  for (let i = 0; i < 2; i++) {
    const client = await makeClient(agent2Id, 10 + i);
    const interaction = await makeCallInteraction(
      client.id,
      agent2Id,
      `Отличный разговор с клиентом по телефону +99290070401${i}, договорились о показе `.repeat(
        4,
      ),
    );
    const ca = await prisma.callAnalysis.create({
      data: {
        interactionId: interaction.id,
        agentId: agent2Id,
        score: 90 + i * 5, // 90, 95
        greeted: true,
        foundNeed: true,
        presentedValue: true,
        handledObjection: true,
        agreedNextStep: true,
        objections: [],
        agreements: ["показ завтра"],
        summary: `Отличный звонок ${i}`,
        coaching: "Продолжать в том же духе",
      },
    });
    callAnalysisIds.push(ca.id);
  }

  // --- Источник B: RoyalScoreEvent с отрицательной дельтой (3 штуки) ---
  const clientForScore = await makeClient(agent1Id, 20);
  for (let i = 0; i < 3; i++) {
    const kinds = [
      "client_lost_agent_fault",
      "mandatory_window_overdue",
      "showing_missed",
    ];
    const ev = await prisma.royalScoreEvent.create({
      data: {
        agentId: agent1Id,
        kind: kinds[i],
        delta: -(5 + i * 3), // -5, -8, -11
        reason: `Штраф за ${kinds[i]}: клиент +992910001005 ушёл`,
        // sourceId = id клиента напрямую НИКОГДА не встречается в реальном коде
        // (08.09.2026, разведка по мёртвому коду) — реальная схема для
        // client_lost_agent_fault: `client-lost-${clientId}`
        // (routes/clients/lifecycle.ts и три других места записи такого штрафа).
        // Старая фикстура (голый id) проверяла код, который никогда не совпадал
        // на проде, а не то, что реально происходит.
        sourceId: kinds[i] === "client_lost_agent_fault" ? `client-lost-${clientForScore.id}` : clientForScore.id,
      },
    });
    scoreEventIds.push(ev.id);
  }

  // --- Источник C: BotAuditFinding agent_bypassed_crm severity=high ---
  const clientForBypass = await makeClient(agent2Id, 30);
  const botConv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      // Настоящий идентификатор Instagram, а не телефон: клиент берётся из
      // BotConversation.clientId, поиск по phone=subscriberId ничего не находит.
      subscriberId: `ig-bypass-${runId}`,
      clientId: clientForBypass.id,
      messages: [
        { role: "user", content: "Хочу купить квартиру" },
        {
          role: "assistant",
          // Настоящая форма отправителя (MessageSender, conversationDelivery.ts).
          by: { kind: "agent", agentId: agent2Id, agentName: "Агент Б" },
          content: "Напишите мне в личку +992900111222, обсудим цену",
        },
        { role: "user", content: "Хорошо, напишу" },
      ] as unknown[],
    },
  });
  botConvId = botConv.id;

  const finding = await prisma.botAuditFinding.create({
    data: {
      conversationId: botConv.id,
      channel: "INSTAGRAM",
      type: "agent_bypassed_crm",
      quote: "Напишите мне в личку +992900111222",
      why: "Агент уводит клиента из CRM в личный мессенджер",
      severity: "high",
    },
  });
  botFindingIds.push(finding.id);
});

afterAll(async () => {
  await prisma.botAuditFinding.deleteMany({
    where: { id: { in: botFindingIds } },
  });
  await prisma.botConversation.deleteMany({ where: { id: { in: [botConvId, ...extraBotConvIds] } } });
  await prisma.telegramConversation.deleteMany({ where: { id: { in: extraTgConvIds } } });
  await prisma.royalScoreEvent.deleteMany({
    where: { id: { in: scoreEventIds } },
  });
  await prisma.callAnalysis.deleteMany({
    where: { id: { in: callAnalysisIds } },
  });
  await prisma.interaction.deleteMany({
    where: { id: { in: interactionIds } },
  });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({
    where: { id: { in: [agent1Id, agent2Id] } },
  });
});

describe("collectCandidates", () => {
  it("возвращает кандидатов из всех четырёх источников", async () => {
    const periodStart = new Date(Date.now() - 86400_000);
    const periodEnd = new Date(Date.now() + 86400_000);

    const candidates = await collectCandidates(periodStart, periodEnd);

    const kinds = new Set(candidates.map((c) => c.kind));
    expect(kinds.has("call_low_score")).toBe(true);
    expect(kinds.has("score_penalty")).toBe(true);
    expect(kinds.has("positive")).toBe(true);
    // Кейс обхода CRM: клиент берётся из BotConversation.clientId (HELPER-FINAL01).
    expect(kinds.has("agent_bypass")).toBe(true);

    // Минимум: 5 низких + 2 позитивных + 3 штрафа = 10 (bypass — бонус)
    const byKind = new Map<string, number>();
    for (const c of candidates) {
      byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
    }
    expect(byKind.get("call_low_score") ?? 0).toBeGreaterThanOrEqual(5);
    expect(byKind.get("positive") ?? 0).toBeGreaterThanOrEqual(2);
    expect(byKind.get("score_penalty") ?? 0).toBeGreaterThanOrEqual(1);
    expect(candidates.length).toBeGreaterThanOrEqual(8);
  });

  it("каждый кандидат имеет обязательные поля", async () => {
    const periodStart = new Date(Date.now() - 86400_000);
    const periodEnd = new Date(Date.now() + 86400_000);

    const candidates = await collectCandidates(periodStart, periodEnd);

    for (const c of candidates) {
      expect(c.kind).toBeTruthy();
      expect(c.sourceKey).toBeTruthy();
      expect(c.agentId).toBeTruthy();
      expect(c.clientId).toBeTruthy();
      expect(c.severity).toBeGreaterThanOrEqual(1);
      expect(c.severity).toBeLessThanOrEqual(5);
      expect(c.rankScore).toBeGreaterThan(0);
    }
  });
});

describe("rankAndPick", () => {
  it("соблюдает квоту ≤3 на одного агента", async () => {
    const periodStart = new Date(Date.now() - 86400_000);
    const periodEnd = new Date(Date.now() + 86400_000);

    const candidates = await collectCandidates(periodStart, periodEnd);
    const picked = rankAndPick(candidates);

    const agentCounts = new Map<string, number>();
    for (const c of picked) {
      // agent_bypass не считается в лимит
      if (c.kind === "agent_bypass") continue;
      agentCounts.set(c.agentId, (agentCounts.get(c.agentId) ?? 0) + 1);
    }

    for (const [, count] of agentCounts) {
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it("гарантирует минимум 3 голосовых кейса", async () => {
    const periodStart = new Date(Date.now() - 86400_000);
    const periodEnd = new Date(Date.now() + 86400_000);

    const candidates = await collectCandidates(periodStart, periodEnd);
    const picked = rankAndPick(candidates);

    const voiceCount = picked.filter(
      (c) => c.kind === "call_low_score",
    ).length;
    expect(voiceCount).toBeGreaterThanOrEqual(3);
  });

  it("гарантирует минимум 1 положительный кейс", async () => {
    const periodStart = new Date(Date.now() - 86400_000);
    const periodEnd = new Date(Date.now() + 86400_000);

    const candidates = await collectCandidates(periodStart, periodEnd);
    const picked = rankAndPick(candidates);

    const positiveCount = picked.filter((c) => c.kind === "positive").length;
    expect(positiveCount).toBeGreaterThanOrEqual(1);
  });

  it("возвращает от 6 до 12 кейсов когда достаточно кандидатов", async () => {
    const periodStart = new Date(Date.now() - 86400_000);
    const periodEnd = new Date(Date.now() + 86400_000);

    const candidates = await collectCandidates(periodStart, periodEnd);
    const picked = rankAndPick(candidates);

    expect(picked.length).toBeGreaterThanOrEqual(6);
    expect(picked.length).toBeLessThanOrEqual(12);
  });

  it("не допускает дубликатов по паре клиент+агент", async () => {
    const periodStart = new Date(Date.now() - 86400_000);
    const periodEnd = new Date(Date.now() + 86400_000);

    const candidates = await collectCandidates(periodStart, periodEnd);
    const picked = rankAndPick(candidates);

    const pairs = new Set<string>();
    for (const c of picked) {
      const key = `${c.clientId}:${c.agentId}`;
      expect(pairs.has(key)).toBe(false);
      pairs.add(key);
    }
  });
});

describe("snapshotTimeline", () => {
  it("маскирует телефоны в транскрипте звонка", async () => {
    const periodStart = new Date(Date.now() - 86400_000);
    const periodEnd = new Date(Date.now() + 86400_000);

    const candidates = await collectCandidates(periodStart, periodEnd);
    const voiceCandidate = candidates.find(
      (c) => c.kind === "call_low_score",
    );
    expect(voiceCandidate).toBeDefined();

    const snapshot = await snapshotTimeline(voiceCandidate!);

    // В транскрипте был номер +99291884455X — после маскировки его быть не должно
    const content = snapshot.content as string;
    expect(content).not.toMatch(/\+992\d{9}/);
    // Маскированный вид должен содержать символ •
    expect(content).toMatch(/•/);
  });

  it("маскирует телефоны в мета-данных agent_bypass", async () => {
    const periodStart = new Date(Date.now() - 86400_000);
    const periodEnd = new Date(Date.now() + 86400_000);

    const candidates = await collectCandidates(periodStart, periodEnd);
    const bypassCandidate = candidates.find(
      (c) => c.kind === "agent_bypass",
    );
    expect(bypassCandidate).toBeDefined();

    const snapshot = await snapshotTimeline(bypassCandidate!);

    // В meta.quote был номер +992900111222
    const metaQuote = (snapshot.meta as Record<string, unknown>).quote as string;
    expect(metaQuote).not.toMatch(/\+992\d{9}/);
    expect(metaQuote).toMatch(/•/);
  });

  it("возвращает корректную структуру для score_penalty", async () => {
    const periodStart = new Date(Date.now() - 86400_000);
    const periodEnd = new Date(Date.now() + 86400_000);

    const candidates = await collectCandidates(periodStart, periodEnd);
    const penaltyCandidate = candidates.find(
      (c) => c.kind === "score_penalty",
    );
    expect(penaltyCandidate).toBeDefined();

    const snapshot = await snapshotTimeline(penaltyCandidate!);

    expect(snapshot.kind).toBe("score_penalty");
    expect(typeof snapshot.content).toBe("string");
    expect((snapshot.meta as Record<string, unknown>).delta).toBeLessThan(0);
    expect((snapshot.meta as Record<string, unknown>).eventKind).toBeTruthy();
  });
});

/**
 * sourceId клиента-потери НЕ равен id клиента (08.09.2026, разведка по мёртвому
 * коду) — обособленный блок, свои фикстуры, чтобы не задевать общие данные выше.
 *
 * Обратный контроль: без починки в insightDigest.ts `client.findUnique({ where:
 * { id: e.sourceId } })` сравнивал `client-lost-<uuid>` (составной sourceId) с
 * id клиента напрямую — не совпадало никогда, и штрафы за потерю клиента (самые
 * тяжёлые кандидаты, вес ×3) не попадали в «Инсайты от ИИ» ни разу с момента
 * внедрения функции. Второй тест — на второй, более тонкий кусок починки:
 * префикс `client-lost-traffic-light-` длиннее и начинается с той же строки,
 * что `client-lost-`, и наивная проверка «покороче» забрала бы совпадение первой,
 * обрезав id неверно.
 */
describe("collectCandidates: sourceId штрафа за потерю клиента — составной ключ, не id", () => {
  const runId2 = Date.now() + 1;
  let agentId: string;
  let clientId: string;
  let clientTrafficLightId: string;
  const eventIds: string[] = [];

  beforeAll(async () => {
    const agent = await prisma.agent.create({
      data: { fullName: `Агент sourceId ${runId2}`, phone: `+99298${runId2.toString().slice(-7)}`, role: "AGENT", passwordHash: "x" },
    });
    agentId = agent.id;

    const client = await prisma.client.create({
      data: {
        fullName: `Клиент sourceId ${runId2}`,
        phone: `+992964${runId2}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
      },
    });
    clientId = client.id;

    const clientTL = await prisma.client.create({
      data: {
        fullName: `Клиент светофора ${runId2}`,
        phone: `+992965${runId2}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
      },
    });
    clientTrafficLightId = clientTL.id;

    const ev1 = await prisma.royalScoreEvent.create({
      data: {
        agentId,
        kind: "client_lost_agent_fault",
        delta: -5,
        reason: "тест: обычная потеря",
        sourceId: `client-lost-${clientId}`,
      },
    });
    // Тот же вид события, другая схема sourceId — через светофор неактивных
    // (lib/inactiveTrafficLight.ts), а не через ручную эскалацию.
    const ev2 = await prisma.royalScoreEvent.create({
      data: {
        agentId,
        kind: "client_lost_agent_fault",
        delta: -5,
        reason: "тест: потеря через светофор",
        sourceId: `client-lost-traffic-light-${clientTrafficLightId}`,
      },
    });
    eventIds.push(ev1.id, ev2.id);
  });

  afterAll(async () => {
    await prisma.royalScoreEvent.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.client.deleteMany({ where: { id: { in: [clientId, clientTrafficLightId] } } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
  });

  it("обычная потеря (client-lost-<id>) находит правильного клиента", async () => {
    const candidates = await collectCandidates(new Date(Date.now() - 86400_000), new Date(Date.now() + 86400_000));
    const found = candidates.find((c) => c.kind === "score_penalty" && c.clientId === clientId);
    expect(found).toBeDefined();
  });

  it("потеря через светофор (префикс длиннее и начинается с той же строки) не путает клиента", async () => {
    const candidates = await collectCandidates(new Date(Date.now() - 86400_000), new Date(Date.now() + 86400_000));
    const found = candidates.find((c) => c.kind === "score_penalty" && c.clientId === clientTrafficLightId);
    expect(found).toBeDefined();
    // Главная проверка: обрезка НЕ короче правильного id (не "traffic-light-<id>").
    expect(found!.clientId).toBe(clientTrafficLightId);
  });
});

describe("collectAgentBypasses: реальная форма сообщений (HELPER-FINAL01)", () => {
  const range = () => [new Date(Date.now() - 86400_000), new Date(Date.now() + 86400_000)] as const;

  it("бот ответил раньше агента: автором нарушения берётся агент, а не бот", async () => {
    const client = await makeClient(agent1Id, 41);
    const conv = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `ig-botfirst-${runId}`,
        clientId: client.id,
        messages: [
          { role: "user", content: "Здравствуйте" },
          { role: "assistant", by: { kind: "bot" }, content: "Добрый день! Чем помочь?" },
          { role: "assistant", by: { kind: "agent", agentId: agent1Id, agentName: "Агент А" }, content: "Пишите в Telegram" },
        ] as unknown[],
      },
    });
    extraBotConvIds.push(conv.id);
    const finding = await prisma.botAuditFinding.create({
      data: { conversationId: conv.id, channel: "INSTAGRAM", type: "agent_bypassed_crm", quote: "Пишите в Telegram", why: "уводит", severity: "high" },
    });
    botFindingIds.push(finding.id);

    const found = (await collectCandidates(...range())).find((c) => c.sourceKey === `audit:${finding.id}`);
    expect(found?.agentId).toBe(agent1Id);
    expect(found?.clientId).toBe(client.id);
  });

  it("находка по диалогу Telegram: клиент и агент берутся из TelegramConversation по её id", async () => {
    const client = await makeClient(agent1Id, 42);
    const tg = await prisma.telegramConversation.create({
      data: {
        chatId: `tg-bypass-${runId}`,
        clientId: client.id,
        messages: [
          { role: "user", content: "Здравствуйте" },
          { role: "assistant", by: { kind: "agent", agentId: agent1Id, agentName: "Агент А" }, content: "Давайте в WhatsApp" },
        ] as unknown[],
      },
    });
    extraTgConvIds.push(tg.id);
    const finding = await prisma.botAuditFinding.create({
      data: { conversationId: tg.id, channel: "TELEGRAM", type: "agent_bypassed_crm", quote: "Давайте в WhatsApp", why: "уводит", severity: "high" },
    });
    botFindingIds.push(finding.id);

    const found = (await collectCandidates(...range())).find((c) => c.sourceKey === `audit:${finding.id}`);
    expect(found?.agentId).toBe(agent1Id);
    expect(found?.clientId).toBe(client.id);
  });
});
