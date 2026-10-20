import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Журнал ошибок и запись разговора: что человеку читать, а что оставить консоли.
 *
 * ПОЧЕМУ ЭТОТ ТЕСТ ЕСТЬ. Журнал ошибок уходит директору утренней сводкой. Пока в
 * него сыпались строки, по которым делать нечего, на него переставали смотреть — и
 * настоящая поломка проходила незамеченной. Здесь закреплены два места:
 *
 *  1) неудачное прослушивание записи (routes/interactions.ts) — ротация, сжатие в
 *     mp3, моргнувший туннель видит сам агент в ответе 400, в журнал идёт только
 *     отказ доступа к каталогу записей;
 *  2) путь вне каталога записей (ingestCallRecording) — это расхождение настроек,
 *     а не происшествие разговора: в журнал не чаще раза в сутки.
 *
 * Без сети и без базы: станция подменена fetch-моком, Prisma и ИИ — моками модулей.
 */

vi.mock("../src/db.js", () => ({
  prisma: {
    interaction: { update: vi.fn().mockResolvedValue({ clientId: "c1", agentId: "a1" }) },
    errorLog: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    // resetCallRecordings (только для тестов, lib/telephony/callRecordings.ts)
    // чистит очередь повторов расшифровки через BackgroundJob — обзавелась этим
    // вызовом позже, чем писался этот мок; без записи здесь падает на самом
    // обращении к полю (undefined.deleteMany), раньше, чем сработал бы .catch().
    backgroundJob: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/ai/transcribe.js", () => ({ transcribeAudio: vi.fn().mockResolvedValue("") }));
vi.mock("../src/ai/audioChunks.js", () => ({ splitAudioForTranscription: vi.fn(() => []) }));
vi.mock("../src/ai/callAnalysis.js", () => ({ analyzeCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/ai/translateTranscript.js", () => ({ translateTranscript: vi.fn().mockResolvedValue(null) }));
vi.mock("../src/lib/cardSuggestions.js", () => ({ buildSuggestionFromCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/lib/r2Client.js", () => ({ r2Download: vi.fn().mockResolvedValue(null) }));

const { logSystemError } = await import("../src/lib/systemError.js");
const { prisma } = await import("../src/db.js");
const {
  fetchRecording,
  ingestCallRecording,
  isRecordingSetupFailure,
  resetCallRecordings,
  RecordingHttpError,
} = await import("../src/lib/telephony/callRecordings.js");

const BASE = "http://pbx.test/recordings";
const CONFIG = { baseUrl: BASE, token: "тест-токен" };
const WAV = "2026/08/10/out-918641718-1006-20260810-171019-1786363812.101.wav";

/** Чем станция отвечает на любой запрос в этом сценарии. */
let respond: () => Promise<Response> = async () => new Response(null, { status: 404 });

beforeEach(async () => {
  vi.mocked(logSystemError).mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => respond()));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  /**
   * ПЕРЕВЗВОДИМ КАЖДЫЙ РАЗ, А НЕ ОДИН РАЗ В ФАБРИКЕ МОКА (15.08.2026).
   *
   * `afterEach` ниже зовёт `vi.restoreAllMocks()` — а он откатывает не только
   * `vi.spyOn`, но и обычные `vi.fn()` из фабрики `vi.mock("../src/db.js", ...)`
   * к пустой заглушке без `mockResolvedValue`. До сих пор это было незаметно:
   * сценарии этого файла ни разу не доходили до вызова `prisma.interaction.update`
   * (путь вне каталога уходит в отказ раньше). Живой статус конвейера
   * (`setStage` в lib/telephony/callRecordings.ts) стал первым, кто его
   * действительно зовёт — и упёрся в мок без реализации: `undefined.catch is not
   * a function`. Мок был не сломан, просто до него ни разу не доходили.
   */
  vi.mocked(prisma.interaction.update).mockResolvedValue({ clientId: "c1", agentId: "a1" } as never);
  // Тот же откат restoreAllMocks — и то же переармирование, что и у update выше:
  // resetCallRecordings() ниже сама зовёт prisma.backgroundJob.deleteMany.
  vi.mocked(prisma.backgroundJob.deleteMany).mockResolvedValue({ count: 0 } as never);
  await resetCallRecordings();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Отказ прослушивания: поломка доступа отличается от пропавшего файла", () => {
  it("ротация и сжатие (404 по всем расширениям) — не поломка настройки", async () => {
    respond = async () => new Response(null, { status: 404 });
    const err = await fetchRecording(WAV, CONFIG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isRecordingSetupFailure(err)).toBe(false);
  });

  it("оборванный туннель — не поломка настройки", async () => {
    respond = async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8089") });
    };
    const err = await fetchRecording(WAV, CONFIG).catch((e: unknown) => e);
    expect(isRecordingSetupFailure(err)).toBe(false);
  });

  it("отказ авторизации на каталоге записей — поломка, и статус доезжает до вызывающего", async () => {
    respond = async () => new Response(null, { status: 401 });
    const err = await fetchRecording(WAV, CONFIG).catch((e: unknown) => e);
    expect(isRecordingSetupFailure(err)).toBe(true);
    expect((err as InstanceType<typeof RecordingHttpError>).status).toBe(401);
  });

  it("хранилище записей отвечает отказом (5xx) — поломка", async () => {
    respond = async () => new Response(null, { status: 503 });
    const err = await fetchRecording(WAV, CONFIG).catch((e: unknown) => e);
    expect(isRecordingSetupFailure(err)).toBe(true);
  });

  it("прочие коды станции (например 400) поломкой настройки не считаются", async () => {
    respond = async () => new Response(null, { status: 400 });
    const err = await fetchRecording(WAV, CONFIG).catch((e: unknown) => e);
    expect(isRecordingSetupFailure(err)).toBe(false);
  });

  it("текст тревоги не зависит от пути — иначе дедупликация не склеит повторы", () => {
    // Ровно та строка, что уходит в журнал из routes/interactions.ts.
    const текст = (status: number) => `Каталог записей на АТС не отдаёт файлы: HTTP ${status}`;
    expect(текст(401)).toBe(текст(401));
    expect(текст(401)).not.toContain(WAV);
  });
});

describe("Путь вне каталога записей: в журнал раз в сутки, повторы — в консоль", () => {
  const OUTSIDE = "/var/spool/asterisk/чужой-каталог/2026/08/10/out-1.wav";

  async function ingestOutside(path = OUTSIDE) {
    return ingestCallRecording({ interactionId: "i1", recordingPath: path });
  }

  beforeEach(() => {
    process.env.PBX_RECORDINGS_URL = BASE;
    process.env.PBX_RECORDINGS_TOKEN = "тест-токен";
  });

  it("первый разговор с неверным путём — одна запись в журнале", async () => {
    const res = await ingestOutside();
    expect(res.ok).toBe(false);
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(logSystemError).toHaveBeenCalledWith("telephony", expect.stringContaining("вне каталога записей АТС"), expect.objectContaining({ dedupKey: expect.any(String) }));
  });

  it("сто разговоров подряд за сутки — по-прежнему одна запись, остальное в консоли", async () => {
    vi.useFakeTimers();
    await ingestOutside();
    for (let i = 0; i < 100; i += 1) {
      // Имя файла у каждого разговора своё — именно поэтому десятиминутная
      // дедупликация logSystemError здесь не работала.
      await ingestOutside(`/var/spool/asterisk/чужой-каталог/2026/08/10/out-${i}.wav`);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("путь вне каталога записей АТС"));
  });

  it("через сутки о неустранённой поломке напоминают снова", async () => {
    vi.useFakeTimers();
    await ingestOutside();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1_000);
    await ingestOutside();
    expect(logSystemError).toHaveBeenCalledTimes(2);
  });

  it("корректный путь сбрасывает отсчёт: следующая поломка — снова новость", async () => {
    vi.useFakeTimers();
    await ingestOutside();
    expect(logSystemError).toHaveBeenCalledTimes(1);

    // Настройку поправили: путь снова внутри каталога записей (файла на станции
    // при этом нет — для сброса отсчёта это неважно).
    respond = async () => new Response(null, { status: 404 });
    await ingestCallRecording({
      interactionId: "i1",
      recordingPath: `/var/spool/asterisk/monitor/${WAV}`,
    });

    vi.mocked(logSystemError).mockClear();
    await ingestOutside();
    expect(logSystemError).toHaveBeenCalledWith("telephony", expect.stringContaining("вне каталога записей АТС"), expect.objectContaining({ dedupKey: expect.any(String) }));
  });
});
