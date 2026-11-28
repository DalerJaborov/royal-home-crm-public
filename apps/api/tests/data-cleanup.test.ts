import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { autoCleanupDays, cleanupWhere, deleteInBatches, runAutoCleanup } from "../src/lib/dataCleanup.js";
import { createNotification } from "../src/lib/notifications.js";
import { dushanbeDateString } from "../src/lib/dushanbeTime.js";

/**
 * ЧИСТКА МУСОРА (владелец 28.11.2026): кнопки «Очистить», автоочистка, «Скрыть».
 * Удаление безвозвратное, поэтому проверяем главное: что стирается ровно нужное, а непрочитанное,
 * неразобранное и свежее — никогда; что рубильник ВЫКЛ ничего не делает; что чужое не трогается.
 */

const runId = Date.now();
const sfx = String(runId).slice(-7);
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const marker = `cleanup-test-${runId}`;
const agentIds: string[] = [];
let directorId = "";
let agentId = "";
let directorToken = "";
let agentToken = "";
let savedSettings: Record<string, unknown> = {};

const note = (agent: string, data: { read?: boolean; createdAt?: Date; tag?: string | null; hiddenAt?: Date | null } = {}) =>
  prisma.notification.create({
    data: { agentId: agent, kind: "lead", title: marker, body: "", read: data.read ?? false, createdAt: data.createdAt ?? new Date(), tag: data.tag ?? null, hiddenAt: data.hiddenAt ?? null },
  });

beforeAll(async () => {
  const director = await prisma.agent.create({ data: { fullName: `Директор чистка ${runId}`, phone: `+992931${sfx}`, role: "DIRECTOR", passwordHash: "x" } });
  const agent = await prisma.agent.create({ data: { fullName: `Агент чистка ${runId}`, phone: `+992932${sfx}`, role: "AGENT", passwordHash: "x" } });
  directorId = director.id;
  agentId = agent.id;
  agentIds.push(director.id, agent.id);
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    autoCleanupEnabled: s.autoCleanupEnabled,
    autoCleanupNotificationsReadDays: s.autoCleanupNotificationsReadDays,
    autoCleanupErrorsResolvedDays: s.autoCleanupErrorsResolvedDays,
    autoCleanupDirectorAlertsDays: s.autoCleanupDirectorAlertsDays,
    autoCleanupBotCountersDays: s.autoCleanupBotCountersDays,
    autoCleanupOneTimeDays: s.autoCleanupOneTimeDays,
  };
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.notification.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.errorLog.deleteMany({ where: { message: { startsWith: marker } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { title: marker } });
  await prisma.guardHit.deleteMany({ where: { guard: { startsWith: marker } } });
  await prisma.idempotencyKey.deleteMany({ where: { key: { startsWith: marker } } });
  await prisma.telegramCallbackSeen.deleteMany({ where: { id: { startsWith: marker } } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: agentIds } } });
  await deleteAgentsWithTraces(agentIds);
});

describe("условие выборки (cleanupWhere)", () => {
  const actor = { id: "a1", role: "DIRECTOR" };
  it("уведомления: «разобранное» — только прочитанное, «всё» — без условия; «мои» — по агенту", () => {
    expect(cleanupWhere("notifications", "handled", "all", actor)).toEqual({ read: true });
    expect(cleanupWhere("notifications", "all", "all", actor)).toEqual({});
    expect(cleanupWhere("notifications", "handled", "mine", actor)).toEqual({ agentId: "a1", read: true });
  });
  it("оповещения директору: «разобранное» — уже разобранные очередью", () => {
    expect(cleanupWhere("directorAlerts", "handled", "all", actor)).toEqual({ sentAt: { not: null } });
    expect(cleanupWhere("directorAlerts", "all", "all", actor)).toEqual({});
  });
  it("журнал ошибок: «разобранное» — с resolvedAt", () => {
    expect(JSON.stringify(cleanupWhere("errorLog", "handled", "all", actor))).toContain('"resolvedAt":{"not":null}');
  });
});

describe("сроки автоочистки", () => {
  it("кривое число в базе приводится к пределам, свежее не стирается", () => {
    const d = autoCleanupDays({ autoCleanupNotificationsReadDays: 0, autoCleanupErrorsResolvedDays: 99999, autoCleanupDirectorAlertsDays: null });
    // Нижний предел 35 дней: удалить раньше — значит получить ту же тревогу заново как новую.
    expect(d.autoCleanupNotificationsReadDays).toBe(35);
    expect(d.autoCleanupErrorsResolvedDays).toBe(365);
    expect(d.autoCleanupDirectorAlertsDays).toBe(35);
    // Счётчики щитов читаются окном в 14 суток — меньше 15 дней поставить нельзя.
    expect(autoCleanupDays({ autoCleanupBotCountersDays: 3 }).autoCleanupBotCountersDays).toBe(15);
    expect(autoCleanupDays({}).autoCleanupOneTimeDays).toBe(7);
  });
});

describe("deleteInBatches", () => {
  it("стирает пачками ровно подходящее, остальное цело", async () => {
    const mine = await Promise.all([1, 2, 3, 4, 5].map(() => note(agentId, { read: true, tag: `${marker}-b` })));
    const keep = await note(agentId, { read: false, tag: `${marker}-keep` });
    const deleted = await deleteInBatches(prisma.notification as never, { agentId, tag: `${marker}-b` }, 10, 2);
    expect(deleted).toBe(5);
    expect(await prisma.notification.count({ where: { id: { in: mine.map((m) => m.id) } } })).toBe(0);
    expect(await prisma.notification.count({ where: { id: keep.id } })).toBe(1);
  });
  it("потолок пачек не даёт чистить бесконечно", async () => {
    await Promise.all([1, 2, 3, 4, 5].map(() => note(agentId, { read: true, tag: `${marker}-cap` })));
    const deleted = await deleteInBatches(prisma.notification as never, { agentId, tag: `${marker}-cap` }, 2, 2);
    expect(deleted).toBe(4);
    await prisma.notification.deleteMany({ where: { agentId, tag: `${marker}-cap` } });
  });
});

describe("runAutoCleanup", () => {
  async function seed() {
    const oldRead = await note(agentId, { read: true, createdAt: ago(40) });
    const oldUnread = await note(agentId, { read: false, createdAt: ago(40) });
    const freshRead = await note(agentId, { read: true, createdAt: ago(5) });
    const errOldResolved = await prisma.errorLog.create({ data: { source: "api", message: `${marker} old-resolved`, resolvedAt: ago(40) } });
    const errOldOpen = await prisma.errorLog.create({ data: { source: "api", message: `${marker} old-open`, createdAt: ago(40) } });
    const errFreshResolved = await prisma.errorLog.create({ data: { source: "api", message: `${marker} fresh-resolved`, resolvedAt: ago(1) } });
    const alertOldSent = await prisma.pendingDirectorAlert.create({ data: { title: marker, body: "", recipientRoles: ["DIRECTOR"], sentAt: ago(40), createdAt: ago(40) } });
    const alertOldPending = await prisma.pendingDirectorAlert.create({ data: { title: marker, body: "", recipientRoles: ["DIRECTOR"], createdAt: ago(40) } });
    return { oldRead, oldUnread, freshRead, errOldResolved, errOldOpen, errFreshResolved, alertOldSent, alertOldPending };
  }

  it("рубильник ВЫКЛ — ничего не удаляет", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoCleanupEnabled: false } });
    const s = await seed();
    const r = await runAutoCleanup();
    expect(r.ran).toBe(false);
    expect(await prisma.notification.count({ where: { id: s.oldRead.id } })).toBe(1);
  });

  it("рубильник ВКЛ — удаляет старое обработанное, непрочитанное, неразобранное и свежее остаётся", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { autoCleanupEnabled: true, autoCleanupNotificationsReadDays: 35, autoCleanupErrorsResolvedDays: 35, autoCleanupDirectorAlertsDays: 35 },
    });
    const s = await seed();
    const r = await runAutoCleanup();
    expect(r.ran).toBe(true);
    const has = async (model: "notification" | "errorLog" | "pendingDirectorAlert", id: string) =>
      (await (prisma[model] as unknown as { count(a: unknown): Promise<number> }).count({ where: { id } })) === 1;
    expect(await has("notification", s.oldRead.id)).toBe(false);
    expect(await has("notification", s.oldUnread.id)).toBe(true);
    expect(await has("notification", s.freshRead.id)).toBe(true);
    expect(await has("errorLog", s.errOldResolved.id)).toBe(false);
    expect(await has("errorLog", s.errOldOpen.id)).toBe(true);
    expect(await has("errorLog", s.errFreshResolved.id)).toBe(true);
    expect(await has("pendingDirectorAlert", s.alertOldSent.id)).toBe(false);
    expect(await has("pendingDirectorAlert", s.alertOldPending.id)).toBe(true);
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoCleanupEnabled: false } });
  });
});

describe("runAutoCleanup: счётчики щитов и одноразовые записи", () => {
  it("удаляет старые и истёкшие, свежие и ещё действующие остаются", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoCleanupEnabled: true, autoCleanupBotCountersDays: 30, autoCleanupOneTimeDays: 7 } });
    const oldDay = dushanbeDateString(ago(45));
    const freshDay = dushanbeDateString(ago(2));
    const hitOld = await prisma.guardHit.create({ data: { day: oldDay, guard: `${marker}-old`, count: 1 } });
    const hitFresh = await prisma.guardHit.create({ data: { day: freshDay, guard: `${marker}-fresh`, count: 1 } });
    const codeOldExpired = await prisma.loginSmsCode.create({ data: { agentId, codeHash: "x", expiresAt: ago(9), createdAt: ago(9) } });
    const codeFresh = await prisma.loginSmsCode.create({ data: { agentId, codeHash: "x", expiresAt: new Date(Date.now() + 300_000) } });
    const idemOld = await prisma.idempotencyKey.create({ data: { agentId, key: `${marker}-o`, method: "POST", path: "/x", createdAt: ago(9) } });
    const idemFresh = await prisma.idempotencyKey.create({ data: { agentId, key: `${marker}-f`, method: "POST", path: "/x" } });
    const tgOld = await prisma.telegramCallbackSeen.create({ data: { id: `${marker}-o`, createdAt: ago(9) } });
    const tgFresh = await prisma.telegramCallbackSeen.create({ data: { id: `${marker}-f` } });
    const r = await runAutoCleanup();
    expect(r.botCounters).toBeGreaterThanOrEqual(1);
    expect(r.oneTime).toBeGreaterThanOrEqual(3);
    expect(await prisma.guardHit.count({ where: { id: hitOld.id } })).toBe(0);
    expect(await prisma.guardHit.count({ where: { id: hitFresh.id } })).toBe(1);
    expect(await prisma.loginSmsCode.count({ where: { id: codeOldExpired.id } })).toBe(0);
    expect(await prisma.loginSmsCode.count({ where: { id: codeFresh.id } })).toBe(1);
    expect(await prisma.idempotencyKey.count({ where: { id: idemOld.id } })).toBe(0);
    expect(await prisma.idempotencyKey.count({ where: { id: idemFresh.id } })).toBe(1);
    expect(await prisma.telegramCallbackSeen.count({ where: { id: tgOld.id } })).toBe(0);
    expect(await prisma.telegramCallbackSeen.count({ where: { id: tgFresh.id } })).toBe(1);
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoCleanupEnabled: false } });
  });
});

describe("кнопки «Очистить» (POST /cleanup/run)", () => {
  const post = (path: string, token: string, body: object) => request(app).post(path).set("Authorization", `Bearer ${token}`).send(body);

  it("агенту нельзя: ни счёт, ни удаление", async () => {
    const prev = await request(app).get("/api/v1/cleanup/preview?target=notifications&mode=all&scope=mine").set("Authorization", `Bearer ${agentToken}`);
    expect(prev.status).toBe(403);
    const run = await post("/api/v1/cleanup/run", agentToken, { target: "notifications", mode: "all", scope: "mine" });
    expect(run.status).toBe(403);
  });

  it("неверные параметры — 400", async () => {
    const res = await post("/api/v1/cleanup/run", directorToken, { target: "auditLog", mode: "all" });
    expect(res.status).toBe(400);
  });

  it("«прочитанное» у себя: число совпадает с превью, непрочитанное и чужое остаётся, операция в AuditLog", async () => {
    const r1 = await note(directorId, { read: true });
    const r2 = await note(directorId, { read: true });
    const unread = await note(directorId, { read: false });
    const others = await note(agentId, { read: true });
    const prev = await request(app).get("/api/v1/cleanup/preview?target=notifications&mode=handled&scope=mine").set("Authorization", `Bearer ${directorToken}`);
    expect(prev.status).toBe(200);
    expect(prev.body.count).toBe(2);
    const run = await post("/api/v1/cleanup/run", directorToken, { target: "notifications", mode: "handled", scope: "mine" });
    expect(run.status).toBe(200);
    expect(run.body.count).toBe(2);
    expect(await prisma.notification.count({ where: { id: { in: [r1.id, r2.id] } } })).toBe(0);
    expect(await prisma.notification.count({ where: { id: { in: [unread.id, others.id] } } })).toBe(2);
    await expect.poll(() => prisma.auditLog.count({ where: { agentId: directorId, action: "CLEANUP" } })).toBeGreaterThan(0);
    const audit = await prisma.auditLog.findFirst({ where: { agentId: directorId, action: "CLEANUP" }, orderBy: { createdAt: "desc" } });
    expect(audit?.meta).toMatchObject({ target: "notifications", mode: "handled", scope: "mine", count: 2 });
  });

  it("«всё» у себя стирает и непрочитанное, но не чужое", async () => {
    const mineUnread = await note(directorId, { read: false });
    const others = await note(agentId, { read: false });
    const run = await post("/api/v1/cleanup/run", directorToken, { target: "notifications", mode: "all", scope: "mine" });
    expect(run.status).toBe(200);
    expect(await prisma.notification.count({ where: { id: mineUnread.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { id: others.id } })).toBe(1);
  });
});

describe("«Скрыть» уведомление", () => {
  const get = (token: string) => request(app).get("/api/v1/me/notifications").set("Authorization", `Bearer ${token}`);
  const ids = (res: request.Response) => (res.body.items as Array<{ id: string }>).map((n) => n.id);

  it("скрытое пропадает из ленты у владельца, остаётся в базе; чужое скрыть нельзя", async () => {
    const mine = await note(agentId, { read: true });
    const stranger = await note(directorId, { read: true });
    const before = await get(agentToken);
    expect(ids(before)).toContain(mine.id);

    const hide = await request(app).post(`/api/v1/me/notifications/${mine.id}/hide`).set("Authorization", `Bearer ${agentToken}`);
    expect(hide.status).toBe(200);
    const after = await get(agentToken);
    expect(ids(after)).not.toContain(mine.id);
    expect(await prisma.notification.count({ where: { id: mine.id } })).toBe(1);

    const foreign = await request(app).post(`/api/v1/me/notifications/${stranger.id}/hide`).set("Authorization", `Bearer ${agentToken}`);
    expect(foreign.status).toBe(404);
    expect((await prisma.notification.findUnique({ where: { id: stranger.id } }))?.hiddenAt).toBeNull();
  });

  it("непрочитанное скрыть нельзя: дело ждёт, строка остаётся в ленте", async () => {
    const unread = await note(agentId, { read: false });
    const res = await request(app).post(`/api/v1/me/notifications/${unread.id}/hide`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
    expect((await prisma.notification.findUnique({ where: { id: unread.id } }))?.hiddenAt).toBeNull();
  });

  it("«Скрыть всё прочитанное» скрывает только прочитанное", async () => {
    const read = await note(agentId, { read: true });
    const unread = await note(agentId, { read: false });
    const res = await request(app).post("/api/v1/me/notifications/hide-read").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    const feed = await get(agentToken);
    expect(ids(feed)).not.toContain(read.id);
    expect(ids(feed)).toContain(unread.id);
  });

  it("повтор того же события (tag) возвращает скрытую строку в ленту", async () => {
    const tag = `${marker}-repeat`;
    const first = await note(agentId, { read: true, tag, hiddenAt: new Date() });
    await createNotification({ agentId, kind: "lead", title: marker, body: "снова", tag });
    const row = await prisma.notification.findUnique({ where: { id: first.id } });
    expect(row?.hiddenAt).toBeNull();
    expect(row?.read).toBe(false);
  });
});
