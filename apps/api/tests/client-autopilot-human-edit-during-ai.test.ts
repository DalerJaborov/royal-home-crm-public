import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * АВТОПИЛОТ ПОВЕРХ ПРАВКИ АГЕНТА, СДЕЛАННОЙ ПОКА ИИ ДУМАЛ (аудит Codex 04.10.2026,
 * находка №5). `runClientAutopilot` читал снимок карточки один раз, считал по нему
 * «поле пусто» и «имя — заглушка», потом секунды ждал платный `buildCardFillSuggestion`
 * и писал безусловным `update`: бюджет, вписанный агентом в это окно, перезаписывался,
 * а имя, переименованное руками, нарушало правило файла «поверх человека никогда».
 * Если за то же окно агент сменил валюту на USD, а бюджет остался пустым, в долларовую
 * карточку ложилась сумма в сомони без пересчёта.
 *
 * Окно — управляемый deferred на `buildCardFillSuggestion`.
 */
const hooks = vi.hoisted(() => ({
  gate: null as null | Promise<unknown>,
  called: 0,
}));

vi.mock("../src/ai/cardFill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/cardFill.js")>()),
  buildCardFillSuggestion: async () => {
    hooks.called++;
    return hooks.gate;
  },
}));
const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

const { prisma } = await import("../src/db.js");
const { runClientAutopilot } = await import("../src/lib/clientAutopilot.js");

const runId = Date.now();
let agentId = "";
const clientIds: string[] = [];

const EMPTY_SUGGESTION = {
  budgetMin: null,
  budgetMax: null,
  address: null,
  districtId: null,
  rooms: null,
  type: null,
  notes: null,
  clientName: null,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Ждём, пока автопилот прочитал снимок и дошёл до вызова ИИ — это и есть окно гонки. */
async function waitForAiCall(before: number) {
  for (let i = 0; i < 300 && hooks.called === before; i++) await new Promise((r) => setTimeout(r, 10));
  if (hooks.called === before) throw new Error("автопилот не дошёл до вызова ИИ");
}

async function makeClient(label: string, data: Record<string, unknown> = {}) {
  const client = await prisma.client.create({
    data: {
      fullName: `Покупатель №${String(runId).slice(-4)}${clientIds.length}`,
      phone: `+9925${clientIds.length}${label.length}${runId}`,
      source: "WHATSAPP",
      assignedAgentId: agentId,
      currency: "TJS",
      acceptedAt: new Date(),
      ...data,
    },
  });
  clientIds.push(client.id);
  return client.id;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент автопилота ${runId}`, phone: `+992918${String(runId).slice(-6)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

beforeEach(() => {
  callAiText.mockReset();
  callAiText.mockResolvedValue({ score: 50, reason: "Тест" });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("автопилот карточки: человек правил, пока ИИ отвечал", () => {
  it("бюджет и имя, вписанные агентом за время ответа ИИ, не затираются", async () => {
    const id = await makeClient("а");
    const gate = deferred<unknown>();
    const before = hooks.called;
    hooks.gate = gate.promise;
    const run = runClientAutopilot(id, "agent_changed");
    await waitForAiCall(before);

    await prisma.client.update({ where: { id }, data: { budgetMax: 600000, fullName: "Ручное" } });
    gate.resolve({ ...EMPTY_SUGGESTION, budgetMax: 500000, clientName: "Догадка" });
    const result = await run;

    const after = await prisma.client.findUnique({ where: { id } });
    expect(Number(after?.budgetMax)).toBe(600000);
    expect(after?.fullName).toBe("Ручное");
    expect(result.filled).not.toContain("budgetMax");
    expect(result.filled).not.toContain("fullName");
  });

  it("агент сменил валюту на USD за время ответа ИИ — сумма в сомони в карточку не ложится", async () => {
    const id = await makeClient("б", { fullName: "Настоящее Имя Клиента" });
    const gate = deferred<unknown>();
    const before = hooks.called;
    hooks.gate = gate.promise;
    const run = runClientAutopilot(id, "agent_changed");
    await waitForAiCall(before);

    await prisma.client.update({ where: { id }, data: { currency: "USD" } });
    gate.resolve({ ...EMPTY_SUGGESTION, budgetMax: 500000, rooms: 2 });
    const result = await run;

    const after = await prisma.client.findUnique({ where: { id } });
    expect(after?.budgetMax).toBeNull();
    expect(result.filled).not.toContain("budgetMax");
    // Остальное поле, не зависящее от валюты, заполняется как прежде.
    expect(after?.desiredRooms).toBe(2);
  });

  it("без вмешательства человека пустые поля и заглушка заполняются как прежде", async () => {
    const id = await makeClient("в");
    hooks.gate = Promise.resolve({ ...EMPTY_SUGGESTION, budgetMax: 500000, clientName: "Алишер Каримов", rooms: 3 });
    const result = await runClientAutopilot(id, "agent_changed");

    const after = await prisma.client.findUnique({ where: { id } });
    expect(Number(after?.budgetMax)).toBe(500000);
    expect(after?.fullName).toBe("Алишер Каримов");
    expect(after?.desiredRooms).toBe(3);
    expect(result.filled).toEqual(expect.arrayContaining(["budgetMax", "fullName", "desiredRooms"]));
  });
});
