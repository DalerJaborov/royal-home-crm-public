import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation, revokeElevation } from "../src/lib/stepUp.js";
import { decryptSecretSafe } from "../src/crypto.js";
import {
  pruneSettingsSnapshots,
  SNAPSHOT_KEEP_COUNT,
  SNAPSHOT_KEEP_DAYS,
} from "../src/lib/settingsSnapshots.js";

/**
 * ТОЧКИ ВОЗВРАТА НАСТРОЕК.
 *
 * ЗАЧЕМ ТЕСТ. Журнал действий записывает по правке настроек только ИМЕНА полей и
 * намеренно не пишет значения (там секреты) — то есть откатиться по нему нельзя в
 * принципе. Владелец просил кнопку «сбросить всё», от неё отказались (умолчания
 * этой строки ПУСТЫ: ни ключей, ни паролей АТС, ни промта бота) и сделали историю
 * состояний. Здесь закрепляется то, без чего история бесполезна или опасна:
 *  • снимок хранит состояние ДО правки, а не после;
 *  • возврат действительно возвращает значения;
 *  • секреты после возврата ПРОДОЛЖАЮТ РАБОТАТЬ (расшифровываются в исходный вид);
 *  • ключ шифрования сменился — секреты не трогаются вовсе, а не пишутся мусором;
 *  • возврат сам снимает точку, поэтому неудачный откат обратим;
 *  • срок хранения обрезает историю;
 *  • без права и без подтверждения личности откат недоступен.
 */

const runId = Date.now();
const password = "testpass123";

let adminId: string;
let adminToken: string;
let agentId: string;
let agentToken: string;
let saved: Record<string, unknown>;

const ORIGINAL_KEY = "AQ.RestorePointOriginal001";
const BROKEN_KEY = "AQ.RestorePointBroken002";

function patch(body: Record<string, unknown>) {
  return request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);
}

function listPoints(token = adminToken) {
  return request(app).get("/api/v1/settings/restore-points").set("Authorization", `Bearer ${token}`);
}

function restore(id: string, token = adminToken) {
  return request(app).post(`/api/v1/settings/restore-points/${id}/restore`).set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ точек возврата", phone: `+992937${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  adminToken = (await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password })).body.accessToken;
  grantElevation(adminId);

  const agent = await prisma.agent.create({
    data: { fullName: "Агент без прав", phone: `+992938${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  agentToken = (await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password })).body.accessToken;

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = {
    companyName: current.companyName,
    leadAcceptMinutes: current.leadAcceptMinutes,
    botEnabled: current.botEnabled,
    geminiApiKey: current.geminiApiKey,
  };
  /**
   * ПОЧЕМУ ЗДЕСЬ ЧИСТКА ВСЕЙ ТАБЛИЦЫ, А НЕ ПО МАРКЕРУ (сверка 11.09.2026).
   *
   * Общее правило набора — не трогать чужое. Здесь исключение: проверяется
   * pruneSettingsSnapshots, а он режет точки возврата ПО ВОЗРАСТУ И ПО СЧЁТУ
   * во всей таблице и возвращает, сколько срезал. Ни выборку, ни ожидание
   * сузить нечем — чужая точка сдвигает оба числа.
   *
   * Цена признана допустимой: SettingsSnapshot — история правок настроек,
   * которую тот же самый механизм и так подрезает до последних N; ни одна
   * другая проверка набора на неё не опирается.
   */
  await prisma.settingsSnapshot.deleteMany({});
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.settingsSnapshot.deleteMany({});
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId] } } });
  await prisma.$disconnect();
});

describe("Точки возврата настроек", () => {
  it("сохранение снимает точку с ПРЕЖНИМ состоянием, а не с новым", async () => {
    await patch({ companyName: "Было раньше", leadAcceptMinutes: 15 });
    const before = (await listPoints()).body.items.length;

    const res = await patch({ companyName: "Стало теперь" });
    expect(res.status).toBe(200);

    const list = await listPoints();
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(before + 1);

    const point = list.body.items[0];
    expect(point.agentName).toBe("Админ точек возврата");
    expect(point.reason).toBe("update");
    expect(point.changedFields).toContain("companyName");
    // Отличия считаются от ДЕЙСТВУЮЩИХ настроек: в точке старое имя, сейчас новое.
    const change = point.changes.find((c: { field: string }) => c.field === "companyName");
    expect(change).toEqual({ field: "companyName", from: "Было раньше", to: "Стало теперь" });
  });

  it("сохранение без изменений точку не плодит", async () => {
    await patch({ companyName: "Без изменений" });
    const before = (await listPoints()).body.items.length;
    // Форма показывает действующие значения: «открыл вкладку и нажал Сохранить»
    // не должно вытеснять из истории настоящие точки.
    const res = await patch({ companyName: "Без изменений" });
    expect(res.status).toBe(200);
    expect((await listPoints()).body.items.length).toBe(before);
  });

  it("возврат восстанавливает прежние значения и сам снимает точку", async () => {
    await patch({ companyName: "Рабочее состояние", leadAcceptMinutes: 20, botEnabled: true });
    await patch({ companyName: "Поломанное состояние", leadAcceptMinutes: 45, botEnabled: false });

    const points = (await listPoints()).body.items;
    const target = points[0];
    expect(target.changedFields).toEqual(expect.arrayContaining(["companyName", "leadAcceptMinutes", "botEnabled"]));

    const res = await restore(target.id);
    expect(res.status).toBe(200);
    expect(res.body.restoredFields).toEqual(
      expect.arrayContaining(["companyName", "leadAcceptMinutes", "botEnabled"])
    );
    expect(res.body.skippedSecrets).toEqual([]);
    // Без этой точки неудачный откат был бы необратим — это и есть страховка.
    expect(res.body.backupPointId).toBeTruthy();

    const row = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(row?.companyName).toBe("Рабочее состояние");
    expect(row?.leadAcceptMinutes).toBe(20);
    expect(row?.botEnabled).toBe(true);

    const backup = (await listPoints()).body.items[0];
    expect(backup.id).toBe(res.body.backupPointId);
    expect(backup.reason).toBe("restore");
    // Точка перед откатом хранит именно ПОЛОМАННОЕ состояние — к нему тоже можно
    // вернуться, если откат оказался ошибкой.
    const backupRow = await prisma.settingsSnapshot.findUnique({ where: { id: backup.id } });
    expect((backupRow?.payload as { companyName: string }).companyName).toBe("Поломанное состояние");
  });

  it("секрет после возврата продолжает работать: расшифровывается в исходный ключ", async () => {
    await patch({ geminiApiKey: ORIGINAL_KEY });
    await patch({ geminiApiKey: BROKEN_KEY });

    const points = (await listPoints()).body.items;
    const target = points[0];
    expect(target.changedFields).toContain("geminiApiKey");
    expect(target.secretsRestorable).toBe(true);
    // Значение секрета наружу не уходит ни в каком виде — ни старое, ни новое.
    expect(JSON.stringify(target)).not.toContain(ORIGINAL_KEY);
    expect(JSON.stringify(target)).not.toContain(BROKEN_KEY);

    // В снимке ключ лежит зашифрованным, а не открытым текстом.
    const snapshotRow = await prisma.settingsSnapshot.findUnique({ where: { id: target.id } });
    const stored = (snapshotRow?.payload as { geminiApiKey: string }).geminiApiKey;
    expect(stored).toBeTruthy();
    expect(stored).not.toBe(ORIGINAL_KEY);
    expect(decryptSecretSafe(stored)).toBe(ORIGINAL_KEY);

    const res = await restore(target.id);
    expect(res.status).toBe(200);
    expect(res.body.restoredFields).toContain("geminiApiKey");

    const row = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(decryptSecretSafe(row?.geminiApiKey ?? null)).toBe(ORIGINAL_KEY);
  });

  it("снимок чужим ключом шифрования: секреты не трогаются, остальное возвращается", async () => {
    await patch({ geminiApiKey: ORIGINAL_KEY, companyName: "До подмены ключа" });
    const currentRow = await prisma.settings.findUnique({ where: { id: "singleton" } });

    // Снимок «из прошлой жизни»: тот же payload, но отпечаток другого ключа.
    const foreign = await prisma.settingsSnapshot.create({
      data: {
        payload: JSON.parse(JSON.stringify({ ...currentRow, companyName: "Старое имя из прошлой жизни" })),
        agentId: adminId,
        agentName: "Админ точек возврата",
        reason: "update",
        changedFields: ["companyName"],
        keyFingerprint: "0123456789abcdef", // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
      },
    });

    await patch({ geminiApiKey: BROKEN_KEY, companyName: "После подмены ключа" });

    const point = (await listPoints()).body.items.find((p: { id: string }) => p.id === foreign.id);
    expect(point.secretsRestorable).toBe(false);

    const res = await restore(foreign.id);
    expect(res.status).toBe(200);
    expect(res.body.restoredFields).toContain("companyName");
    expect(res.body.restoredFields).not.toContain("geminiApiKey");
    expect(res.body.skippedSecrets).toContain("geminiApiKey");

    const row = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(row?.companyName).toBe("Старое имя из прошлой жизни");
    // Действующий ключ остался действующим — вместо нечитаемого мусора, который
    // выглядел бы как настоящий маркер и молча обрывал бы работу интеграции.
    expect(decryptSecretSafe(row?.geminiApiKey ?? null)).toBe(BROKEN_KEY);
  });

  it("срок хранения: обрезает по возрасту и по количеству", async () => {
    await prisma.settingsSnapshot.deleteMany({});
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    await prisma.settingsSnapshot.create({
      data: {
        payload: {},
        agentName: "Система",
        changedFields: ["companyName"],
        createdAt: new Date(now - (SNAPSHOT_KEEP_DAYS + 1) * dayMs),
      },
    });
    await prisma.settingsSnapshot.createMany({
      data: Array.from({ length: SNAPSHOT_KEEP_COUNT + 5 }, (_, i) => ({
        payload: {},
        agentName: "Система",
        changedFields: ["companyName"],
        createdAt: new Date(now - i * 60_000),
      })),
    });

    const result = await pruneSettingsSnapshots();
    expect(result.byAge).toBe(1);
    expect(result.byCount).toBe(5);
    expect(await prisma.settingsSnapshot.count()).toBe(SNAPSHOT_KEEP_COUNT);

    // Свежие точки остались, самая старая из свежих — ушла.
    const oldest = await prisma.settingsSnapshot.findFirst({ orderBy: { createdAt: "asc" } });
    expect(oldest!.createdAt.getTime()).toBeGreaterThan(now - SNAPSHOT_KEEP_COUNT * 60_000);
  });

  it("без права settings.manage — ни списка, ни отката", async () => {
    await patch({ companyName: "Состояние для проверки прав" });
    const point = (await listPoints()).body.items[0];

    expect((await listPoints(agentToken)).status).toBe(403);
    expect((await restore(point.id, agentToken)).status).toBe(403);
  });

  it("без подтверждения личности откат не проходит", async () => {
    await patch({ companyName: "Состояние для проверки подтверждения" });
    const point = (await listPoints()).body.items[0];

    revokeElevation(adminId);
    const res = await restore(point.id);
    expect(res.status).toBe(428);
    expect(res.body.stepUpRequired).toBe(true);

    grantElevation(adminId);
    expect((await restore(point.id)).status).toBe(200);
  });
});
