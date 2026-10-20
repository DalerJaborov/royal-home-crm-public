import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * СВОДКА ПОДСКАЗОК СТАНЦИИ (`GET /api/v1/settings/call-whisper`).
 *
 * До 25.09.2026 этого экрана не касался ни один тест: владелец видит здесь, сколько
 * фраз готово, самую длинную и живой образец — и всё это молча ломалось бы любой
 * правкой рядом. Найдено обходом «выборки по всей таблице» (`orderBy` без `where`).
 *
 * ПОЧЕМУ ВСЕ ПРОВЕРКИ ЗДЕСЬ РАЗНОСТНЫЕ, А НЕ ТОЧНЫЕ. Маршрут считает по ВСЕЙ таблице
 * `callWhisper`, а не по записям этого файла, и так и задумано: это сводка хозяйства,
 * а не выборка. Значит утверждать «готово ровно два» нельзя — соседний файл в том же
 * прогоне добавит свои, и красным станет не тот, кто менял код (тот же класс, что
 * #959 и #966). Поэтому счётчики сверяются ПРИРОСТОМ до и после, а самая длинная —
 * неравенством.
 */

const runId = Date.now();
const clientIds: string[] = [];
const fileNames: string[] = [];
let adminToken = "";
let agentToken = "";
let adminId = "";
let agentId = "";
let tokenBefore: string | null = null;

const LONG_MS = 9_000_000;

async function makeWhisper(direction: "in" | "out", durationMs: number) {
  const idx = fileNames.length;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент сводки подсказок ${runId}-${idx}`,
      phone: `+99274${String(runId).slice(-6)}${idx}`,
      source: "PHONE_CALL",
    },
  });
  clientIds.push(client.id);
  const fileName = `stats-${runId}-${idx}`;
  fileNames.push(fileName);
  await prisma.callWhisper.create({
    data: {
      clientId: client.id,
      direction,
      language: "ru",
      digest: `digest-${fileName}`,
      fileName,
      text: `Подсказка ${idx}. Клиент сводки`,
      durationMs,
    },
  });
}

function stats(token: string) {
  return request(app).get("/api/v1/settings/call-whisper").set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: { fullName: `Админ сводки ${runId}`, phone: `+99275${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
  });
  const agent = await prisma.agent.create({
    data: { fullName: `Агент сводки ${runId}`, phone: `+99276${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  adminId = admin.id;
  agentId = agent.id;
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { callWhisperStationToken: true },
  });
  tokenBefore = settings?.callWhisperStationToken ?? null;
});

afterAll(async () => {
  await prisma.callWhisper.deleteMany({ where: { fileName: { in: fileNames } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId] } } });
  // Общий ключ станции возвращается ровно таким, каким был: он один на базу, и
  // соседний файл читает его признак.
  await prisma.settings
    .update({ where: { id: "singleton" }, data: { callWhisperStationToken: tokenBefore } })
    .catch(() => undefined);
});

describe("Сводка подсказок станции", () => {
  it("счётчики растут на СВОИ записи: входящая и исходящая ложатся в разные строки", async () => {
    const before = await stats(adminToken);
    expect(before.status).toBe(200);

    // Входящих ДВЕ, исходящая ОДНА, и это нарочно: при одной и одной перепутанные
    // местами счётчики дали бы те же приросты, и проверка пропустила бы подмену.
    await makeWhisper("in", 1200);
    await makeWhisper("in", 1300);
    await makeWhisper("out", LONG_MS);

    const after = await stats(adminToken);
    expect(after.status).toBe(200);
    expect(after.body.ready - before.body.ready).toBe(3);
    expect(after.body.readyIncoming - before.body.readyIncoming).toBe(2);
    expect(after.body.readyOutgoing - before.body.readyOutgoing).toBe(1);
  });

  it("самая длинная фраза — не короче нашей", async () => {
    const res = await stats(adminToken);
    expect(res.status).toBe(200);
    expect(res.body.longestMs).toBeGreaterThanOrEqual(LONG_MS);
  });

  it("живой образец — настоящая запись целиком, а не выдуманный текст", async () => {
    const res = await stats(adminToken);
    expect(res.status).toBe(200);
    expect(res.body.sample).toBeTruthy();
    expect(typeof res.body.sample.text).toBe("string");
    expect(res.body.sample.text.length).toBeGreaterThan(0);
    expect(typeof res.body.sample.durationMs).toBe("number");
    expect(["in", "out"]).toContain(res.body.sample.direction);
    const row = await prisma.callWhisper.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { text: true, durationMs: true },
    });
    expect(res.body.sample.text).toBe(row?.text);
    expect(res.body.sample.durationMs).toBe(row?.durationMs);
  });

  it("ключ станции наружу не отдаётся — только признак, что он задан", async () => {
    const secret = `station-${runId}`;
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { callWhisperStationToken: encryptSecret(secret) },
    });

    const res = await stats(adminToken);
    expect(res.status).toBe(200);
    expect(res.body.hasStationToken).toBe(true);
    // Ни открытым текстом, ни шифротекстом: ищем по всему ответу, а не по имени поля,
    // потому что утечка приезжает под новым именем, а не под старым.
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(JSON.stringify(res.body)).not.toContain("callWhisperStationToken");
  });

  it("агенту сводка закрыта: это настройки, а не его экран", async () => {
    const res = await stats(agentToken);
    expect(res.status).toBe(403);
  });
});
