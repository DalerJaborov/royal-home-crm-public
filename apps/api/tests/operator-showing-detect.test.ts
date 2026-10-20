import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Агент договаривается о показе ВРУЧНУЮ (диалог передан ему целиком, бот на
 * длинной паузе) — до 18.08.2026 такая договорённость не превращалась в запись
 * показа сама: агенту приходилось идти в календарь руками. Хук в
 * conversationDelivery.ts вызывает лёгкий классификатор (lib/operatorShowingDetector.ts)
 * после КАЖДОГО ручного ответа агента и, если в переписке есть явная
 * договорённость, назначает показ той же функцией, которой пользуется бот
 * (showingBooking.ts) — со всей её защитой от дублей.
 */

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

const { prisma } = await import("../src/db.js");
const { detectOperatorShowingAgreement } = await import("../src/lib/operatorShowingDetector.js");

const runId = Date.now();
let districtId: string;
let agentId: string;
let clientId: string;
let propertyId: string;
let propertyShortId: number;
let conversationId: string;

/** Фоновая часть (bookShowing) не ожидается вызывающим кодом — даём ей тик. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 250));

async function makeConversation(messages: unknown[]) {
  // clientId уникален на BotConversation — предыдущий диалог того же клиента убираем.
  await prisma.botConversation.deleteMany({ where: { clientId } });
  const conv = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `sub-${runId}-${Math.random()}`,
      clientId,
      messages: messages as any,
    },
  });
  conversationId = conv.id;
  return conv;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-ручной-показ-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент ручного показа", phone: `+992961${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент ручного показа ${runId}`,
        phone: `+992962${runId}`,
        source: "WHATSAPP",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  const property = await prisma.property.create({
    data: {
      title: `Объект ручного показа ${runId}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 300000,
      currency: "TJS",
      districtId,
      address: `Тестовая ручная, ${runId}`,
      condition: "GOOD",
      assignedAgentId: agentId,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;
});

beforeEach(async () => {
  sendPushToAgent.mockClear();
  callAiText.mockReset();
  await prisma.interaction.deleteMany({ where: { clientId } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.botConversation.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

// Функция, а не константа: agentId присваивается асинхронно в beforeAll, которая
// выполняется ПОСЛЕ вычисления модульных const — захваченное здесь значение было бы
// undefined. Найдено 20.08.2026 при добавлении actor в detectOperatorShowingAgreement:
// раньше agentId у отправителя нигде не читался, и баг ничем себя не проявлял.
function agentSender() {
  return { kind: "agent" as const, agentId, agentName: "Агент ручного показа" };
}

describe("Разбор договорённости о показе в ручном ответе агента", () => {
  it("чёткая договорённость о времени — показ создаётся", async () => {
    await makeConversation([
      { role: "user", content: `Здравствуйте, хочу посмотреть объект [код ${propertyShortId}]` },
      {
        role: "assistant",
        content: "Давайте завтра в 17:00 у вас на объекте?",
        by: agentSender(),
      },
      { role: "user", content: "Да, подходит, буду завтра в 17:00" },
    ]);
    callAiText.mockResolvedValueOnce({
      found: true,
      day: "tomorrow",
      time: "17:00",
      propertyCode: propertyShortId,
    });

    const target = { kind: "bot" as const, id: conversationId, channel: "WHATSAPP", subscriberId: "x", accountId: null };
    await detectOperatorShowingAgreement(target, "Давайте завтра в 17:00 у вас на объекте?", agentSender());
    await flush();

    expect(callAiText).toHaveBeenCalledTimes(1);
    const showing = await prisma.interaction.findFirst({ where: { clientId, type: "SHOWING" } });
    expect(showing).not.toBeNull();
    expect(showing?.propertyId).toBe(propertyId);
    expect(showing?.nextAction).toBe("Показ объекта");

    // Найдено 20.08.2026: договорился сам агент вручную, а не бот по словам клиента —
    // запись обязана называть его, а не приписывать договорённость боту.
    expect(showing?.notes).toContain("по переписке агента");
    expect(showing?.notes).toContain(agentSender().agentName);
    expect(showing?.notes).not.toContain("ботом");
    // И агент не должен получить push «Бот назначил показ» о действии, которое он
    // только что сделал сам руками — та же защита, что уже есть у переноса/отмены
    // (pushTarget в showingBooking.ts), теперь и у самой первой записи показа.
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("без договорённости — ИИ вообще не вызывается (эвристика отсекла), показ не создаётся", async () => {
    await makeConversation([
      { role: "user", content: "Здравствуйте, какая у вас комиссия?" },
      { role: "assistant", content: "Комиссия 0% для покупателя, всё оплачивает собственник.", by: agentSender() },
    ]);

    const target = { kind: "bot" as const, id: conversationId, channel: "WHATSAPP", subscriberId: "x", accountId: null };
    await detectOperatorShowingAgreement(
      target,
      "Комиссия 0% для покупателя, всё оплачивает собственник.",
      agentSender()
    );
    await flush();

    expect(callAiText).not.toHaveBeenCalled();
    const showing = await prisma.interaction.findFirst({ where: { clientId, type: "SHOWING" } });
    expect(showing).toBeNull();
  });

  it("слова о времени есть, но твёрдой договорённости нет — модель отвечает found=false, показ не создаётся", async () => {
    await makeConversation([
      { role: "user", content: "А когда вообще можно приехать посмотреть, может в четверг?" },
      { role: "assistant", content: "Можем в четверг, скажите какое время вам удобнее.", by: agentSender() },
    ]);
    callAiText.mockResolvedValueOnce({ found: false });

    const target = { kind: "bot" as const, id: conversationId, channel: "WHATSAPP", subscriberId: "x", accountId: null };
    await detectOperatorShowingAgreement(target, "Можем в четверг, скажите какое время вам удобнее.", agentSender());
    await flush();

    expect(callAiText).toHaveBeenCalledTimes(1);
    const showing = await prisma.interaction.findFirst({ where: { clientId, type: "SHOWING" } });
    expect(showing).toBeNull();
  });

  it("показ на эту дату/время уже назначен — второй не заводится (та же защита, что и у бота)", async () => {
    await makeConversation([
      { role: "user", content: "Хорошо, тогда до завтра" },
      { role: "assistant", content: "Договорились, завтра в 18:00 жду вас на объекте.", by: agentSender() },
    ]);
    callAiText.mockResolvedValue({ found: true, day: "tomorrow", time: "18:00", propertyCode: propertyShortId });

    const target = { kind: "bot" as const, id: conversationId, channel: "WHATSAPP", subscriberId: "x", accountId: null };
    await detectOperatorShowingAgreement(target, "Договорились, завтра в 18:00 жду вас на объекте.", agentSender());
    await flush();
    const firstCount = await prisma.interaction.count({ where: { clientId, type: "SHOWING" } });
    expect(firstCount).toBe(1);

    // Та же договорённость приходит ещё раз (например повторная реплика/повторный
    // ход) — bookShowing узнаёт то же время как уже назначенное и не плодит вторую запись.
    await detectOperatorShowingAgreement(target, "Договорились, завтра в 18:00 жду вас на объекте.", agentSender());
    await flush();
    expect(await prisma.interaction.count({ where: { clientId, type: "SHOWING" } })).toBe(firstCount);
  });

  it("ответ не от агента (сам бот/служебная рассылка) — классификатор не запускается", async () => {
    await makeConversation([{ role: "assistant", content: "Завтра в 17:00 у вас на объекте, до встречи!" }]);

    const target = { kind: "bot" as const, id: conversationId, channel: "WHATSAPP", subscriberId: "x", accountId: null };
    await detectOperatorShowingAgreement(target, "Завтра в 17:00 у вас на объекте, до встречи!", { kind: "system" });
    await flush();

    expect(callAiText).not.toHaveBeenCalled();
    expect(await prisma.interaction.count({ where: { clientId, type: "SHOWING" } })).toBe(0);
  });
});
