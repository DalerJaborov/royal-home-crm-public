import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { processMessengerTurn as actualProcessMessengerTurn } from "../src/messengers/conversation.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * КАРТОЧКА УДАЛЕНА, КЛИЕНТ СНОВА ПИШЕТ НОМЕР — ЗАЯВКА ОБЯЗАНА ВОСКРЕСНУТЬ
 * (ночная проверка 24.09.2026, «горячие файлы» №2).
 *
 * Отвязка диалога от удалённой карточки (messengers/conversation.ts) писала только
 * `clientId: null`, а стадия черновика оставалась `"done"` от прежней заявки.
 * Следующий номер в сообщении шёл в acceptLead, где атомарный захват хода
 * (`stage NOT IN ('done','accepting')`) забирал 0 строк — и приём выходил молча:
 * ни реплики клиента в переписке, ни карточки, ни строки в журнале. Telegram-бот
 * при той же отвязке стадию сбрасывает давно (telegram/bot.ts).
 *
 * Модель подменена: тест не должен ни платить за токены, ни зависеть от сети.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

let messengerFixture: CustomerMessengerFixture;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...messengerFixture.turnInput(input.subscriberId) });
}

const runId = Date.now().toString(36);
const SUBSCRIBER = `delclient-${runId}`;
/** Девять цифр — нормализуется в «+992…», как и настоящий номер клиента. */
const PHONE = `91${Date.now().toString().slice(-7)}`;

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;
let clientId: string;

beforeAll(async () => {
  messengerFixture = await createCustomerMessengerFixture("INSTAGRAM");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  // Окно склейки в ноль: предмет теста — приём номера, а не ожидание.
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 0 } });

  // A collision is not ownership: never delete another fixture's client.
  expect(await prisma.client.count({ where: { phone: `+992${PHONE}` } })).toBe(0);
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Удалённый клиент ${runId}`,
        phone: `+992${PHONE}`,
        source: "INSTAGRAM",
        acceptedAt: new Date(),
      },
    })
  ).id;
  // Диалог с уже оформленной заявкой: стадия «done», карточка привязана…
  await prisma.botConversation.update({
    where: { id: (await messengerFixture.ensureConversation(SUBSCRIBER)).id },
    data: {
      channel: "INSTAGRAM",
      subscriberId: SUBSCRIBER,
      clientId,
      leadDraft: { stage: "done" } as never,
      messages: [
        { role: "user", content: PHONE, at: new Date().toISOString() },
        { role: "assistant", content: "Ташаккур, агенти мо ба зудӣ тамос мегирад", by: { kind: "bot" }, at: new Date().toISOString() },
      ] as never,
    },
  });
  // …а потом карточку убрали в Корзину.
  await prisma.client.update({ where: { id: clientId }, data: { deletedAt: new Date() } });
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  const convs = await prisma.botConversation.findMany({
    where: { channel: "INSTAGRAM", subscriberId: { startsWith: SUBSCRIBER } },
    select: { id: true, clientId: true },
  });
  for (const c of convs) await prisma.errorLog.deleteMany({ where: { source: "ai", message: { contains: `диалог ${c.id}` } } });
  const ids = new Set<string>([clientId, ...convs.map((c) => c.clientId)].filter((id): id is string => Boolean(id)));
  await prisma.interaction.deleteMany({ where: { clientId: { in: [...ids] } } });
  await prisma.client.deleteMany({ where: { id: { in: [...ids] } } });
  await messengerFixture?.dispose();
});

beforeEach(() => {
  callAi.mockReset();
});

describe("Карточка удалена, клиент пишет номер снова", () => {
  it("номер сохраняется в переписку, карточка воскресает, бот отвечает", async () => {
    callAi.mockResolvedValue({ reply: "Ташаккур! Агенти мо ба зудӣ занг мезанад." });

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: SUBSCRIBER, text: PHONE });

    // Без починки: reply "" и shouldReply=false — захват хода дал 0 строк, ход вышел молча.
    expect(result.accepted).toBe(true);
    expect(result.shouldReply).not.toBe(false);
    expect(result.reply).not.toBe("");

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER },
      select: { clientId: true, messages: true, leadDraft: true },
    });
    // Диалог снова привязан к той же карточке — её достали из Корзины по номеру.
    expect(conv?.clientId).toBe(clientId);
    const revived = await prisma.client.findUnique({ where: { id: clientId }, select: { deletedAt: true } });
    expect(revived?.deletedAt).toBeNull();

    // Реплика клиента с номером — в переписке (второй раз, уже как новое сообщение).
    const messages = (Array.isArray(conv?.messages) ? conv!.messages : []) as { role: string; content: string }[];
    const withPhone = messages.filter((m) => m.role === "user" && m.content.includes(PHONE));
    expect(withPhone.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Стадия «done» без карточки осталась от старой отвязки", () => {
  it("захват хода не удался — реплика с номером всё равно в переписке, а в журнале строка", async () => {
    // Диалог, отвязанный ещё старым кодом: clientId пуст, стадия «done» не сброшена.
    const subscriber = `${SUBSCRIBER}-stale`;
    await prisma.botConversation.update({
    where: { id: (await messengerFixture.ensureConversation(subscriber)).id },
      data: {
        channel: "INSTAGRAM",
        subscriberId: subscriber,
        clientId: null,
        leadDraft: { stage: "done" } as never,
        messages: [
          { role: "assistant", content: "Ташаккур, агенти мо ба зудӣ тамос мегирад", by: { kind: "bot" }, at: new Date().toISOString() },
        ] as never,
      },
    });
    callAi.mockResolvedValue({ reply: "Ташаккур!" });
    const marker = `Салом, ${PHONE}`;
    // Стадию не трогает никто, кроме приёма: захват отдаст 0 строк.
    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: subscriber, text: marker });
    expect(result.shouldReply).toBe(false);

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: subscriber },
      select: { id: true, messages: true },
    });
    const messages = (Array.isArray(conv?.messages) ? conv!.messages : []) as { role: string; content: string }[];
    // Без починки: реплика клиента не сохранена (запись в acceptLead идёт после захвата).
    expect(messages.some((m) => m.role === "user" && m.content.includes(PHONE))).toBe(true);

    // Запись в журнал идёт «в отрыве» (void) — читаем через waitFor.
    const logged = await waitFor(
      () =>
        prisma.errorLog.findFirst({
          where: { source: "ai", message: { contains: `диалог ${conv!.id}` } },
          select: { id: true },
        }),
      { label: "строка журнала о несостоявшемся захвате" }
    );
    expect(logged).not.toBeNull();
  });
});
