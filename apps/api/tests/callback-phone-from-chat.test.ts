import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * НОМЕР ДЛЯ ОБРАТНОГО ЗВОНКА БЕРЁТСЯ ИЗ ПЕРЕПИСКИ (владелец 21.09.2026: «когда
 * просят оператора — можно взять номер телефона и автоматически соединить с
 * ведущим оператором, и всё это как обратный звонок»).
 *
 * Механизм соединения существовал с 16.08.2026, но почти никогда не срабатывал:
 * вызывающий телефон не передавал, а карточки клиента у написавшего обычно ещё
 * нет — соединение упиралось в «номера нет» и дежурный звонил руками, хотя номер
 * лежал сообщением выше.
 *
 * Берём ТОЛЬКО номер, названный самим человеком. wa_id не годится никогда: на нём
 * репозиторий уже обжигался 01.08.2026 — владелец написал боту со своего WhatsApp
 * и получил карточку с американским номером, по которому ему не звонят. Вместе с
 * номером из wa_id теряется и согласие.
 *
 * Соединение подменено: тест про то, какой номер попал в запрос, а не про АТС.
 */

const { connect } = vi.hoisted(() => ({ connect: vi.fn(async () => "no_operator" as const) }));
vi.mock("../src/lib/telephony/callbackConnect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/callbackConnect.js")>()),
  connectCallbackToOperator: connect,
}));

const { prisma } = await import("../src/db.js");
const { recordCallbackRequest, tryConnectPendingCallback } = await import("../src/lib/callbackRequests.js");

const runId = Date.now().toString(36).slice(-6);
/** Номер той же длины, что и у соседних файлов, и своей полосы — иначе столкнутся. */
const PHONE = `+992934${String(Date.now()).slice(-6)}`;
const conversationIds: string[] = [];

async function makeConversation(messages: { role: string; content: string }[]): Promise<string> {
  const row = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `cbphone-${runId}-${conversationIds.length}`,
      messages,
    },
    select: { id: true },
  });
  conversationIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  await prisma.callbackRequest.deleteMany({ where: { topic: { startsWith: `Тест номера ${runId}` } } });
});

afterAll(async () => {
  await prisma.callbackRequest.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
});

describe("обратный звонок: номер из переписки", () => {
  it("номер, названный человеком, попадает в запрос сам", async () => {
    const conversationId = await makeConversation([
      { role: "user", content: "Салом, есть двушка в Сино?" },
      { role: "assistant", content: "Есть несколько вариантов." },
      { role: "user", content: `Соедините с оператором, мой номер ${PHONE}` },
    ]);
    await recordCallbackRequest({
      conversationId,
      channel: "INSTAGRAM",
      topic: `Тест номера ${runId}: просит оператора`,
      // Человек прямо попросил оператора — только такая просьба набирает дежурного
      // (владелец 22.09.2026, см. ai/operatorHandoff.ts).
      byClientRequest: true,
    });
    const row = await prisma.callbackRequest.findFirstOrThrow({
      where: { conversationId },
      select: { phone: true },
    });
    expect(row.phone).not.toBeNull();
    // Сравниваем по последним девяти цифрам: запись нормализует форму номера.
    expect(row.phone!.replace(/\D/g, "").slice(-9)).toBe(PHONE.replace(/\D/g, "").slice(-9));
    // Просьба из переписки дежурного оператора через АТС НЕ набирает (владелец
    // 22.09.2026: оператору — только входящие на городской, переписка — агентам).
    expect(connect).not.toHaveBeenCalled();
  });

  it("переданный вызывающим номер главнее найденного в переписке", async () => {
    const conversationId = await makeConversation([{ role: "user", content: `старый номер ${PHONE}` }]);
    await recordCallbackRequest({
      conversationId,
      channel: "WHATSAPP",
      phone: "+992935000111",
      topic: `Тест номера ${runId}: явный номер`,
    });
    const row = await prisma.callbackRequest.findFirstOrThrow({
      where: { conversationId },
      select: { phone: true },
    });
    expect(row.phone).toBe("+992935000111");
  });

  it("чисел в переписке много, а номера нет — запрос остаётся без телефона", async () => {
    // Бюджет и площадь номером стать не должны: правило отбора строгое.
    const conversationId = await makeConversation([
      { role: "user", content: "бюджет 1 100 000 сомони, площадь 54" },
      { role: "user", content: "соедините с оператором" },
    ]);
    await recordCallbackRequest({
      conversationId,
      channel: "INSTAGRAM",
      topic: `Тест номера ${runId}: без номера`,
    });
    const row = await prisma.callbackRequest.findFirstOrThrow({
      where: { conversationId },
      select: { phone: true },
    });
    expect(row.phone).toBeNull();
  });

  it("номер, названный ПОСЛЕ просьбы, дозаполняет запрос", async () => {
    // Обычный порядок разговора: «соедините» → «хорошо, ваш номер?» → номер.
    const conversationId = await makeConversation([{ role: "user", content: "соедините с оператором" }]);
    await recordCallbackRequest({
      conversationId,
      channel: "INSTAGRAM",
      topic: `Тест номера ${runId}: номер позже`,
      byClientRequest: true,
    });
    let row = await prisma.callbackRequest.findFirstOrThrow({
      where: { conversationId },
      select: { id: true, phone: true },
    });
    expect(row.phone).toBeNull();

    await prisma.botConversation.update({
      where: { id: conversationId },
      data: {
        messages: [
          { role: "user", content: "соедините с оператором" },
          { role: "assistant", content: "Оставьте номер, пожалуйста." },
          { role: "user", content: PHONE },
        ],
      },
    });
    await tryConnectPendingCallback(conversationId, null);

    row = await prisma.callbackRequest.findFirstOrThrow({
      where: { conversationId },
      select: { id: true, phone: true },
    });
    expect(row.phone!.replace(/\D/g, "").slice(-9)).toBe(PHONE.replace(/\D/g, "").slice(-9));
  });
});
