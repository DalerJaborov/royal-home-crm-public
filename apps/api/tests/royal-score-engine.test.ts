import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { DEFAULT_EVENT_POINTS, computeRoyalScore, loadEventPoints, recordScoreEvent } from "../src/lib/scoreJournal.js";

/**
 * Движок Royal Score по спецификации (решение владельца 03.08.2026): счёт = старт +
 * сумма событий в скользящем окне, зажатая в 0–100. Окно снимает риск «потолка»
 * (docs/owner-spec-verbatim-31-07-01-08-2026.md, часть 3) — событие вне окна не
 * считается вовсе, будто его не было.
 */

const runId = Date.now();
let agentId: string;
let savedSettings: { royalScoreEventPoints: unknown; royalScoreWindowDays: number; royalScoreStartingScore: number };

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: "Агент движка", phone: `+99291${runId.toString().slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;

  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { royalScoreEventPoints: true, royalScoreWindowDays: true, royalScoreStartingScore: true },
  });
  savedSettings = {
    royalScoreEventPoints: s?.royalScoreEventPoints ?? null,
    royalScoreWindowDays: s?.royalScoreWindowDays ?? 30,
    royalScoreStartingScore: s?.royalScoreStartingScore ?? 100,
  };
});

afterEach(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  // NB: явный `null`, а не `?? undefined` — Prisma трактует undefined как «поле не
  // меняем» (пропускает из UPDATE), а не «очистить». С `?? undefined` восстановление
  // после теста, оставившего непустой override, тихо не срабатывало бы, и следующий
  // тест в файле унаследовал бы чужие настройки.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      royalScoreEventPoints: savedSettings.royalScoreEventPoints as object | null,
      royalScoreWindowDays: savedSettings.royalScoreWindowDays,
      royalScoreStartingScore: savedSettings.royalScoreStartingScore,
    },
  });
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

/** recordScoreEvent — «выстрелил и забыл» (см. scoreJournal.ts); ждём появления
 *  записи вместо фиксированной паузы, чтобы тест не был чувствителен к нагрузке. */
async function waitForEvent(sourceId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const found = await prisma.royalScoreEvent.findFirst({ where: { agentId, sourceId } });
    if (found) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Событие с sourceId=${sourceId} не появилось за отведённое время`);
}

describe("Цена события из настроек", () => {
  it("без переопределений — таблица владельца по умолчанию", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { royalScoreEventPoints: null } });
    expect(await loadEventPoints()).toEqual(DEFAULT_EVENT_POINTS);
  });

  it("директор переопределил часть — остальные остаются зашитыми", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { royalScoreEventPoints: { deal_closed: 20, task_on_time: 4 } },
    });
    const points = await loadEventPoints();
    expect(points.deal_closed).toBe(20);
    expect(points.task_on_time).toBe(4);
    expect(points.call_on_time).toBe(DEFAULT_EVENT_POINTS.call_on_time);
  });

  it("цена снятого штрафа из старых Настроек не действует (16.11.2026)", async () => {
    // На проде в Settings.royalScoreEventPoints могли остаться цены штрафов,
    // заданные до их снятия: −5 за пропущенный показ и т.п. Они обязаны молча
    // стать нулём, иначе старые строки журнала в окне продолжали бы тянуть счёт.
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { royalScoreEventPoints: { showing_missed: -7, call_15min_missed: -9, deal_closed: 12 } },
    });
    const points = await loadEventPoints();
    expect(points.showing_missed).toBe(0);
    expect(points.call_15min_missed).toBe(0);
    expect(points.deal_closed).toBe(12);
  });

  it("мусор в колонке не долетает до расчёта", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { royalScoreEventPoints: { deal_closed: "десять", unknown_kind: 99 } },
    });
    const points = await loadEventPoints();
    expect(points.deal_closed).toBe(DEFAULT_EVENT_POINTS.deal_closed);
    expect((points as Record<string, number>).unknown_kind).toBeUndefined();
  });
});

describe("Скользящее окно снимает риск потолка", () => {
  it("без событий — стартовый счёт из настроек", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { royalScoreStartingScore: 70 } });
    expect(await computeRoyalScore(agentId)).toBe(70);
  });

  it("две сделки не упирают агента в потолок мгновенно — просто складываются со стартом", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { royalScoreStartingScore: 50 } });
    // delta в вызове — историческая цена на момент события; computeRoyalScore
    // пересчитывает по ТЕКУЩЕЙ (DEFAULT_EVENT_POINTS.deal_closed=15) — см. тест
    // «правка цены события… действует и на уже записанные», это то же поведение.
    recordScoreEvent({ agentId, kind: "deal_closed", delta: 10, reason: "Сделка 1", sourceId: `deal1-${runId}` });
    recordScoreEvent({ agentId, kind: "deal_closed", delta: 10, reason: "Сделка 2", sourceId: `deal2-${runId}` });
    await waitForEvent(`deal1-${runId}`);
    await waitForEvent(`deal2-${runId}`);
    expect(await computeRoyalScore(agentId)).toBe(50 + DEFAULT_EVENT_POINTS.deal_closed * 2);
  });

  it("счёт никогда не превышает 100", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { royalScoreStartingScore: 95 } });
    recordScoreEvent({ agentId, kind: "deal_closed", delta: 10, reason: "Сделка", sourceId: `deal-cap-${runId}` });
    await waitForEvent(`deal-cap-${runId}`);
    expect(await computeRoyalScore(agentId)).toBe(100);
  });

  it("счёт никогда не опускается ниже 0", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { royalScoreStartingScore: 3 } });
    // Минус остался только у компенсации плюса — аннулированная сделка (−10).
    recordScoreEvent({ agentId, kind: "deal_closed_reversed", delta: -10, reason: "Сделка аннулирована", sourceId: `miss-${runId}` });
    await waitForEvent(`miss-${runId}`);
    expect(await computeRoyalScore(agentId)).toBe(0);
  });

  it("событие вне окна не считается — старое списание само выходит из расчёта", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { royalScoreStartingScore: 100, royalScoreWindowDays: 30 },
    });
    const old = await prisma.royalScoreEvent.create({
      data: { agentId, kind: "deal_closed_reversed", delta: -10, reason: "Старое списание", sourceId: `old-${runId}` },
    });
    // Событие «случилось» 40 дней назад — за пределами 30-дневного окна.
    await prisma.royalScoreEvent.update({
      where: { id: old.id },
      data: { at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });
    expect(await computeRoyalScore(agentId)).toBe(100);
  });

  it("то же событие внутри окна — учитывается", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { royalScoreStartingScore: 100, royalScoreWindowDays: 30 },
    });
    const recent = await prisma.royalScoreEvent.create({
      data: { agentId, kind: "deal_closed_reversed", delta: -10, reason: "Свежее списание", sourceId: `recent-${runId}` },
    });
    await prisma.royalScoreEvent.update({
      where: { id: recent.id },
      data: { at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    });
    expect(await computeRoyalScore(agentId)).toBe(90);
  });

  it("строка снятого штрафа внутри окна счёт больше не тянет (16.11.2026)", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { royalScoreStartingScore: 100, royalScoreWindowDays: 30, royalScoreEventPoints: null },
    });
    // Штрафы, записанные до снятия, лежат в журнале с delta −5. Цена вида теперь
    // 0 — счёт обязан о них забыть, а не дожидаться выхода из окна.
    await prisma.royalScoreEvent.create({
      data: { agentId: agentId, kind: "showing_missed", delta: -5, reason: "Старый штраф", sourceId: `retired-${runId}` },
    });
    expect(await computeRoyalScore(agentId)).toBe(100);
  });

  it("правка цены события в настройках действует и на уже записанные события в окне", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { royalScoreStartingScore: 50 } });
    recordScoreEvent({ agentId, kind: "deal_closed", delta: 10, reason: "Сделка", sourceId: `deal-repriced-${runId}` });
    await waitForEvent(`deal-repriced-${runId}`);
    expect(await computeRoyalScore(agentId)).toBe(50 + DEFAULT_EVENT_POINTS.deal_closed);

    await prisma.settings.update({ where: { id: "singleton" }, data: { royalScoreEventPoints: { deal_closed: 20 } } });
    expect(await computeRoyalScore(agentId)).toBe(70);
  });
});

describe("Дробные баллы не теряются", () => {
  it("дробный балл (+2.7) сохраняется без округления до целого", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { royalScoreStartingScore: 50 } });
    // Раньше пример — «объект исправлен после возврата» (+2.7); вид снят 16.11.2026
    // вместе со штрафом за доработку, а округление проверяется на любом виде.
    recordScoreEvent({
      agentId,
      kind: "call_on_time",
      delta: 2.7,
      reason: "Дробная цена",
      sourceId: `fix-${runId}`,
    });
    await waitForEvent(`fix-${runId}`);
    const row = await prisma.royalScoreEvent.findFirst({ where: { agentId, sourceId: `fix-${runId}` } });
    expect(row?.delta).toBe(2.7);
  });
});
