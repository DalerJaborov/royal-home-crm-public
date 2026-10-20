import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  computeRoyalScoreBreakdown,
  computeRoyalScoreBreakdownBatch,
  loadScoreEvents,
  recordScoreEvent,
} from "../src/lib/scoreJournal.js";

/**
 * Журнал Royal Score.
 *
 * Спецификация требует объяснимости: рядом со счётом всегда видно, из чего он
 * сложился. Разбор по показателям отвечает «сколько», журнал — «за что».
 *
 * Запись НИКОГДА не роняет основное действие: закрытие сделки не должно
 * проваливаться из-за строки в журнале. Поэтому recordScoreEvent ничего не
 * возвращает и не бросает — а значит, тест обязан дождаться записи иначе.
 */

const runId = Date.now();
let agentId: string;
let directorId: string;

/** recordScoreEvent намеренно «выстрелил и забыл» — ждём появления записи. */
async function waitForEvents(count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const n = await prisma.royalScoreEvent.count({ where: { agentId } });
    if (n >= count) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: "Агент журнала", phone: `+99293${runId.toString().slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  const director = await prisma.agent.create({
    data: { fullName: "Директор журнала", phone: `+99294${runId.toString().slice(-7)}`, role: "DIRECTOR", passwordHash: "x" },
  });
  agentId = agent.id;
  directorId = director.id;
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
});

describe("Что попадает в журнал", () => {
  it("событие системы пишется без инициатора", async () => {
    recordScoreEvent({ agentId, kind: "deal_closed", delta: 10, reason: "Сделка закрыта: тест" });
    await waitForEvents(1);

    const events = await loadScoreEvents(agentId);
    expect(events[0].delta).toBe(10);
    expect(events[0].reason).toContain("Сделка закрыта");
    // Инициатор пуст — значит «это сделала система», и агенту не на кого пенять.
    expect(events[0].initiator).toBeNull();
  });

  it("ручная правка счёта показывает, КТО её сделал", async () => {
    recordScoreEvent({
      agentId,
      kind: "kpi_override",
      delta: -5,
      reason: "Счёт изменён вручную: 90 → 85",
      initiatorId: directorId,
    });
    await waitForEvents(2);

    const events = await loadScoreEvents(agentId);
    // Молчаливая правка сверху обесценивает весь рейтинг — имя обязано быть видно.
    expect(events[0].initiator).toBe("Директор журнала");
    expect(events[0].delta).toBe(-5);
  });

  it("свежие события идут первыми", async () => {
    const events = await loadScoreEvents(agentId);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(new Date(events[0].at).getTime()).toBeGreaterThanOrEqual(new Date(events[1].at).getTime());
  });

  /** Маршрут, возвращающий массив, обязан иметь предел выборки. */
  it("выдача ограничена запрошенным числом", async () => {
    const events = await loadScoreEvents(agentId, 1);
    expect(events).toHaveLength(1);
  });
});

/**
 * FAIR PLAY: одно действие — одни баллы.
 *
 * Повторный PATCH сделки (сеть моргнула, кнопку нажали дважды) не должен начислять
 * «+10 за сделку» второй раз: иначе агент, умеющий кликать, обгоняет агента,
 * умеющего продавать. Арбитр — уникальность в БД, а не проверка «а нет ли уже
 * такого»: два одновременных запроса оба увидели бы пустоту.
 */
describe("Двойное начисление невозможно", () => {
  it("одно и то же событие с тем же источником пишется один раз", async () => {
    const sourceId = `deal-${runId}`;
    recordScoreEvent({ agentId, kind: "deal_closed", delta: 10, reason: "Сделка закрыта", sourceId });
    recordScoreEvent({ agentId, kind: "deal_closed", delta: 10, reason: "Сделка закрыта", sourceId });
    recordScoreEvent({ agentId, kind: "deal_closed", delta: 10, reason: "Сделка закрыта", sourceId });

    // Даём всем трём попыткам отработать: запись «выстрелил и забыл».
    await new Promise((r) => setTimeout(r, 300));
    const count = await prisma.royalScoreEvent.count({ where: { agentId, sourceId } });
    expect(count).toBe(1);
  });

  /** Ручная правка счёта, наоборот, повторяться ДОЛЖНА: каждая обязана остаться в
   *  журнале отдельной строкой, иначе вторая правка окажется невидимой. */
  it("события без источника повторяются свободно", async () => {
    const before = await prisma.royalScoreEvent.count({ where: { agentId, kind: "kpi_override" } });
    recordScoreEvent({ agentId, kind: "kpi_override", delta: -1, reason: "Правка 1", initiatorId: directorId });
    recordScoreEvent({ agentId, kind: "kpi_override", delta: -2, reason: "Правка 2", initiatorId: directorId });

    await new Promise((r) => setTimeout(r, 300));
    const after = await prisma.royalScoreEvent.count({ where: { agentId, kind: "kpi_override" } });
    expect(after).toBe(before + 2);
  });
});

/**
 * Штраф за бездействие — ПОСЛЕ предупреждения.
 *
 * Последний пункт Fair Play, и порядок здесь принципиален: штрафовать за то, о чём
 * человека не предупредили, — это ровно то, от чего Fair Play должен защищать.
 * Проверяем, что предупреждение стоит нулём (это ещё не наказание, а «мы
 * заметили») и что повтор прохода не начисляет штраф второй раз за ту же карточку.
 */
describe("Бездействие: сначала предупреждение, потом штраф", () => {
  it("предупреждение записывается с нулевой ценой", async () => {
    recordScoreEvent({
      agentId,
      kind: "inactivity_warning",
      delta: 0,
      reason: "Предупреждение: по клиенту нет записей",
      sourceId: `warn-${runId}`,
    });
    await new Promise((r) => setTimeout(r, 200));

    const events = await loadScoreEvents(agentId);
    const warning = events.find((e) => e.kind === "inactivity_warning");
    expect(warning).toBeDefined();
    expect(warning!.delta).toBe(0);
  });

  it("штраф за одну и ту же карточку не начисляется дважды", async () => {
    const sourceId = `penalty-${runId}`;
    recordScoreEvent({ agentId, kind: "inactivity_penalty", delta: -5, reason: "Штраф", sourceId });
    recordScoreEvent({ agentId, kind: "inactivity_penalty", delta: -5, reason: "Штраф", sourceId });
    await new Promise((r) => setTimeout(r, 300));

    const count = await prisma.royalScoreEvent.count({ where: { agentId, sourceId } });
    expect(count).toBe(1);
  });
});

/**
 * Дашборд считает «слабое звено недели» по всем активным агентам сразу. Раньше это
 * был поштучный computeRoyalScoreBreakdown в цикле (2 запроса к базе на агента),
 * теперь батч (2 запроса на весь список). Тест стережёт совпадение: разойдись они —
 * дашборд показывал бы одно, а карточка агента (там разбор всё ещё поштучный) другое,
 * и спорить было бы не с чем.
 */
describe("Батч-разбор Royal Score совпадает с поштучным", () => {
  let agent2Id: string;

  beforeAll(async () => {
    const agent2 = await prisma.agent.create({
      data: {
        fullName: "Второй агент батча",
        phone: `+99295${runId.toString().slice(-7)}`,
        role: "AGENT",
        passwordHash: "x",
      },
    });
    agent2Id = agent2.id;
    recordScoreEvent({ agentId: agent2Id, kind: "showing_done", delta: 3, reason: "Показ проведён: тест" });
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(async () => {
    await prisma.royalScoreEvent.deleteMany({ where: { agentId: agent2Id } });
    await prisma.agent.deleteMany({ where: { id: agent2Id } });
  });

  it("сумма по каждому агенту в батче равна поштучному расчёту", async () => {
    const now = new Date();
    const [single1, single2] = await Promise.all([
      computeRoyalScoreBreakdown(agentId, now),
      computeRoyalScoreBreakdown(agent2Id, now),
    ]);
    const batch = await computeRoyalScoreBreakdownBatch([agentId, agent2Id], now);

    expect(batch.get(agentId)).toEqual(single1);
    expect(batch.get(agent2Id)).toEqual(single2);
  });

  it("пустой список агентов не запрашивает базу и возвращает пустую карту", async () => {
    const batch = await computeRoyalScoreBreakdownBatch([]);
    expect(batch.size).toBe(0);
  });
});
