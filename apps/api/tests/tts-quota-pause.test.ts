import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { synthesizeSpeech, ttsQuotaPausedUntil, resetTtsQuotaPause } from "../src/ai/tts.js";

/**
 * ПАУЗА ОЗВУЧКИ ПРИ ИСЧЕРПАННОЙ КВОТЕ.
 *
 * ЗАЧЕМ ТЕСТ (живой случай 21.08.2026). Квота синтеза кончилась вечером, а крон
 * подсказок агенту ходит каждые пять минут по одним и тем же карточкам: за ночь
 * ~240 запросов в час, все с 429, и сотни одинаковых записей в журнале ошибок.
 *
 * Здесь закреплено ровно два обещания, данных владельцу:
 *   · поймали 429 — в сеть больше не ходим, пока пауза не кончится;
 *   · добавил ключ в Настройках — работает СРАЗУ, ждать конца паузы не нужно.
 * Второе и есть причина, по которой пауза привязана к набору ключей, а не к часам.
 */

const MODEL = "test-tts-model";
const KEY_A = "AQ.TestTtsQuotaKeyAAAA0001"; // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
const KEY_B = "AQ.TestTtsQuotaKeyBBBB0002"; // gitleaks:allow -- reviewed synthetic test value or non-secret identifier

let saved: { geminiApiKey: string | null; geminiApiKey2: string | null };

/** Ответ Google «квота исчерпана». */
function quotaResponse() {
  return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
}

/** Успешная озвучка: PCM в base64 с частотой в mimeType, как отдаёт Gemini. */
function audioResponse() {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/L16;codec=pcm;rate=24000" } }] } }],
    }),
    { status: 200 }
  );
}

async function setKeys(keys: string[]) {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      geminiApiKey: keys[0] ? encryptSecret(keys[0]) : null,
      geminiApiKey2: keys[1] ? encryptSecret(keys[1]) : null,
    },
  });
}

beforeAll(async () => {
  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = { geminiApiKey: current.geminiApiKey, geminiApiKey2: current.geminiApiKey2 };
  // Один раз, НЕ в beforeEach: три теста ниже — намеренно последовательная
  // история одной модели (пауза → смена ключей снимает её → пауза снова).
  // Сброс перед каждым тестом обнулил бы и то, что тест №2 как раз проверяет
  // (что старая пауза слетает из-за смены набора ключей, а не просто пуста).
  // Нужен он только чтобы не наследовать паузу от прошлого прогона этого же
  // файла в общем воркере vitest (найдено 03.09.2026 полным прогоном).
  resetTtsQuotaPause();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.$disconnect();
});

describe("Озвучка на выжженной квоте", () => {
  it("после 429 в сеть больше не ходит", async () => {
    await setKeys([KEY_A]);
    const fetchMock = vi.fn(async () => quotaResponse());
    vi.stubGlobal("fetch", fetchMock);

    expect(await synthesizeSpeech("салом", { model: MODEL })).toBeNull();
    const afterFirst = fetchMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Второй вызов обязан молчать, не потратив ни одного запроса.
    expect(await synthesizeSpeech("салом", { model: MODEL })).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
    expect(await ttsQuotaPausedUntil(MODEL)).toBeGreaterThan(Date.now());
  });

  it("новый ключ снимает паузу сразу — ждать её конца не нужно", async () => {
    await setKeys([KEY_A, KEY_B]);

    // Набор ключей изменился, значит прежняя пауза к нему не относится.
    expect(await ttsQuotaPausedUntil(MODEL)).toBeNull();

    const fetchMock = vi.fn(async () => audioResponse());
    vi.stubGlobal("fetch", fetchMock);
    const result = await synthesizeSpeech("салом", { model: MODEL });
    expect(result?.audioBase64).toBe("AAAA");
    expect(result?.sampleRateHz).toBe(24000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("пауза считается по модели: выжженная одна не лишает голоса другую", async () => {
    await setKeys([KEY_A]);
    vi.stubGlobal("fetch", vi.fn(async () => quotaResponse()));
    await synthesizeSpeech("салом", { model: MODEL });
    expect(await ttsQuotaPausedUntil(MODEL)).toBeGreaterThan(Date.now());
    expect(await ttsQuotaPausedUntil("other-tts-model")).toBeNull();
  });
});

describe("Пауза квоты и резервная модель (CHANNEL-NEW-26)", () => {
  const PRIMARY = "test-tts-primary-404";
  const FALLBACK = "test-tts-fallback-429";

  it("основная модель закрыта (404), резервная без квоты (429): повторный вызов не делает ни одного запроса", async () => {
    resetTtsQuotaPause();
    await setKeys([KEY_A]);
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes(PRIMARY) ? new Response("not found", { status: 404 }) : quotaResponse()
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await synthesizeSpeech("салом", { models: [PRIMARY, FALLBACK] })).toBeNull();
    const afterFirst = fetchMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Пауза хранится под именем резервной модели, а проверялась только основная:
    // каждая следующая озвучка снова била в закрытую 404 и в исчерпанную квоту.
    expect(await synthesizeSpeech("салом", { models: [PRIMARY, FALLBACK] })).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
    // Внешние проверки (whisperClips, propertyWhisper) смотрят паузу по основной модели цепочки.
    expect(await ttsQuotaPausedUntil(PRIMARY)).toBeGreaterThan(Date.now());
    resetTtsQuotaPause();
  });

  it("основная жива, пауза только у резервной: основная по-прежнему вызывается", async () => {
    resetTtsQuotaPause();
    await setKeys([KEY_A]);
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes(PRIMARY) ? audioResponse() : quotaResponse()
    );
    vi.stubGlobal("fetch", fetchMock);
    // Резервная модель уходит на паузу отдельным вызовом, где она единственная.
    expect(await synthesizeSpeech("салом", { models: [FALLBACK] })).toBeNull();
    fetchMock.mockClear();

    const res = await synthesizeSpeech("салом", { models: [PRIMARY, FALLBACK] });
    expect(res).not.toBeNull();
    expect(fetchMock.mock.calls.every((c) => String(c[0]).includes(PRIMARY))).toBe(true);
    resetTtsQuotaPause();
  });
});
