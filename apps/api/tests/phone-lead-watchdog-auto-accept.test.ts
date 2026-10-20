import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { runPhoneLeadWatchdogTick } from "../src/lib/phoneLeadWatchdog.js";

/**
 * СТОРОЖ «НОМЕР ЕСТЬ — КАРТОЧКИ НЕТ» ЗАВОДИТ КАРТОЧКУ САМ (ступень 4, 03.09.2026).
 *
 * Владелец: «я не хочу каждый раз делать такое руками». До этого сторож только
 * звал руководство, то есть превращал сбой приёма в ручную работу — и тем большую,
 * чем хуже работает приём.
 *
 * Проверяем ровно границу «где решает код, а где человек»:
 *  1. читаемый номер в живой переписке — карточка появляется сама, без сигнала;
 *  2. диалог помечен как рассылка — карточки нет, зовём человека (спамеру карточку
 *     заводить нельзя, и решать это не фоновому заданию);
 *  3. номер не разобрался («00 000 10 08») — карточки нет, зовём человека.
 *
 * Модель не подменяем нарочно: приём идёт в тихом режиме (silent), а он ходов
 * модели не делает вовсе — если бы делал, тест платил бы за токены и падал без сети.
 */

const runId = Date.now().toString(36);
const SUB = `watchdog-${runId}`;
/** Хвост номера уникален на прогон: телефон в CRM уникален глобально, и повторный
 *  прогон не должен спотыкаться о карточку, созданную предыдущим. */
const PHONE_DIGITS = `9${String(Date.now()).slice(-8)}`;
/**
 * Номер для диалога-рассылки. ОТДЕЛЬНОЙ КОНСТАНТОЙ, А НЕ `PHONE_DIGITS.slice(0, 8) + "1"`
 * (11.09.2026, поймано красным CI на main — и выкат из-за него сутки не ехал).
 *
 * Прежняя запись подменяла последнюю цифру единицей, то есть В КАЖДОМ ДЕСЯТОМ
 * прогоне — когда `Date.now()` оканчивается на 1 — давала РОВНО тот же номер, что
 * у диалога из первого теста. А сторож на уровне 2 привязывает диалог к уже
 * известной карточке независимо от пометки «рассылка» (это данные, а не приём
 * заявки), и `clientId` переставал быть пустым. Тест падал раз в десять прогонов
 * и выглядел как поломка продукта, хотя ломались сами данные теста.
 */
// Номер рассылки независим от номера живого клиента И от часов: производная от
// Date.now() у двух прогонов в одну миллисекунду совпадает, а сторож привязывает
// «рассылку» к чужой карточке по хвосту номера (падение CI main 11.09).
const SPAM_PHONE_DIGITS = `9${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

const conversationIds: string[] = [];
const clientIds: string[] = [];

async function seedConversation(input: {
  suffix: string;
  text: string;
  spam?: boolean;
  /** Своё состояние черновика (зависший захват приёма и т.п.). */
  leadDraft?: Record<string, unknown>;
}): Promise<string> {
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      // Хвост случайный на КАЖДЫЙ вызов, а не на модуль: `retry: 1` в CI перезапускает
      // упавший тест в том же модуле, и с общим хвостом повтор падал на уникальном
      // ключе (channel, subscriberId) о диалог первой попытки (CI main 11.09).
      subscriberId: `${SUB}-${input.suffix}-${Math.random().toString(36).slice(2, 7)}`,
      name: `Тест сторожа ${input.suffix}`,
      messages: [{ role: "user", content: input.text }] as never,
      leadDraft: (input.leadDraft ?? { stage: "chatting" }) as never,
      lastMessageAt: new Date(),
      ...(input.spam ? { spamFlaggedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  conversationIds.push(conv.id);
  return conv.id;
}

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
});

afterAll(async () => {
  const convs = await prisma.botConversation.findMany({
    where: { id: { in: conversationIds } },
    select: { id: true, clientId: true },
  });
  for (const c of convs) if (c.clientId) clientIds.push(c.clientId);
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  if (clientIds.length > 0) {
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.notification.deleteMany({ where: { url: { in: conversationIds.map((id) => `/messages?open=${id}`) } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  }
});

describe("Сторож лидов без карточки", () => {
  it("читаемый номер — заявку оформляет сам, человека не дёргает", async () => {
    const id = await seedConversation({ suffix: "ok", text: `Салом, хона даркор. Рақамам ${PHONE_DIGITS}` });

    const result = await runPhoneLeadWatchdogTick();
    expect(result.accepted).toBeGreaterThan(0);

    const conv = await prisma.botConversation.findUnique({
      where: { id },
      select: { clientId: true },
    });
    // Карточка появилась и привязана к переписке — именно этого не хватало.
    expect(conv?.clientId).toBeTruthy();

    // И руководство про этот диалог не тревожили: работа сделана, звать некого.
    const alerts = await prisma.notification.count({ where: { url: `/messages?open=${id}` } });
    expect(alerts).toBe(0);
  });

  it("диалог помечен как рассылка — карточки нет, решает человек", async () => {
    const id = await seedConversation({
      suffix: "spam",
      text: `Реклама! Пишите ${SPAM_PHONE_DIGITS}`,
      spam: true,
    });

    await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true } });
    expect(conv?.clientId).toBeNull();
  });

  it("номер не разобрался — карточки нет, решает человек", async () => {
    // «00 000 10 08» сюда больше не годится: разбор проверяется только длиной
    // (владелец 03.09.2026 — коды операторов вроде «01» у MegaFon начинаются с
    // нуля, гадать по цифрам нельзя), и девять значащих цифр «000001008» теперь
    // ПРИНИМАЮТСЯ как валидный номер — см. tests/phone-unreadable-retry.test.ts.
    // Здесь нужен пример, короткий по ДЛИНЕ вне зависимости от того, какой код
    // операторов появится завтра: код страны есть, а после него восемь цифр.
    const id = await seedConversation({ suffix: "raw", text: "Занг занед 99298544494" });

    await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true } });
    expect(conv?.clientId).toBeNull();
  });
});

describe("Сторож и зависший захват приёма (AI-DIALOGUE01)", () => {
  it("диалог застрял в «accepting» после сбоя: сторож перезахватывает и заводит карточку", async () => {
    const digits = `9${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const id = await seedConversation({
      suffix: "stuck",
      text: `Салом, хона даркор. Рақамам ${digits}`,
      leadDraft: { stage: "accepting", acceptingAt: Date.now() - 20 * 60_000 },
    });

    await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true } });
    expect(conv?.clientId).toBeTruthy();
  });

  it("приём вернул accepted без карточки: сторож не считает это успехом и зовёт человека", async () => {
    const digits = `9${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    // Захват свежий: приём считает себя опоздавшим и ничего не делает (карточки нет).
    const id = await seedConversation({
      suffix: "inflight",
      text: `Салом, хона даркор. Рақамам ${digits}`,
      leadDraft: { stage: "accepting", acceptingAt: Date.now() },
    });

    const result = await runPhoneLeadWatchdogTick();

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true } });
    expect(conv?.clientId).toBeNull();
    // Диалог остался человеку: тревога по нему поставлена, а не молча «оформлен».
    expect(result.alerted).toBeGreaterThan(0);
  });
});
