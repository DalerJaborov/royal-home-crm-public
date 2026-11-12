import { afterEach, describe, expect, it, vi } from "vitest";
import { spokenArea, spokenPrice } from "@royal-home/shared";

/**
 * ТАДЖИКСКАЯ РЕЧЬ РОБОТА (11.11.2026). Без сети:
 *  - правила речи — одно место (ai/tajikPhoneSpeech.ts) и попадают в таджикские
 *    части промта обоих поставщиков, но не в промт с замком «только русский»;
 *  - числа в образцах — словами и той же функцией, что отдаёт цены роботу;
 *  - слова распознавания агента — в пределах Scribe Realtime, слова владельца целы;
 *  - словарь произношения: только подтверждённые и только таджикские слова (словарь
 *    агента звучит и в русской речи — проверено живьём 11.11), словари владельца
 *    целы, наши старые версии снимаются, отказ сети звонок не трогает.
 */

const logged = vi.hoisted(() => ({ keys: [] as (string | undefined)[] }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async (_source: string, _message: string, opts?: { dedupKey?: string }) => {
    logged.keys.push(opts?.dedupKey);
  },
}));

const lexicon = await import("../src/ai/tajikVoiceLexicon.js");
const { TAJIK_PHONE_SPEECH_RULES, TAJIK_PHONE_NUMBERS_RULE } = await import("../src/ai/tajikPhoneSpeech.js");
const { buildLiveVoiceSystemPrompt, LIVE_VOICE_TAJIK_EXAMPLES_INBOUND } = await import("../src/ai/liveVoicePersona.js");
const { buildAgentTuningPatch, mergePronunciationLocators, syncTajikPronunciationDictionary } = await import(
  "../src/ai/elevenLabsAgentSync.js"
);

describe("правила таджикской речи — одно место для ElevenLabs и Gemini", () => {
  it("попадают в промт исходящих и консультанта, когда таджикский разрешён", () => {
    expect(buildLiveVoiceSystemPrompt(undefined, { forceRussianOnly: false })).toContain(TAJIK_PHONE_SPEECH_RULES);
    expect(LIVE_VOICE_TAJIK_EXAMPLES_INBOUND).toContain(TAJIK_PHONE_SPEECH_RULES);
  });

  it("с замком «только русский» таджикских правил в промте нет", () => {
    expect(buildLiveVoiceSystemPrompt(undefined, { forceRussianOnly: true })).not.toContain("ТАДЖИКСКАЯ РЕЧЬ ПО ТЕЛЕФОНУ");
  });

  it("образцы чисел — словами и той же функцией, что отдаёт цены роботу", () => {
    expect(TAJIK_PHONE_NUMBERS_RULE).toContain(spokenPrice(1_380_000, "TJS", "tg"));
    expect(TAJIK_PHONE_NUMBERS_RULE).toContain(spokenPrice(45_000, "USD", "tg"));
    expect(TAJIK_PHONE_NUMBERS_RULE).toContain(spokenArea(80, "tg"));
    // Внутри «…» — ни одной цифры: образец с цифрами модель повторит цифрами.
    const quoted = TAJIK_PHONE_SPEECH_RULES.match(/«[^»]*»/g) ?? [];
    expect(quoted.length).toBeGreaterThan(10);
    for (const q of quoted) expect(q).not.toMatch(/\d/);
  });

  it("запрещённые владельцем слова встречаются только в строках «Нельзя»", () => {
    for (const line of TAJIK_PHONE_SPEECH_RULES.split("\n")) {
      if (/нельзя/i.test(line)) continue;
      expect(line).not.toMatch(/лутфан|безаҳмат|илтимос|хоҳиш мекунам|қулай|қизиқ|мутахассис|муфассал/i);
    }
  });

  it("обращение только «Шумо», без «ака/апа»", () => {
    expect(TAJIK_PHONE_SPEECH_RULES).toContain("«Шумо»");
    expect(TAJIK_PHONE_SPEECH_RULES).not.toMatch(/«(ака|апа)/i);
  });
});

describe("слова распознавания (asr.keywords)", () => {
  it("в пределах Scribe Realtime: до 50 штук, до 20 знаков, без повторов", () => {
    const kw = lexicon.TAJIK_ASR_KEYWORDS;
    expect(kw.length).toBeLessThanOrEqual(lexicon.ASR_KEYWORDS_MAX);
    for (const w of kw) {
      expect(w.length).toBeLessThanOrEqual(lexicon.ASR_KEYWORD_MAX_CHARS);
      expect(w.split(/\s+/).length).toBeLessThanOrEqual(5);
    }
    expect(new Set(kw.map((w) => w.toLowerCase())).size).toBe(kw.length);
  });

  it("слова владельца первыми и целы (даже длинные), наши — до предела, без повторов", () => {
    const owner = ["Сино", "  Мой ориентир ", "очень-очень длинное слово-ориентир"];
    const merged = lexicon.mergeAsrKeywords(owner);
    expect(merged.slice(0, 3)).toEqual(["Сино", "Мой ориентир", "очень-очень длинное слово-ориентир"]);
    expect(merged.filter((w) => w.toLowerCase() === "сино")).toHaveLength(1);
    expect(merged).toHaveLength(50);
    // У владельца уже 70 слов — его слова не режем, наших не добавляем.
    const many = lexicon.mergeAsrKeywords(Array.from({ length: 70 }, (_, i) => `слово${i}`));
    expect(many).toHaveLength(70);
    expect(many).not.toContain("Шоҳмансур");
  });
});

describe("словарь произношения", () => {
  const rule = (word: string, approved = true) => ({ word, ipa: "ˈtest", approved });

  it("каждый кандидат — слово с таджикскими буквами (словарь агента звучит и в русской речи)", () => {
    for (const r of lexicon.TAJIK_PRONUNCIATION_RULES) expect(r.word).toMatch(lexicon.TAJIK_ONLY_LETTERS);
  });

  it("в агента уходят только подтверждённые и только таджикские слова", () => {
    const picked = lexicon.approvedTajikPronunciationRules([rule("Шоҳмансур"), rule("Сино"), rule("Ваҳдат", false)]);
    expect(picked.map((r) => r.word)).toEqual(["Шоҳмансур"]);
  });

  it("сейчас ни одно правило не подтверждено — агент без нашего словаря, пока владелец не послушает", () => {
    expect(lexicon.approvedTajikPronunciationRules()).toEqual([]);
  });

  it("имя словаря несёт отпечаток правил: правка правил — новое имя", () => {
    const a = lexicon.tajikDictionaryName([rule("Шоҳмансур")]);
    const b = lexicon.tajikDictionaryName([{ ...rule("Шоҳмансур"), ipa: "ʃohmanˈsur" }]);
    expect(a.startsWith(lexicon.TAJIK_DICTIONARY_NAME_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("файл PLS: язык tg, IPA, по записи на правило, спецзнаки экранированы", () => {
    const pls = lexicon.buildTajikPronunciationPls([rule("Шоҳмансур"), { word: "A&B<", ipa: "ab", approved: false }]);
    expect(pls).toContain('alphabet="ipa" xml:lang="tg"');
    expect(pls.match(/<lexeme>/g)).toHaveLength(2);
    expect(pls).toContain("<grapheme>A&amp;B&lt;</grapheme>");
    expect(lexicon.buildTajikPronunciationPls().match(/<lexeme>/g)).toHaveLength(lexicon.TAJIK_PRONUNCIATION_RULES.length);
  });

  it("словари агента: наш первым, словари владельца целы, наши старые сняты, не больше трёх", () => {
    const existing = [
      { pronunciation_dictionary_id: "owner1", version_id: "v1" },
      { pronunciation_dictionary_id: "ours_old", version_id: "v0" },
      { pronunciation_dictionary_id: "owner2", version_id: null },
      { pronunciation_dictionary_id: "owner3", version_id: "v3" },
    ];
    const merged = mergePronunciationLocators(existing, {
      locator: { pronunciation_dictionary_id: "ours_new", version_id: "v9" },
      ourIds: ["ours_old", "ours_new"],
    });
    expect(merged).toEqual([
      { pronunciation_dictionary_id: "ours_new", version_id: "v9" },
      { pronunciation_dictionary_id: "owner1", version_id: "v1" },
      { pronunciation_dictionary_id: "owner2", version_id: null },
    ]);
    expect(mergePronunciationLocators(existing, { locator: null, ourIds: ["ours_old"] }).map((l) => l.pronunciation_dictionary_id)).toEqual([
      "owner1",
      "owner2",
      "owner3",
    ]);
  });

  it("второй PATCH: словари владельца уходят назад даже без нашего словаря (замена tts целиком их не сотрёт)", () => {
    const agent = { conversation_config: { tts: { voice_id: "v", pronunciation_dictionary_locators: [{ pronunciation_dictionary_id: "own", version_id: "1" }] } } };
    const tts = (buildAgentTuningPatch(agent, []) as { conversation_config: { tts: Record<string, unknown> } }).conversation_config.tts;
    expect(tts.pronunciation_dictionary_locators).toEqual([{ pronunciation_dictionary_id: "own", version_id: "1" }]);
    const bare = (buildAgentTuningPatch({}, []) as { conversation_config: { tts: Record<string, unknown> } }).conversation_config.tts;
    expect(bare).not.toHaveProperty("pronunciation_dictionary_locators");
  });
});

describe("словарь в аккаунте ElevenLabs (fetch подменён)", () => {
  type Call = { method: string; path: string; body?: Record<string, unknown> };
  let calls: Call[] = [];
  const stub = (handler: (c: Call) => { status?: number; json: unknown }) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const u = new URL(String(url));
        const call: Call = { method: String(init.method), path: u.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        const r = handler(call);
        return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
      })
    );

  afterEach(() => {
    calls = [];
    logged.keys.length = 0;
    vi.unstubAllGlobals();
  });

  const approved = [{ word: "Шоҳмансур", ipa: "ʃohmanˈsur", approved: true }];

  it("нет подтверждённых правил и словарей у агента — сеть не трогается", async () => {
    stub(() => ({ json: {} }));
    expect(await syncTajikPronunciationDictionary("sk", {}, [])).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("правила есть, нашего словаря этой версии нет — заводится, старая версия снимается", async () => {
    stub((c) =>
      c.method === "GET"
        ? { json: { pronunciation_dictionaries: [{ id: "old", name: `${lexicon.TAJIK_DICTIONARY_NAME_PREFIX} · deadbeef`, latest_version_id: "v0" }, { id: "own", name: "Словарь владельца", latest_version_id: "v1" }] } }
        : { json: { id: "new", version_id: "v1" } }
    );
    const sync = await syncTajikPronunciationDictionary("sk", {}, approved);
    expect(sync).toEqual({ locator: { pronunciation_dictionary_id: "new", version_id: "v1" }, ourIds: ["old", "new"] });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/v1/pronunciation-dictionaries/add-from-rules");
    expect(post?.body?.name).toBe(lexicon.tajikDictionaryName(approved));
    expect(post?.body?.rules).toEqual([
      { type: "phoneme", string_to_replace: "Шоҳмансур", phoneme: "ʃohmanˈsur", alphabet: "ipa", case_sensitive: false, word_boundaries: true },
    ]);
  });

  it("словарь этой версии уже есть — новый не заводится", async () => {
    stub(() => ({ json: { pronunciation_dictionaries: [{ id: "cur", name: lexicon.tajikDictionaryName(approved), latest_version_id: "v5" }] } }));
    const sync = await syncTajikPronunciationDictionary("sk", {}, approved);
    expect(sync?.locator).toEqual({ pronunciation_dictionary_id: "cur", version_id: "v5" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("правил больше нет, а у агента словари есть — наши снимаются, словари владельца остаются", async () => {
    stub(() => ({ json: { pronunciation_dictionaries: [{ id: "old", name: `${lexicon.TAJIK_DICTIONARY_NAME_PREFIX} · 1`, latest_version_id: "v" }] } }));
    const agent = { conversation_config: { tts: { pronunciation_dictionary_locators: [{ pronunciation_dictionary_id: "old", version_id: "v" }, { pronunciation_dictionary_id: "own", version_id: "1" }] } } };
    const sync = await syncTajikPronunciationDictionary("sk", agent, []);
    expect(sync).toEqual({ locator: null, ourIds: ["old"] });
    const tts = (buildAgentTuningPatch(agent, [], { tajikPronunciation: sync }) as { conversation_config: { tts: Record<string, unknown> } }).conversation_config.tts;
    expect(tts.pronunciation_dictionary_locators).toEqual([{ pronunciation_dictionary_id: "own", version_id: "1" }]);
  });

  it("отказ сети — undefined и запись в журнал, словари агента не меняются", async () => {
    stub(() => ({ status: 500, json: { detail: "boom" } }));
    expect(await syncTajikPronunciationDictionary("sk", {}, approved)).toBeUndefined();
    expect(logged.keys).toContain("elevenlabs-tajik-dictionary");
  });
});
