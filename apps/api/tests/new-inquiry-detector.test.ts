import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * НОВЫЙ ПОВОД ОБРАТИТЬСЯ ОТ УЖЕ ПРИНЯТОГО КЛИЕНТА (владелец 19.08.2026).
 *
 * Бот на любое сообщение уже принятого клиента отвечает одной скупой фразой —
 * без этого детектора совсем другое дело («был продавцом, теперь покупатель»)
 * тонуло бы в общем «агент свяжется» или гасилось эмодзи-реакцией молча.
 */

const callAi = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi }));

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { detectNewInquiryFromKnownClient } = await import("../src/lib/newInquiryDetector.js");

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент нового запроса", phone: `+992898${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

async function makeClient(kind: "BUYER" | "SELLER") {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент детектора ${runId}-${clientIds.length}`,
      phone: `+992899${runId}${clientIds.length}`,
      source: "INSTAGRAM",
      kind,
      assignedAgentId: agentId,
    },
  });
  clientIds.push(c.id);
  return c;
}

describe("detectNewInquiryFromKnownClient", () => {
  it("явно новое дело — пишет заметку, пушит агента, меняет kind", async () => {
    const client = await makeClient("SELLER");
    callAi.mockResolvedValueOnce({
      isNewInquiry: true,
      kind: "BUYER",
      summary: "Хочет купить 2-комнатную в Сино",
    });

    await detectNewInquiryFromKnownClient(client.id, "Кстати, хочу купить квартиру в Сино, 2 комнаты");

    const note = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { startsWith: "Новый запрос клиента" } },
    });
    expect(note).not.toBeNull();
    expect(note?.notes).toContain("купить 2-комнатную");
    expect(note?.notes).toContain("Продавец → Покупатель");

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.kind).toBe("BUYER");

    const call = sendPushToAgent.mock.calls.find(([id]) => id === agentId);
    expect(call).toBeDefined();
    expect((call![1] as Record<string, string>).title).toContain("новом деле");
  });

  it("продолжение старого дела — ничего не пишет и не пушит", async () => {
    const client = await makeClient("BUYER");
    callAi.mockResolvedValueOnce({ isNewInquiry: false, summary: "Спрашивает про рассрочку" });
    sendPushToAgent.mockClear();

    await detectNewInquiryFromKnownClient(client.id, "А рассрочка у вас какая, на сколько месяцев?");

    const note = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { startsWith: "Новый запрос клиента" } },
    });
    expect(note).toBeNull();
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("короткая реплика без ключевых слов — модель вообще не вызывается", async () => {
    const client = await makeClient("BUYER");
    callAi.mockClear();

    await detectNewInquiryFromKnownClient(client.id, "Спасибо!");

    expect(callAi).not.toHaveBeenCalled();
  });
});
