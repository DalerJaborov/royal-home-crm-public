import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import {
  findStalledSellers,
  runSellerWorkStalledAlarmTick,
  STALLED_AGENT_WORKING_DAYS,
  STALLED_DIRECTOR_WORKING_DAYS,
} from "../src/lib/sellerWorkStalledAlarm.js";
import { workingDaysBetween } from "../src/lib/alarmCalendar.js";

/**
 * «АГЕНТ САМ ПЕРЕСТАЛ ПЫТАТЬСЯ» (владелец 16.09.2026).
 *
 * До этого вердикт «работа встала» читали только тесты — ни один тик его не
 * спрашивал, и фундамент контроля ни разу не срабатывал. Здесь проверяется сама
 * выборка: кого тик считает вставшим, а кого обязан пропустить.
 *
 * Границы, которые тест держит, — это ровно те места, где механизм превратился бы
 * в ложное обвинение честного человека:
 *  - агент звонил вчера → не тишина;
 *  - клиент написал вчера → отсчёт идёт от его сообщения, а не от старой попытки;
 *  - назначен следующий шаг на будущее → агент вправе молчать до своей даты;
 *  - карточка закрыта, потеряна или неактивна → спрашивать не с кого.
 */

const runId = Date.now();
const password = "testpass123";
const DAY_MS = 86_400_000;

/** Вторник, 12:00 по Душанбе (07:00 UTC) — рабочий день, подальше от границ. */
const NOW = new Date("2026-09-01T07:00:00Z");

let agentId: string;
let agentPhone: string;
const clientIds: string[] = [];

/**
 * Момент, с которого к NOW набирается ровно `n` РАБОЧИХ дней тишины.
 *
 * Считать календарными сутками нельзя, и это первое, на чём тест сам и поймался:
 * три календарных дня назад от вторника — это суббота, а между ними лежит
 * воскресенье, которое в счёт не идёт. Получалось 2 рабочих дня вместо трёх, и
 * проверка порога владельца падала на ровном месте. Срок спрашиваем у той самой
 * функции, что считает его в бою.
 */
function attemptFor(workingDays: number): Date {
  let cursor = new Date(NOW.getTime());
  while (workingDaysBetween(cursor, NOW) < workingDays) {
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return cursor;
}

/** Календарные сутки назад — там, где рабочий календарь не при чём. */
function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS);
}

async function makeSeller(opts: {
  lastAgentAttemptAt?: Date | null;
  lastClientMessageAt?: Date | null;
  acceptedAt?: Date;
  workStatus?: string;
  status?: string;
  assigned?: boolean;
  nextStepAt?: Date | null;
}) {
  const client = await prisma.client.create({
    data: {
      fullName: `Продавец тишины ${clientIds.length}-${runId}`,
      phone: `+992919${String(clientIds.length).padStart(2, "0")}${runId.toString().slice(-4)}`,
      kind: "SELLER",
      status: opts.status ?? "CONTACTED",
      workStatus: opts.workStatus ?? "ACTIVE",
      source: "PHONE_CALL",
      assignedAgentId: opts.assigned === false ? null : agentId,
      acceptedAt: opts.acceptedAt ?? daysAgo(10),
      lastAgentAttemptAt: opts.lastAgentAttemptAt ?? null,
      lastClientMessageAt: opts.lastClientMessageAt ?? null,
    },
  });
  clientIds.push(client.id);
  if (opts.nextStepAt) {
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        notes: "Договорились созвониться",
        nextActionDate: opts.nextStepAt,
      },
    });
  }
  return client;
}

beforeAll(async () => {
  agentPhone = `+992955${runId.toString().slice(-6)}`;
  agentId = (
    await prisma.agent.create({
      data: {
        fullName: "Агент тишины",
        phone: agentPhone,
        role: "AGENT",
        passwordHash: await bcrypt.hash(password, 10),
      },
    })
  ).id;
});

afterEach(async () => {
  await prisma.pendingDirectorAlert.deleteMany({
    where: { tag: { startsWith: "seller-work-stalled-" } },
  });
  await prisma.notification.deleteMany({
    where: { tag: { startsWith: `seller-work-stalled-agent-${agentId}-` } },
  });
  if (clientIds.length === 0) return;
  await prisma.property.deleteMany({
    where: { sellerClientId: { in: clientIds } },
  });
  await prisma.interaction.deleteMany({
    where: { clientId: { in: clientIds } },
  });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  clientIds.length = 0;
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { phone: agentPhone } });
});

/** Только свои карточки: на стенде и в проде рядом живут чужие. */
async function mine(now: Date = NOW) {
  const all = await findStalledSellers(now);
  return all.filter((c) => clientIds.includes(c.id));
}

describe("Кого считаем вставшим", () => {
  it("агент не пытался 2 рабочих дня — попадает, и это порог пуша ему самому", async () => {
    await makeSeller({
      lastAgentAttemptAt: attemptFor(STALLED_AGENT_WORKING_DAYS),
    });
    const found = await mine();
    expect(found).toHaveLength(1);
    expect(found[0].workingDaysSilent).toBe(STALLED_AGENT_WORKING_DAYS);
  });

  it("агент не пытался 3 рабочих дня — дотягивает до порога владельца", async () => {
    await makeSeller({
      lastAgentAttemptAt: attemptFor(STALLED_DIRECTOR_WORKING_DAYS),
    });
    const found = await mine();
    expect(found).toHaveLength(1);
    expect(found[0].workingDaysSilent).toBeGreaterThanOrEqual(
      STALLED_DIRECTOR_WORKING_DAYS,
    );
  });

  it("попыток не было вовсе — считаем от принятия карточки", async () => {
    await makeSeller({
      lastAgentAttemptAt: null,
      acceptedAt: attemptFor(STALLED_DIRECTOR_WORKING_DAYS),
    });
    const found = await mine();
    expect(found).toHaveLength(1);
    expect(found[0].workingDaysSilent).toBeGreaterThanOrEqual(
      STALLED_DIRECTOR_WORKING_DAYS,
    );
  });
});

describe("Кого НЕ трогаем — здесь механизм превратился бы в ложное обвинение", () => {
  it("агент звонил вчера — это работа, а не тишина", async () => {
    await makeSeller({ lastAgentAttemptAt: attemptFor(1) });
    expect(await mine()).toHaveLength(0);
  });

  it("клиент написал вчера — отсчёт от его сообщения, а не от старой попытки агента", async () => {
    // Живая переписка не должна выглядеть тишиной: разговор идёт.
    await makeSeller({
      lastAgentAttemptAt: daysAgo(6),
      lastClientMessageAt: attemptFor(1),
    });
    expect(await mine()).toHaveLength(0);
  });

  it("назначен следующий шаг на будущее — агент вправе молчать до своей даты", async () => {
    await makeSeller({
      lastAgentAttemptAt: daysAgo(5),
      nextStepAt: new Date(NOW.getTime() + 2 * DAY_MS),
    });
    expect(await mine()).toHaveLength(0);
  });

  it("прошедший срок назначенного шага уже не защищает", async () => {
    // Шаг просрочен — это как раз тот случай, ради которого тик и заведён.
    await makeSeller({
      lastAgentAttemptAt: daysAgo(5),
      nextStepAt: new Date(NOW.getTime() - 2 * DAY_MS),
    });
    expect(await mine()).toHaveLength(1);
  });

  it("карточка без агента — спрашивать не с кого", async () => {
    await makeSeller({ lastAgentAttemptAt: daysAgo(5), assigned: false });
    expect(await mine()).toHaveLength(0);
  });

  it("сделка закрыта, карточка потеряна или в архиве — не тревожим", async () => {
    await makeSeller({ lastAgentAttemptAt: daysAgo(5), status: "DEAL_CLOSED" });
    await makeSeller({ lastAgentAttemptAt: daysAgo(5), status: "LOST" });
    await makeSeller({ lastAgentAttemptAt: daysAgo(5), status: "ARCHIVED" });
    expect(await mine()).toHaveLength(0);
  });

  it("карточка уже в «Неактивных» — ею занимается светофор, не этот тик", async () => {
    await makeSeller({
      lastAgentAttemptAt: daysAgo(5),
      workStatus: "INACTIVE",
    });
    expect(await mine()).toHaveLength(0);
  });
});

describe("Порядок выдачи", () => {
  it("самые запущенные идут первыми — их и называют поимённо", async () => {
    await makeSeller({ lastAgentAttemptAt: daysAgo(2) });
    await makeSeller({ lastAgentAttemptAt: daysAgo(6) });
    await makeSeller({ lastAgentAttemptAt: daysAgo(4) });
    const found = await mine();
    expect(found).toHaveLength(3);
    expect(found[0].workingDaysSilent).toBeGreaterThanOrEqual(
      found[1].workingDaysSilent,
    );
    expect(found[1].workingDaysSilent).toBeGreaterThanOrEqual(
      found[2].workingDaysSilent,
    );
  });
});

describe("Тик целиком: агенту — пуш, владельцу — одна строка на всех", () => {
  it("два дня тишины: ни агенту, ни владельцу уведомления нет (владелец 02.10.2026)", async () => {
    await makeSeller({
      lastAgentAttemptAt: attemptFor(STALLED_AGENT_WORKING_DAYS),
    });
    const res = await runSellerWorkStalledAlarmTick(NOW);
    expect(res.pokedAgents).toBe(0);
    expect(res.reportedToDirector).toBe(0);

    const note = await prisma.notification.findFirst({
      where: { agentId, tag: { startsWith: `seller-work-stalled-agent-${agentId}-` } },
    });
    expect(note).toBeNull();
    const forDirector = await prisma.pendingDirectorAlert.findFirst({
      where: { tag: { startsWith: "seller-work-stalled-" } },
    });
    expect(forDirector).toBeNull();
  });

  it("три дня тишины: строки владельцу нет (рассылка убрана 02.10.2026)", async () => {
    await makeSeller({
      lastAgentAttemptAt: attemptFor(STALLED_DIRECTOR_WORKING_DAYS),
    });
    await makeSeller({
      lastAgentAttemptAt: attemptFor(STALLED_DIRECTOR_WORKING_DAYS + 1),
    });
    const res = await runSellerWorkStalledAlarmTick(NOW);
    expect(res).toEqual({ pokedAgents: 0, reportedToDirector: 0, skipped: 0 });

    const alerts = await prisma.pendingDirectorAlert.findMany({
      where: { tag: { startsWith: "seller-work-stalled-" } },
    });
    expect(alerts).toHaveLength(0);
  });
});

describe("Часовой тик ничего не пишет (владелец 02.10.2026)", () => {
  it("второй проход через час: владельцу по-прежнему ничего не уходит", async () => {
    await makeSeller({
      lastAgentAttemptAt: attemptFor(STALLED_DIRECTOR_WORKING_DAYS),
    });
    await runSellerWorkStalledAlarmTick(NOW);
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    await runSellerWorkStalledAlarmTick(later);

    const alerts = await prisma.pendingDirectorAlert.findMany({
      where: { tag: { startsWith: "seller-work-stalled-" } },
    });
    expect(alerts).toHaveLength(0);
  });
});

describe("Объект в продаже — работа идёт (владелец 23.09.2026)", () => {
  it("продавец, чей объект в продаже, в «без движения» не попадает; на подготовке — попадает", async () => {
    const onSale = await makeSeller({
      lastAgentAttemptAt: attemptFor(STALLED_DIRECTOR_WORKING_DAYS),
    });
    const preparing = await makeSeller({
      lastAgentAttemptAt: attemptFor(STALLED_DIRECTOR_WORKING_DAYS),
    });
    for (const [c, status] of [
      [onSale, "AVAILABLE"],
      [preparing, "AWAITING_PHOTOS"],
    ] as const) {
      await prisma.property.create({
        data: {
          title: `Объект ${c.id.slice(0, 6)}`,
          type: "APARTMENT",
          areaSqm: 50,
          price: 300000,
          condition: "GOOD",
          status,
          sellerClientId: c.id,
        },
      });
    }
    const ids = (await mine()).map((c) => c.id);
    expect(ids).not.toContain(onSale.id);
    expect(ids).toContain(preparing.id);
  });
});
