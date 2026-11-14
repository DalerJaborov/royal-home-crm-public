import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { raiseCriticalAlarm } from "../src/lib/channelKeyAlarm.js";
import { checkBackupFreshness, BACKUP_STALE_MS } from "../src/lib/backupFreshness.js";
import { alertOnIntegrationBreakage } from "../src/lib/integrationHealth.js";
import { BILLING_RE } from "../src/lib/paymentReminders.js";
import { beatLoopHeartbeat } from "../src/lib/cronHeartbeat.js";

/**
 * Молчаливые поломки доходят до директора (охота 14.11.2026, №3, 4, 6a, 7).
 * Дверь одна (`raiseCriticalAlarm`): CRITICAL и срочно (мимо часов алармов), одна
 * метка на поломку, не чаще раза в 12 часов. Общий пуш «новая проблема» не
 * возвращается (решение владельца 02.10).
 */

const HOUR = 3_600_000;
const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, "../src", rel), "utf8");

const TAGS = ["test-door-a", "backup:OFFSITE", "backup:DB", "backup:RESTORE_DRILL", "integration:test-door-svc", "integration:test-door-svc-2"];

async function clean() {
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: TAGS } } });
}
beforeEach(clean);
afterAll(async () => {
  await clean();
  await prisma.integrationHealthSnapshot.deleteMany({ where: { name: { startsWith: "test-door-svc" } } });
  await prisma.$disconnect();
});

const alertsFor = (tag: string) => prisma.pendingDirectorAlert.findMany({ where: { tag } });

describe("дверь срочной тревоги", () => {
  it("CRITICAL и срочная; повтор по той же метке в пределах 12 часов не ставится, через 12 часов ставится", async () => {
    const t0 = new Date();
    expect((await raiseCriticalAlarm({ tag: "test-door-a", title: "Т", body: "Б", now: t0 })).alerted).toBe(true);
    expect((await raiseCriticalAlarm({ tag: "test-door-a", title: "Т", body: "Б", now: new Date(t0.getTime() + HOUR) })).alerted).toBe(false);
    const rows = await alertsFor("test-door-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: "CRITICAL", urgent: true });
    expect((await raiseCriticalAlarm({ tag: "test-door-a", title: "Т", body: "Б", now: new Date(t0.getTime() + 13 * HOUR) })).alerted).toBe(true);
  });
});

describe("сторож свежести копий", () => {
  const now = new Date();
  const run = (kind: string, success: boolean, hoursAgo: number, detail?: string) =>
    prisma.backupRun.create({
      data: { kind, success, detail, startedAt: new Date(now.getTime() - hoursAgo * HOUR), finishedAt: new Date(now.getTime() - hoursAgo * HOUR) },
    });
  beforeEach(async () => {
    await prisma.backupRun.deleteMany({});
  });
  afterAll(async () => {
    await prisma.backupRun.deleteMany({});
  });

  it("строк нет вовсе: тревога «копия не создаётся»", async () => {
    expect(await checkBackupFreshness(now)).toBe(1);
    expect(await alertsFor("backup:OFFSITE")).toHaveLength(1);
  });

  it("последняя удачная выгрузка старше 26 часов: тревога; свежая (20 часов): тишина", async () => {
    await run("OFFSITE", true, BACKUP_STALE_MS / HOUR + 2);
    expect(await checkBackupFreshness(now)).toBe(1);
    await clean();
    await prisma.backupRun.deleteMany({});
    await run("OFFSITE", true, 20);
    expect(await checkBackupFreshness(now)).toBe(0);
    expect(await alertsFor("backup:OFFSITE")).toHaveLength(0);
  });

  it("свежая неудача любого вида: тревога по виду; если позже был успех того же вида: тишина", async () => {
    await run("OFFSITE", true, 3);
    await run("RESTORE_DRILL", false, 5, "не восстановилось");
    expect(await checkBackupFreshness(now)).toBe(1);
    const [row] = await alertsFor("backup:RESTORE_DRILL");
    expect(row.body).toContain("не восстановилось");
    await clean();
    await run("RESTORE_DRILL", true, 1);
    expect(await checkBackupFreshness(now)).toBe(0);
  });
});

describe("переход внешнего доступа в «сломан»", () => {
  it("жив -> сломан: тревога; сломан -> сломан: тишина; не настроен -> сломан: тревога", async () => {
    await prisma.integrationHealthSnapshot.upsert({ where: { name: "test-door-svc" }, create: { name: "test-door-svc", ok: true }, update: { ok: true } });
    await prisma.integrationHealthSnapshot.upsert({ where: { name: "test-door-svc-2" }, create: { name: "test-door-svc-2", ok: null }, update: { ok: null } });
    const broken = [
      { name: "test-door-svc", ok: false, detail: "ответ 401" },
      { name: "test-door-svc-2", ok: false, detail: "ключ отозван" },
    ];
    expect(await alertOnIntegrationBreakage(broken)).toBe(2);
    expect(await alertsFor("integration:test-door-svc")).toHaveLength(1);
    expect((await alertsFor("integration:test-door-svc"))[0]).toMatchObject({ level: "CRITICAL", urgent: true });
    // Снимок записывает cron.ts уже после; на следующие сутки поломка та же: перехода нет.
    await prisma.integrationHealthSnapshot.updateMany({ where: { name: { startsWith: "test-door-svc" } }, data: { ok: false } });
    await clean();
    expect(await alertOnIntegrationBreakage(broken)).toBe(0);
    expect(await alertOnIntegrationBreakage([{ name: "test-door-svc", ok: true }, { name: "test-door-svc-2", ok: null }])).toBe(0);
  });
});

describe("признак сбоя оплаты (6a)", () => {
  it.each([
    "Озвучка роликов: кредиты ElevenLabs закончились. Озвучки ждут пополнения",
    'ElevenLabs: {"detail":{"status":"quota_exceeded"}}',
    "Робозвонок остановлен: у ElevenLabs закончились минуты (кредиты)",
  ])("узнаёт: %s", (text) => {
    expect(BILLING_RE.test(text)).toBe(true);
  });
  it("голый лимит скорости оплатой не считается", () => {
    expect(BILLING_RE.test("ElevenLabs: 429 too many requests")).toBe(false);
  });
});

describe("пульс Telegram-поллера", () => {
  it("не чаще раза в минуту: второй удар в ту же минуту пропущен, в следующую проходит", async () => {
    const name = "test-door-loop";
    const t = Date.now();
    beatLoopHeartbeat(name, true, t);
    beatLoopHeartbeat(name, true, t + 30_000);
    await new Promise((r) => setTimeout(r, 300));
    const first = await prisma.cronHeartbeat.findUnique({ where: { name } });
    expect(first?.lastRunAt?.getTime()).toBe(t);
    beatLoopHeartbeat(name, false, t + 61_000);
    await new Promise((r) => setTimeout(r, 300));
    const second = await prisma.cronHeartbeat.findUnique({ where: { name } });
    expect(second?.lastRunAt?.getTime()).toBe(t + 61_000);
    expect(second?.lastOkAt?.getTime()).toBe(t);
    await prisma.cronHeartbeat.deleteMany({ where: { name } });
  });
});

describe("сторож в CI: все места класса зовут одну дверь", () => {
  it("крон молчит и тик снят по таймауту", () => {
    const text = src("lib/cronHeartbeat.ts");
    expect(text.match(/raiseCriticalAlarm\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(text).toContain("cron-silent:");
  });
  it("доступы, Telegram-поллер, озвучка, робозвонок, копии", () => {
    expect(src("cron.ts")).toContain("alertOnIntegrationBreakage(checks)");
    expect(src("cron.ts")).toContain('scheduleTracked("backup-freshness"');
    expect(src("lib/integrationHealth.ts")).toContain("raiseCriticalAlarm(");
    expect(src("telegram/poller.ts")).toMatch(/raiseCriticalAlarm\(\{\s*tag: "telegram-poller"/);
    expect(src("lib/narrationAutoFlow.ts")).toContain("ELEVENLABS_QUOTA_ALARM_TAG");
    expect(src("ai/liveVoiceProvider.ts")).toContain("ELEVENLABS_QUOTA_ALARM_TAG");
    expect(src("lib/backupFreshness.ts")).toContain("raiseCriticalAlarm(");
  });
  it("общий пуш «новая проблема» не вернулся: заглушка на месте", () => {
    const push = src("push.ts");
    const stub = /export async function notifyDirectorsAboutNewError[^{]*\{([\s\S]*?)\n\}/.exec(push);
    expect(stub).not.toBeNull();
    expect(stub![1]).not.toMatch(/sendPush|enqueueDirectorAlert|notifyAgent/);
  });
});
