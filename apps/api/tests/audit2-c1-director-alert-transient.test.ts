import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * АУДИТ CODEX 04.10.2026, CHANNEL-NEW-03: ВРЕМЕННЫЙ ОТКАЗ БД НЕ ЗАКРЫВАЕТ НЕДОСТАВЛЕННЫЙ АЛАРМ.
 *
 * catch в flushDirectorAlertQueue выставлял sentAt при ЛЮБОЙ ошибке (защита от «поломанной
 * строки»), и временный сбой createNotifications/поиска получателей молча терял аларм:
 * следующие проходы читают только sentAt: null. Теперь строка остаётся в очереди и
 * закрывается как проваленная только когда ей больше суток.
 */
const failTag = vi.hoisted(() => ({ tag: "", armed: false }));
vi.mock("../src/lib/notifications.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/notifications.js")>();
  return {
    ...orig,
    createNotifications: async (...args: Parameters<typeof orig.createNotifications>) => {
      if (failTag.armed && (args[1] as { tag?: string }).tag === failTag.tag) {
        throw new Error("временный отказ БД");
      }
      return orig.createNotifications(...args);
    },
  };
});
const sendPushToAgents = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { enqueueDirectorAlert, flushDirectorAlertQueue } = await import("../src/lib/directorAlertQueue.js");

const runId = Date.now();
const ALARM_HOURS_NOW = new Date("2026-09-01T07:00:00Z"); // 12:00 Душанбе — внутри окна
let directorId = "";

beforeAll(async () => {
  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор аларм-сбой ${runId}`, phone: `+992942${String(runId).slice(-9)}`, role: "DIRECTOR", passwordHash: "x", isActive: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.pendingDirectorAlert.deleteMany({ where: { title: { contains: runId.toString() } } });
  await prisma.notification.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

async function enqueueOwn(suffix: string, createdAt?: Date) {
  const tag = `c1-transient-${runId}-${suffix}`;
  await enqueueDirectorAlert({ title: `Аларм сбой ${runId} ${suffix}`, body: "тело", recipientRoles: ["DIRECTOR"], tag });
  if (createdAt) await prisma.pendingDirectorAlert.updateMany({ where: { tag }, data: { createdAt } });
  return tag;
}
const rowOf = (tag: string) => prisma.pendingDirectorAlert.findFirstOrThrow({ where: { tag } });

describe("flushDirectorAlertQueue: временный сбой доставки", () => {
  it("свежая строка при сбое остаётся в очереди, следующий проход доставляет", async () => {
    const tag = await enqueueOwn("fresh", new Date(ALARM_HOURS_NOW.getTime() - 60 * 60 * 1000));
    failTag.tag = tag;
    failTag.armed = true;
    await flushDirectorAlertQueue(ALARM_HOURS_NOW);
    expect((await rowOf(tag)).sentAt).toBeNull();
    expect(await prisma.notification.count({ where: { agentId: directorId, tag } })).toBe(0);

    failTag.armed = false;
    await flushDirectorAlertQueue(ALARM_HOURS_NOW);
    expect((await rowOf(tag)).sentAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { agentId: directorId, tag } })).toBe(1);
  });

  it("строка старше суток при сбое закрывается — поломанная запись не копится вечно", async () => {
    const tag = await enqueueOwn("old", new Date(ALARM_HOURS_NOW.getTime() - 26 * 60 * 60 * 1000));
    failTag.tag = tag;
    failTag.armed = true;
    await flushDirectorAlertQueue(ALARM_HOURS_NOW);
    failTag.armed = false;
    expect((await rowOf(tag)).sentAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { agentId: directorId, tag } })).toBe(0);
  });
});
