import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent }));
// По умолчанию (крон) уведомление уходит в очередь алармов (07.09.2026) —
// тест не должен плавать в зависимости от часа реального прогона.
vi.mock("../src/lib/workingHours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/workingHours.js")>()),
  isWithinAlarmHours: async () => true,
}));

const { prisma } = await import("../src/db.js");
const { buildProblemMetrics, generateProblemReport, problemPeriodRanges } = await import(
  "../src/lib/problemReport.js"
);
const { flushDirectorAlertQueue } = await import("../src/lib/directorAlertQueue.js");

/**
 * Разбор проблемных мест (решение владельца 11.08.2026).
 *
 * Что здесь проверяется и почему именно это:
 *  - отчёт собирается на базе, где нужных данных может не быть вовсе, — джоб не
 *    должен падать в понедельник утром из-за пустой недели;
 *  - в отчёт попадают события СВОЕГО периода: ровно на этом ломались все прежние
 *    периодические сводки (граница суток по Душанбе — UTC+5, и события вечера
 *    воскресенья уезжали в соседний отчёт);
 *  - повторная сборка не плодит дубликат и не трогает заметки владельца;
 *  - выключенный в Настройках отчёт не собирается вовсе — ни кроном, ни кнопкой.
 *
 * База общая с другими прогонами, поэтому абсолютные числа не проверяются нигде:
 * только ПРИРОСТ от собственных записей и наличие собственных карточек в списке.
 */

const runId = Date.now();
let agentId: string;
let directorId: string;
let insideClientId: string;
let outsideClientId: string;
let weeklyEnabledBefore = true;

const { current, previous } = problemPeriodRanges("week");
/**
 * Момент внутри отчётной недели и момент до неё — по ним и проверяются границы.
 *
 * insidePeriod специально ставим НЕДАЛЕКО ОТ КОНЦА периода (а не сразу после его
 * начала, как было раньше). Причина не во времени по Душанбе (границу недели код
 * считает верно — см. первый it ниже) и не в смене даты во время сессии, а в
 * запросе, который отбирает ссылки для раздела «клиенты»: он берёт
 * `orderBy: escalatedAt desc, take: LINKS_PER_SECTION` (6 штук), а база общая с
 * другими тестами и прогонами. Если поставить наш маркер в САМОЕ НАЧАЛО недели —
 * это самая старая точка в окне, и в живой базе за неделю почти всегда найдётся
 * 6+ чужих клиентов с более свежим escalatedAt, которые вытеснят наш из топа. Тест
 * с шансом падал не из-за границы периода, а из-за того, что клиент есть в выборке
 * (счётчик `escalated` рос верно — assert на дельту проходил), но не попадал в
 * список ссылок, ограниченный шестью самыми свежими. Помещая маркер у конца
 * периода (последний час перед `current.to`), он почти наверняка попадает в топ
 * по свежести независимо от того, что ещё есть в базе.
 *
 * Отступ — 10 минут, не 1: ниже к insidePeriod прибавляется ещё 60 секунд для
 * второго события, а верхняя граница периода исключающая (`lt: current.to`) —
 * при отступе в минуту второе событие ровно совпало бы с `current.to` и само
 * вылетело бы за пределы периода.
 */
const insidePeriod = new Date(current.to.getTime() - 10 * 60 * 1000);
const beforePeriod = new Date(previous.from.getTime() + 60 * 60 * 1000);

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент разбора ${runId}`, phone: `+992931${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  // Получателя пуша заводим сами: в CI база поднимается миграциями без сида, и
  // проверка «директоров уведомили» падала бы на исправном коде.
  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор разбора ${runId}`, phone: `+992932${runId}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;

  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  weeklyEnabledBefore = settings.problemReportWeeklyEnabled;

  // Отчёт за эту неделю мог остаться от прошлого прогона: тогда проверка «отчёт
  // собран» превратилась бы в «он уже был», и падало бы не то, что сломано.
  await prisma.problemReport.deleteMany({ where: { period: "week", periodStart: current.from } });
});

afterAll(async () => {
  await prisma.problemReport.deleteMany({ where: { period: "week", periodStart: current.from } });
  await prisma.problemReport.deleteMany({ where: { period: "month", periodStart: problemPeriodRanges("month").current.from } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: "problem-report-" } } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.client.deleteMany({ where: { id: { in: [insideClientId, outsideClientId].filter(Boolean) } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { problemReportWeeklyEnabled: weeklyEnabledBefore },
  });
  await prisma.$disconnect();
});

describe("Разбор проблемных мест", () => {
  it("границы недели считаются по Душанбе, прошлый период такой же длины", () => {
    const days = (current.to.getTime() - current.from.getTime()) / 86_400_000;
    expect(days).toBe(7);
    expect(previous.to.getTime()).toBe(current.from.getTime());
    expect(current.from.getTime() - previous.from.getTime()).toBe(7 * 86_400_000);
    // Полночь по Душанбе — это 19:00 UTC предыдущего дня, а не UTC-полночь.
    expect(current.from.getUTCHours()).toBe(19);
  });

  it("собирается без падения и отдаёт все четыре раздела с выводом", async () => {
    const metrics = await buildProblemMetrics("week");
    expect(metrics.sections.map((s) => s.key)).toEqual(["clients", "agents", "calls", "properties"]);
    expect(metrics.headline.length).toBeGreaterThan(0);
    for (const section of metrics.sections) {
      expect(section.headline.length).toBeGreaterThan(0);
      expect(section.metrics.length).toBeGreaterThan(0);
      expect(["better", "worse", "same"]).toContain(section.direction);
    }
  });

  it("в отчёт попадают события своего периода, соседние — нет", async () => {
    const before = await buildProblemMetrics("week");
    const windowsBefore = value(before, "agents", "windows");
    const escalatedBefore = value(before, "clients", "escalated");

    await prisma.royalScoreEvent.createMany({
      data: [
        // Два просроченных окна внутри недели…
        { agentId, kind: "mandatory_window_overdue", delta: -2, reason: "Тест: внутри периода", at: insidePeriod },
        {
          agentId,
          kind: "mandatory_window_overdue",
          delta: -2,
          reason: "Тест: внутри периода 2",
          at: new Date(insidePeriod.getTime() + 60_000),
          sourceId: `problem-report-${runId}-a`,
        },
        // …и одно ДО неё: оно обязано остаться за границей отчёта.
        {
          agentId,
          kind: "mandatory_window_overdue",
          delta: -2,
          reason: "Тест: прошлый период",
          at: beforePeriod,
          sourceId: `problem-report-${runId}-b`,
        },
      ],
    });

    insideClientId = (
      await prisma.client.create({
        data: {
          fullName: `Клиент разбора внутри ${runId}`,
          phone: `+992933${runId}`,
          source: "INSTAGRAM",
          escalatedAt: insidePeriod,
        },
      })
    ).id;
    outsideClientId = (
      await prisma.client.create({
        data: {
          fullName: `Клиент разбора снаружи ${runId}`,
          phone: `+992934${runId}`,
          source: "INSTAGRAM",
          escalatedAt: beforePeriod,
        },
      })
    ).id;

    const after = await buildProblemMetrics("week");
    // Прирост ровно на свои записи: абсолютные числа зависят от общей базы.
    expect(value(after, "agents", "windows") - windowsBefore).toBe(2);
    expect(value(after, "clients", "escalated") - escalatedBefore).toBe(1);

    const agentsSection = after.sections.find((s) => s.key === "agents")!;
    const mine = agentsSection.links.find((l) => l.href === `/team?agent=${agentId}`);
    expect(mine?.hint).toContain("просрочено окон: 2");

    const clientsSection = after.sections.find((s) => s.key === "clients")!;
    const hrefs = clientsSection.links.map((l) => l.href);
    const inside = await shortIdOf(insideClientId);
    const outside = await shortIdOf(outsideClientId);
    expect(hrefs).toContain(`/clients/${inside}`);
    expect(hrefs).not.toContain(`/clients/${outside}`);
  });

  it("выключенный в Настройках отчёт не собирается вовсе", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { problemReportWeeklyEnabled: false } });
    const result = await generateProblemReport("week");
    expect(result.created).toBe(false);
    expect(result.reason).toBe("disabled");
    const count = await prisma.problemReport.count({ where: { period: "week", periodStart: current.from } });
    expect(count).toBe(0);
    await prisma.settings.update({ where: { id: "singleton" }, data: { problemReportWeeklyEnabled: true } });
  });

  it("собирает отчёт и уведомляет директоров ссылкой на него (кнопка «Собрать сейчас» — immediate:true)", async () => {
    // immediate:true — то же, что шлёт routes/reports.ts на клик директора; по
    // умолчанию (крон) уведомление ставится в очередь алармов, см. отдельный тест.
    const result = await generateProblemReport("week", new Date(), true);
    expect(result.created).toBe(true);
    const saved = await prisma.problemReport.findUnique({
      where: { period_periodStart: { period: "week", periodStart: current.from } },
    });
    expect(saved).not.toBeNull();
    expect(sendPushToAgent).toHaveBeenCalledWith(
      directorId,
      expect.objectContaining({ url: "/reports?problems=week" })
    );
  });

  it("по умолчанию (крон) — ставит уведомление в очередь алармов, не шлёт мгновенно", async () => {
    const result = await generateProblemReport("month");
    expect(result.created).toBe(true);
    expect(sendPushToAgent).not.toHaveBeenCalledWith(directorId, expect.objectContaining({ url: "/reports?problems=month" }));

    const delivered = await flushDirectorAlertQueue();
    expect(delivered).toBeGreaterThanOrEqual(1);
    // Получателей ищет сам сборщик очереди — по РОЛИ, среди всех активных
    // директоров базы. На стенде и на проде их несколько (сид, соседние файлы),
    // поэтому точный массив `[directorId]` — ожидание пустой базы, а не поведения
    // кода. Проверяем, что наш директор в получателях, а не что он там один.
    expect(sendPushToAgent).toHaveBeenCalledWith(
      expect.arrayContaining([directorId]),
      expect.objectContaining({ url: "/reports?problems=month" })
    );
  });

  it("повторная сборка того же периода не плодит дубликат и не трогает заметки", async () => {
    await prisma.problemReport.update({
      where: { period_periodStart: { period: "week", periodStart: current.from } },
      data: { notes: "Мои дополнения" },
    });
    const again = await generateProblemReport("week", new Date(), true);
    expect(again.created).toBe(false);
    expect(again.reason).toBe("exists");
    const rows = await prisma.problemReport.findMany({ where: { period: "week", periodStart: current.from } });
    expect(rows).toHaveLength(1);
    expect(rows[0].notes).toBe("Мои дополнения");
  });

  it("месячный период — предыдущий календарный месяц, а не тридцать суток", () => {
    const month = problemPeriodRanges("month");
    const days = (month.current.to.getTime() - month.current.from.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);
    expect(month.previous.to.getTime()).toBe(month.current.from.getTime());
  });
});

/** Значение показателя раздела — по ключам, а не по порядку: порядок метрик может
 *  меняться, смысл проверки от этого зависеть не должен. */
function value(
  metrics: Awaited<ReturnType<typeof buildProblemMetrics>>,
  section: string,
  key: string
): number {
  const found = metrics.sections.find((s) => s.key === section)?.metrics.find((m) => m.key === key);
  if (!found) throw new Error(`В разборе нет показателя ${section}.${key}`);
  return found.value;
}

async function shortIdOf(clientId: string): Promise<number> {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { shortId: true } });
  return client!.shortId;
}
