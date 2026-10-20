import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { runPhoneLeadWatchdogTick } from "../src/lib/phoneLeadWatchdog.js";
import { findStuckConversations } from "../src/lib/stuckConversations.js";

/**
 * ПЕТЛЯ СТОРОЖА ЛИДОВ — АВАРИЯ НА ПРОДЕ 17.09.2026.
 *
 * Владелец увидел, как в шести живых переписках «клиент» шлёт один и тот же номер
 * ровно каждые 15 минут, а бот примерно каждые полчаса отвечает ему «Ташаккур,
 * рақаматонро қабул кардам…». Клиент написал: «Систематон сбой додагиай».
 *
 * Цепочка была такая:
 *  1. `phone-lead-watchdog` (каждые 15 минут) берёт диалоги без карточки, у которых
 *     в переписке есть номер, и зовёт `acceptLead` в тихом режиме;
 *  2. приём дописывал `clientText` в СОХРАНЁННУЮ историю как новую реплику клиента
 *     и двигал `lastMessageAt` — то есть сам продлевал окно сторожа;
 *  3. с 17.09.2026 разговор о работе карточки клиента не заводит вовсе (это анкета
 *     кандидата), поэтому `clientId` оставался пустым НАВСЕГДА — и шаг 1 повторялся
 *     бесконечно, каждые 15 минут, дописывая ещё одну поддельную реплику;
 *  4. а раз последней в истории всегда оказывалась реплика клиента, диалог попадал
 *     в `findStuckConversations` (health-automation, раз в 30 минут) — и бот
 *     «отвечал» клиенту на подделку, уже по-настоящему, через Meta.
 *
 * За сутки история диалога (потолок 40 реплик) оказалась целиком забита повторами
 * одного номера — настоящий разговор из неё вытеснился.
 *
 * Тест держит все четыре узла разом, потому что чинить их по одному бессмысленно:
 * достаточно одного уцелевшего, чтобы рассылка продолжилась.
 */

const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const PHONE = `9${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

const conversationIds: string[] = [];

async function seedCandidateConversation(input: { intent?: string }): Promise<string> {
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `watchdog-loop-${runId}-${Math.random().toString(36).slice(2, 7)}`,
      name: `Кандидат петли ${runId}`,
      messages: [
        { role: "user", content: "Салом, кор ҳаст?", at: new Date().toISOString() },
        { role: "assistant", content: "Бале, мо агентони фурӯшро ба кор мегирем.", at: new Date().toISOString() },
        { role: "user", content: `Рақамам ${PHONE}`, at: new Date().toISOString() },
      ] as never,
      leadDraft: { stage: "chatting", ...(input.intent ? { intent: input.intent } : {}) } as never,
      lastMessageAt: new Date(),
    },
    select: { id: true },
  });
  conversationIds.push(conv.id);
  return conv.id;
}

async function storedMessages(id: string): Promise<{ role: string; content: string }[]> {
  const conv = await prisma.botConversation.findUnique({ where: { id }, select: { messages: true } });
  return (Array.isArray(conv?.messages) ? conv.messages : []) as { role: string; content: string }[];
}

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
});

afterAll(async () => {
  const convs = await prisma.botConversation.findMany({
    where: { id: { in: conversationIds } },
    select: { id: true, clientId: true },
  });
  const clientIds = convs.map((c) => c.clientId).filter((c): c is string => !!c);
  await prisma.jobApplication.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.notification.deleteMany({
    where: { url: { in: conversationIds.map((id) => `/messages?open=${id}`) } },
  });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  if (clientIds.length > 0) {
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  }
});

describe("Сторож лидов не зацикливается на диалоге без карточки", () => {
  it("кандидат с номером: сторож не дописывает реплику и не повторяет приём на втором тике", async () => {
    const id = await seedCandidateConversation({ intent: "job" });
    const before = await storedMessages(id);

    await runPhoneLeadWatchdogTick();
    const afterFirst = await storedMessages(id);
    // Главное: переписка НЕ ВЫРОСЛА. Именно лишняя реплика с номером и запускала
    // всю цепочку — и она же вытеснила настоящий разговор из истории на проде.
    expect(afterFirst).toHaveLength(before.length);
    expect(afterFirst.filter((m) => m.content.includes(PHONE))).toHaveLength(1);

    // Второй тик (через 15 минут на проде) обязан пройти мимо: карточки у разговора
    // о работе не будет никогда, а значит повторять приём — это петля, а не попытка.
    await runPhoneLeadWatchdogTick();
    const afterSecond = await storedMessages(id);
    expect(afterSecond).toHaveLength(before.length);
  });

  it("одна попытка автоприёма на диалог — второй тик диалог уже не берёт", async () => {
    const id = await seedCandidateConversation({});

    await runPhoneLeadWatchdogTick();
    const conv = await prisma.botConversation.findUnique({
      where: { id },
      select: { watchdogAttemptedAt: true, lastMessageAt: true },
    });
    // Отметка стоит — сколько бы ни было следующих тиков, этот диалог им не достанется.
    expect(conv?.watchdogAttemptedAt).toBeTruthy();

    const lastMessageAt = conv?.lastMessageAt?.getTime();
    await runPhoneLeadWatchdogTick();
    const again = await prisma.botConversation.findUnique({
      where: { id },
      select: { watchdogAttemptedAt: true, lastMessageAt: true },
    });
    // И окно сторожа не продлевается само собой: lastMessageAt стоит на месте.
    expect(again?.lastMessageAt?.getTime()).toBe(lastMessageAt);
    expect(again?.watchdogAttemptedAt?.getTime()).toBe(conv?.watchdogAttemptedAt?.getTime());
  });

  it("реплику, записанную вместо молчания бота, повтор зависших не подхватывает", async () => {
    // Тихий приём (бот намеренно молчит, а номер оформляют) помечает реплику
    // клиента `silentCapture`. Без пометки такой диалог выглядел как «клиент
    // написал, бот не ответил» — и health-automation заставлял бота заговорить
    // поверх молчания, о котором решение уже принято.
    const conv = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `watchdog-loop-silent-${runId}`,
        name: `Тихий приём ${runId}`,
        messages: [
          { role: "assistant", content: "Салом! Чӣ хизмат?", at: new Date().toISOString() },
          { role: "user", content: `Рақамам ${PHONE}`, at: new Date().toISOString(), silentCapture: true },
        ] as never,
        leadDraft: { stage: "chatting" } as never,
        lastMessageAt: new Date(),
      },
      select: { id: true },
    });
    conversationIds.push(conv.id);

    const stuck = await findStuckConversations();
    expect(stuck.map((s) => s.id)).not.toContain(conv.id);
  });
});
