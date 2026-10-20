import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

/**
 * Конвейер записи разговора: найти файл на АТС → расшифровать → привязать к карточке.
 *
 * Два решения, которые проверяются здесь и которые легко сломать обратно:
 *
 * 1. ФАЙЛЫ ОСТАЮТСЯ НА СТАНЦИИ (решение владельца 07.08.2026). Сначала записи
 *    складывались в Cloudflare R2, но там бесплатных 10 ГБ, а на диске станции
 *    свободно 68 ГБ — год архива после сжатия занимает около 24 ГБ. В хронологии
 *    сохраняется путь, а слушает запись сотрудник через CRM (она посредник, потому
 *    что АТС снаружи недоступна).
 *
 * 2. ИМЯ ФАЙЛА СТАНЦИЯ НЕ СООБЩАЕТ. Предполагалось, что придёт переменная
 *    MIXMONITOR_FILENAME, но на живых событиях FreePBX шлёт только TOUCH_MONITOR с
 *    внутренним uniqueid. Поэтому запись ищется по каталогу дня — по номеру клиента,
 *    внутреннему номеру агента и минуте начала разговора. Совпасть всем трём у
 *    чужого разговора невозможно.
 *
 * Ни живой АТС, ни живого Gemini здесь нет: станция стоит во внутренней сети офиса,
 * а каждый прогон против Gemini — деньги и лотерея с лимитами. Подменяются ровно две
 * внешние границы (HTTP к станции и расшифровка), всё остальное настоящее, включая
 * запись в БД: смысл проверки в том, что путь и текст доезжают до Interaction.
 */

interface TranscribeCallContext {
  kind?: string;
  callerPhone?: string | null;
  agentName?: string | null;
  agentExtension?: string | null;
}
const transcribeCalls: { filename: string; mediaType: string; size: number; context?: TranscribeCallContext }[] = [];
let transcribeResult: string | null = "Здравствуйте, я по поводу квартиры на Рудаки.";
/**
 * Текст ПО КУСКАМ (24.09.2026, тест на "\n" между кусками) — если задан, побеждает
 * над transcribeResult: индекс берётся из имени файла («… (2/6)», см.
 * transcribeAndEnrich), а не из порядка вызова мока — куски идут ПАРАЛЛЕЛЬНО
 * (CHUNK_CONCURRENCY), порядок ответа мока не совпадает с порядком кусков.
 */
let transcribeResultByChunk: (string | null)[] | null = null;
/**
 * Отказ поставщика, а не «в записи нечего разбирать»: конвейер их различает —
 * первое встаёт в очередь повтора, второе нет (см. ai/transcribe.ts).
 */
let transcribeFailed = false;
/**
 * Искусственная задержка + счётчик одновременных вызовов — только так и можно
 * проверить, что куски ОДНОГО разговора расшифровываются параллельно, а не по
 * очереди: без задержки все вызовы отвечают мгновенно и последовательный вызов от
 * параллельного снаружи неотличим (тест 15.08.2026, «два куска в работе разом»).
 */
let transcribeDelayMs = 0;
let concurrentTranscribeCalls = 0;
let maxConcurrentTranscribeCalls = 0;
vi.mock("../src/ai/transcribe.js", () => ({
  isTranscriptionEnabled: async () => true,
  transcribeAudioResult: async (buffer: Buffer, filename: string, mediaType: string, context?: TranscribeCallContext) => {
    transcribeCalls.push({ filename, mediaType, size: buffer.length, context });
    concurrentTranscribeCalls += 1;
    maxConcurrentTranscribeCalls = Math.max(maxConcurrentTranscribeCalls, concurrentTranscribeCalls);
    if (transcribeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, transcribeDelayMs));
    concurrentTranscribeCalls -= 1;
    let text = transcribeResult;
    if (transcribeResultByChunk) {
      const match = /\((\d+)\//.exec(filename);
      const idx = match ? Number(match[1]) - 1 : 0;
      text = transcribeResultByChunk[idx] ?? null;
    }
    return { text, failed: transcribeFailed, detail: transcribeFailed ? "Gemini молчит" : undefined };
  },
  transcribeAudio: async (buffer: Buffer, filename: string, mediaType: string) => {
    transcribeCalls.push({ filename, mediaType, size: buffer.length });
    return transcribeResult;
  },
}));
/**
 * analyzeCall/buildSuggestionFromCall (27.08.2026, найдено при разборе двух
 * тестов, зависавших на 20-40с). transcribeAndEnrich зовёт их безусловно ПОСЛЕ
 * расшифровки — с достаточно длинным текстом (>= MIN_ANALYZED_TRANSCRIPT_CHARS,
 * 80 символов — набирается при склейке кусков длинного разговора) или заданным
 * durationSec (>= MIN_TALK_SECONDS в cardSuggestions.ts, 15с) они делают
 * НАСТОЯЩИЙ вызов ИИ. Этот файл подменяет глобальный fetch под ответы АТС
 * (stubPbx) — тот же fetch перехватывает и запрос к Gemini, отдавая ему
 * файл-заглушку вместо JSON, и разбор зависает на повторных попытках вместо
 * быстрого отказа. Сам разбор и предложение по карточке проверяются отдельными
 * файлами (tests/ai-call-outcome.test.ts, tests/card-auto-apply.test.ts) — здесь
 * важна только доставка расшифровки до карточки, не их внутренняя логика.
 */
vi.mock("../src/ai/callAnalysis.js", () => ({ analyzeCall: vi.fn().mockResolvedValue({ ok: false, reason: "мок" }) }));
/**
 * logSystemError ПОДМЕНЁН, ЧТОБЫ ВИДЕТЬ dedupKey (24.09.2026) — сам аргумент не
 * попадает в БД (только используется для WHERE при записи), поэтому проверить
 * его можно только перехватом вызова, не чтением errorLog после факта.
 */
const systemErrorCalls: { source: string; message: string; dedupKey?: string }[] = [];
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: (source: string, message: string, context?: { dedupKey?: string }) => {
    systemErrorCalls.push({ source, message, dedupKey: context?.dedupKey });
    return Promise.resolve();
  },
}));
vi.mock("../src/lib/cardSuggestions.js", () => ({ buildSuggestionFromCall: vi.fn().mockResolvedValue({ created: false, reason: "мок" }) }));

const { prisma } = await import("../src/db.js");
const {
  ingestCallRecording,
  fetchRecording,
  findRecording,
  relativeRecordingPath,
  resetCallRecordings,
  waitForTranscriptions,
  runTranscriptionRetryAttempt,
  runRecordingSearchRetryAttempt,
  recoverInterruptedTranscriptionStages,
} = await import("../src/lib/telephony/callRecordings.js");

/** Ждущие повтора расшифровки — с 27.08 это строки BackgroundJob, не память
 *  процесса. Постановка fire-and-forget, поэтому перед подсчётом даём
 *  микрозадачам добежать. */
const pendingTranscriptionRetries = async () => {
  await new Promise((r) => setTimeout(r, 200));
  return prisma.backgroundJob.count({ where: { type: "transcription-retry", status: "PENDING" } });
};
const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
const { resetIncomingCalls } = await import("../src/lib/telephony/incomingCalls.js");

const runId = Date.now();
/** Номер карточки этого файла — с него же «звонит клиент» во входящем сценарии. */
const CLIENT_PHONE_FOR_INCOMING = `+99296${String(runId).slice(-7)}`;
let agentId = "";
let clientId = "";

const AGENT_EXT = "1004";
const CLIENT_PHONE = "+992880001007";
/** Разговор начался 07.08.2026 в 18:16 по Душанбе (UTC+5) — это 13:16 UTC. */
const STARTED_AT = new Date("2026-08-07T13:16:24.000Z");
const RECORDING_NAME = "out-880001007-1004-20260807-181624-1786108584.84.mp3";
// Padding до реалистичного размера — с 18.08.2026 конвейер отбраковывает файлы
// меньше MIN_RECORDING_BYTES (см. callRecordings.ts) как «станция не записала
// звук», и голая строка-заглушка в 72 байта попадала бы под этот же фильтр.
const AUDIO = Buffer.concat([Buffer.from("ID3....фальшивый mp3 для проверки конвейера"), Buffer.alloc(4096)]);

/**
 * Ответ станции: листинг каталога дня, затем сам файл.
 *
 * `byDir` нужен для звонка через полночь: станция раскладывает записи по местному
 * времени Душанбе, и разговор, начатый в 23:57, лежит уже в каталоге следующих
 * суток. Ключ — «ГГГГ/ММ/ДД», значение — имена файлов в этом каталоге.
 */
function stubPbx(options: { listing?: string[]; byDir?: Record<string, string[]>; fileOk?: boolean } = {}) {
  const names = options.listing ?? [RECORDING_NAME];
  const html = names.map((n) => `<a href="${n}">${n}</a>`).join("\n");
  const fetchMock = vi.fn(async (url: string) => {
    const isListing = String(url).endsWith("/");
    if (isListing) {
      if (options.byDir) {
        const dir = Object.keys(options.byDir).find((d) => String(url).includes(`/${d}/`));
        const list = dir ? options.byDir[dir] : [];
        const body = list.map((n) => `<a href="${n}">${n}</a>`).join("\n");
        return { ok: true, status: 200, text: async () => body } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => html } as unknown as Response;
    }
    if (options.fileOk === false) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => AUDIO.buffer.slice(AUDIO.byteOffset, AUDIO.byteOffset + AUDIO.byteLength),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** То же самое, но отдаёт указанный буфер вместо стандартного AUDIO — нужно
 *  сценарию с разговором крупнее предела Gemini (см. TRANSCRIBE_MAX_BYTES). */
function stubPbxWithAudio(audio: Buffer) {
  const html = `<a href="${RECORDING_NAME}">${RECORDING_NAME}</a>`;
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/")) return { ok: true, status: 200, text: async () => html } as unknown as Response;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** То же самое, но со своим именем файла — нужно сценарию «формат не режется»
 *  (см. contentTypeFor: единственное расширение из тех, что реально попадаются
 *  на станции, для которого splitAudioForTranscription не умеет резать, — .ogg;
 *  wav/mp3/gsm все умеют). */
function stubPbxWithNamedAudio(name: string, audio: Buffer) {
  const html = `<a href="${name}">${name}</a>`;
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/")) return { ok: true, status: 200, text: async () => html } as unknown as Response;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function newInteraction(): Promise<string> {
  const created = await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "Звонок инициирован из CRM" },
  });
  return created.id;
}

const search = { startedAt: STARTED_AT, agentExtension: AGENT_EXT, clientPhone: CLIENT_PHONE, direction: "outgoing" as const };

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент записи ${runId}`, phone: `+99295${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент записи ${runId}`,
      phone: CLIENT_PHONE_FOR_INCOMING,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
});

beforeEach(() => {
  process.env.PBX_RECORDINGS_URL = "http://172.19.0.1:8090";
  process.env.PBX_RECORDINGS_TOKEN = "секрет-туннеля";
  transcribeCalls.length = 0;
  transcribeResult = "Здравствуйте, я по поводу квартиры на Рудаки.";
  transcribeResultByChunk = null;
  transcribeFailed = false;
  transcribeDelayMs = 0;
  concurrentTranscribeCalls = 0;
  maxConcurrentTranscribeCalls = 0;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  resetIncomingCalls();
  await resetCallRecordings();
  await prisma.incomingCall.deleteMany({ where: { channelId: { startsWith: `rec-in-${runId}` } } });
  await prisma.interaction.deleteMany({ where: { clientId } });
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Поиск записи в каталоге станции", () => {
  it("находит файл по номеру клиента, номеру агента и минуте начала", async () => {
    stubPbx();
    const found = await findRecording(search, { baseUrl: "http://ари", token: "т" });
    expect(found).toBe(`2026/08/07/${RECORDING_NAME}`);
  });

  it("чужой разговор не берёт: другой агент в ту же минуту с тем же клиентом", async () => {
    stubPbx({ listing: ["out-880001007-1009-20260807-181624-1786108584.90.mp3"] });
    const found = await findRecording(search, { baseUrl: "http://ари", token: "т" });
    expect(found).toBeNull();
  });

  it("запись из другого времени не берёт: окно поиска пять минут", async () => {
    stubPbx({ listing: ["out-880001007-1004-20260807-150000-1786100000.10.mp3"] });
    const found = await findRecording(search, { baseUrl: "http://ари", token: "т" });
    expect(found).toBeNull();
  });

  it("каталог берётся по времени Душанбе, а не сервера: разговор ночью не уезжает во вчера", async () => {
    // 02:30 по Душанбе 8 августа = 21:30 UTC 7 августа. Каталог должен быть 08/08.
    const night = new Date("2026-08-07T21:30:00.000Z");
    const fetchMock = stubPbx({ listing: [] });
    await findRecording({ ...search, startedAt: night }, { baseUrl: "http://ари", token: "т" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("2026/08/08/");
  });
});

/**
 * ЗАПИСЬ ВХОДЯЩЕГО РАЗГОВОРА.
 *
 * Её не существовало вовсе: два модуля противоречили друг другу об имени файла, и
 * противоречие разрешено в пользу callRecordings.ts — станция переменную
 * MIXMONITOR_FILENAME не присылает (живое наблюдение 11.08.2026). У входящего при
 * этом три отличия от исходящего: номер приходит С КОДОМ СТРАНЫ, внутреннего номера
 * оператора в имени НЕТ (пишет очередь), и каталогов надо смотреть три — разговор
 * может начаться до полуночи, а файл лечь в следующие сутки.
 */
describe("Поиск записи ВХОДЯЩЕГО разговора", () => {
  /** Имя записи очереди: q-<очередь>-<номер с кодом страны>-<дата>-<время>-<uniqueid>. */
  const QUEUE_NAME = "q-1000-992880001007-20260807-181630-1786108584.84.wav";
  const incomingSearch = {
    startedAt: STARTED_AT,
    answeredAt: new Date(STARTED_AT.getTime() + 6_000),
    clientPhone: CLIENT_PHONE,
    direction: "incoming" as const,
  };

  it("находится по номеру звонящего и времени — без внутреннего номера агента", async () => {
    stubPbx({ listing: [QUEUE_NAME] });
    const found = await findRecording(incomingSearch, { baseUrl: "http://ари", token: "т" });
    expect(found).toBe(`2026/08/07/${QUEUE_NAME}`);
  });

  it("двенадцатизначный номер в имени сходится по девятизначному хвосту", async () => {
    // Прежняя проверка искала подстроку «-880001007-» и номер с кодом страны
    // (992880001007) не находила НИКОГДА — то есть запись входящего не находилась.
    expect(QUEUE_NAME).toContain("992880001007");
    stubPbx({ listing: [QUEUE_NAME] });
    expect(await findRecording(incomingSearch, { baseUrl: "http://ари", token: "т" })).not.toBeNull();
  });

  it("чужой номер не подходит", async () => {
    stubPbx({ listing: ["q-1000-992900000000-20260807-181630-1786108584.84.wav"] });
    const found = await findRecording(incomingSearch, { baseUrl: "http://ари", token: "т" });
    expect(found).toBeNull();
  });

  it("разговор через полночь: файл лежит в каталоге следующих суток и всё равно находится", async () => {
    // 23:57 по Душанбе 7 августа = 18:57 UTC. Ответ оператора — через минуту,
    // запись легла в 00:01 уже восьмого числа.
    const midnightName = "q-1000-992880001007-20260808-000100-1786190460.11.wav";
    stubPbx({ byDir: { "2026/08/07": [], "2026/08/08": [midnightName] } });

    const found = await findRecording(
      { startedAt: new Date("2026-08-07T18:57:00.000Z"), clientPhone: CLIENT_PHONE, direction: "incoming" },
      { baseUrl: "http://ари", token: "т" }
    );
    expect(found).toBe(`2026/08/08/${midnightName}`);
  });

  it("uniqueid не принимается за номер клиента", async () => {
    // Сегмент длиннее любого телефона (13 цифр) отсекается длиной. Настоящий
    // uniqueid Asterisk длину 9–12 как раз проходит (это epoch, десять цифр) — от
    // него защищают несовпадение хвоста номера и окно времени, а не длина: в
    // соседних тестах uniqueid 1786108584 стоит в имени и ни разу не помешал.
    stubPbx({ listing: ["q-1000-9992880001007-20260807-181630-1786108584.84.wav"] });
    const found = await findRecording(incomingSearch, { baseUrl: "http://ари", token: "т" });
    expect(found).toBeNull();
  });

  it("запись из другого времени не берётся и у входящих", async () => {
    stubPbx({ listing: ["q-1000-992880001007-20260807-150000-1786100000.10.wav"] });
    const found = await findRecording(incomingSearch, { baseUrl: "http://ари", token: "т" });
    expect(found).toBeNull();
  });

  it("ждали в очереди дольше окна поиска — считаем от момента ответа, а не от гудка", async () => {
    // Клиент восемь минут слушал музыку ожидания: запись начинается с ответа
    // оператора, и окно вокруг НАЧАЛА звонка до файла бы не дотянулось.
    const waited = {
      startedAt: new Date("2026-08-07T13:08:00.000Z"),
      answeredAt: new Date("2026-08-07T13:16:24.000Z"),
      clientPhone: CLIENT_PHONE,
      direction: "incoming" as const,
    };
    stubPbx({ listing: [QUEUE_NAME] });
    const found = await findRecording(waited, { baseUrl: "http://ари", token: "т" });
    expect(found).toBe(`2026/08/07/${QUEUE_NAME}`);
  });
});

/**
 * НАПРАВЛЕНИЕ — ПЕРВЫЙ ФИЛЬТР, А НЕ ДОГАДКА ПО НОМЕРУ И МИНУТЕ (21.09.2026).
 *
 * Прод-жалоба 21.09.2026: три входящих на 1010 (14:01, 16:19, 16:18:39) получили
 * файлы соседних ИСХОДЯЩИХ (13:57, 16:22) того же клиента — поиск совпадал по
 * номеру клиента и попадал в окно ±5 минут, а префикс имени файла не проверялся
 * вовсе. Здесь — тот же сценарий: один и тот же клиент, один и тот же номер, файлы
 * обоих направлений лежат в одном каталоге минуту в минуту, и только направление
 * звонка решает, какой из них правильный.
 */
describe("Направление звонка отсекает чужую запись соседнего направления", () => {
  const OUT_NAME = "out-880001007-1004-20260807-181624-1786108584.84.mp3";
  const IN_NAME = "q-1000-992880001007-20260807-181624-1786200000.11.wav";

  it("ВХОДЯЩИЙ не подхватывает исходящую запись того же клиента в ту же минуту", async () => {
    stubPbx({ listing: [OUT_NAME, IN_NAME] });
    const found = await findRecording(
      { startedAt: STARTED_AT, answeredAt: STARTED_AT, clientPhone: CLIENT_PHONE, direction: "incoming" },
      { baseUrl: "http://ари", token: "т" }
    );
    expect(found).toBe(`2026/08/07/${IN_NAME}`);
  });

  it("ВХОДЯЩИЙ отвечает null, если в каталоге лежит только чужой исходящий", async () => {
    stubPbx({ listing: [OUT_NAME] });
    const found = await findRecording(
      { startedAt: STARTED_AT, answeredAt: STARTED_AT, clientPhone: CLIENT_PHONE, direction: "incoming" },
      { baseUrl: "http://ари", token: "т" }
    );
    expect(found).toBeNull();
  });

  it("ИСХОДЯЩИЙ не подхватывает запись очереди того же клиента в ту же минуту", async () => {
    stubPbx({ listing: [OUT_NAME, IN_NAME] });
    const found = await findRecording(search, { baseUrl: "http://ари", token: "т" });
    expect(found).toBe(`2026/08/07/${OUT_NAME}`);
  });

  it("ИСХОДЯЩИЙ отвечает null, если в каталоге лежит только запись очереди", async () => {
    stubPbx({ listing: [IN_NAME] });
    const found = await findRecording(search, { baseUrl: "http://ари", token: "т" });
    expect(found).toBeNull();
  });

  it("префикс external- тоже считается входящим", async () => {
    const externalName = "external-992880001007-20260807-181624-1786210000.12.wav";
    stubPbx({ listing: [OUT_NAME, externalName] });
    const found = await findRecording(
      { startedAt: STARTED_AT, answeredAt: STARTED_AT, clientPhone: CLIENT_PHONE, direction: "incoming" },
      { baseUrl: "http://ари", token: "т" }
    );
    expect(found).toBe(`2026/08/07/${externalName}`);
  });
});

describe("Зависший туннель не держит маршрут «слушать запись»", () => {
  it("общий бюджет времени на все расширения, а не таймаут на каждое", async () => {
    /**
     * Станция сжимает wav в mp3, поэтому запись спрашивается в четырёх форматах
     * подряд. Пока таймаут был у каждого запроса свой, зависший туннель держал
     * маршрут `/interactions/:id/recording` до ВОСЬМИ МИНУТ: браузер и обратный
     * прокси давно отвалились, а сокет на сервере всё ещё ждал.
     *
     * Первый запрос отвечает честным 404 (файла в этом формате нет), а дальше
     * станция замолкает навсегда — ровно так выглядит оборванный туннель.
     */
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
        call += 1;
        if (call === 1) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("timeout")));
        });
      })
    );

    const startedAt = Date.now();
    await expect(
      fetchRecording(`2026/08/07/${RECORDING_NAME}`, { baseUrl: "http://ари", token: "т" }, 400)
    ).rejects.toThrow();
    // Уложились в бюджет с запасом, а не в бюджет × число расширений.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("Запись разговора: путь от станции до карточки клиента", () => {
  it("файл найден, путь сохранён, расшифровка ушла в очередь и привязалась к записи", async () => {
    const fetchMock = stubPbx();
    const interactionId = await newInteraction();

    const result = await ingestCallRecording({ interactionId, search, durationSec: 171 });
    expect(result.ok).toBe(true);

    // Запрос шёл с токеном станции — иначе она отвечает 403.
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers["X-Recordings-Token"]).toBe("секрет-туннеля");

    // В хронологии — путь на станции (не ссылка на внешнее хранилище) и длительность.
    const saved = await prisma.interaction.findUnique({ where: { id: interactionId } });
    expect(saved?.recordingUrl).toBe(`2026/08/07/${RECORDING_NAME}`);
    expect(saved?.recordingDurationSec).toBe(171);

    // Расшифровка — отдельной очередью, тем же Gemini, что и голосовые клиентов.
    await waitForTranscriptions();
    expect(transcribeCalls).toHaveLength(1);
    expect(transcribeCalls[0].mediaType).toBe("audio/mpeg");
    const after = await prisma.interaction.findUnique({ where: { id: interactionId } });
    expect(after?.transcript).toMatch(/Рудаки/);
  }, 40_000);

  it("расшифровка звонка получает kind:call, номер клиента и имя агента (24.09.2026)", async () => {
    stubPbx();
    const interactionId = await newInteraction();

    await ingestCallRecording({ interactionId, search, durationSec: 171 });
    await waitForTranscriptions();

    expect(transcribeCalls).toHaveLength(1);
    expect(transcribeCalls[0].context?.kind).toBe("call");
    expect(transcribeCalls[0].context?.callerPhone).toBe(CLIENT_PHONE_FOR_INCOMING);
    expect(transcribeCalls[0].context?.agentName).toBe(`Агент записи ${runId}`);
  }, 40_000);

  it("записи нет — это штатный исход: карточка остаётся целой, ничего не падает", async () => {
    stubPbx({ listing: [] });
    const interactionId = await newInteraction();

    const result = await ingestCallRecording({ interactionId, search });

    expect(result.ok).toBe(false);
    const row = await prisma.interaction.findUnique({ where: { id: interactionId } });
    expect(row?.recordingUrl).toBeNull();
    expect(row?.notes).toBe("Звонок инициирован из CRM");
  }, 40_000);

  it("станция не отдала найденный файл — запись в хронологии не портится", async () => {
    stubPbx({ fileOk: false });
    const interactionId = await newInteraction();

    const result = await ingestCallRecording({ interactionId, search });

    expect(result.ok).toBe(false);
    const row = await prisma.interaction.findUnique({ where: { id: interactionId } });
    expect(row?.recordingUrl).toBeNull();
  }, 40_000);

  it("путь вне каталога записей отбрасывается: одной подделанной переменной канала мало", async () => {
    const fetchMock = stubPbx();
    const interactionId = await newInteraction();

    const result = await ingestCallRecording({ interactionId, recordingPath: "/etc/asterisk/sip.conf" });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(relativeRecordingPath("/var/spool/asterisk/monitor/../../../etc/passwd")).toBeNull();
    expect(relativeRecordingPath(`/var/spool/asterisk/monitor/2026/08/07/${RECORDING_NAME}`)).toBe(
      `2026/08/07/${RECORDING_NAME}`
    );
  });

  it("Gemini вернул пустоту — запись остаётся, поле расшифровки просто пустое", async () => {
    stubPbx();
    transcribeResult = null;
    const interactionId = await newInteraction();

    const result = await ingestCallRecording({ interactionId, search });
    expect(result.ok).toBe(true);
    await waitForTranscriptions();

    const row = await prisma.interaction.findUnique({ where: { id: interactionId } });
    expect(row?.recordingUrl).toBe(`2026/08/07/${RECORDING_NAME}`);
    expect(row?.transcript).toBeNull();
  }, 40_000);

  it("отказ поставщика ставит разговор в очередь повтора, пустой ответ — нет", async () => {
    /**
     * РАЗНИЦА, КОТОРОЙ РАНЬШЕ НЕ БЫЛО. Расшифровка делается один раз, сразу после
     * звонка. Отказ Gemini в эту минуту (лимит ключа, обрыв прокси, таймаут на
     * длинной записи) оставлял разговор немым НАВСЕГДА: запись есть, текста нет,
     * разбора нет, и повторить некому.
     *
     * При этом повторять пустой ответ («в записи нечего разбирать» — гудки,
     * молчание) бессмысленно и платно, поэтому в очередь он не попадает.
     */
    stubPbx();
    transcribeResult = null;
    transcribeFailed = true;
    const failedId = await newInteraction();
    await ingestCallRecording({ interactionId: failedId, search });
    await waitForTranscriptions();
    expect(await pendingTranscriptionRetries()).toBe(1);

    await resetCallRecordings();
    stubPbx();
    transcribeFailed = false;
    const silentId = await newInteraction();
    await ingestCallRecording({ interactionId: silentId, search });
    await waitForTranscriptions();
    expect(await pendingTranscriptionRetries()).toBe(0);
  }, 40_000);

  it("повтор догоняет расшифровку: текст, перевод и разбор появляются со второй попытки", async () => {
    stubPbx();
    transcribeResult = null;
    transcribeFailed = true;
    const interactionId = await newInteraction();
    await ingestCallRecording({ interactionId, search });
    await waitForTranscriptions();
    // Задание встало с отступом первой попытки (~5 минут) — повтор не уходит
    // в ту же секунду, что и отказ. Срок уважает сам runner (background-jobs.test.ts),
    // здесь проверяем содержание попытки. Постановка fire-and-forget — ждём её через
    // waitFor (фиксированные 200 мс на загруженной машине не хватали), и берём задание
    // именно этого разговора: соседние тесты ставят такие же в общую очередь.
    const job = await waitFor(
      () =>
        prisma.backgroundJob.findFirst({
          where: { type: "transcription-retry", status: "PENDING", payload: { path: ["interactionId"], equals: interactionId } },
        }),
      { timeoutMs: 10_000, label: "задание повтора расшифровки" }
    );
    expect(job?.payload).toEqual({ interactionId });
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + 3 * 60_000);

    // Поставщик ожил — попытка задания доводит разговор до текста.
    transcribeResult = "Здравствуйте, я по поводу квартиры на Рудаки.";
    transcribeFailed = false;
    stubPbx();
    await runTranscriptionRetryAttempt(interactionId);

    const row = await prisma.interaction.findUnique({ where: { id: interactionId } });
    expect(row?.transcript).toMatch(/Рудаки/);

    // А когда поставщик всё ещё лежит — попытка бросает, и очередь ретраит по лесенке.
    transcribeResult = null;
    transcribeFailed = true;
    stubPbx();
    const failedAgain = await newInteraction();
    await ingestCallRecording({ interactionId: failedAgain, search });
    await waitForTranscriptions();
    await expect(runTranscriptionRetryAttempt(failedAgain)).rejects.toThrow(/отказал/);
  }, 40_000);

  /**
   * ЖИВОЙ СТАТУС КОНВЕЙЕРА (владелец 15.08.2026): «человек не должен просто
   * сидеть и ждать секунды, пока это всё расшифровывается». До этого разговор от
   * отбоя до готового разбора не давал никакого сигнала о том, что происходит —
   * теперь Interaction.transcriptionStage проходит через видимые шаги и в конце
   * гарантированно возвращается в null.
   */
  it("стадия конвейера проходит SEARCHING → TRANSCRIBING → ANALYZING → null (перевод теперь по клику, не в конвейере)", async () => {
    stubPbx();
    const interactionId = await newInteraction();
    await ingestCallRecording({ interactionId, search });
    await waitForTranscriptions();

    const row = await prisma.interaction.findUnique({ where: { id: interactionId } });
    // Разговор дошёл до готового разбора — конвейер им больше не занят.
    expect(row?.transcriptionStage).toBeNull();
    expect(row?.transcriptionProgress).toBeNull();
    expect(row?.transcript).toMatch(/Рудаки/);
  });

  it("стадия снимается и на отказавшем разговоре — не висит вечным «Ищем запись»", async () => {
    stubPbx();
    transcribeResult = null;
    transcribeFailed = true;
    const interactionId = await newInteraction();
    await ingestCallRecording({ interactionId, search });
    await waitForTranscriptions();

    const row = await prisma.interaction.findUnique({ where: { id: interactionId } });
    // Разговор встал в очередь повтора (см. тест выше) — но экран не должен
    // застревать на «Ищем запись на станции» до следующей попытки через 5 минут.
    expect(row?.transcriptionStage).toBeNull();
  });

  /**
   * КУСКИ ОДНОГО ДЛИННОГО РАЗГОВОРА — ПАРАЛЛЕЛЬНО, А НЕ ПО ОЧЕРЕДИ (15.08.2026).
   *
   * Раньше это был `for` с `await` внутри: третий кусок часового разговора не
   * начинал расшифровываться, пока первые два не отвечали полностью, хотя куски
   * друг от друга не зависят. Здесь искусственная задержка в моке транскрибации
   * (transcribeDelayMs) — единственный способ отличить «действительно параллельно»
   * от «просто быстро ответило»: без задержки оба сценария неразличимы по факту.
   */
  it("куски длинного разговора расшифровываются одновременно, а не по очереди", async () => {
    // .mp3 режется по байтам без разбора WAV-заголовка (см. audioChunks.ts) —
    // проще всего собрать фиктивный файл нужного размера для этого сценария.
    //
    // 32 МБ, без durationSec — audioChunks.ts (24.09.2026) больше не режет строго
    // по байтовому пределу (было бы 3 куска по 15 МБ): у mp3 без точной
    // длительности резчик целится в TARGET_CHUNK_SECONDS по оценке битрейта
    // станции, и раз по этой цели кусков вышло бы больше MAX_PARTS (6), он растит
    // кусок ровно до предела в 6 штук (см. докстринг chunkSizeFor), а не до
    // минимума в 3 — тесту на параллельность важно только «кусков больше одного»,
    // сама цифра — следствие резчика, а не то, что здесь проверяется.
    const BIG_AUDIO = Buffer.alloc(32 * 1024 * 1024, 1); // 32 МБ — шесть кусков (MAX_PARTS)
    stubPbxWithAudio(BIG_AUDIO);
    transcribeDelayMs = 60; // достаточно, чтобы параллельные вызовы гарантированно пересеклись
    const interactionId = await newInteraction();

    await ingestCallRecording({ interactionId, search });
    await waitForTranscriptions();

    // Шесть кусков — это минимум 6 вызовов мока; при СТРОГО последовательной
    // обработке (как было до 15.08.2026 — `for` с `await` внутри) максимум
    // одновременных вызовов был бы 1 при любой задержке. Это прямое доказательство
    // параллельности, а не по времени всего конвейера: у ingestCallRecording
    // хватает своих накладных расходов (запись пути, стадии, перевод, разбор), не
    // связанных с расшифровкой кусков, — сравнивать с ними общее время было бы
    // шатко.
    expect(transcribeCalls.length).toBe(6);
    expect(maxConcurrentTranscribeCalls).toBeGreaterThanOrEqual(2);
    // И не больше ограничения — иначе первая же пачка звонков выбрала бы лимит
    // Gemini на всё агентство разом (см. CHUNK_CONCURRENCY).
    expect(maxConcurrentTranscribeCalls).toBeLessThanOrEqual(2);

    const row = await prisma.interaction.findUnique({ where: { id: interactionId } });
    expect(row?.transcript).toMatch(/Рудаки/);
    expect(row?.transcriptionStage).toBeNull();
  });

  it("куски склеиваются переводом строки, а не пробелом — реплики соседних кусков не сливаются (24.09.2026)", async () => {
    // Тот же приём, что в тесте параллельности выше: .mp3 без durationSec режется
    // резчиком на несколько кусков по оценке битрейта (см. audioChunks.ts).
    const BIG_AUDIO = Buffer.alloc(32 * 1024 * 1024, 1);
    stubPbxWithAudio(BIG_AUDIO);
    // Каждый кусок «отвечает» своей репликой — если бы склейка шла пробелом,
    // последняя реплика куска 1 и первая куска 2 слились бы в одну строку.
    transcribeResultByChunk = [
      "Агент: здравствуйте, слушаю вас.",
      "Клиент: ищу квартиру в Сино.",
      "Агент: на какой бюджет ориентируетесь?",
      "Клиент: до пятидесяти тысяч.",
      "Агент: хорошо, подберу варианты.",
      "Клиент: спасибо, жду.",
    ];
    const interactionId = await newInteraction();

    await ingestCallRecording({ interactionId, search });
    await waitForTranscriptions();

    const row = await prisma.interaction.findUnique({ where: { id: interactionId } });
    const lines = (row?.transcript ?? "").split("\n");
    expect(lines).toEqual(transcribeResultByChunk);
    // Ни одна строка не содержит слитых реплик двух сторон разом.
    for (const line of lines) {
      expect(line.match(/Агент:|Клиент:/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it("входящий разговор доходит до файла и расшифровки — стык событий станции и конвейера", async () => {
    /**
     * Тот самый стык, которого не существовало: обработчик события конца входящего
     * звонка не передавал в конвейер НИЧЕГО, по чему можно искать файл, а на имя
     * файла от станции полагаться нельзя (см. шапку модуля). Здесь звонок проходит
     * весь путь событиями АТС — от гудка до отбоя.
     */
    const digits = CLIENT_PHONE_FOR_INCOMING.replace(/\D/g, "");
    // Имя записи очереди на «сейчас»: без внутреннего номера оператора и с кодом
    // страны в номере — ровно так его пишет FreePBX.
    const local = new Date(Date.now() + 5 * 60 * 60_000);
    const stamp =
      `${local.getUTCFullYear()}${String(local.getUTCMonth() + 1).padStart(2, "0")}${String(local.getUTCDate()).padStart(2, "0")}` +
      `-${String(local.getUTCHours()).padStart(2, "0")}${String(local.getUTCMinutes()).padStart(2, "0")}${String(local.getUTCSeconds()).padStart(2, "0")}`;
    const name = `q-1000-${digits}-${stamp}-1786108584.84.wav`;
    stubPbx({ listing: [name] });

    const channelId = `rec-in-${runId}-1`;
    const channel = {
      id: channelId,
      name: `SIP/out-${channelId}`,
      state: "Ring",
      caller: { number: digits.slice(-9) },
      dialplan: { context: "ext-queues", exten: "1000" },
    };
    await handleAriEvent({ type: "ChannelCreated", channel });
    await handleAriEvent({
      type: "ChannelEnteredBridge",
      channel: { id: "op-rec", name: "SIP/1001-00000012", state: "Up", caller: {} },
      bridge: { id: "b-rec", channels: [channelId, "op-rec"] },
    });
    await handleAriEvent({ type: "ChannelDestroyed", channel });

    const record = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    expect(record.answered).toBe(true);
    expect(record.interactionId).not.toBeNull();

    // Конвейер выгрузки идёт в фоне и начинается с паузы в две секунды (файл на
    // станции ещё дописывается) — дожидаемся его вместе с очередью расшифровок.
    //
    // Ждём именно ПОСТАНОВКУ В ОЧЕРЕДЬ (стадия ушла с SEARCHING), а не появление
    // recordingUrl: путь сохраняется на несколько строк РАНЬШЕ, чем расшифровка
    // попадает в очередь (см. ingestCallRecording — сначала update с recordingUrl,
    // потом setStage("QUEUED") и enqueueTranscription). Тест успевал проскочить в
    // этот зазор, вызывал waitForTranscriptions на ещё пустой очереди — она
    // возвращалась мгновенно, и transcript был null. Это давало плавающее падение
    // примерно раз из трёх, которое трижды блокировало выкат 16.08.2026.
    await vi.waitFor(
      async () => {
        const row = await prisma.interaction.findUniqueOrThrow({ where: { id: record.interactionId! } });
        expect(row.recordingUrl).not.toBeNull();
        expect(row.transcriptionStage).not.toBe("SEARCHING");
      },
      { timeout: 25_000, interval: 500 }
    );
    await waitForTranscriptions();

    const saved = await prisma.interaction.findUniqueOrThrow({ where: { id: record.interactionId! } });
    expect(saved.recordingUrl).toContain(name);
    expect(saved.transcript).toMatch(/Рудаки/);
  }, 40_000);

  it("расшифровка доехала после того, как крон записал «нет расшифровки» — входящий звонок разбирается заново (аудит Codex 04.10.2026, №10)", async () => {
    stubPbx();
    transcribeResult = null;
    transcribeFailed = true;
    const interactionId = await newInteraction();
    await ingestCallRecording({ interactionId, search });
    await waitForTranscriptions();

    // Крон уже проходил по звонку без текста и записал терминальный исход.
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const call = await prisma.incomingCall.create({
      data: {
        channelId: `rec-in-${runId}-late`,
        phone: CLIENT_PHONE_FOR_INCOMING,
        startedAt: hourAgo,
        endedAt: hourAgo,
        answered: true,
        talkSeconds: 90,
        clientId,
        interactionId,
        autoLeadAt: hourAgo,
        autoLeadStatus: "no_data",
      },
    });

    // Поставщик ожил: текст появляется впервые, конвейер зовёт автоматику.
    transcribeResult = "Здравствуйте, я по поводу квартиры на Рудаки.";
    transcribeFailed = false;
    stubPbx();
    await runTranscriptionRetryAttempt(interactionId);

    const after = await prisma.incomingCall.findUniqueOrThrow({ where: { id: call.id } });
    // Прежний исход сброшен и звонок взят в работу заново: замок занят свежим временем.
    expect(after.autoLeadAt!.getTime()).toBeGreaterThan(hourAgo.getTime() + 30 * 60_000);
  }, 40_000);

  it("CHANNEL-NEW-39: разбор звонка упал временным сбоем при сохранённой расшифровке — ставится повтор, повтор доводит разбор", async () => {
    const { analyzeCall } = await import("../src/ai/callAnalysis.js");
    const analyze = vi.mocked(analyzeCall);
    stubPbx();
    analyze.mockResolvedValueOnce({ ok: false, reason: "ошибка разбора" });
    const interactionId = await newInteraction();
    await ingestCallRecording({ interactionId, search });
    await waitForTranscriptions();
    expect((await prisma.interaction.findUnique({ where: { id: interactionId } }))?.transcript).toMatch(/Рудаки/);
    // Текст сохранён, разбор не вышел: раньше повтор не назначался вовсе.
    expect(await pendingTranscriptionRetries()).toBe(1);

    // Попытка задания: разбор снова не вышел — бросает, очередь ретраит по лесенке.
    analyze.mockClear();
    analyze.mockResolvedValueOnce({ ok: false, reason: "ошибка разбора" });
    await expect(runTranscriptionRetryAttempt(interactionId)).rejects.toThrow(/разбор/);
    // Разбор получился — задание завершается, транскрипт не перекачивается.
    analyze.mockResolvedValueOnce({ ok: true });
    const fetchMock = stubPbx();
    await runTranscriptionRetryAttempt(interactionId);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    // «Разбор уже есть» — это не отказ, повторять нечего.
    analyze.mockResolvedValueOnce({ ok: false, reason: "разбор уже есть" });
    await runTranscriptionRetryAttempt(interactionId);
    analyze.mockResolvedValue({ ok: false, reason: "мок" });
  }, 40_000);

  it("CHANNEL-NEW-40: догоняющий поиск нашёл файл, но скачивание упало — попытка бросает (лесенка продолжается); окончательный отказ — нет", async () => {
    const interactionId = await newInteraction();
    const payload = {
      interactionId,
      search: {
        startedAt: STARTED_AT.toISOString(),
        agentExtension: AGENT_EXT,
        clientPhone: CLIENT_PHONE,
        answeredAt: null,
        direction: "outgoing" as const,
      },
      durationSec: null,
    };
    // Каталог отдаёт имя, а сам файл не скачивается (туннель моргнул) — временный отказ.
    stubPbx({ fileOk: false });
    await expect(runRecordingSearchRetryAttempt(payload)).rejects.toThrow(/не сохранена/);
    expect((await prisma.interaction.findUnique({ where: { id: interactionId } }))?.recordingUrl).toBeNull();

    // Файл пустой — станция не пишет звук: окончательно, повторять незачем.
    stubPbxWithAudio(Buffer.alloc(10));
    await expect(runRecordingSearchRetryAttempt(payload)).resolves.toBeUndefined();

    // Туннель ожил — запись сохраняется.
    stubPbx();
    await runRecordingSearchRetryAttempt(payload);
    expect((await prisma.interaction.findUnique({ where: { id: interactionId } }))?.recordingUrl).toBe(`2026/08/07/${RECORDING_NAME}`);
  }, 40_000);

  it("адрес каталога записей не задан — конвейер молча выключен, звонки работают", async () => {
    const previousUrl = process.env.PBX_RECORDINGS_URL ?? "";
    delete process.env.PBX_RECORDINGS_URL;
    const fetchMock = stubPbx();
    const interactionId = await newInteraction();

    const result = await ingestCallRecording({ interactionId, search });
    expect(result.ok).toBe(false);
    // Поиск записи предыдущего кейса идёт в отрыве с повторами и может ещё постучаться в
    // свежий мок ПРЕЖНИМ адресом станции — это не обращение этого кейса. Считаем только
    // вызовы, которые мог сделать он сам: без адреса их быть не должно вовсе (09.10.2026,
    // шаткость на ship: «not called, but called 1 times» при зелёном коде).
    const ownCalls = fetchMock.mock.calls.filter(([url]) => !(previousUrl && String(url).startsWith(previousUrl)));
    expect(ownCalls).toHaveLength(0);
  });

  /**
   * ФОРМАТ НЕ УМЕЕТ РЕЗАТЬСЯ (24.09.2026, splitAudioForTranscription вернула []).
   *
   * .ogg — единственное расширение из тех, что реально встречаются на станции,
   * для которого резчик честно отвечает пустым массивом (wav/mp3/gsm он режет
   * все). Две ветки: файл укладывается в предел Gemini целиком — резать было и
   * не нужно, расшифровка уходит одним вызовом; файл крупнее предела — раньше
   * разговор оставался немым навсегда (только строка в журнале), теперь
   * назначается scheduleTranscriptionRetry.
   */
  it("формат не режется, но укладывается в предел целиком — расшифровывается одним вызовом", async () => {
    const oggName = "out-880001007-1004-20260807-181624-1786108584.84.ogg";
    // > MIN_RECORDING_BYTES (2000), заведомо < TRANSCRIBE_MAX_BYTES (15 МБ).
    const audio = Buffer.concat([Buffer.from("OggS не WAV и не mp3 — просто иной формат"), Buffer.alloc(4096, 5)]);
    stubPbxWithNamedAudio(oggName, audio);
    const interactionId = await newInteraction();

    const result = await ingestCallRecording({ interactionId, search });
    expect(result.ok).toBe(true);
    await waitForTranscriptions();

    expect(transcribeCalls).toHaveLength(1);
    expect(transcribeCalls[0].mediaType).toBe("audio/ogg");
    expect(transcribeCalls[0].size).toBe(audio.length);
    const row = await prisma.interaction.findUnique({ where: { id: interactionId } });
    expect(row?.transcript).toMatch(/Рудаки/);
    expect(row?.transcriptionStage).toBeNull();
  });

  it("формат не режется и крупнее предела — назначается повтор, а не немой разговор навсегда", async () => {
    const oggName = "out-880001007-1004-20260807-181624-1786108584.85.ogg";
    const bigAudio = Buffer.alloc(16 * 1024 * 1024, 2); // 16 МБ — больше TRANSCRIBE_MAX_BYTES (15 МБ).
    stubPbxWithNamedAudio(oggName, bigAudio);
    const interactionId = await newInteraction();

    const result = await ingestCallRecording({ interactionId, search });
    // Запись НАЙДЕНА и сохранена (recordingUrl уже записан выше по коду) — это
    // не отказ ingestCallRecording, а отказ именно расшифровки.
    expect(result.ok).toBe(true);
    // Расшифровка не звалась вовсе — до неё дело не дошло, кусков нет.
    expect(transcribeCalls).toHaveLength(0);

    const row = await prisma.interaction.findUnique({ where: { id: interactionId } });
    expect(row?.recordingUrl).toContain(oggName);
    expect(row?.transcript).toBeNull();
    expect(row?.transcriptionStage).toBeNull();
    // Раньше здесь очередь повтора оставалась пустой навсегда — теперь задание есть.
    expect(await pendingTranscriptionRetries()).toBeGreaterThanOrEqual(1);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * РЕСТАРТ ПОСРЕДИ КОНВЕЙЕРА (21.09.2026)
 *
 * Живой случай: звонок 21.09 в 13:02 остался с вечной плашкой «Ищем запись на
 * станции» и без записи вовсе. Автовыкат поднял контейнеры заново ровно посреди
 * 23-секундного поиска файла: стадию снимать стало некому, а страховка (задание
 * recording-search-retry) заводилась НИЖЕ по коду — то есть после того окна,
 * которое она обязана страховать, и до неё дело не дошло.
 * ──────────────────────────────────────────────────────────────────────────── */
describe("Конвейер переживает рестарт процесса", () => {
  const pendingSearchRetries = () =>
    prisma.backgroundJob.count({ where: { type: "recording-search-retry", status: "PENDING" } });

  it("страховка заводится ДО поиска файла, а не после него", async () => {
    stubPbx({ listing: [] });
    const interactionId = await newInteraction();

    // Не ждём конца: проверяем ровно то, что раньше было неверно — что задание
    // уже лежит в БД, ПОКА поиск ещё идёт. Первая пауза поиска — две секунды,
    // поэтому на 500 мс станцию ещё даже не спрашивали.
    const running = ingestCallRecording({ interactionId, search, clientAnswered: true });
    await new Promise((r) => setTimeout(r, 500));
    expect(await pendingSearchRetries()).toBe(1);

    const result = await running;
    expect(result.ok).toBe(false);
    // Файла нет — страховка остаётся: именно её ступени (1/5/15 минут) и есть
    // второй шанс для разговора, попавшего на обрыв туннеля.
    expect(await pendingSearchRetries()).toBe(1);
  }, 40_000);

  it("недозвону страховка по-прежнему не заводится", async () => {
    stubPbx({ listing: [] });
    const interactionId = await newInteraction();

    const result = await ingestCallRecording({ interactionId, search, clientAnswered: false });
    expect(result.ok).toBe(false);
    expect(await pendingSearchRetries()).toBe(0);
  }, 40_000);

  it("отвеченный разговор без файла — приписка в notes «запись не найдена на станции» (24.09.2026)", async () => {
    stubPbx({ listing: [] });
    const created = await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Звонок через CRM, разговор 1:23" },
    });

    const result = await ingestCallRecording({ interactionId: created.id, search, clientAnswered: true });
    expect(result.ok).toBe(false);

    const row = await prisma.interaction.findUnique({ where: { id: created.id } });
    expect(row?.notes).toBe("Звонок через CRM, разговор 1:23 — запись не найдена на станции");
  }, 40_000);

  it("тот же случай по длительности разговора (durationSec > 0), без clientAnswered", async () => {
    stubPbx({ listing: [] });
    const created = await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Звонок через CRM, разговор 0:45" },
    });

    await ingestCallRecording({ interactionId: created.id, search, durationSec: 45 });

    const row = await prisma.interaction.findUnique({ where: { id: created.id } });
    expect(row?.notes).toBe("Звонок через CRM, разговор 0:45 — запись не найдена на станции");
  }, 40_000);

  it("недозвон без файла — notes НЕ трогаем, это штатная тишина", async () => {
    stubPbx({ listing: [] });
    const created = await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Звонок через CRM, разговор 0:00" },
    });

    await ingestCallRecording({ interactionId: created.id, search, clientAnswered: false });

    const row = await prisma.interaction.findUnique({ where: { id: created.id } });
    expect(row?.notes).toBe("Звонок через CRM, разговор 0:00");
  }, 40_000);

  it("файл найден — страховка снимается, второго прохода по станции не будет", async () => {
    stubPbx();
    const interactionId = await newInteraction();

    const result = await ingestCallRecording({ interactionId, search, clientAnswered: true });
    expect(result.ok).toBe(true);
    await waitForTranscriptions();
    expect(await pendingSearchRetries()).toBe(0);
  }, 40_000);

  it("в записи нет звука — исход окончательный, страховку тоже снимаем", async () => {
    // 44 байта — ровно пустой заголовок WAV, ниже MIN_RECORDING_BYTES.
    stubPbxWithAudio(Buffer.alloc(44));
    const interactionId = await newInteraction();

    const result = await ingestCallRecording({ interactionId, search, clientAnswered: true });
    expect(result.ok).toBe(false);
    expect(result.terminal).toBe(true);
    // Повторный поиск нашёл бы ТОТ ЖЕ пустой файл и закончился бы ложной
    // строкой в журнале «запись так и не нашлась».
    expect(await pendingSearchRetries()).toBe(0);
  }, 40_000);

  it("тревога «станция записала разговор без звука» несёт dedupKey ПО ДНЮ (24.09.2026)", async () => {
    systemErrorCalls.length = 0;
    stubPbxWithAudio(Buffer.alloc(44));
    const interactionId = await newInteraction();

    await ingestCallRecording({ interactionId, search, clientAnswered: true });

    const alarm = systemErrorCalls.find((c) => c.message.includes("MixMonitor не пишет"));
    expect(alarm).toBeTruthy();
    // Ключ — по дню (Душанбе), а не стабильный навсегда: иначе `everSeen`
    // (systemError.ts) становится true один раз за всю жизнь процесса, и на
    // ту же поломку станции через месяц директор пушем уже не услышит.
    // Дата — по Душанбе (UTC+5), тем же способом, что и в самом коде
    // (dushanbeWallClock(...).toISOString().slice(0, 10)).
    const expectedDay = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
    expect(alarm?.dedupKey).toBe(`recording-empty-${expectedDay}`);
    // Путь и размер файла НЕ входят в ключ — иначе каждый разговор считался бы
    // новым видом ошибки вместо повтора одной и той же поломки станции.
    expect(alarm?.dedupKey).not.toContain(String(44));
  }, 40_000);

  it("пустая запись на каждом разговоре — руководству одно уведомление, а не по одному на звонок (E11, 02.10.2026)", async () => {
    const director = await prisma.agent.create({
      data: { fullName: `Директор пустых записей ${runId}`, phone: `+99291${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash: "x" },
    });
    try {
      await prisma.notification.deleteMany({ where: { tag: { startsWith: "recording-empty" } } });
      const count = () => prisma.notification.count({ where: { agentId: director.id, tag: { startsWith: "recording-empty" } } });
      for (let i = 0; i < 2; i++) {
        stubPbxWithAudio(Buffer.alloc(44));
        const interactionId = await newInteraction();
        await ingestCallRecording({ interactionId, search, clientAnswered: true });
        await waitForSettled(count, { timeoutMs: 3000 });
      }
      expect(await waitForSettled(count, { timeoutMs: 3000 })).toBe(1);
    } finally {
      await prisma.notification.deleteMany({ where: { agentId: director.id } });
      await prisma.agent.delete({ where: { id: director.id } });
    }
  }, 60_000);

  it("оборванная стадия снимается на старте, а разговор отправляется догонять запись", async () => {
    const stuck = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        notes: "Звонок через CRM, разговор 0:27",
        callAttempt: "TALKED",
        transcriptionStage: "SEARCHING",
      },
    });

    const { cleared, requeued } = await recoverInterruptedTranscriptionStages();
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(requeued).toBeGreaterThanOrEqual(1);

    const row = await prisma.interaction.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(row.transcriptionStage).toBeNull();
    expect(await pendingSearchRetries()).toBe(1);
  });

  it("запись есть, а текста нет — досылаем расшифровку, а не поиск файла", async () => {
    const stuck = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        notes: "Звонок через CRM, разговор 3:00",
        callAttempt: "TALKED",
        recordingUrl: `2026/08/07/${RECORDING_NAME}`,
        transcriptionStage: "QUEUED",
      },
    });

    const { requeued } = await recoverInterruptedTranscriptionStages();
    expect(requeued).toBeGreaterThanOrEqual(1);

    const row = await prisma.interaction.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(row.transcriptionStage).toBeNull();
    expect(await pendingTranscriptionRetries()).toBe(1);
    // Файл на станции цел — заново его искать незачем.
    expect(await pendingSearchRetries()).toBe(0);
  });

  it("живое задание в очереди — стадия честная, её не трогают", async () => {
    const working = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        notes: "Звонок через CRM, разговор 1:10",
        callAttempt: "TALKED",
        recordingUrl: `2026/08/07/${RECORDING_NAME}`,
        transcriptionStage: "TRANSCRIBING",
      },
    });
    await prisma.backgroundJob.create({
      data: {
        type: "transcription-retry",
        payload: { interactionId: working.id },
        dedupeKey: `transcription-retry:${working.id}`,
        maxAttempts: 3,
      },
    });

    const { cleared } = await recoverInterruptedTranscriptionStages();
    expect(cleared).toBe(0);

    const row = await prisma.interaction.findUniqueOrThrow({ where: { id: working.id } });
    expect(row.transcriptionStage).toBe("TRANSCRIBING");
  });

  it("недозвон без записи не гоняет станцию заново — догонять нечего", async () => {
    const missed = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        notes: "Звонок через CRM: клиент не ответил",
        callAttempt: "NO_ANSWER",
        transcriptionStage: "SEARCHING",
      },
    });

    const { cleared, requeued } = await recoverInterruptedTranscriptionStages();
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(requeued).toBe(0);

    const row = await prisma.interaction.findUniqueOrThrow({ where: { id: missed.id } });
    expect(row.transcriptionStage).toBeNull();
    expect(await pendingSearchRetries()).toBe(0);
  });
});
