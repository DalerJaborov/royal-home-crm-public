import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { uploadsDir } from "../src/upload.js";

/**
 * Пересжатие звука телефонии в формат станции (8 кГц моно) и честный статус
 * загрузки — разбор 15.08.2026: владелец грузил свою музыку и приветствие ещё
 * 13-14.08, а станция продолжала играть штатную мелодию FreePBX. Причина —
 * CRM сохраняла файл, каким его прислал браузер, а Asterisk ждёт конкретный
 * формат. Настоящий ffmpeg здесь не гоняем (его нет в этом окружении и незачем
 * дублировать в тесте, что делает сама библиотека) — подменяем прослойку
 * lib/telephony/audioTranscode.ts и проверяем поведение МАРШРУТА: какой файл
 * лёг на диск, что случилось со старым, и что видит интерфейс при отказе.
 */

// vi.mock — поднимается над импортами, поэтому ссылаться на внешний const нельзя
// (упало бы "Cannot access before initialization"): значение заводится через
// vi.hoisted, который выполняется в том же поднятом порядке.
const { WAV_STUB } = vi.hoisted(() => ({ WAV_STUB: Buffer.from("RIFF-stub-wav-bytes") }));

vi.mock("../src/lib/telephony/audioTranscode.js", () => {
  class AudioTranscodeError extends Error {}
  return {
    AudioTranscodeError,
    transcodeForAsterisk: vi.fn().mockResolvedValue(WAV_STUB),
  };
});
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined) }));

const { transcodeForAsterisk, AudioTranscodeError } = await import("../src/lib/telephony/audioTranscode.js");
const { logSystemError } = await import("../src/lib/systemError.js");

const runId = Date.now();
const password = "testpass123";
const audioDir = path.join(uploadsDir, "telephony");

let adminId: string;
let adminToken: string;

function cleanupFiles() {
  for (const ext of ["wav", "mp3"]) {
    fs.rmSync(path.join(audioDir, `moh.${ext}`), { force: true });
  }
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ звуков телефонии", phone: `+992937${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);
  cleanupFiles();
});

afterEach(() => {
  vi.mocked(transcodeForAsterisk).mockClear();
  vi.mocked(transcodeForAsterisk).mockResolvedValue(WAV_STUB);
  vi.mocked(logSystemError).mockClear();
});

afterAll(async () => {
  cleanupFiles();
  await prisma.agent.delete({ where: { id: adminId } });
  await prisma.$disconnect();
});

function upload(kind: string, filename = "greeting.mp3") {
  return request(app)
    .post(`/api/v1/settings/telephony-audio/${kind}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .attach("audio", Buffer.from("не важно, что тут — transcode замокан"), filename);
}

describe("Загрузка звуков телефонии", () => {
  it("сохраняет результат пересжатия как .wav, а не то, что прислал браузер", async () => {
    const res = await upload("moh");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, kind: "moh", format: "wav" });
    expect(transcodeForAsterisk).toHaveBeenCalledTimes(1);

    const onDisk = fs.readFileSync(path.join(audioDir, "moh.wav"));
    expect(onDisk.equals(WAV_STUB)).toBe(true);
  });

  it("убирает старый .mp3 при повторной загрузке — иначе оба адреса отвечали бы", async () => {
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, "moh.mp3"), "устаревший файл");

    const res = await upload("moh");
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(audioDir, "moh.mp3"))).toBe(false);
    expect(fs.existsSync(path.join(audioDir, "moh.wav"))).toBe(true);
  });

  it("файл, который ffmpeg не смог обработать — понятная ошибка, а не тихий сбой", async () => {
    vi.mocked(transcodeForAsterisk).mockRejectedValueOnce(new AudioTranscodeError("файл не похож на аудио"));

    const res = await upload("moh");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("файл не похож на аудио");
    expect(logSystemError).toHaveBeenCalledWith(
      "telephony",
      expect.stringContaining("файл не похож на аудио")
    );
    // Отказ не должен затирать УЖЕ рабочий файл предыдущей загрузки.
    expect(fs.existsSync(path.join(audioDir, "moh.wav"))).toBe(true);
  });

  it("GET отдаёт честное состояние диска — интерфейс не полагается на память браузера", async () => {
    await upload("moh");
    const res = await request(app)
      .get("/api/v1/settings/telephony-audio")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.moh).toMatchObject({ format: "wav", stale: false });
    expect(new Date(res.body.moh.uploadedAt).getTime()).not.toBeNaN();
  });

  /**
   * Разбор 16.08.2026: на проде лежал `moh.mp3` от загрузки 14.08 (до пересжатия),
   * `moh.wav` не существовал вовсе — станция ходит только за `.wav` и получала 404,
   * поэтому в очереди играла тишина. Экран же писал «файл загружен», и увидеть
   * поломку было неоткуда. Признак `stale` — единственное, что об этом говорит.
   */
  it("оставшийся с прошлых версий mp3 помечен как устаревший — станция ходит за wav", async () => {
    fs.mkdirSync(audioDir, { recursive: true });
    fs.rmSync(path.join(audioDir, "greeting.wav"), { force: true });
    fs.writeFileSync(path.join(audioDir, "greeting.mp3"), Buffer.from("старый файл"));

    const res = await request(app)
      .get("/api/v1/settings/telephony-audio")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.greeting).toMatchObject({ format: "mp3", stale: true });
  });

  it("рядом лежащий устаревший mp3 не перебивает рабочий wav", async () => {
    await upload("queue");
    fs.writeFileSync(path.join(audioDir, "queue.mp3"), Buffer.from("старый файл"));

    const res = await request(app)
      .get("/api/v1/settings/telephony-audio")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.queue).toMatchObject({ format: "wav", stale: false });
  });

  it("«агент отказал» — тот же путь, что и остальные три вида звука", async () => {
    const res = await upload("agentDeclined");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, kind: "agentDeclined", format: "wav" });
    expect(fs.existsSync(path.join(audioDir, "agentDeclined.wav"))).toBe(true);
    fs.rmSync(path.join(audioDir, "agentDeclined.wav"), { force: true });
  });

  /**
   * ОТКАЗ ДИСКА — ВНЯТНЫЙ КОД И ЗАПИСЬ В ЖУРНАЛ, А НЕ ГОЛЫЙ 500.
   *
   * Запись звука — единственный шаг этого маршрута, который умеет отказать при
   * совершенно здоровой базе (кончилось место, права, том только на чтение).
   * Раньше исключение уходило наверх: владелец видел общую ошибку и не понимал,
   * применился звук или нет, а в журнале не оставалось ничего. Вдобавок
   * `writeFile` открывает файл с обрезанием, поэтому сорвавшаяся на полпути
   * запись оставляла станции ОБРЕЗАННЫЙ `moh.wav` — и та честно играла обрезок
   * каждому звонящему. Теперь запись идёт через временный файл и переименование.
   *
   * Отказ устраиваем настоящий, а не подменой `fs`: на месте `moh.wav` каталог.
   * Он ломает ОБА пути — и прежний `writeFile` поверх (EISDIR), и нынешнее
   * переименование на место каталога, — поэтому сторож честно падает на снятой
   * правке, а не проходит мимо неё.
   */
  it("отказ записи на диск — 503 и запись в журнал, без мусора рядом", async () => {
    const target = path.join(audioDir, "moh.wav");
    fs.mkdirSync(audioDir, { recursive: true });
    fs.rmSync(target, { force: true });
    fs.mkdirSync(target);

    try {
      const res = await upload("moh");
      expect(res.status).toBe(503);
      expect(res.body.error).toContain("не сохранился");
      expect(logSystemError).toHaveBeenCalledWith("telephony", expect.stringContaining("не записался на диск"));
      // Временный файл не остаётся лежать в каталоге, который синхронизирует станция.
      expect(fs.existsSync(`${target}.new`)).toBe(false);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("имена с прототипа объекта (constructor, __proto__, toString) — тоже неизвестный тип (находка №165)", async () => {
    for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const res = await upload(kind);
      expect(res.status, kind).toBe(404);
    }
    expect(transcodeForAsterisk).not.toHaveBeenCalled();
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(fs.existsSync(path.join(audioDir, `${name}.wav`)), name).toBe(false);
    }
  });

  it("неизвестный тип звука отклоняется до попытки чтения файла", async () => {
    const res = await upload("ringtone");
    expect(res.status).toBe(404);
    expect(transcodeForAsterisk).not.toHaveBeenCalled();
  });
});
