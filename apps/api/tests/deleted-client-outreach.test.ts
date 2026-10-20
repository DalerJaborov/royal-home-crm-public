import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { autoConnectDueCallback, connectCallbackToOperator } = await import("../src/lib/telephony/callbackConnect.js");
const { cancelClientCallbackRequests, loadPendingCallbackRequests } = await import("../src/lib/callbackRequests.js");
const { notifyAgentOfClientMessage } = await import("../src/lib/clientMessageAlert.js");
const { findClientDeliveryTarget, findClientDeliveryTargets } = await import("../src/lib/conversationDelivery.js");

/**
 * УДАЛЁННАЯ КАРТОЧКА — НЕ АДРЕСАТ (27.08.2026, вторая волна сплошной охоты).
 *
 * Общий класс: клиента убрали в Корзину, а шесть независимых путей продолжали
 * действовать так, будто он на месте — звонили ему, писали от лица бота, слали
 * агенту пуш о его сообщении. Каждый тест здесь воспроизводит ровно тот путь,
 * который нашла охота, и проверяет, что после правки Корзина — тупик, а не
 * прозрачная стена.
 */

let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture("WHATSAPP"); });

const runId = Date.now();

let agentId: string;
const clientIds: string[] = [];
const requestIds: string[] = [];

async function makeDeletedClient(name: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+992907${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      deletedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: "Оператор Корзины", phone: `+992964${runId}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.callbackRequest.deleteMany({ where: { id: { in: requestIds } } });
  // BotConversation.clientId не каскадирует при удалении клиента (нет onDelete в
  // схеме) — без явной чистки диалоги переживали клиента и накапливались в общей
  // тестовой базе. Ровно это сломало соседний tests/inbox.test.ts: его запросы
  // без фильтра по клиенту сортируют по lastMessageAt/updatedAt, и десятки
  // осиротевших диалогов с "updatedAt = только что" вытесняли из top-N записи с
  // датами прошлого месяца, на которые опирался тест.
  await fixture?.dispose();
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.delete({ where: { id: agentId } });
});

describe("Крон обратного звонка не набирает удалённого клиента", () => {
  /**
   * ТОЧНАЯ ПРОВЕРКА ФИЛЬТРА, А НЕ ПОБОЧНОГО ЭФФЕКТА. В тестовой среде дежурный
   * оператор не настроен (Settings.callbackOperatorAgentId пуст), поэтому ЛЮБАЯ
   * непустая очередь при отсутствии фильтра дошла бы до connectCallbackToOperator
   * и вернула бы "no_operator" — то же самое, что и правильное поведение "idle"
   * по внешнему виду ("не connected"). Различить старый и новый код можно только
   * по ТОЧНОМУ исходу: "idle" значит «в очереди для меня нет ни одной подходящей
   * записи» — фильтр отсеял единственную (удалённую) запись ДО похода за
   * оператором. "no_operator" значил бы, что фильтра нет и запись дошла до
   * следующего шага.
   */
  it("autoConnectDueCallback не видит просьбу, если карточка в Корзине — idle, а не no_operator", async () => {
    const client = await makeDeletedClient("Отозванный");
    const req = await prisma.callbackRequest.create({
      data: { clientId: client.id, phone: client.phone, channel: "INSTAGRAM", topic: `Тест ${runId}` },
    });
    requestIds.push(req.id);

    const outcome = await autoConnectDueCallback();
    expect(outcome).toBe("idle");
  });

  it("connectCallbackToOperator закрывает просьбу по удалённой карточке без набора", async () => {
    const client = await makeDeletedClient("Прямой-вызов");
    const req = await prisma.callbackRequest.create({
      data: { clientId: client.id, phone: client.phone, channel: "WHATSAPP", topic: `Тест ${runId}` },
    });
    requestIds.push(req.id);

    const outcome = await connectCallbackToOperator(req.id);
    // Никакого "connected" по мёртвой карточке — вне рабочего времени/без
    // оператора функция и так не звонит, но нас интересует именно ветка клиента.
    expect(outcome).not.toBe("connected");
  });
});

describe("Баннер и гашение просьб по удалённой карточке", () => {
  it("loadPendingCallbackRequests не отдаёт и сам закрывает просьбу с удалённым клиентом", async () => {
    const client = await makeDeletedClient("В-баннере");
    const req = await prisma.callbackRequest.create({
      data: { clientId: client.id, phone: client.phone, channel: "TELEGRAM", topic: `Тест ${runId}` },
    });
    requestIds.push(req.id);

    const items = await loadPendingCallbackRequests(50);
    expect(items.some((i) => i.id === req.id)).toBe(false);

    const fresh = await prisma.callbackRequest.findUnique({ where: { id: req.id } });
    expect(fresh?.doneAt).not.toBeNull();
  });

  it("cancelClientCallbackRequests гасит открытые просьбы клиента", async () => {
    const client = await makeDeletedClient("Гашение");
    const req = await prisma.callbackRequest.create({
      data: { clientId: client.id, phone: client.phone, channel: "FACEBOOK", topic: `Тест ${runId}` },
    });
    requestIds.push(req.id);

    const closed = await cancelClientCallbackRequests(client.id);
    expect(closed).toBe(1);
    const fresh = await prisma.callbackRequest.findUnique({ where: { id: req.id } });
    expect(fresh?.doneAt).not.toBeNull();
  });
});

describe("Бот не пишет и не пушит по удалённой карточке", () => {
  it("findClientDeliveryTarget не находит адрес доставки для удалённого клиента", async () => {
    const client = await makeDeletedClient("Молчащий");
    await prisma.botConversation.create({
      data: { clientId: client.id, channel: "WHATSAPP", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId, subscriberId: `sub-${runId}` },
    });

    const target = await findClientDeliveryTarget(client.id);
    expect(target).toBeNull();
  });

  it("findClientDeliveryTargets пропускает удалённых из пачки", async () => {
    const deleted = await makeDeletedClient("Пачка-удалён");
    const live = await prisma.client.create({
      data: { fullName: `Пачка-жив ${runId}`, phone: `+992908${runId}`, source: "PHONE_CALL", assignedAgentId: agentId },
    });
    clientIds.push(live.id);
    await prisma.botConversation.createMany({
      data: [
        { clientId: deleted.id, channel: "WHATSAPP", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId, subscriberId: `sub-d-${runId}` },
        { clientId: live.id, channel: "WHATSAPP", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId, subscriberId: `sub-l-${runId}` },
      ],
    });

    const targets = await findClientDeliveryTargets([deleted.id, live.id]);
    expect(targets.has(deleted.id)).toBe(false);
    expect(targets.has(live.id)).toBe(true);
  });

  it("push «клиент написал» не уходит по удалённой карточке", async () => {
    const client = await makeDeletedClient("Без-пуша");
    sendPushToAgent.mockClear();
    await notifyAgentOfClientMessage(client.id, "Здравствуйте, а квартира ещё продаётся?");
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });
});
