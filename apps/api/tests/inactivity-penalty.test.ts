import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { runInactivityCheck } from "../src/lib/inactivityPenalty.js";

/**
 * Бездействие по клиентам: сначала предупреждение, потом штраф.
 *
 * Правило существует, чтобы никого не штрафовать за то, о чём не предупредили.
 * Но проверка порядка строилась только на возрасте последней записи: карточка,
 * которая УЖЕ старше обоих сроков на первом же проходе (принята давно, работы по
 * ней не было — обычная ситуация для живой базы, где правило появилось позже
 * самих лидов), получала штраф, ни разу не пройдя через предупреждение. Ровно то,
 * чего это правило обязано не допускать.
 */

const runId = Date.now();
let agentId: string;
/** Второй агент заводится по ходу теста про передачу карточки — убирается в afterAll. */
let secondAgentId: string | null = null;
const clientIds: string[] = [];

async function makeClient(acceptedDaysAgo: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент бездействия ${clientIds.length}-${runId}`,
      phone: `+9929${String(runId).slice(-8)}${clientIds.length}`,
      status: "NEW",
      kind: "BUYER",
      source: "WEBSITE",
      assignedAgentId: agentId,
      acceptedAt: new Date(Date.now() - acceptedDaysAgo * 86400_000),
    },
  });
  clientIds.push(c.id);
  return c;
}

/** Событие по этой карточке — у любого агента. Ищем findFirst, а не по ключу:
 *  уникальность теперь (kind, sourceId, agentId), и «есть ли вообще запись»
 *  спрашивается независимо от того, кому она досталась. */
function eventFor(clientId: string, kind: string) {
  return prisma.royalScoreEvent.findFirst({ where: { kind, sourceId: clientId } });
}

/** recordScoreEvent — «выстрелил и забыл»: ждём, пока запись действительно появится. */
async function waitForEvent(clientId: string, kind: string) {
  for (let i = 0; i < 50; i++) {
    const ev = await eventFor(clientId, kind);
    if (ev) return ev;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент бездействия ${runId}`,
      phone: `+99295${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: "x",
    },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { sourceId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, ...(secondAgentId ? [secondAgentId] : [])] } } });
});

describe("Штраф за бездействие приходит только после предупреждения", () => {
  it("карточка старше обоих сроков на первом проходе получает предупреждение, а не штраф", async () => {
    // 30 дней без единой записи — заведомо за обоими сроками при любых настройках.
    const client = await makeClient(30);

    await runInactivityCheck();

    expect(await waitForEvent(client.id, "inactivity_warning")).not.toBeNull();
    expect(await eventFor(client.id, "inactivity_penalty")).toBeNull();
  });

  it("на следующем проходе, когда предупреждение уже в журнале, приходит штраф", async () => {
    const client = await makeClient(30);

    await runInactivityCheck();
    await waitForEvent(client.id, "inactivity_warning");
    await runInactivityCheck();

    const penalty = await waitForEvent(client.id, "inactivity_penalty");
    expect(penalty).not.toBeNull();
    expect(penalty!.delta).toBeLessThan(0);
  });

  /**
   * Карточка ходит по рукам, и порядок «сначала предупреждение» обязан проходить
   * заново для каждого, с кого спрашивают. Пока уникальность события была
   * (kind, sourceId) без агента, предупреждение прежнего хозяина засчитывалось
   * новому: тот получал штраф первой же ночью, не увидев ни одного предупреждения,
   * а его собственное предупреждение молча не записывалось (аудит 09.08.2026).
   */
  it("клиент перешёл другому агенту — новый получает своё предупреждение, а не чужой штраф", async () => {
    const client = await makeClient(30);
    await runInactivityCheck();
    await waitForEvent(client.id, "inactivity_warning");

    const second = await prisma.agent.create({
      data: {
        fullName: `Второй агент бездействия ${runId}`,
        phone: `+99296${String(runId).slice(-7)}`,
        role: "AGENT",
        passwordHash: "x",
      },
    });
    secondAgentId = second.id;
    await prisma.client.update({ where: { id: client.id }, data: { assignedAgentId: second.id } });

    await runInactivityCheck();

    // Своё предупреждение у нового агента появилось (запись «выстрелил и забыл» —
    // ждём её, а не читаем сразу).
    let warnings: { agentId: string }[] = [];
    for (let i = 0; i < 50; i++) {
      warnings = await prisma.royalScoreEvent.findMany({
        where: { kind: "inactivity_warning", sourceId: client.id },
        select: { agentId: true },
      });
      if (warnings.length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(warnings.map((w) => w.agentId).sort()).toEqual([agentId, second.id].sort());

    // ...а штрафа он ещё не получил: его предупредили только что.
    const penalty = await prisma.royalScoreEvent.findFirst({
      where: { kind: "inactivity_penalty", sourceId: client.id, agentId: second.id },
    });
    expect(penalty).toBeNull();
  });
});

/**
 * Журнал показывает ту же цену, что снимает счёт (глубокая проверка 02.10.2026,
 * C11). Счёт берёт цену вида из каталога баллов, а строка штрафа писалась ценой
 * из «Дисциплины» (по умолчанию 5): агент видел «−5» (или «−10»), а счёт падал
 * на 3. Решение владельца 02.10 «да, по советам»: главная — таблица баллов,
 * поле в «Дисциплине» убрано с экрана.
 */
describe("Строка штрафа — по цене, которой считается счёт (C11)", () => {
  it("цена в «Дисциплине» 10, в каталоге своя — журнал совпадает с каталогом", async () => {
    const { loadEventPoints, scoreEventPoints } = await import("../src/lib/scoreJournal.js");
    const saved = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { inactivityPenaltyPoints: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { inactivityPenaltyPoints: 10 } });
    try {
      const client = await makeClient(30);
      await runInactivityCheck();
      await waitForEvent(client.id, "inactivity_warning");
      await runInactivityCheck();
      const penalty = await waitForEvent(client.id, "inactivity_penalty");
      expect(penalty).not.toBeNull();
      const points = await loadEventPoints();
      expect(penalty!.delta).toBe(scoreEventPoints(penalty!, points));
    } finally {
      await prisma.settings.update({
        where: { id: "singleton" },
        data: { inactivityPenaltyPoints: saved?.inactivityPenaltyPoints ?? 5 },
      });
    }
  });

  it("директор меняет цену в таблице баллов — штраф снимается именно ею, «Дисциплина» не при чём", async () => {
    const saved = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { inactivityPenaltyPoints: true, royalScoreEventPoints: true },
    });
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { inactivityPenaltyPoints: 10, royalScoreEventPoints: { inactivity_penalty: -7 } },
    });
    try {
      const client = await makeClient(30);
      await runInactivityCheck();
      await waitForEvent(client.id, "inactivity_warning");
      await runInactivityCheck();
      const penalty = await waitForEvent(client.id, "inactivity_penalty");
      expect(penalty!.delta).toBe(-7);
    } finally {
      await prisma.settings.update({
        where: { id: "singleton" },
        data: {
          inactivityPenaltyPoints: saved?.inactivityPenaltyPoints ?? 5,
          royalScoreEventPoints: (saved?.royalScoreEventPoints as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
        },
      });
    }
  });
});
