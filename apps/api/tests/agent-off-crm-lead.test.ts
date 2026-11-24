import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * «СОТРУДНИК ЗОВЁТ КЛИЕНТА В ЛИЧНЫЙ КАНАЛ» БЕЗ ИИ (23.11.2026).
 *
 * Сигнал раньше давал только ночной судья диалогов (удалён с «Обучением бота»).
 * Теперь — шаблоны на отправке реплики сотрудника (lib/agentOffCrmLeadDetector.ts),
 * через ту же точку входа, что «агент спросил номер» (checkAgentPhoneAsk).
 *
 * Положение рубильника автоматики СБ подменяется только в этом файле; сигнал при
 * выключенной автоматике проверяется по вызову одной двери reportSecuritySignal.
 */
const automation = vi.hoisted(() => ({ on: false }));
const signals = vi.hoisted(() => ({ calls: [] as Array<{ source: string; what: string; dedupeKey: string; subjectAgentId: string | null }> }));
vi.mock("../src/lib/securityAutomation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/securityAutomation.js")>();
  return {
    ...actual,
    securityAutomationOn: async () => automation.on,
    reportSecuritySignal: async (input: Parameters<typeof actual.reportSecuritySignal>[0]) => {
      signals.calls.push({ source: input.source, what: input.what, dedupeKey: input.dedupeKey, subjectAgentId: input.subjectAgentId });
      return { notified: true };
    },
  };
});

const { prisma } = await import("../src/db.js");
const { detectOffCrmLead, checkAgentOffCrmLead } = await import("../src/lib/agentOffCrmLeadDetector.js");
const { checkAgentPhoneAsk } = await import("../src/lib/agentPhoneAskDetector.js");

describe("detectOffCrmLead: ловит личный канал сотрудника", () => {
  it.each([
    "Пишите мне в личку, там быстрее отвечу",
    "Напишите мне в ватсап, скину все фото",
    "напиши мне в WhatsApp",
    "Скиньте мне в телеграм документы",
    "Позвоните мне на мой номер, обсудим цену",
    "Пишите на мой личный номер",
    "Мой ватсап +992 900 000 012, пишите туда",
    "мой телеграм: @agent_rh",
    "Пишите в личку",
    "Ба ман дар ватсап нависед, суратҳоро мефиристам",
    "Ба ватсапи ман нависед",
    "Ба рақами ман занг занед",
    "napishite mne v whatsapp",
    "pishi v lichku",
    "Write me on WhatsApp please",
    "ba man dar whatsapp navised",
  ])("ловит: %s", (text) => {
    expect(detectOffCrmLead(text)).not.toBeNull();
  });
});

describe("detectOffCrmLead: не ловит канал компании и чужие слова", () => {
  it.each([
    // канал компании, не личный
    "Пишите нам в WhatsApp, ответим в течение часа",
    "Наш номер +992 900 000 013, звоните с 9 до 18",
    "Напишите в WhatsApp компании, там менеджер",
    "Напишите в WhatsApp",
    // клиентские вопросы и согласие (сюда не попадают по каналу, но и шаблон молчит)
    "Можно вам в ватсап написать?",
    "Хорошо, напишу вам в телеграм",
    // бытовое
    "Запишите, пожалуйста, адрес объекта",
    "Перезвоните мне на следующей неделе",
    "Добрый день! Фото объекта в карточке",
    "Ба мо нависед, ҷавоб медиҳем",
  ])("молчит: %s", (text) => {
    expect(detectOffCrmLead(text)).toBeNull();
  });
});

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let agentId: string;
const clientIds: string[] = [];

async function makeClient(extra: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Увод мимо CRM ${runId}-${clientIds.length}`,
      phone: `+992971${runId.slice(-6)}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      ...extra,
    } as never,
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  agentId = (await prisma.agent.create({
    data: { fullName: `Агент увода ${runId}`, phone: `+992972${runId.slice(-7)}`, role: "AGENT", passwordHash: "x" },
  })).id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("checkAgentOffCrmLead: действие по сигналу", () => {
  it("автоматика СБ выключена: сигнал в дело через одну дверь, карточка не меняется, номер в цитате скрыт", async () => {
    automation.on = false;
    signals.calls = [];
    const client = await makeClient();
    const fired = await checkAgentOffCrmLead({ agentId, clientId: client.id, channel: "text", text: "Мой ватсап +992 900 000 012, пишите туда" });
    expect(fired).toBe(true);
    expect(signals.calls).toHaveLength(1);
    expect(signals.calls[0].source).toBe("agent-off-crm-lead");
    expect(signals.calls[0].subjectAgentId).toBe(agentId);
    expect(signals.calls[0].what).not.toMatch(/900\s?000\s?012/);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id }, select: { securityReview: true } });
    expect(after.securityReview).not.toBe("PENDING");
  });

  it("автоматика СБ включена: карточка встаёт на проверку СБ", async () => {
    automation.on = true;
    signals.calls = [];
    const client = await makeClient();
    const fired = await checkAgentOffCrmLead({ agentId, clientId: client.id, channel: "voice", text: "Пишите мне в личку" });
    expect(fired).toBe(true);
    expect(signals.calls).toHaveLength(0);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id }, select: { securityReview: true, securityReviewRequestedAt: true } });
    expect(after.securityReview).toBe("PENDING");
    expect(after.securityReviewRequestedAt).not.toBeNull();
  });

  it("уже на проверке — второй раз не зовёт; обычная реплика — ничего", async () => {
    automation.on = false;
    signals.calls = [];
    const pending = await makeClient({ securityReview: "PENDING" });
    expect(await checkAgentOffCrmLead({ agentId, clientId: pending.id, channel: "text", text: "Пишите мне в личку" })).toBe(false);
    const plain = await makeClient();
    expect(await checkAgentOffCrmLead({ agentId, clientId: plain.id, channel: "text", text: "Пишите нам в WhatsApp" })).toBe(false);
    expect(signals.calls).toHaveLength(0);
  });

  it("точка входа checkAgentPhoneAsk: реплика клиенту проверяется, заметка и звонок — нет (там говорит и клиент)", async () => {
    automation.on = false;
    signals.calls = [];
    const client = await makeClient();
    for (const channel of ["comment", "call"] as const) {
      await checkAgentPhoneAsk({ agentId, agentName: "", clientId: client.id, clientName: null, channel, text: "Клиент: напишите мне в ватсап" });
    }
    expect(signals.calls).toHaveLength(0);
    await checkAgentPhoneAsk({ agentId, agentName: "", clientId: client.id, clientName: null, channel: "text", text: "Напишите мне в ватсап" });
    expect(signals.calls).toHaveLength(1);
  });
});
