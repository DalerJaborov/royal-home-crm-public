import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";

const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { enqueueDirectorAlert, flushDirectorAlertQueue } = await import("../src/lib/directorAlertQueue.js");

/**
 * Общая очередь алармов руководству (владелец 07.09.2026, разбор часов
 * алармов) — enqueueDirectorAlert пишет мгновенно в любой час, а
 * flushDirectorAlertQueue доставляет только в часы алармов
 * (Settings.alarmHoursStart/End, по умолчанию 9:50–14:45 Душанбе).
 */

const runId = Date.now();
const ALARM_HOURS_NOW = new Date("2026-09-01T07:00:00Z"); // 12:00 Душанбе, вторник — внутри окна
const NIGHT_NOW = new Date("2026-09-01T20:00:00Z"); // 01:00 Душанбе — точно вне окна

let directorId: string;
let assignerId: string; // агент с правом clients.assign

beforeAll(async () => {
  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор очереди ${runId}`, phone: `+992940${runId}`, role: "DIRECTOR", passwordHash: "x", isActive: true },
    })
  ).id;
});

beforeEach(() => sendPushToAgents.mockClear());

afterAll(async () => {
  await prisma.pendingDirectorAlert.deleteMany({ where: { title: { contains: runId.toString() } } });
  await prisma.errorLog.deleteMany({ where: { dedupKey: "director-alert-no-recipients:MARKETING" } });
  await prisma.notification.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

describe("enqueueDirectorAlert / flushDirectorAlertQueue", () => {
  it("постановка в очередь не доставляет мгновенно — доставка только на flush", async () => {
    await enqueueDirectorAlert({
      title: `Тест очереди ${runId} А`,
      body: "тело",
      recipientRoles: ["DIRECTOR"],
      tag: `queue-test-${runId}-a`,
    });
    expect(sendPushToAgents).not.toHaveBeenCalled();
  });

  it("вне часов алармов flush молчит, ничего не доставляет", async () => {
    await enqueueDirectorAlert({
      title: `Тест очереди ${runId} Б`,
      body: "тело",
      recipientRoles: ["DIRECTOR"],
      tag: `queue-test-${runId}-b`,
    });
    const sent = await flushDirectorAlertQueue(NIGHT_NOW);
    expect(sent).toBe(0);
    expect(sendPushToAgents).not.toHaveBeenCalled();
  });

  it("в часы алармов flush доставляет по ролям (DIRECTOR)", async () => {
    await enqueueDirectorAlert({
      title: `Тест очереди ${runId} В`,
      body: "тело В",
      recipientRoles: ["DIRECTOR"],
      tag: `queue-test-${runId}-c`,
      url: "/oversight",
    });
    const sent = await flushDirectorAlertQueue(ALARM_HOURS_NOW);
    expect(sent).toBeGreaterThanOrEqual(1);
    const call = sendPushToAgents.mock.calls.find(([, p]) => (p as Record<string, string>).tag === `queue-test-${runId}-c`);
    expect(call).toBeDefined();
    const [to] = call!;
    expect(to as string[]).toContain(directorId);

    const note = await prisma.notification.findFirst({ where: { agentId: directorId, tag: `queue-test-${runId}-c` } });
    expect(note).not.toBeNull();
  });

  it("повторный flush не шлёт дубль (sentAt уже проставлен)", async () => {
    await enqueueDirectorAlert({
      title: `Тест очереди ${runId} Г`,
      body: "тело Г",
      recipientRoles: ["DIRECTOR"],
      tag: `queue-test-${runId}-d`,
    });
    await flushDirectorAlertQueue(ALARM_HOURS_NOW);
    sendPushToAgents.mockClear();
    await flushDirectorAlertQueue(ALARM_HOURS_NOW);
    // Не «сборщик вообще ничего не отправил»: очередь общая, рядом лежат чужие
    // строки (сид стенда, соседние файлы, крон), и их доставка — не ошибка.
    // Проверяемое свойство — НАША строка вторым проходом не уходит повторно.
    const repeat = sendPushToAgents.mock.calls.find(
      ([, p]) => (p as Record<string, string>).tag === `queue-test-${runId}-d`
    );
    expect(repeat).toBeUndefined();
  });

  it("доставляет по праву (findAgentsWithPermission), не только по роли", async () => {
    assignerId = (
      await prisma.agent.create({
        data: { fullName: `Агент с правом ${runId}`, phone: `+992941${runId}`, role: "ADMIN", passwordHash: "x", isActive: true },
      })
    ).id;
    await enqueueDirectorAlert({
      title: `Тест очереди ${runId} Д`,
      body: "тело Д",
      recipientPermission: "clients.assign",
      tag: `queue-test-${runId}-e`,
    });
    const sent = await flushDirectorAlertQueue(ALARM_HOURS_NOW);
    expect(sent).toBeGreaterThanOrEqual(1);
    await prisma.agent.deleteMany({ where: { id: assignerId } });
  });

  it("получателей у роли нет — аларм уходит директору и администратору, а не закрывается пустым", async () => {
    /**
     * «Получателей нет» тест обеспечивает САМ, а не надеется, что их нет.
     *
     * Раньше здесь стояло «MARKETING — валидная роль, но в этом тесте ни у кого
     * не назначена». Это верно ровно в одной среде: в CI база пустая, её только
     * что накатили миграциями и не сеяли. На любом стенде, поднятом с сидом (а
     * сид заводит маркетолога, `scripts/agent-stand.mjs`), получатель
     * находится, доставка происходит, и тест падает — при том что проверяемый
     * им код совершенно исправен. Замер 12.09.2026: единственное падение из
     * 4235 тестов, и оба раза не по делу.
     *
     * Поэтому на время проверки гасим тех маркетологов, что есть, и возвращаем
     * обратно в `finally`. Своё состояние вместо надежды на чужое.
     */
    const marketers = await prisma.agent.findMany({
      where: { role: "MARKETING", isActive: true },
      select: { id: true },
    });
    const ids = marketers.map((m) => m.id);
    if (ids.length) await prisma.agent.updateMany({ where: { id: { in: ids } }, data: { isActive: false } });
    try {
      await enqueueDirectorAlert({
        title: `Тест очереди ${runId} Е`,
        body: "тело Е",
        recipientRoles: ["MARKETING"],
        tag: `queue-test-${runId}-f`,
      });
      await flushDirectorAlertQueue(ALARM_HOURS_NOW);
      const ownSend = () =>
        sendPushToAgents.mock.calls.find(([, p]) => (p as Record<string, string>).tag === `queue-test-${runId}-f`);
      // 07.10.2026: «получателей нет» больше не значит «доставлено в никуда» — аларм
      // уходит запасным получателям (директор и администратор), и наш директор
      // среди них. Раньше строка молча закрывалась пустой.
      const sent = ownSend();
      expect(sent).toBeDefined();
      expect(sent![0] as string[]).toContain(directorId);
      // Отказ — в журнале ошибок: у роли нет ни одного получателя.
      // Запись дедуплицируется по ключу роли на десять минут (повторный прогон теста
      // не пишет вторую), поэтому ищем по ключу, а не по тексту этого прогона.
      const logged = await waitFor(() =>
        prisma.errorLog.findFirst({
          where: { source: "api", dedupKey: "director-alert-no-recipients:MARKETING" },
          orderBy: { createdAt: "desc" },
        })
      );
      expect(logged.message).toContain("нет ни одного получателя");
      // И строка закрыта ПОСЛЕ реальной доставки: второй проход её не повторяет.
      const row = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `queue-test-${runId}-f` } });
      expect(row?.sentAt).not.toBeNull();
      sendPushToAgents.mockClear();
      await flushDirectorAlertQueue(ALARM_HOURS_NOW);
      expect(ownSend()).toBeUndefined();
    } finally {
      if (ids.length) await prisma.agent.updateMany({ where: { id: { in: ids } }, data: { isActive: true } });
    }
  });
});
