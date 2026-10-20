import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ПЛАШКИ «КЛИЕНТ ПРОСИТ ЗВОНОК» НЕТ, ПРЯМАЯ ПРОСЬБА О ЧЕЛОВЕКЕ — ОДИН ПУШ
 * (владелец 24.09.2026).
 *
 * Плашку видели директор и админ, хотя звонить должен агент, и владелец её убрал:
 * «мне не нужна просьба позвонить и плашка». Но попросил не терять настоящие
 * просьбы: «если вдруг реально кто-то просит оператора или живого человека, пуш
 * подключить». Проверяем notifyHumanAsk (lib/callbackRequests.ts): кому уходит,
 * что «перезвоните» не считается просьбой о человеке и что повтор не шлёт второй пуш.
 */

const { pushed } = vi.hoisted(() => ({ pushed: vi.fn(async () => undefined) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: pushed,
}));

const { prisma } = await import("../src/db.js");
const { notifyHumanAsk } = await import("../src/lib/callbackRequests.js");
const { clientAskedForOperator } = await import("../src/ai/operatorHandoff.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now().toString(36).slice(-6);
const conversationIds: string[] = [];
const clientIds: string[] = [];
let operatorId = "";
let ownerAgentId = "";
let settingsBefore: string | null = null;

async function makeConversation(): Promise<string> {
  const row = await prisma.botConversation.create({
    data: { channel: "WHATSAPP", subscriberId: `humanask-${runId}-${conversationIds.length}`, messages: [] },
    select: { id: true },
  });
  conversationIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  operatorId = await createTestAgent(`Дежурный ${runId}`);
  ownerAgentId = await createTestAgent(`Агент клиента ${runId}`);
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { callbackOperatorAgentId: true },
  });
  settingsBefore = settings?.callbackOperatorAgentId ?? null;
  await prisma.settings.update({ where: { id: "singleton" }, data: { callbackOperatorAgentId: operatorId } });
});

afterAll(async () => {
  await prisma.settings
    .update({ where: { id: "singleton" }, data: { callbackOperatorAgentId: settingsBefore } })
    .catch(() => {});
  await prisma.callbackRequest.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([operatorId, ownerAgentId]);
});

beforeEach(() => {
  pushed.mockClear();
});

describe("clientAskedForOperator — просьба о человеке в любом падеже", () => {
  it.each(["хочу поговорить с живым человеком", "передайте живому человеку", "дайте живого человека", "оператор"])(
    "ловит: %s",
    (text) => {
      expect(clientAskedForOperator([text])).toBe(true);
    }
  );
  it.each(["перезвоните мне", "мой номер 931234567", "живу в Сино"])("не ловит: %s", (text) => {
    expect(clientAskedForOperator([text])).toBe(false);
  });
});

describe("notifyHumanAsk — прямая просьба о живом человеке", () => {
  it("«перезвоните» — не просьба о человеке: ни пуша, ни записи", async () => {
    const conversationId = await makeConversation();
    const outcome = await notifyHumanAsk({
      conversationId,
      clientId: null,
      channel: "WHATSAPP",
      topic: "по квартире",
      clientText: "перезвоните мне пожалуйста",
    });
    expect(outcome).toBe("not_asked");
    expect(pushed).not.toHaveBeenCalled();
    expect(await prisma.callbackRequest.count({ where: { conversationId } })).toBe(0);
  });

  it("клиент без агента просит оператора — один пуш дежурному, повтор не шлёт второй", async () => {
    const conversationId = await makeConversation();
    const input = {
      conversationId,
      clientId: null,
      channel: "WHATSAPP",
      topic: "хочет поговорить о покупке",
      clientText: "Соедините с оператором",
    };
    expect(await notifyHumanAsk(input)).toBe("sent");
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(pushed).toHaveBeenCalledWith(
      operatorId,
      expect.objectContaining({ title: "🙋 Клиент просит живого человека" })
    );

    expect(await notifyHumanAsk({ ...input, clientText: "оператор?" })).toBe("duplicate");
    expect(pushed).toHaveBeenCalledTimes(1);
  });

  it("у клиента есть свой агент — пуш ему, а не дежурному", async () => {
    const conversationId = await makeConversation();
    const client = await prisma.client.create({
      data: {
        fullName: `Клиент ${runId}`,
        phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
        source: "WHATSAPP",
        assignedAgentId: ownerAgentId,
      },
    });
    clientIds.push(client.id);
    const outcome = await notifyHumanAsk({
      conversationId,
      clientId: client.id,
      channel: "WHATSAPP",
      topic: "по продаже",
      clientText: "хочу поговорить с живым человеком",
    });
    expect(outcome).toBe("sent");
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(pushed).toHaveBeenCalledWith(ownerAgentId, expect.anything());
  });
});
