import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import {
  runBuyerNoCallAlarmTick,
  alertRefusedHighScoreBuyer,
  runRefusedHighScoreAlarmTick,
} from "../src/lib/buyerNoCallAlarm.js";

/**
 * Регрессионные тесты алармов директору по требованию 6 (аудит 02.09.2026).
 *
 * A) Крон-тик «покупатель активен, нет звонка N дней»:
 *    - ACTIVE + BUYER + score>=70 + нет звонка 3 дня → аларм создан
 *    - повторный прогон через 1 час → дубля нет (dedup по tag)
 *    - низкий скоринг / свежий звонок / не BUYER → аларма нет
 *
 * B) Триггер на отказ при высоком скоринге (07.09.2026: событие мгновенное,
 *    ставит только отметку; пуш шлёт отдельный часовой тик в часы алармов):
 *    - BUYER + score>=70 → отметка, затем пуш директору на тике в часы алармов
 *    - вне часов алармов тик молчит, следующий тик в окне досылает
 *    - BUYER + score<70 / SELLER → отметки нет вовсе
 */

const runId = Date.now();
// Тик молчит вне рабочих часов (решение владельца 03.09): фиксируем вторник 12:00 по Душанбе.
const WORK_NOW = new Date("2026-09-01T07:00:00Z");
const password = "testpass123";
const DAY = 24 * 60 * 60 * 1000;

let directorId: string;
let agentId: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];
const agentIds: string[] = [];
const notificationIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);

  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор аларм-теста ${runId}`, phone: `+992980${runId}`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  agentIds.push(directorId);

  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент аларм-теста ${runId}`, phone: `+992981${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(agentId);
});

afterAll(async () => {
  // Чистим уведомления, созданные алармами (по tag)
  await prisma.notification.deleteMany({
    where: {
      OR: [
        { tag: { startsWith: "alarm-buyer-no-call-" } },
        { tag: { startsWith: "alarm-refused-high-score-" } },
      ],
    },
  });
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("Аларм «нет звонка N дней» (крон-тик) — рассылка убрана 02.10.2026", () => {
  /**
   * Решение владельца 02.10.2026: «📵 Нет звонка N+ дн» директору и администратору —
   * спам. Тик остался заглушкой с прежней сигнатурой (его вызывает cron.ts), ни
   * ленты, ни пуша. Условия, при которых раньше уходило уведомление, остаются теми
   * же, чтобы тест ловил возврат рассылки в любом из случаев.
   */
  it("ACTIVE BUYER с высоким скорингом и без звонка 3 дня → записи в ленте директору нет", async () => {
    const now = WORK_NOW;
    const staleClient = await prisma.client.create({
      data: {
        fullName: `Аларм нет звонка ${runId}`,
        phone: `+992982${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        workStatus: "ACTIVE",
        status: "NEW",
        assignedAgentId: agentId,
        aiScore: 85,
        lastContactAt: new Date(now.getTime() - 3 * DAY),
      },
    });
    clientIds.push(staleClient.id);

    const { alerted } = await runBuyerNoCallAlarmTick(now);
    expect(alerted).toBe(0);

    const notification = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `alarm-buyer-no-call-${staleClient.id}` },
    });
    expect(notification).toBeNull();
  });

  it("SELLER с dualIntent=true (владелец 06.09.2026 п.4) и без звонка → тоже молчит", async () => {
    const now = WORK_NOW;
    const dualClient = await prisma.client.create({
      data: {
        fullName: `Продавец и покупатель ${runId}`,
        phone: `+992989${runId}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        dualIntent: true,
        workStatus: "ACTIVE",
        status: "NEW",
        assignedAgentId: agentId,
        aiScore: 90,
        lastContactAt: new Date(now.getTime() - 5 * DAY),
      },
    });
    clientIds.push(dualClient.id);

    const { alerted } = await runBuyerNoCallAlarmTick(now);
    expect(alerted).toBe(0);

    const notification = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `alarm-buyer-no-call-${dualClient.id}` },
    });
    expect(notification).toBeNull();
  });
});

describe("Аларм «отказ при высоком скоринге» (триггер мгновенный, пуш — по часам алармов)", () => {
  it("BUYER с score>=70 → ставит отметку, пуш уходит только на тике в часы алармов", async () => {
    const highScoreBuyer = await prisma.client.create({
      data: {
        fullName: `Отказ высокий скоринг ${runId}`,
        phone: `+992986${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        workStatus: "ACTIVE",
        status: "COLD",
        assignedAgentId: agentId,
        aiScore: 85,
      },
    });
    clientIds.push(highScoreBuyer.id);

    await alertRefusedHighScoreBuyer(highScoreBuyer);

    // Само событие мгновенное — уведомления ещё нет, только отметка на карточке.
    let notification = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `alarm-refused-high-score-${highScoreBuyer.id}` },
    });
    expect(notification).toBeNull();
    const flagged = await prisma.client.findUnique({ where: { id: highScoreBuyer.id } });
    expect(flagged?.refusedHighScoreFlaggedAt).not.toBeNull();

    const { alerted } = await runRefusedHighScoreAlarmTick(WORK_NOW);
    expect(alerted).toBeGreaterThanOrEqual(1);
    notification = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `alarm-refused-high-score-${highScoreBuyer.id}` },
    });
    expect(notification).toBeTruthy();
    expect(notification!.title).toContain("Отказ при высоком скоринге");
    if (notification) notificationIds.push(notification.id);
  });

  it("вне часов алармов тик молчит — отметка остаётся ждать следующего окна", async () => {
    const buyer = await prisma.client.create({
      data: {
        fullName: `Отказ ночью ${runId}`,
        phone: `+992986${runId}n`,
        source: "PHONE_CALL",
        kind: "BUYER",
        workStatus: "ACTIVE",
        status: "COLD",
        assignedAgentId: agentId,
        aiScore: 85,
      },
    });
    clientIds.push(buyer.id);
    await alertRefusedHighScoreBuyer(buyer);

    const nightNow = new Date("2026-09-01T20:00:00Z"); // 01:00 по Душанбе — точно вне окна
    const { alerted } = await runRefusedHighScoreAlarmTick(nightNow);
    expect(alerted).toBe(0);
    const notification = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `alarm-refused-high-score-${buyer.id}` },
    });
    expect(notification).toBeNull();

    // Наступили часы алармов — тот же случай досылается.
    const { alerted: alertedNextDay } = await runRefusedHighScoreAlarmTick(WORK_NOW);
    expect(alertedNextDay).toBeGreaterThanOrEqual(1);
    const delivered = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `alarm-refused-high-score-${buyer.id}` },
    });
    expect(delivered).toBeTruthy();
    if (delivered) notificationIds.push(delivered.id);
  });

  it("НЕ ставит отметку для BUYER с score<70", async () => {
    const lowScoreBuyer = await prisma.client.create({
      data: {
        fullName: `Отказ низкий скоринг ${runId}`,
        phone: `+992987${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        workStatus: "ACTIVE",
        status: "COLD",
        assignedAgentId: agentId,
        aiScore: 40,
      },
    });
    clientIds.push(lowScoreBuyer.id);

    await alertRefusedHighScoreBuyer(lowScoreBuyer);

    const flagged = await prisma.client.findUnique({ where: { id: lowScoreBuyer.id } });
    expect(flagged?.refusedHighScoreFlaggedAt).toBeNull();
  });

  it("НЕ ставит отметку для SELLER даже с высоким скорингом", async () => {
    const highScoreSeller = await prisma.client.create({
      data: {
        fullName: `Продавец отказ нет аларма ${runId}`,
        phone: `+992988${runId}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        workStatus: "ACTIVE",
        status: "COLD",
        assignedAgentId: agentId,
        aiScore: 90,
      },
    });
    clientIds.push(highScoreSeller.id);

    await alertRefusedHighScoreBuyer(highScoreSeller);

    const flagged = await prisma.client.findUnique({ where: { id: highScoreSeller.id } });
    expect(flagged?.refusedHighScoreFlaggedAt).toBeNull();
  });
});