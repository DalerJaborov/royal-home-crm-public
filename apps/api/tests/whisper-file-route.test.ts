import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { whisperFilePath } from "../src/lib/telephony/whisperAudio.js";
import { waitForCount } from "./helpers/waitFor.js";

/**
 * ОТДАЧА ФАЙЛА ОЗВУЧКИ СТАНЦИИ — docs/TASKS.md: «файлы озвучки телефонии отдают
 * 404 (~100 обращений за 20 часов)».
 *
 * Причина найдена в whisperSync.ts (removeStaleWhispers): файл стирался с диска
 * РАНЬШЕ строки в базе, и в этом окне GET /manifest ещё называл станции файл,
 * которого на диске уже не было. Порядок исправлен (строка удаляется первой), а
 * здесь проверяется наблюдаемое поведение маршрута: известный файл на диске
 * отдаётся, а расхождение «строка есть — файла нет» ловится и пишется в журнал
 * ОДИН раз, а не на каждый заход станции (logSystemError дедуплицирует сам).
 */

const runId = Date.now();
const token = `test-whisper-token-${runId}`;

const clientIds: string[] = [];
const fileNames: string[] = [];

async function makeWhisper(fileName: string) {
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент подсказки ${runId}-${fileNames.length}`,
      phone: `+992${String(runId).slice(-6)}${fileNames.length}`,
      source: "PHONE_CALL",
    },
  });
  await prisma.callWhisper.create({
    data: {
      clientId: client.id,
      direction: "in",
      language: "ru",
      digest: `digest-${fileName}`,
      fileName,
      text: "Тест. клиент",
      durationMs: 900,
    },
  });
  clientIds.push(client.id);
  fileNames.push(fileName);
  return client.id;
}

beforeAll(async () => {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", callWhisperStationToken: encryptSecret(token) },
    update: { callWhisperStationToken: encryptSecret(token) },
  });
});

afterAll(async () => {
  await prisma.callWhisper.deleteMany({ where: { fileName: { in: fileNames } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  // Только свои записи (имя файла содержит runId), а не всё про CallWhisper:
  // на общей базе так стирались бы настоящие следы расхождений.
  for (const name of fileNames) {
    await prisma.errorLog.deleteMany({ where: { source: "telephony", message: { contains: name } } });
  }
  await prisma.settings.update({ where: { id: "singleton" }, data: { callWhisperStationToken: null } });
  for (const name of fileNames) fs.rmSync(whisperFilePath(name, "wav"), { force: true });
  await prisma.$disconnect();
});

describe("GET /api/v1/telephony/whisper/file/:name", () => {
  it("без верного токена — 404, маршрут не выдаёт своё существование", async () => {
    const res = await request(app).get("/api/v1/telephony/whisper/file/anything");
    expect(res.status).toBe(404);
  });

  it("файл есть на диске и в базе — отдаётся audio/wav", async () => {
    await makeWhisper(`rhtest${runId}a`);
    const filePath = whisperFilePath(fileNames[0]!, "wav");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from("RIFF....WAVEfmt "));

    const res = await request(app)
      .get(`/api/v1/telephony/whisper/file/${fileNames[0]}`)
      .set("x-whisper-token", token);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/wav/);
  });

  it("строка в базе есть, файла на диске нет — 404 и ОДНА запись в журнале, а не на каждый заход", async () => {
    const missingName = `rhtest${runId}b`;
    await makeWhisper(missingName);
    // Файл намеренно не создаём — это и есть расхождение, которое чинит задача.

    const first = await request(app)
      .get(`/api/v1/telephony/whisper/file/${missingName}`)
      .set("x-whisper-token", token);
    expect(first.status).toBe(404);

    const second = await request(app)
      .get(`/api/v1/telephony/whisper/file/${missingName}`)
      .set("x-whisper-token", token);
    expect(second.status).toBe(404);

    // Дедуп logSystemError (10 минут, см. lib/systemError.ts) — два захода подряд
    // дают одну запись, а не две. Ждём появления записи, а не проверяем сразу:
    // маршрут пишет журнал уже после ответа станции, и голая проверка гонялась бы
    // с этой записью наперегонки (см. tests/helpers/waitFor.ts).
    await waitForCount(
      () => prisma.errorLog.count({ where: { source: "telephony", message: { contains: missingName } } }),
      1,
      { label: `запись в журнале про ${missingName}` }
    );
    const logged = await prisma.errorLog.findMany({
      where: { source: "telephony", message: { contains: missingName } },
    });
    expect(logged.length).toBe(1);
  });

  it("подсказка по приметам объекта — в манифесте станции и отдаётся тем же путём (24.09.2026)", async () => {
    const property = await prisma.property.create({
      data: { title: `Подсказка маршрута ${runId}`, type: "APARTMENT", areaSqm: 50, price: 1, condition: "GOOD", status: "AVAILABLE" },
      select: { id: true },
    });
    const name = `rhtest${runId}p`;
    fileNames.push(name);
    try {
      await prisma.propertyWhisper.create({
        data: { propertyId: property.id, language: "ru", digest: `digest-${name}`, fileName: name, text: "Клиент по объекту", durationMs: 900 },
      });
      const filePath = whisperFilePath(name, "wav");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from("RIFF....WAVEfmt "));

      const manifest = await request(app).get("/api/v1/telephony/whisper/manifest").set("x-whisper-token", token);
      expect(manifest.status).toBe(200);
      expect(manifest.text.split("\n")).toContain(`${name} digest-${name}`);
      const file = await request(app).get(`/api/v1/telephony/whisper/file/${name}`).set("x-whisper-token", token);
      expect(file.status).toBe(200);
    } finally {
      await prisma.property.delete({ where: { id: property.id } });
    }
  });
});
