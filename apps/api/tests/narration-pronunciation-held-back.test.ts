import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { narrationConfigSchema } from "@royal-home/shared";

/**
 * СЛОВАРЬ ПРОИЗНОШЕНИЯ ОЗВУЧКИ: ЗВУКИ БЕЗ ПРОВЕРКИ НОСИТЕЛЕМ В ElevenLabs НЕ УХОДЯТ (20.11.2026, ФАКТ на слух владельца
 * на проде: со словарём таджикский звучал с акцентом, без словаря — правильно). База настоящая, ElevenLabs — только подмена
 * fetch (живых запросов и трат нет). Что проверяется:
 *  A — что реально уходит в словарь и когда словарь «устарел» (чистые функции);
 *  B — синхронизация: непроверенные звуки не отправляются, отпечаток записывается;
 *  C — проход при старте процесса: обновляет сам, идемпотентен, при отказе не падает, пишет узко и не затирает экран Настроек;
 *  D — сохранение настроек на экране: правка непроверенного звука словарь не трогает, снятие пометки — обновляет;
 *  E — worker.ts действительно зовёт проход при старте.
 */
process.env.ELEVENLABS_API_KEY = "test-key-not-real";
const errors = vi.hoisted(() => ({ log: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock("../src/auth/middleware.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/auth/middleware.js")>(), requireAuth: (req: any, _res: any, next: () => void) => { req.agent = { id: "staff", role: "ADMIN" }; next(); } }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/systemError.js")>(), logSystemError: errors.log }));

const { prisma } = await import("../src/db.js");
const { narrationRouter } = await import("../src/routes/properties/narration.js");
const { pronunciationRulesForElevenLabs, pronunciationFingerprint, pronunciationDictionaryStale, syncPronunciationDictionary, syncPronunciationDictionaryOnStart } = await import("../src/lib/narrationPronunciation.js");

const app = express(); app.use(express.json()); app.use("/properties", narrationRouter);
const HELD = { word: "ошёна", phoneme: "/oʃˈɵna/", needsNative: true };
const VERIFIED = { word: "хона", phoneme: "/xoˈna/" };
const ALIAS = { word: "м²", alias: "метри мураббаъ" };
const ALIAS_MARKED = { word: "Сино", alias: "Сино́", needsNative: true };
const VOICES = [{ id: "voiceA", name: "А", gender: "female" as const }];
const base = (over: Record<string, unknown> = {}) => ({ modelId: "eleven_v4", voices: VOICES, ...over });
let configBefore: unknown = null;

async function saveConfig(config: Record<string, unknown>) {
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", propertyNarrationConfig: config as object }, update: { propertyNarrationConfig: config as object } });
}
async function storedConfig() {
  return (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } })).propertyNarrationConfig as Record<string, any>;
}
type Call = { url: string; method: string; body: any };
function fakeFetch(opts: { status?: number; versionPrefix?: string; onCall?: () => Promise<void> | void; throws?: boolean } = {}) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null });
    await opts.onCall?.();
    if (opts.throws) throw new Error("сеть пропала");
    return new Response(JSON.stringify({ id: "dict1", version_id: `${opts.versionPrefix ?? "ver"}${calls.length}` }), { status: opts.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

beforeAll(async () => {
  configBefore = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } }))?.propertyNarrationConfig ?? null;
});
beforeEach(() => { errors.log.mockClear(); });
afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: (configBefore ?? {}) as object } }).catch(() => {});
});

describe("A: что уходит в ElevenLabs и когда словарь устарел", () => {
  it("звуки с пометкой «проверить носителем» остаются в CRM, но не отправляются; алиасы и проверенные звуки уходят", () => {
    const payload = pronunciationRulesForElevenLabs([HELD, VERIFIED, ALIAS, ALIAS_MARKED]);
    expect(payload).toEqual([
      { type: "phoneme", string_to_replace: "хона", phoneme: "xoˈna", alphabet: "ipa" },
      { type: "alias", string_to_replace: "м²", alias: "метри мураббаъ" },
      { type: "alias", string_to_replace: "Сино", alias: "Сино́" },
    ]);
    expect(pronunciationRulesForElevenLabs(undefined)).toEqual([]);
  });
  it("отпечаток: тот же набор — тот же, другой — другой; правка непроверенного звука его не меняет", () => {
    const fp = (rules: Parameters<typeof pronunciationRulesForElevenLabs>[0]) => pronunciationFingerprint(pronunciationRulesForElevenLabs(rules));
    expect(fp([VERIFIED, ALIAS])).toBe(fp([VERIFIED, ALIAS]));
    expect(fp([VERIFIED, ALIAS])).not.toBe(fp([VERIFIED, { ...ALIAS, alias: "кв. м" }]));
    expect(fp([VERIFIED, HELD, ALIAS])).toBe(fp([VERIFIED, { ...HELD, phoneme: "/другое/" }, ALIAS]));
    expect(fp([VERIFIED, { ...HELD, needsNative: undefined }, ALIAS])).not.toBe(fp([VERIFIED, HELD, ALIAS]));
  });
  it("словарь устарел: нет словаря, нет отпечатка, отпечаток не совпал; свежий, пустой набор и чужая модель — нет", () => {
    const rules = [VERIFIED, HELD, ALIAS];
    const fp = pronunciationFingerprint(pronunciationRulesForElevenLabs(rules));
    expect(pronunciationDictionaryStale(base({ pronunciationRules: rules }) as any)).toBe(true);
    expect(pronunciationDictionaryStale(base({ pronunciationRules: rules, pronunciationDictionaries: [{ id: "d1" }] }) as any)).toBe(true);
    expect(pronunciationDictionaryStale(base({ pronunciationRules: rules, pronunciationDictionaries: [{ id: "d1", rulesFingerprint: "0".repeat(64) }] }) as any)).toBe(true);
    expect(pronunciationDictionaryStale(base({ pronunciationRules: rules, pronunciationDictionaries: [{ id: "d1", rulesFingerprint: fp }] }) as any)).toBe(false);
    // Остались только непроверенные звуки: отправлять нечего — словарь надо архивировать, если он есть, а если нет — всё в порядке.
    expect(pronunciationDictionaryStale(base({ pronunciationRules: [HELD], pronunciationDictionaries: [{ id: "d1", rulesFingerprint: fp }] }) as any)).toBe(true);
    expect(pronunciationDictionaryStale(base({ pronunciationRules: [HELD] }) as any)).toBe(false);
    expect(pronunciationDictionaryStale(base({ pronunciationRules: rules, modelId: "eleven_v4_turbo" }) as any)).toBe(false);
  });
  it("старые настройки без отпечатка читаются схемой", () => {
    expect(narrationConfigSchema.safeParse(base({ pronunciationDictionaries: [{ id: "d1", versionId: "v1" }] })).success).toBe(true);
    expect(narrationConfigSchema.safeParse(base({ pronunciationDictionaries: [{ id: "d1", rulesFingerprint: "zz" }] })).success).toBe(false);
  });
});

describe("B: синхронизация со словарём", () => {
  it("в запросе нет непроверенных звуков, в ответе — отпечаток отправленного", async () => {
    const { calls, fetcher } = fakeFetch();
    const config = base({ pronunciationRules: [HELD, VERIFIED, ALIAS] }) as any;
    const result = await syncPronunciationDictionary(config, "k", fetcher);
    expect(calls[0]!.url).toMatch(/add-from-rules$/);
    expect(calls[0]!.body.rules.map((r: any) => r.string_to_replace)).toEqual(["хона", "м²"]);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("ошёна");
    expect(result).toEqual({ status: "SYNCED", dictionaries: [{ id: "dict1", versionId: "ver1", rulesFingerprint: pronunciationFingerprint(pronunciationRulesForElevenLabs(config.pronunciationRules)) }] });
  });
  it("все правила непроверенные: нового словаря не создаём, существующий архивируем", async () => {
    const none = fakeFetch();
    expect(await syncPronunciationDictionary(base({ pronunciationRules: [HELD] }) as any, "k", none.fetcher)).toEqual({ status: "SYNCED", dictionaries: [] });
    expect(none.calls).toHaveLength(0);
    const archive = fakeFetch();
    expect(await syncPronunciationDictionary(base({ pronunciationRules: [HELD], pronunciationDictionaries: [{ id: "dict1" }] }) as any, "k", archive.fetcher)).toEqual({ status: "SYNCED", dictionaries: [] });
    expect(archive.calls[0]).toMatchObject({ method: "PATCH", body: { archived: true } });
  });
});

describe("C: проход при старте процесса", () => {
  const legacy = () => base({ autoGenerate: true, dailyCharLimit: 5000, pronunciationRules: [HELD, VERIFIED, ALIAS], pronunciationDictionaries: [{ id: "dict1", versionId: "old" }] });
  it("словарь без отпечатка (так лежит на проде) обновляется сам, остальные настройки целы", async () => {
    await saveConfig(legacy());
    const { calls, fetcher } = fakeFetch();
    expect(await syncPronunciationDictionaryOnStart(fetcher)).toBe("SYNCED");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/dict1\/set-rules$/);
    expect(calls[0]!.body.rules.map((r: any) => r.string_to_replace)).toEqual(["хона", "м²"]);
    const stored = await storedConfig();
    expect(stored.pronunciationDictionaries).toEqual([{ id: "dict1", versionId: "ver1", rulesFingerprint: pronunciationFingerprint(pronunciationRulesForElevenLabs([HELD, VERIFIED, ALIAS])) }]);
    expect(stored).toMatchObject({ autoGenerate: true, dailyCharLimit: 5000, modelId: "eleven_v4", voices: VOICES });
    expect(stored.pronunciationRules).toHaveLength(3);
    expect(narrationConfigSchema.safeParse(stored).success).toBe(true);
  });
  it("повторный запуск ничего не делает: ни одного запроса к ElevenLabs", async () => {
    const again = fakeFetch();
    expect(await syncPronunciationDictionaryOnStart(again.fetcher)).toBe("FRESH");
    expect(again.calls).toHaveLength(0);
  });
  it("нет словаря вовсе — создаётся; нет ключа или модель без словаря — ничего не трогаем", async () => {
    await saveConfig(base({ pronunciationRules: [VERIFIED] }));
    const created = fakeFetch();
    expect(await syncPronunciationDictionaryOnStart(created.fetcher)).toBe("SYNCED");
    expect(created.calls[0]!.url).toMatch(/add-from-rules$/);
    expect((await storedConfig()).pronunciationDictionaries[0]).toMatchObject({ id: "dict1", versionId: "ver1" });
    await saveConfig({ ...legacy(), modelId: "eleven_v4_turbo" });
    const wrongModel = fakeFetch();
    expect(await syncPronunciationDictionaryOnStart(wrongModel.fetcher)).toBe("SKIPPED");
    expect(wrongModel.calls).toHaveLength(0);
    delete process.env.ELEVENLABS_API_KEY;
    try {
      await saveConfig(legacy());
      const noKey = fakeFetch();
      expect(await syncPronunciationDictionaryOnStart(noKey.fetcher)).toBe("SKIPPED");
      expect(noKey.calls).toHaveLength(0);
    } finally { process.env.ELEVENLABS_API_KEY = "test-key-not-real"; }
  });
  it("ElevenLabs отказал или пропал: в журнал ошибок, процесс не падает, конфиг не тронут", async () => {
    await saveConfig(legacy());
    const before = await storedConfig();
    expect(await syncPronunciationDictionaryOnStart(fakeFetch({ status: 500 }).fetcher)).toBe("FAILED");
    expect(await syncPronunciationDictionaryOnStart(fakeFetch({ throws: true }).fetcher)).toBe("FAILED");
    expect(errors.log).toHaveBeenCalledTimes(2);
    expect(String(errors.log.mock.calls[0]![1])).toContain("Словарь произношения озвучки не обновился");
    expect(errors.log.mock.calls[0]![2]).toMatchObject({ dedupKey: "narration-dictionary-start-sync" });
    expect(await storedConfig()).toEqual(before);
  });
  it("пока шёл запрос, на экране поправили ДРУГОЕ поле: оно не затёрто и словарь записан", async () => {
    await saveConfig(legacy());
    const { fetcher } = fakeFetch({ onCall: async () => { await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { ...legacy(), dailyCharLimit: 7777, debounceMinutes: 9 } } }); } });
    expect(await syncPronunciationDictionaryOnStart(fetcher)).toBe("SYNCED");
    const stored = await storedConfig();
    expect(stored).toMatchObject({ dailyCharLimit: 7777, debounceMinutes: 9 });
    expect(stored.pronunciationDictionaries[0].rulesFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it("пока шёл запрос, словарь на экране сменили: чужой результат не затираем, словарь остаётся устаревшим", async () => {
    await saveConfig(legacy());
    const { fetcher } = fakeFetch({ onCall: async () => { await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { ...legacy(), pronunciationDictionaries: [{ id: "dict1", versionId: "screen" }] } } }); } });
    expect(await syncPronunciationDictionaryOnStart(fetcher)).toBe("RACED");
    expect((await storedConfig()).pronunciationDictionaries).toEqual([{ id: "dict1", versionId: "screen" }]);
    expect(pronunciationDictionaryStale(narrationConfigSchema.parse(await storedConfig()))).toBe(true);
  });
});

describe("D: сохранение настроек на экране", () => {
  // Экран всегда присылает модель и голоса (NarrationSettingsPanel); частичный запрос без них стёр бы их схемой — это отдельная находка.
  const screen = (over: Record<string, unknown>) => ({ modelId: "eleven_v4", voices: VOICES, ...over });
  const stubFetch = () => { const f = fakeFetch(); vi.stubGlobal("fetch", f.fetcher); return f; };
  const fresh = (rules: unknown[]) => ({ id: "dict1", versionId: "ver0", rulesFingerprint: pronunciationFingerprint(pronunciationRulesForElevenLabs(rules as any)) });
  it("правка непроверенного звука словарь в ElevenLabs не трогает", async () => {
    const rules = [HELD, VERIFIED, ALIAS];
    await saveConfig(base({ pronunciationRules: rules, pronunciationDictionaries: [fresh(rules)] }));
    const { calls } = stubFetch();
    const res = await request(app).put("/properties/narration-settings").send(screen({ pronunciationRules: [{ ...HELD, phoneme: "/другое/" }, VERIFIED, ALIAS] }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect((await storedConfig()).pronunciationRules[0].phoneme).toBe("/другое/");
  });
  it("снятие пометки «проверить носителем» обновляет словарь и записывает новый отпечаток", async () => {
    const rules = [HELD, VERIFIED, ALIAS];
    await saveConfig(base({ pronunciationRules: rules, pronunciationDictionaries: [fresh(rules)] }));
    const { calls } = stubFetch();
    const confirmed = { word: HELD.word, phoneme: HELD.phoneme };
    const res = await request(app).put("/properties/narration-settings").send(screen({ pronunciationRules: [confirmed, VERIFIED, ALIAS] }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.rules.map((r: any) => r.string_to_replace)).toEqual(["ошёна", "хона", "м²"]);
    expect((await storedConfig()).pronunciationDictionaries[0]).toMatchObject({ id: "dict1", rulesFingerprint: pronunciationFingerprint(pronunciationRulesForElevenLabs([confirmed, VERIFIED, ALIAS])) });
  });
  it("словарь без отпечатка догоняется любым сохранением настроек; свежий — не трогается", async () => {
    const rules = [HELD, VERIFIED, ALIAS];
    await saveConfig(base({ pronunciationRules: rules, pronunciationDictionaries: [{ id: "dict1", versionId: "old" }] }));
    const stale = stubFetch();
    expect((await request(app).put("/properties/narration-settings").send(screen({ dailyCharLimit: 4000 }))).status).toBe(200);
    expect(stale.calls).toHaveLength(1);
    expect((await storedConfig()).pronunciationDictionaries[0].rulesFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const again = stubFetch();
    expect((await request(app).put("/properties/narration-settings").send(screen({ dailyCharLimit: 4100 }))).status).toBe(200);
    expect(again.calls).toHaveLength(0);
  });
});

describe("E: фоновый процесс зовёт проход при старте", () => {
  it("worker.ts: проверка словаря стоит в startBackgroundWork, в ветке, где плановые задачи не заглушены", () => {
    const source = fs.readFileSync(fileURLToPath(new URL("../src/worker.ts", import.meta.url)), "utf8");
    const body = source.slice(source.indexOf("export function startBackgroundWork"), source.indexOf("const CATCH_UP_DELAY_MS"));
    expect(body).toContain("m.syncPronunciationDictionaryOnStart()");
    expect(body.indexOf("syncPronunciationDictionaryOnStart")).toBeGreaterThan(body.indexOf("} else {"));
    expect(body.indexOf("syncPronunciationDictionaryOnStart")).toBeLessThan(body.indexOf("startTelegramBot()"));
  });
});
