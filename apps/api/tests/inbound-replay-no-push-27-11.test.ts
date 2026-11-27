import { afterAll, beforeAll, expect, it, vi } from "vitest";

// ПОВТОР ХОДА НЕ ДУБЛИРУЕТ ПУШ АГЕНТУ (27.11.2026). Повтор «зависших» снова берёт клиентов с агентом
// (lib/stuckConversations.ts), а исключение 14.09.2026 держалось ровно на этом пуше: повтор шёл через
// applyInboundSideEffects без ключа события и раз в 30 минут слал агенту то же сообщение клиента.
// Повтор помечен replay: карточка и досье — как обычно, пуши агенту и хозяину объекта — нет.
const { notifyAgentOfClientMessage, notifyPropertyChatMessage } = vi.hoisted(() => ({
  notifyAgentOfClientMessage: vi.fn(async () => undefined), notifyPropertyChatMessage: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/clientMessageAlert.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientMessageAlert.js")>()), notifyAgentOfClientMessage,
}));
vi.mock("../src/lib/propertyChatMessageAlert.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/propertyChatMessageAlert.js")>()), notifyPropertyChatMessage,
}));

const { prisma } = await import("../src/db.js");
const { applyInboundSideEffects } = await import("../src/lib/inboundSideEffects.js");
const { ensureScopedBotConversation } = await import("../src/lib/customerConversationScope.js");

const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
let conversationId = "", clientId = "";
beforeAll(async () => {
  const client = await prisma.client.create({ data: { fullName: `Повтор ${runId}`, phone: `+99290${String(Date.now()).slice(-7)}`, source: "PHONE_CALL" } });
  clientId = client.id;
  const native = await prisma.$transaction((tx) => ensureScopedBotConversation(tx, { channel: "WEBSITE", subscriberId: `replay-${runId}` }));
  conversationId = native.id;
  await prisma.botConversation.update({ where: { id: conversationId }, data: { clientId } });
});
afterAll(async () => {
  await prisma.customerInquiry.deleteMany({ where: { conversationId } });
  await prisma.botConversation.deleteMany({ where: { id: conversationId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
});

it("живое сообщение — пуш агенту; повтор того же хода — без пуша", async () => {
  const base = { source: "legacy" as const, channel: "WEBSITE", peer: `replay-${runId}`, conversationId, text: "Нархаш чанд?" };
  await applyInboundSideEffects({ ...base, eventId: `live-${runId}` });
  expect(notifyAgentOfClientMessage).toHaveBeenCalledTimes(1);
  expect(notifyPropertyChatMessage).toHaveBeenCalledTimes(1);

  await applyInboundSideEffects({ ...base, eventId: null, replay: true });
  await applyInboundSideEffects({ ...base, eventId: null, replay: true });
  expect(notifyAgentOfClientMessage).toHaveBeenCalledTimes(1);
  expect(notifyPropertyChatMessage).toHaveBeenCalledTimes(1);
});
