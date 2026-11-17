import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgents = vi.fn(async () => 1);
const sendDevicePushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
  sendDevicePushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { enqueueDirectorAlert, flushDirectorAlertQueue } = await import("../src/lib/directorAlertQueue.js");

/**
 * СРОЧНЫЕ ТРЕВОГИ И КОЛОКОЛЬЧИК СРАЗУ (14.11.2026, аудит скрытых механизмов №1).
 *
 * До правки очередь тревог руководству разбиралась только в часы алармов
 * (на проде 09:50–14:45) — и пуш, и запись в колокольчик. 115 из 415 тревог за
 * 30 дней пришли позже 12 часов, включая «ключ канала умер» и «щит остановил бота».
 * Теперь: колокольчик — сразу в любой час; пуш срочной — сразу; пуш «к сведению» —
 * по-прежнему в окне.
 */

const runId = Date.now();
const ALARM_HOURS_NOW = new Date("2026-11-10T07:00:00Z"); // 12:00 Душанбе — внутри окна
const OFF_WINDOW_NOW = new Date("2026-11-10T12:00:00Z"); // 17:00 Душанбе — после окна, рабочий вечер
let directorId: string;
let saved: { alarmHoursStart: string | null; alarmHoursEnd: string | null } | null = null;

const ownPush = (tag: string) => sendPushToAgents.mock.calls.find(([, p]) => (p as { tag?: string }).tag === tag);
const ownDevicePush = (tag: string) => sendDevicePushToAgents.mock.calls.find(([, p]) => (p as { tag?: string }).tag === tag);

beforeAll(async () => {
  saved = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { alarmHoursStart: true, alarmHoursEnd: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { alarmHoursStart: "09:50", alarmHoursEnd: "14:45" } });
  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор срочных ${runId}`, phone: `+992946${String(runId).slice(-6)}`, role: "DIRECTOR", passwordHash: "x", isActive: true },
    })
  ).id;
});

beforeEach(() => {
  sendPushToAgents.mockClear();
  sendDevicePushToAgents.mockClear();
});

afterAll(async () => {
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: `urgent-test-${runId}` } } });
  await prisma.notification.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

describe("Очередь тревог: колокольчик сразу, пуш по срочности", () => {
  it("«к сведению» вне окна: колокольчик сразу, пуша нет, строка ждёт окна; в окне — пуш, второй записи в ленте нет", async () => {
    const tag = `urgent-test-${runId}-info`;
    await enqueueDirectorAlert({ title: `Сводка ${runId}`, body: "к сведению", recipientRoles: ["DIRECTOR"], tag });

    await flushDirectorAlertQueue(OFF_WINDOW_NOW);
    expect(ownPush(tag)).toBeUndefined();
    const note = await prisma.notification.findFirst({ where: { agentId: directorId, tag } });
    expect(note).not.toBeNull();
    const row = await prisma.pendingDirectorAlert.findFirst({ where: { tag } });
    expect(row?.feedAt).not.toBeNull();
    expect(row?.sentAt).toBeNull();

    // Второй проход вне окна строку не трогает: колокольчик уже записан.
    await flushDirectorAlertQueue(new Date(OFF_WINDOW_NOW.getTime() + 60_000));
    expect(ownPush(tag)).toBeUndefined();

    // Прочитал вечером — утренний пуш не должен вернуть строку в непрочитанные.
    await prisma.notification.updateMany({ where: { agentId: directorId, tag }, data: { read: true } });
    await flushDirectorAlertQueue(ALARM_HOURS_NOW);
    // Только звонок: колокольчик записан ещё вечером.
    expect(ownPush(tag)).toBeUndefined();
    const pushed = ownDevicePush(tag);
    expect(pushed).toBeDefined();
    expect(pushed![0] as string[]).toContain(directorId);
    const closed = await prisma.pendingDirectorAlert.findFirst({ where: { tag } });
    expect(closed?.sentAt).not.toBeNull();
    // Колокольчик не задвоился и не стал снова непрочитанным.
    const notes = await prisma.notification.findMany({ where: { agentId: directorId, tag } });
    expect(notes).toHaveLength(1);
    expect(notes[0].read).toBe(true);
    expect(notes[0].count).toBe(1);
  });

  it("срочная вне окна уходит пушем сразу и закрывается", async () => {
    const tag = `urgent-test-${runId}-critical`;
    await enqueueDirectorAlert({
      title: `Ключ канала умер ${runId}`,
      body: "срочно",
      level: "CRITICAL",
      severity: "critical",
      recipientRoles: ["DIRECTOR"],
      tag,
    });
    const row = await prisma.pendingDirectorAlert.findFirst({ where: { tag } });
    expect(row?.urgent).toBe(true);

    await flushDirectorAlertQueue(OFF_WINDOW_NOW);
    const pushed = ownPush(tag);
    expect(pushed).toBeDefined();
    expect((pushed![1] as { level?: string }).level).toBe("CRITICAL");
    const note = await prisma.notification.findFirst({ where: { agentId: directorId, tag } });
    expect(note?.level).toBe("CRITICAL");
    const closed = await prisma.pendingDirectorAlert.findFirst({ where: { tag } });
    expect(closed?.sentAt).not.toBeNull();

    sendPushToAgents.mockClear();
    await flushDirectorAlertQueue(new Date(OFF_WINDOW_NOW.getTime() + 60_000));
    expect(ownPush(tag)).toBeUndefined();
  });

  it("уровень CRITICAL без severity — НЕ срочно: антифрод и сторож номеров владелец сам отправил в окно", async () => {
    const tag = `urgent-test-${runId}-level-only`;
    await enqueueDirectorAlert({ title: `Антифрод ${runId}`, body: "в окно", level: "CRITICAL", recipientRoles: ["DIRECTOR"], tag });
    await flushDirectorAlertQueue(OFF_WINDOW_NOW);
    expect(ownPush(tag)).toBeUndefined();
    expect(await prisma.notification.findFirst({ where: { agentId: directorId, tag } })).not.toBeNull();
  });
});

/**
 * СТОРОЖ СПИСКА СРОЧНЫХ. Срочность — решение вызывающего кода; если правка
 * тихо уберёт `severity: "critical"` у одного из этих мест, тревога снова будет
 * ждать до утра, и ни сборка, ни остальные тесты этого не заметят.
 */
describe("Срочные тревоги помечены срочными", () => {
  const critical = [
    "src/lib/channelKeyAlarm.ts", // ключ канала перестал работать
    "src/lib/outboundShield.ts", // щит остановил бота
    "src/lib/liveVoiceSpend.ts", // минуты робота на исходе / кончились
    "src/lib/telephony/voicemailIngest.ts", // сообщение на автоответчике
    "src/lib/instagramIdentityGuard.ts", // бот молчит в Instagram
    "src/lib/customerAgentRevisionAlert.ts", // новый бот остановлен
    "src/lib/clientWaitingAlert.ts", // клиент ждёт ответа, агента нет
  ];
  for (const file of critical) {
    it(file, () => {
      const src = readFileSync(path.resolve(__dirname, "..", file), "utf8");
      expect(src).toMatch(/enqueueDirectorAlert/);
      expect(src).toMatch(/severity:\s*"critical"/);
    });
  }
});
