import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import {
  classifyInactiveLevelByDepth,
  runInactiveTrafficLightTick,
  shiftInactiveClockAfterAbsence,
} from "../src/lib/inactiveTrafficLight.js";
import { runAbsenceReturnTick } from "../src/lib/absenceReturn.js";
import { findTrafficLightSummary } from "../src/routes/oversight.js";

/**
 * «Слитый клиент действительно уходит от агента» (владелец 01.09.2026, идея с
 * мозгового штурма 21.08.2026 — до этой правки предел попыток светофора менял
 * только status="LOST", assignedAgentId оставался прежним навсегда). Проверяем
 * оба следствия: карточка освобождается (assignedAgentId=null) и агент получает
 * штраф Royal Score (client_lost_agent_fault), а lastAgentId — НЕ трогается
 * (уже стоит от deactivateClient, по нему клиент, вернувшийся сам, всё ещё
 * предлагается сначала этому же агенту).
 */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
const clientIds: string[] = [];

// В рабочие часы по Душанбе (09:30-18:00, UTC+5) — 07:00Z = 12:00 в Душанбе,
// иначе isWithinWorkingHours(now) внутри тика молча пропустит всё вычисление.
const NOW = new Date("2026-09-01T07:00:00Z");

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: {
        fullName: "Агент слитого клиента",
        phone: `+992965${runId}`,
        role: "AGENT",
        passwordHash,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({
    where: { sellerClientId: { in: clientIds } },
  });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({
    where: { clientId: { in: clientIds } },
  });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

async function makeExhaustedClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Слитый клиент ${runId}-${clientIds.length}`,
      phone: `+992966${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      lastAgentId: agentId, // ставит deactivateClient в реальном потоке — тут напрямую
      acceptedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
      workStatus: "INACTIVE",
      inactiveLevel: "RED",
      /**
       * inactivePingCount — уже РЕАЛЬНО ОТПРАВЛЕНО столько напоминаний, не
       * "хочу считать лимит исчерпанным" сам по себе: тик сравнивает его с
       * dueAttempt (сколько интервалов реально прошло от inactiveSince) и, если
       * дошло уже отправленных ping даже БОЛЬШЕ, чем прошло интервалов, решает
       * «рано» и пропускает карточку целиком — отдельно от проверки предела.
       * Красный по умолчанию — 2 попытки (Settings.inactiveRedMaxAttempts) и 72ч
       * шаг (inactiveRedPingHours): 3 шага в прошлом ГАРАНТИРУЮТ dueAttempt=3 > 2,
       * и pingCount=2 уже равен пределу — оба условия promoteToLost выполнены.
       */
      inactiveSince: new Date(NOW.getTime() - 3 * 72 * 60 * 60 * 1000),
      inactivePingCount: 2,
    },
  });
  clientIds.push(c.id);
  return c;
}

describe("Светофор неактивных: предел попыток исчерпан", () => {
  it("клиент остаётся у агента (assignedAgentId сохраняется), lastAgentId проставлен тем же агентом", async () => {
    const client = await makeExhaustedClient();
    const result = await runInactiveTrafficLightTick(NOW);
    expect(result.lost).toBeGreaterThanOrEqual(1);

    const reloaded = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(reloaded.status).toBe("LOST");
    expect(reloaded.assignedAgentId).toBe(agentId);
    expect(reloaded.lastAgentId).toBe(agentId);
  });

  it("след остаётся в хронологии клиента, без уведомления агенту (02.10.2026) и без записи в журнале ошибок (13.09.2026)", async () => {
    const client = await makeExhaustedClient();
    // Снимок ДО тика: утверждение ниже проверяет, что журнал ошибок не вырос
    // именно от этого тика.
    // ОБА замера через waitForSettled: `void logSystemError` соседних тестов
    // приземляется уже после снимка, и чужая строка засчиталась бы этому тику
    // (класс «тест наперегонки с записью в отрыве», CLAUDE.md).
    const errorsBefore = await waitForSettled(() => prisma.errorLog.count());
    await runInactiveTrafficLightTick(NOW);

    const interaction = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM" },
      orderBy: { createdAt: "desc" },
    });
    expect(interaction?.notes).toContain("Светофор неактивных");

    const notification = await prisma.notification.findFirst({
      where: { agentId, tag: `client-lost-traffic-light-${client.id}` },
    });
    // Владелец 02.10.2026: информационное уведомление «Клиент переведён в Потерянные» убрано.
    expect(notification).toBeNull();

    // ПОИСК ПО shortId УБРАН 19.09.2026. Было:
    // `where: { message: { contains: client.shortId.toString() } }` — короткое
    // число, которое `contains` находит в чём угодно, в том числе внутри UUID
    // чужого клиента из СОСЕДНЕГО тестового файла: базы раздаются по процессу
    // (tests/dbPerWorker.ts), а не по файлу, поэтому чужие строки журнала никуда
    // не деваются. Так этот тест падал на PR, где не тронуто ни строки кода
    // приложения (прогон 35456552609), и «красный прогон» переставал означать
    // поломку — а на этом стоит весь замок на слияние.
    // Теперь проверяется то же самое, но без зависимости от чужих записей: тик
    // не добавил в журнал ошибок НИ ОДНОЙ строки. Механизм штатный (см.
    // «СЛЕД ШТАТНОГО СОБЫТИЯ» в lib/inactiveTrafficLight.ts), писать в журнал
    // ошибок ему нечего.
    expect(await waitForSettled(() => prisma.errorLog.count())).toBe(
      errorsBefore,
    );
  });

  it("агент получает штраф Royal Score (client_lost_agent_fault)", async () => {
    const client = await makeExhaustedClient();
    await runInactiveTrafficLightTick(NOW);

    const event = await waitFor(
      () =>
        prisma.royalScoreEvent.findFirst({
          where: {
            agentId,
            sourceId: `client-lost-traffic-light-${client.id}`,
          },
        }),
      { label: "штраф client_lost_agent_fault" },
    );
    expect(event).toBeTruthy();
    expect(event?.kind).toBe("client_lost_agent_fault");
    expect(event?.delta).toBeLessThan(0);
  });

  it("повторный тик по уже потерянному клиенту не штрафует дважды (assignedAgentId уже null — гейт цикла его пропускает)", async () => {
    const client = await makeExhaustedClient();
    await runInactiveTrafficLightTick(NOW);
    await runInactiveTrafficLightTick(new Date(NOW.getTime() + 60 * 60 * 1000));

    await waitFor(
      () =>
        prisma.royalScoreEvent.findFirst({
          where: {
            agentId,
            sourceId: `client-lost-traffic-light-${client.id}`,
          },
        }),
      { label: "первый штраф светофора" },
    );
    const events = await waitForSettled(() =>
      prisma.royalScoreEvent.count({
        where: { agentId, sourceId: `client-lost-traffic-light-${client.id}` },
      }),
    );
    expect(events).toBe(1);
  });
});

/**
 * Регрессия на баг B1 (docs/audit-02-09-2026/01-lifecycle.md): «попытка»
 * светофора неактивных должна считаться ТОЛЬКО по реальному звонку через CRM
 * (Interaction.type=CALL, callAttempt=TALKED), а не по отправленному пушу.
 * Раньше любой пуш сбрасывал таймер, и агент мог бесконечно откладывать LOST,
 * просто не открывая карточку. Теперь:
 *  - пуш без звонка НЕ сбрасывает inactiveSince/inactivePingCount;
 *  - звонок через CRM после inactiveSince СБРАСЫВАЕТ оба поля.
 */
describe("Светофор неактивных: B1 — попытка = звонок через CRM, не пуш", () => {
  it("пуш без звонка НЕ сбрасывает таймер (клиент уходит в LOST по пределу)", async () => {
    const client = await makeExhaustedClient();

    // Создаём пуш-подобную запись (SYSTEM interaction) — она НЕ должна
    // считаться попыткой и сбрасывать таймер.
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "SYSTEM",
        notes: "Пуш-напоминание агенту (не звонок)",
      },
    });

    const result = await runInactiveTrafficLightTick(NOW);
    expect(result.lost).toBeGreaterThanOrEqual(1);

    const reloaded = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(reloaded.status).toBe("LOST");
    expect(reloaded.assignedAgentId).toBe(agentId);
  });

  it("звонок через CRM (CALL + TALKED) СБРАСЫВАЕТ таймер — клиент НЕ уходит в LOST", async () => {
    const client = await makeExhaustedClient();

    // Агент реально дозвонился через CRM после перевода в Неактивные.
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        callAttempt: "TALKED",
        recordingDurationSec: 45,
        notes: "Дозвонился, договорились на показ",
      },
    });

    const result = await runInactiveTrafficLightTick(NOW);
    // Клиент НЕ должен быть потерян — звонок сбросил таймер.
    const reloaded = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(reloaded.status).not.toBe("LOST");
    expect(reloaded.assignedAgentId).toBe(agentId);
    // inactivePingCount сброшен в 0, inactiveSince обновлён до NOW.
    expect(reloaded.inactivePingCount).toBe(0);
    expect(reloaded.inactiveSince?.getTime()).toBe(NOW.getTime());
  });

  it("звонок ДО inactiveSince НЕ сбрасывает таймер (только звонки ПОСЛЕ перевода считаются)", async () => {
    const client = await makeExhaustedClient();

    // Звонок был ДО перевода в Неактивные — не должен влиять на светофор.
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        callAttempt: "TALKED",
        recordingDurationSec: 30,
        createdAt: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000), // 10 дней назад
        notes: "Старый звонок до неактивности",
      },
    });

    const result = await runInactiveTrafficLightTick(NOW);
    expect(result.lost).toBeGreaterThanOrEqual(1);

    const reloaded = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(reloaded.status).toBe("LOST");
  });

  it("NO_ANSWER звонок НЕ сбрасывает таймер (только TALKED считается попыткой)", async () => {
    const client = await makeExhaustedClient();

    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        callAttempt: "NO_ANSWER",
        notes: "Не дозвонился",
      },
    });

    await runInactiveTrafficLightTick(NOW);

    const reloaded = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(reloaded.status).toBe("LOST");
    expect(reloaded.assignedAgentId).toBe(agentId);
  });
});

/**
 * АГЕНТ В ОТПУСКЕ ИЛИ НА БОЛЬНИЧНОМ — светофор его клиентов не трогает
 * (владелец 08.09.2026).
 *
 * До этой правки заморозка была светофору неизвестна вовсе: агент уходил в отпуск,
 * его неактивные клиенты досчитывали предел попыток и уходили в «Потерянные»
 * АВТОМАТИЧЕСКИ, со штрафом ему же за слитого клиента. Возвращался — а портфеля нет.
 */
describe("Светофор неактивных: агента нет на работе", () => {
  it("замороженный агент — клиент НЕ уходит в Потерянные и штрафа нет", async () => {
    const client = await makeExhaustedClient();
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        frozenAt: new Date(NOW.getTime() - 24 * 3600_000),
        frozenReason: "Отпуск",
      },
    });
    try {
      const res = await runInactiveTrafficLightTick(NOW);
      expect(res.lost).toBe(0);
      expect(res.pinged).toBe(0);

      const after = await prisma.client.findUnique({
        where: { id: client.id },
      });
      // Карточка на месте: и статус, и агент.
      expect(after?.status).not.toBe("LOST");
      expect(after?.assignedAgentId).toBe(agentId);

      // Проверка «штрафа НЕТ»: ждать нечего, поэтому замер через waitForSettled —
      // иначе запоздавшая запись проскочит мимо проверки.
      const penalties = await waitForSettled(() =>
        prisma.royalScoreEvent.count({
          where: {
            agentId,
            sourceId: `client-lost-traffic-light-${client.id}`,
          },
        }),
      );
      expect(penalties).toBe(0);
    } finally {
      await prisma.agent.update({
        where: { id: agentId },
        data: { frozenAt: null, frozenReason: null },
      });
    }
  });

  /**
   * АГЕНТ ВЕРНУЛСЯ — ПАЧКИ ПОТЕРЬ НЕТ (владелец 23.09.2026). Раньше тест
   * утверждал обратное: сразу после возврата «тот же клиент снова разбирается
   * тиком» и уходит в LOST. Так и было — и это была дыра: заморозка лишь
   * откладывала потери до дня возврата. inactiveSince во время отпуска не
   * сдвигался, и на первых же тиках после разморозки у каждого неактивного
   * клиента «прошли» все дни отпуска: недосланные напоминания срабатывали
   * подряд за час-два, и клиенты пачкой уходили в «Потерянные» со штрафом
   * вернувшемуся агенту. Теперь время отсутствия в срок не идёт
   * (shiftInactiveClockAfterAbsence при разморозке): после возврата клиент
   * продолжает с того места, где его застала заморозка.
   *
   * Без правки тест красный: на третьем тике клиент в LOST.
   */
  it("агент вернулся из отпуска — клиенты не уходят в Потерянные пачкой в первые часы", async () => {
    const frozenAt = new Date(NOW.getTime() - 10 * 24 * 3600_000);
    const c = await prisma.client.create({
      data: {
        fullName: `Клиент отпускника ${runId}`,
        phone: `+992963${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
        lastAgentId: agentId,
        acceptedAt: new Date(NOW.getTime() - 30 * 24 * 3600_000),
        workStatus: "INACTIVE",
        inactiveLevel: "RED",
        // Ушёл в Неактивные за час до отпуска, напоминаний ещё не было.
        inactiveSince: new Date(frozenAt.getTime() - 3600_000),
        inactivePingCount: 0,
      },
    });
    clientIds.push(c.id);
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        frozenAt,
        frozenReason: "Отпуск",
        absenceKind: "VACATION",
        absenceUntil: new Date(NOW.getTime() - 60_000),
      },
    });
    try {
      // Возврат по сроку отпуска — тот же путь, что у крона.
      await runAbsenceReturnTick(NOW);
      const returned = await prisma.agent.findUniqueOrThrow({
        where: { id: agentId },
      });
      expect(returned.frozenAt).toBeNull();

      const shifted = await prisma.client.findUniqueOrThrow({
        where: { id: c.id },
      });
      // Сдвиг ровно на время отпуска: до заморозки прошёл час, он и остался.
      expect(shifted.inactiveSince?.getTime()).toBe(NOW.getTime() - 3600_000);
      expect(shifted.inactivePingCount).toBe(0);

      // Пять тиков подряд, раз в полчаса, как крон.
      for (let i = 0; i < 5; i++)
        await runInactiveTrafficLightTick(
          new Date(NOW.getTime() + i * 30 * 60_000),
        );
      const after = await prisma.client.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(after.status).not.toBe("LOST");
      expect(after.inactivePingCount).toBe(0);
    } finally {
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          frozenAt: null,
          frozenReason: null,
          absenceKind: null,
          absenceUntil: null,
        },
      });
    }
  });

  it("клиент ушёл в Неактивные уже во время отпуска — сдвиг только на его часть отсутствия", async () => {
    const frozenAt = new Date(NOW.getTime() - 10 * 24 * 3600_000);
    const since = new Date(NOW.getTime() - 2 * 24 * 3600_000);
    const c = await makeExhaustedClient();
    await prisma.client.update({
      where: { id: c.id },
      data: { inactiveSince: since, inactivePingCount: 1 },
    });
    await shiftInactiveClockAfterAbsence(agentId, frozenAt, NOW);
    const after = await prisma.client.findUniqueOrThrow({
      where: { id: c.id },
    });
    // Весь его цикл пришёлся на отпуск — отсчёт начинается с возврата.
    expect(after.inactiveSince?.getTime()).toBe(NOW.getTime());
    expect(after.inactivePingCount).toBe(1);
  });

  it("начало отсутствия неизвестно — цикл начинается заново", async () => {
    const c = await makeExhaustedClient();
    await shiftInactiveClockAfterAbsence(agentId, null, NOW);
    const after = await prisma.client.findUniqueOrThrow({
      where: { id: c.id },
    });
    expect(after.inactiveSince?.getTime()).toBe(NOW.getTime());
    expect(after.inactivePingCount).toBe(0);
  });

  it("потерянных клиентов сдвиг не трогает", async () => {
    const c = await makeExhaustedClient();
    const lostSince = new Date(NOW.getTime() - 5 * 24 * 3600_000);
    await prisma.client.update({
      where: { id: c.id },
      data: { status: "LOST", inactiveSince: lostSince },
    });
    await shiftInactiveClockAfterAbsence(
      agentId,
      new Date(NOW.getTime() - 10 * 24 * 3600_000),
      NOW,
    );
    const after = await prisma.client.findUniqueOrThrow({
      where: { id: c.id },
    });
    expect(after.inactiveSince?.getTime()).toBe(lostSince.getTime());
  });
});

describe("Живой по делу клиент сам в «Потерянные» не уходит (жалоба агента 23.09.2026)", () => {
  it("продавец с объектом в продаже остаётся неактивным у агента", async () => {
    const client = await makeExhaustedClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { kind: "SELLER" },
    });
    await prisma.property.create({
      data: {
        title: `Объект продавца ${runId}`,
        type: "APARTMENT",
        price: 500000,
        areaSqm: 60,
        condition: "GOOD",
        status: "AVAILABLE",
        sellerClientId: client.id,
        assignedAgentId: agentId,
      },
    });
    await runInactiveTrafficLightTick(NOW);
    const reloaded = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(reloaded.status).not.toBe("LOST");
    expect(reloaded.workStatus).toBe("INACTIVE");
  });

  it("клиент, который сам вернулся и ждёт решения агента, тоже остаётся", async () => {
    const client = await makeExhaustedClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { reactivationOfferedToAgentId: agentId },
    });
    await runInactiveTrafficLightTick(NOW);
    const reloaded = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(reloaded.status).not.toBe("LOST");
  });

  it("продавец без объекта в работе уходит, как и раньше", async () => {
    const client = await makeExhaustedClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { kind: "SELLER" },
    });
    await runInactiveTrafficLightTick(NOW);
    const reloaded = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(reloaded.status).toBe("LOST");
  });
});

/**
 * СБРОС ТАЙМЕРА — ЛЮБЫМ РЕАЛЬНЫМ КОНТАКТОМ, А НЕ ТОЛЬКО ЗВОНКОМ TALKED
 * (владелец 23.09.2026: «светофор решает всё сам и правильно»). До правки
 * каждый тест ниже, кроме отрицательных, был красным: клиент уходил в LOST.
 */
describe("Светофор неактивных: сброс по реальному контакту", () => {
  async function expectReset(clientId: string) {
    const r = await prisma.client.findUniqueOrThrow({
      where: { id: clientId },
    });
    expect(r.status).not.toBe("LOST");
    expect(r.inactivePingCount).toBe(0);
    expect(r.inactiveSince?.getTime()).toBe(NOW.getTime());
    return r;
  }

  it("ручная запись о звонке с исходом (без звонка через CRM) — сброс", async () => {
    const client = await makeExhaustedClient();
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        outcome: "WAITING_CALL",
        notes: "Поговорили, перезвонит в пятницу",
      },
    });
    await runInactiveTrafficLightTick(NOW);
    await expectReset(client.id);
  });

  it("«связался со своего телефона» с исходом — сброс", async () => {
    const client = await makeExhaustedClient();
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        outsideCrm: true,
        outcome: "POSITIVE",
        notes: "Созвонились с мобильного",
      },
    });
    await runInactiveTrafficLightTick(NOW);
    await expectReset(client.id);
  });

  it("ручная запись «не дозвонился» — не контакт, клиент уходит", async () => {
    const client = await makeExhaustedClient();
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        outcome: "NO_ANSWER",
        notes: "Не взял трубку",
      },
    });
    await runInactiveTrafficLightTick(NOW);
    const r = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(r.status).toBe("LOST");
  });

  it("состоявшийся показ — сброс, и цвет пересчитан в зелёный", async () => {
    const client = await makeExhaustedClient();
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "SHOWING",
        notes: "Показ",
        nextActionDate: new Date(NOW.getTime() - 3 * 3600_000),
        completedAt: new Date(NOW.getTime() - 2 * 3600_000),
      },
    });
    await runInactiveTrafficLightTick(NOW);
    const r = await expectReset(client.id);
    expect(r.inactiveLevel).toBe("GREEN");
  });

  it("показ, снятый автоматикой ДО своего времени, — не встреча, клиент уходит", async () => {
    const client = await makeExhaustedClient();
    // closeStaleNextActions гасит завтрашний показ сегодняшним completedAt.
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "SHOWING",
        notes: "Показ на завтра",
        nextAction: "Показ",
        nextActionDate: new Date(NOW.getTime() + 24 * 3600_000),
        completedAt: new Date(NOW.getTime() - 3600_000),
      },
    });
    await runInactiveTrafficLightTick(NOW);
    const r = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(r.status).toBe("LOST");
  });

  it("клиент написал после перевода в Неактивные — сброс", async () => {
    const client = await makeExhaustedClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { lastClientMessageAt: new Date(NOW.getTime() - 3600_000) },
    });
    await runInactiveTrafficLightTick(NOW);
    await expectReset(client.id);
  });

  it("сообщение клиента ДО перевода — не сброс", async () => {
    const client = await makeExhaustedClient();
    await prisma.client.update({
      where: { id: client.id },
      data: {
        lastClientMessageAt: new Date(
          client.inactiveSince!.getTime() - 3600_000,
        ),
      },
    });
    await runInactiveTrafficLightTick(NOW);
    const r = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(r.status).toBe("LOST");
  });

  it("звонок TALKED по «красному» — сброс и цвет пересчитан в жёлтый", async () => {
    const client = await makeExhaustedClient();
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        callAttempt: "TALKED",
        recordingDurationSec: 45,
        notes: "Дозвонился",
      },
    });
    await runInactiveTrafficLightTick(NOW);
    const r = await expectReset(client.id);
    expect(r.inactiveLevel).toBe("YELLOW");
  });
});

describe("Светофор неактивных: цвет продавца, сдавшего объект", () => {
  it("у продавца есть объект (даже проданный) — зелёный", async () => {
    const client = await makeExhaustedClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { kind: "SELLER" },
    });
    expect(
      await classifyInactiveLevelByDepth(client.id, "SELLER", 30),
    ).toBe("RED");
    await prisma.property.create({
      data: {
        title: `Проданный объект ${runId}`,
        type: "APARTMENT",
        price: 400000,
        areaSqm: 50,
        condition: "GOOD",
        status: "SOLD",
        sellerClientId: client.id,
        assignedAgentId: agentId,
      },
    });
    expect(
      await classifyInactiveLevelByDepth(client.id, "SELLER", 30),
    ).toBe("GREEN");
  });

  it("объект в корзине не считается", async () => {
    const client = await makeExhaustedClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { kind: "SELLER" },
    });
    await prisma.property.create({
      data: {
        title: `Удалённый объект ${runId}`,
        type: "APARTMENT",
        price: 400000,
        areaSqm: 50,
        condition: "GOOD",
        status: "WITHDRAWN",
        sellerClientId: client.id,
        assignedAgentId: agentId,
        deletedAt: new Date(),
      },
    });
    expect(
      await classifyInactiveLevelByDepth(client.id, "SELLER", 30),
    ).toBe("RED");
  });
});

describe("Потерянный не считается неактивным в светофоре директора", () => {
  it("findTrafficLightSummary не считает LOST с workStatus=INACTIVE", async () => {
    const before = await findTrafficLightSummary();
    const mine = (x: typeof before) =>
      x.agents.find((a) => a.agentId === agentId);
    const client = await makeExhaustedClient();
    const withLive = await findTrafficLightSummary();
    expect((mine(withLive)?.red ?? 0) - (mine(before)?.red ?? 0)).toBe(1);

    await prisma.client.update({
      where: { id: client.id },
      data: { status: "LOST" },
    });
    const withLost = await findTrafficLightSummary();
    expect(mine(withLost)?.red ?? 0).toBe(mine(before)?.red ?? 0);
  });
});
