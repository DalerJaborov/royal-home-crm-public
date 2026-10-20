import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * РАЗДЕЛ L, УРОВЕНЬ 2 (03.09.2026, план вечерней сессии §L) — номер, всплывший в
 * переписке без привязанной карточки, но принадлежащий УЖЕ ИЗВЕСТНОМУ клиенту, не
 * должен просто отфильтровываться из аларма «карточки нет» и повисать безымянным
 * навсегда: диалог сам привязывается к найденной карточке, и её агент узнаёт о
 * втором канале (см. lib/phoneLeadWatchdog.ts::attachKnownClientConversations).
 *
 * ПРОВЕРКИ «неизвестный номер сигналит директору» и «ночью молчит» из исходной
 * ветки здесь НЕ воспроизведены осознанно (перенос 10.09.2026): обе описывали
 * поведение сторожа до двух более поздних решений владельца. Во-первых, ступень 3
 * (main) теперь САМА оформляет заявку по неизвестному номеру (tryAcceptQuietly),
 * и до аларма «карточки нет» дело чаще всего не доходит вовсе. Во-вторых, часы
 * тишины с 07.09.2026 держит общая очередь алармов (lib/directorAlertQueue.ts),
 * а не гейт внутри этого модуля: ночное событие не теряется, а уходит утром, и
 * Notification в момент тика не появляется. Оба поведения покрыты тестами тех
 * механизмов, а не этого файла.
 */

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
const { runPhoneLeadWatchdogTick } = await import("../src/lib/phoneLeadWatchdog.js");
const { dushanbeDateTimeString, dushanbeInputToDate } = await import("../src/lib/dushanbeTime.js");

const runId = Date.now();
const password = "testpass123";

/** «Сейчас», но гарантированно в рабочих часах по Душанбе (04.09.2026, аларм
 *  директору молчит вне них) — реальная календарная дата (lastMessageAt в тестах
 *  ниже пишется через реальный Date.now()), только время сдвинуто на полдень. */
function workHoursNow(): Date {
  const today = dushanbeDateTimeString(new Date()).slice(0, 10);
  return dushanbeInputToDate(today, "12:00");
}

let ownerAgentId: string;
let directorId: string;
const clientIds: string[] = [];
const agentIds: string[] = [];
const conversationIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  ownerAgentId = (
    await prisma.agent.create({
      data: { fullName: `Хозяин известного номера ${runId}`, phone: `+992${runId}80`, role: "AGENT", passwordHash },
    })
  ).id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор сторожа ${runId}`, phone: `+992${runId}81`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  agentIds.push(ownerAgentId, directorId);
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.notification.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("runPhoneLeadWatchdogTick — уровень 2: номер уже известен", () => {
  it("диалог привязывается к найденной карточке, агент уведомлён", async () => {
    const clientPhone = `+992918${String(runId).slice(-6)}`;
    const client = await prisma.client.create({
      data: {
        fullName: `Известный клиент ${runId}`,
        phone: clientPhone,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: ownerAgentId,
      },
    });
    clientIds.push(client.id);

    const conversation = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `watchdog-known-${runId}`,
        messages: [{ role: "user", content: `Мой номер ${clientPhone}, перезвоните пожалуйста` }],
        lastMessageAt: new Date(),
      },
    });
    conversationIds.push(conversation.id);

    const { attached, alerted } = await runPhoneLeadWatchdogTick(workHoursNow());
    expect(attached).toBeGreaterThanOrEqual(1);

    const after = await prisma.botConversation.findUnique({ where: { id: conversation.id } });
    expect(after?.clientId).toBe(client.id);

    // Владельцу карточки — уведомление о втором канале, а не директору «карточки нет».
    const ownerNotified = await prisma.notification.findFirst({
      where: { agentId: ownerAgentId, tag: `duplicate-review-known-client-${conversation.id}` },
    });
    expect(ownerNotified).not.toBeNull();

    const falseAlarmToDirector = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `alarm-phone-without-lead-${conversation.id}` },
    });
    expect(falseAlarmToDirector).toBeNull();
    void alerted;
  });

});
