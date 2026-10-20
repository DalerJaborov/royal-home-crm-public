import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { fetchRecording } from "../src/lib/telephony/callRecordings.js";

/** Что «лежит в R2» — бакет прежней эпохи (записи до 07.08.2026). */
let r2Files = new Map<string, Buffer>();
vi.mock("../src/lib/r2Client.js", () => ({
  r2Download: async (key: string) => {
    const body = r2Files.get(key);
    if (!body) return null;
    return { body: new Response(body).body!, contentType: "audio/wav" };
  },
  isR2Configured: () => true,
  r2Upload: async () => undefined,
  r2Delete: async () => true,
  r2PresignDownloadUrl: async () => null,
}));

/** Журнал ошибок подменён: проверяем не только звук, но и что в него попадает. */
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));
const { logSystemError } = await import("../src/lib/systemError.js");

/**
 * Прослушивание записи разговора.
 *
 * Баг 11.08.2026: станция сжимает `.wav` в `.mp3` через пять минут после звонка и
 * удаляет исходник, а в карточке остаётся путь на `.wav`. В итоге НЕ ПРОИГРЫВАЛАСЬ
 * НИ ОДНА запись старше пяти минут, при этом расшифровка была на месте — сбой
 * выглядел как «текст есть, звук исчез». Наружу это приходило голым «Ошибка
 * запроса: 502», потому что Cloudflare подменяет тело ответов 5xx.
 *
 * Отсюда три вещи, которые тест обязан держать: соседнее расширение находится,
 * найденный путь запоминается, а отказ станции приходит человеческим текстом с
 * кодом, который Cloudflare не перехватывает.
 */

const runId = Date.now();
const password = "testpass123";
const BASE = "http://pbx.test/recordings";

let adminId: string;
let adminToken: string;
let agentId: string;
let clientId: string;
let interactionId: string;

/** Что «лежит на станции». Ключ — полный адрес запроса. */
let files = new Map<string, Buffer>();
/** Чем станция отвечает, когда файла по адресу нет. 404 — ротация или сжатие;
 *  подменяется в тестах про отказ доступа к каталогу записей. */
let missStatus = 404;
const fetchMock = vi.fn(async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input.toString();
  const body = files.get(url);
  if (!body) return new Response(null, { status: missStatus });
  return new Response(body, { status: 200 });
});

beforeAll(async () => {
  process.env.PBX_RECORDINGS_URL = BASE;
  process.env.PBX_RECORDINGS_TOKEN = "тест-токен";
  vi.stubGlobal("fetch", fetchMock);
  r2Files = new Map([
    ["call-recordings/2026/08/69c62cd3-4fde-45c6-ac65-de8a42f632c0.wav", Buffer.from("звук-из-R2")],
  ]);

  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ записей", phone: `+992895${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;

  const agent = await prisma.agent.create({
    data: { fullName: "Агент записей", phone: `+992894${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;

  const client = await prisma.client.create({
    data: { fullName: `Клиент записей ${runId}`, phone: `+992893${runId}`, source: "PHONE_CALL" },
  });
  clientId = client.id;

  const interaction = await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "CALL",
      notes: "Разговор с записью",
      // Путь на .wav — ровно то, что CRM записывает в момент звонка.
      recordingUrl: "2026/08/10/out-918641718-1006-20260810-171019-1786363812.101.wav",
    },
  });
  interactionId = interaction.id;
});

afterEach(() => {
  fetchMock.mockClear();
  missStatus = 404;
  vi.mocked(logSystemError).mockClear();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId] } } });
  await prisma.$disconnect();
});

function play() {
  return request(app)
    .get(`/api/v1/interactions/${interactionId}/recording`)
    .set("Authorization", `Bearer ${adminToken}`);
}

/** Адрес файла на станции — так же, как его собирает fetchRecording. */
function url(path: string) {
  return `${BASE}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

const WAV = "2026/08/10/out-918641718-1006-20260810-171019-1786363812.101.wav";
const MP3 = "2026/08/10/out-918641718-1006-20260810-171019-1786363812.101.mp3";

describe("Станция сжала запись в mp3", () => {
  it("файл находится по соседнему расширению", async () => {
    files = new Map([[url(MP3), Buffer.from("звук-mp3")]]);
    const { buffer, path } = await fetchRecording(WAV, { baseUrl: BASE, token: "тест-токен" });
    expect(path).toBe(MP3);
    expect(buffer.toString()).toBe("звук-mp3");
  });

  it("маршрут отдаёт звук и запоминает найденный путь", async () => {
    files = new Map([[url(MP3), Buffer.from("звук-mp3")]]);
    await prisma.interaction.update({ where: { id: interactionId }, data: { recordingUrl: WAV } });

    const res = await play();
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");
    // Запись доступна только администрации — общий кэш её держать не должен.
    expect(res.headers["cache-control"]).toContain("no-store");

    // Путь переписан: второе прослушивание пойдёт прямо, без перебора расширений.
    const after = await prisma.interaction.findUnique({ where: { id: interactionId } });
    expect(after?.recordingUrl).toBe(MP3);

    fetchMock.mockClear();
    const second = await play();
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Записи прежней эпохи (Cloudflare R2)", () => {
  it("ключ бакета ищется в R2, а не на станции", async () => {
    // До 07.08.2026 записи уезжали в R2, и в карточке лежит ключ бакета, а не путь
    // на АТС. Файлы там живы (проверено на проде 11.08.2026) — идти за ними на
    // станцию бессмысленно, там их не было никогда.
    const key = "call-recordings/2026/08/69c62cd3-4fde-45c6-ac65-de8a42f632c0.wav";
    await prisma.interaction.update({ where: { id: interactionId }, data: { recordingUrl: key } });
    files = new Map(); // на станции пусто, и это не должно ни на что влиять

    const res = await play();
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("звук-из-R2");
    // На станцию не ходили вовсе.
    expect(fetchMock).not.toHaveBeenCalled();

    // Путь не переписан: ключ бакета остаётся ключом бакета.
    const after = await prisma.interaction.findUnique({ where: { id: interactionId } });
    expect(after?.recordingUrl).toBe(key);
  });

  it("если записи нет и в R2 — понятная ошибка", async () => {
    r2Files = new Map();
    const res = await play();
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("R2");
  });
});

describe("Станция недоступна", () => {
  it("ошибка приходит человеческим текстом, а не голым кодом", async () => {
    files = new Map(); // на станции нет ничего
    await prisma.interaction.update({ where: { id: interactionId }, data: { recordingUrl: WAV } });

    const res = await play();
    // НЕ 502: Cloudflare подменяет тело ответов 5xx своей типовой страницей, и
    // причина до интерфейса не доходит — агент читает номер кода вместо объяснения.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("АТС");
    expect(res.body.error).not.toMatch(/^\d+$/);
  });

  /**
   * ЖУРНАЛ ДИРЕКТОРА ПРОТИВ ЭКРАНА АГЕНТА (12.08.2026).
   *
   * Причина отказа показывается агенту тут же, в ответе 400. Пока в журнал уходила
   * каждая неудача, директор читал в утренней сводке пересказ того, что агент уже
   * увидел сам и по чему сделать ничего нельзя: запись удалена ротацией, сжата в
   * mp3, туннель моргнул. Дедупликация не помогала — текст меняется вместе с путём.
   *
   * В журнал остаётся только то, что означает поломку доступа: пока каталог
   * записей не пускает или отвечает отказом, не проиграется НИ ОДНА запись.
   */
  it("ротация записи: агент видит причину, журнал молчит, консоль помнит", async () => {
    files = new Map(); // на станции нет ничего
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await prisma.interaction.update({ where: { id: interactionId }, data: { recordingUrl: WAV } });

    const res = await play();

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("АТС");
    expect(logSystemError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("не отдана агенту"));
    warn.mockRestore();
  });

  it("каталог записей не пускает (401) — вот это в журнал, и текст без пути", async () => {
    files = new Map();
    missStatus = 401;
    await prisma.interaction.update({ where: { id: interactionId }, data: { recordingUrl: WAV } });

    const res = await play();

    // Агенту по-прежнему внятная причина на экране, а не голый код.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("АТС");
    expect(logSystemError).toHaveBeenCalledTimes(1);
    const [source, text] = vi.mocked(logSystemError).mock.calls[0];
    expect(source).toBe("telephony");
    expect(text).toBe("Каталог записей на АТС не отдаёт файлы: HTTP 401");
    // Путь в тексте сделал бы каждую запись уникальной, и дедупликация
    // logSystemError снова перестала бы склеивать повторы.
    expect(text).not.toContain(WAV);
  });

  it("хранилище записей отвечает отказом (503) — тоже в журнал", async () => {
    files = new Map();
    missStatus = 503;
    await prisma.interaction.update({ where: { id: interactionId }, data: { recordingUrl: WAV } });

    const res = await play();

    expect(res.status).toBe(400);
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logSystemError).mock.calls[0][1]).toContain("HTTP 503");
  });

  it("у разговора без записи — 404, а не ошибка станции", async () => {
    const noRecording = await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Без записи" },
    });
    const res = await request(app)
      .get(`/api/v1/interactions/${noRecording.id}/recording`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
