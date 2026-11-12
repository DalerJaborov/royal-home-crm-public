import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * НАСТРОЙКИ ТЕЛЕФОННОГО РАЗГОВОРА АГЕНТА ELEVENLABS (10.11.2026). Без сети:
 *  - тело ВТОРОГО PATCH (настройки звучания) — белый список полей, прочитанные
 *    подобъекты целиком назад не уходят;
 *  - первый PATCH (id функций и разрешения на подмену) от настроек не зависит:
 *    отказ второго не роняет первый и не роняет звонок;
 *  - после отказа — пауза, звонки не ждут повторов.
 * Значения — передача 24.10 (docs/journal/2026-11-10-voice-elevenlabs-switch.md).
 */

const logged = vi.hoisted(() => ({ messages: [] as { key?: string; text: string }[] }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async (_source: string, message: string, opts?: { dedupKey?: string }) => {
    logged.messages.push({ key: opts?.dedupKey, text: String(message) });
  },
}));

const {
  ELEVENLABS_SYNC_RETRY_PAUSE_MS,
  buildAgentSyncPatch,
  buildAgentTuningPatch,
  ensureElevenLabsAgentReady,
  resetElevenLabsSyncCacheForTests,
  syncElevenLabsAgentDetailed,
} = await import("../src/ai/elevenLabsAgentSync.js");
import type { LiveVoiceFunctionDeclaration } from "../src/ai/liveVoiceClient.js";

type Patch = {
  conversation_config: {
    agent: { prompt: Record<string, unknown> };
    tts: Record<string, unknown>;
    asr: Record<string, unknown>;
    turn: Record<string, unknown> & { interruption_ignore_terms: string[]; soft_timeout_config: Record<string, unknown> };
    language_presets: Record<string, { overrides: Record<string, unknown> }>;
  };
  platform_settings?: unknown;
};

const OWNER_AGENT = {
  name: "Larisa",
  conversation_config: {
    agent: {
      language: "ru",
      first_message: "",
      prompt: {
        prompt: "кабинет",
        llm: "gemini-3.8-flash",
        temperature: 0.3,
        tool_ids: ["own_tool"],
        knowledge_base: [{ id: "kb1", type: "file" }],
        built_in_tools: { end_call: { type: "system", name: "end_call" } },
      },
    },
    // Поля, которых нет в схеме ввода (так выглядит «ответ GET шире, чем PATCH»).
    tts: { voice_id: "larisa", model_id: "eleven_flash_v2_5", similarity_boost: 0.8, read_only_cost: 42, supported_voices: [{ x: 1 }] },
    asr: { provider: "scribe_realtime", quality: "high", keywords: ["Сино"], user_input_audio_format: "pcm_16000", computed: true },
    turn: {
      turn_timeout: 7,
      turn_eagerness: "normal",
      interruption_ignore_terms: ["окей"],
      soft_timeout_config: { timeout_seconds: 3, message: "Мм...", server_only: 1 },
      some_new_field: "x",
    },
    language_presets: { en: { overrides: { agent: { first_message: "Hi" } } } },
  },
  platform_settings: { overrides: { conversation_config_override: { tts: { stability: true } } } },
};

describe("второй PATCH: настройки из передачи 24.10, белый список полей", () => {
  const patch = buildAgentTuningPatch(OWNER_AGENT, ["tool_1"], { voiceIdTg: " manzura " }) as unknown as Patch;
  const cc = patch.conversation_config;

  it("голос: eleven_v4_turbo без скорости (на v4 Turbo не работает), стабильность 0.45, эмоции вкл (12.11), ulaw 8 кГц; голос владельца цел", () => {
    expect(cc.tts).toEqual({
      model_id: "eleven_v4_turbo",
      stability: 0.45,
      expressive_mode: true,
      agent_output_audio_format: "ulaw_8000",
      // 11.11.2026: таджикские цифры нормализатор ElevenLabs читает с ошибками.
      text_normalisation_type: "system_prompt",
      voice_id: "larisa",
    });
  });

  it("распознавание: ulaw 8 кГц; поставщик цел; слова владельца первыми, затем таджикские, без повторов; прочее не уходит", () => {
    expect(Object.keys(cc.asr).sort()).toEqual(["keywords", "provider", "user_input_audio_format"]);
    expect(cc.asr).toMatchObject({ user_input_audio_format: "ulaw_8000", provider: "scribe_realtime" });
    const kw = cc.asr.keywords as string[];
    expect(kw[0]).toBe("Сино");
    expect(kw.filter((w) => w === "Сино")).toHaveLength(1);
    for (const w of ["Шоҳмансур", "Фирдавсӣ", "Рӯдакӣ", "Роял Хоум"]) expect(kw).toContain(w);
    expect(kw.length).toBeLessThanOrEqual(50);
  });

  it("очередь реплик: eager, turn_timeout 5, turn_v3 + speculative_turn; заполнители выкл; чужих полей нет", () => {
    expect(cc.turn).toEqual({
      turn_model: "turn_v3",
      speculative_turn: true,
      turn_eagerness: "eager",
      turn_timeout: 5,
      soft_timeout_config: { timeout_seconds: -1 },
      interruption_ignore_terms: expect.any(Array),
    });
  });

  it("поддакивания ru/tg не перебивают агента, «нет/стоп/подождите» — перебивают; слова владельца первыми", () => {
    const terms = cc.turn.interruption_ignore_terms;
    expect(terms[0]).toBe("окей");
    for (const w of ["ага", "угу", "ҳа", "хуб"]) expect(terms).toContain(w);
    for (const w of ["нет", "стоп", "подождите", "не надо"]) expect(terms).not.toContain(w);
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("промт: потолок 300 токенов (вызов save_client_request не режется), пояс Душанбе, определение языка", () => {
    expect(cc.agent.prompt).toEqual({
      prompt: "кабинет",
      llm: "gemini-3.8-flash",
      temperature: 0.3,
      tool_ids: ["own_tool", "tool_1"],
      max_tokens: 300,
      timezone: "Asia/Dushanbe",
      built_in_tools: {
        // Встроенный end_call владельца выключается политикой CRM (11.11.2026): трубку кладёт мост.
        end_call: null,
        language_detection: {
          type: "system",
          name: "language_detection",
          description: "",
          params: { system_tool_type: "language_detection" },
        },
      },
    });
  });

  it("второй язык tg — только свой пресет с таджикским голосом (пробелы срезаны); чужие пресеты не пересылаются", () => {
    expect(cc.language_presets).toEqual({ tg: { overrides: { tts: { voice_id: "manzura" } } } });
    const bare = buildAgentTuningPatch({}, []) as unknown as Patch;
    expect(bare.conversation_config.language_presets).toEqual({ tg: { overrides: {} } });
  });

  it("основной язык, первая фраза и разрешения на подмену во втором PATCH не трогаются", () => {
    expect(cc.agent).not.toHaveProperty("language");
    expect(cc.agent).not.toHaveProperty("first_message");
    expect(patch).not.toHaveProperty("platform_settings");
  });
});

describe("первый PATCH: только id функций и разрешения — как до 10.11", () => {
  it("настроек звучания в нём нет", () => {
    const first = buildAgentSyncPatch(OWNER_AGENT, ["tool_1"]) as Record<string, Record<string, unknown>>;
    expect(Object.keys(first.conversation_config)).toEqual(["agent"]);
    const prompt = (first.conversation_config.agent as { prompt: Record<string, unknown> }).prompt;
    expect(prompt.tool_ids).toEqual(["own_tool", "tool_1"]);
    expect(prompt).not.toHaveProperty("max_tokens");
    expect(prompt).not.toHaveProperty("timezone");
  });
});

describe("подготовка агента по сети (fetch подменён)", () => {
  type Call = { method: string; path: string; body: Patch | undefined };
  let calls: Call[] = [];
  let failWhen: (c: Call) => number | null = () => null;
  let now = 1_800_000_000_000;

  // tool_ids, которые агент «сохранил» последним PATCH: подготовка сверяет их GET-ом (11.11.2026).
  let attached: string[] | null = null;

  beforeEach(() => {
    calls = [];
    attached = null;
    failWhen = () => null;
    logged.messages.length = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const call: Call = {
          method: String(init.method),
          path: new URL(String(url)).pathname,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        };
        calls.push(call);
        const status = failWhen(call);
        if (status) return new Response(JSON.stringify({ detail: "Unprocessable" }), { status });
        const sentIds = call.body?.conversation_config?.agent?.prompt?.tool_ids;
        if (call.method === "PATCH" && call.path.startsWith("/v1/convai/agents/") && Array.isArray(sentIds)) attached = sentIds as string[];
        const agentNow = attached
          ? { ...OWNER_AGENT, conversation_config: { ...OWNER_AGENT.conversation_config, agent: { ...OWNER_AGENT.conversation_config.agent, prompt: { ...OWNER_AGENT.conversation_config.agent.prompt, tool_ids: attached } } } }
          : OWNER_AGENT;
        const json =
          call.method === "GET" && call.path === "/v1/convai/tools"
            ? { tools: [] }
            : call.method === "POST"
              ? { id: "tool_new" }
              : call.method === "GET"
                ? agentNow
                : {};
        return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetElevenLabsSyncCacheForTests();
  });

  const isAgentPatch = (c: Call) => c.method === "PATCH" && c.path.startsWith("/v1/convai/agents/");
  const agentPatches = () => calls.filter(isAgentPatch);
  const isTuning = (c: Call) => isAgentPatch(c) && !!c.body?.conversation_config?.tts;
  const flush = () => new Promise((r) => setImmediate(r));

  const TOOL: LiveVoiceFunctionDeclaration = {
    name: "search_properties",
    description: "Поиск",
    parameters: { type: "OBJECT", properties: { district: { type: "STRING", description: "Район" } }, required: [] },
  };

  it("два PATCH: сначала id функций и разрешения, потом настройки звучания", async () => {
    const outcome = await syncElevenLabsAgentDetailed("sk_test", "agent_1", [TOOL], { voiceIdTg: "manzura" });
    expect(outcome).toEqual({ ids: new Map([["search_properties", "tool_new"]]), tuned: true, tuningError: null });
    const [first, second] = agentPatches();
    expect(first.body).toHaveProperty("platform_settings");
    expect(first.body!.conversation_config.agent.prompt.tool_ids).toEqual(["own_tool", "tool_new"]);
    expect(second.body!.conversation_config.tts.model_id).toBe("eleven_v4_turbo");
    expect(second.body!.conversation_config.agent.prompt.tool_ids).toEqual(["own_tool", "tool_new"]);
  });

  it("звонок без функций: список инструментов не читается, но агент получает настройки", async () => {
    const ids = await ensureElevenLabsAgentReady("sk_test", "agent_1", [], { voiceIdTg: "manzura" });
    expect(ids).toEqual(new Map());
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/convai/agents/agent_1",
      "PATCH /v1/convai/agents/agent_1",
      "PATCH /v1/convai/agents/agent_1",
    ]);
  });

  it("настройки отвечают 422: разрешения ушли, ensure не бросает и отдаёт id, звонок идёт, ошибка в журнале", async () => {
    failWhen = (c) => (isTuning(c) ? 422 : null);
    const ids = await ensureElevenLabsAgentReady("sk_test", "agent_1", [TOOL]);
    expect(ids).toEqual(new Map([["search_properties", "tool_new"]]));
    expect(agentPatches()).toHaveLength(2);
    expect(agentPatches()[0].body).toHaveProperty("platform_settings");
    expect(logged.messages.find((m) => m.key === "elevenlabs-agent-tuning")?.text).toContain("не принял настройки разговора");
    expect(logged.messages.some((m) => m.key === "elevenlabs-agent-sync")).toBe(false);

    // Следующий звонок до конца паузы — из памяти, без сети.
    const before = calls.length;
    expect(await ensureElevenLabsAgentReady("sk_test", "agent_1", [TOOL])).toEqual(ids);
    expect(calls.length).toBe(before);

    // После паузы — настройки повторяются в фоне, звонок их не ждёт.
    now += ELEVENLABS_SYNC_RETRY_PAUSE_MS;
    failWhen = () => null;
    expect(await ensureElevenLabsAgentReady("sk_test", "agent_1", [TOOL])).toEqual(ids);
    await vi.waitFor(() => expect(calls.filter(isTuning)).toHaveLength(2));
    await flush();
  });

  it("первый PATCH отказал (403): null и запись в журнал, настройки не шлются; повторы — только после паузы", async () => {
    failWhen = (c) => (isAgentPatch(c) && !isTuning(c) ? 403 : null);
    expect(await ensureElevenLabsAgentReady("sk_test", "agent_1", [TOOL])).toBeNull();
    expect(calls.filter(isTuning)).toHaveLength(0);
    expect(logged.messages.find((m) => m.key === "elevenlabs-agent-sync")?.text).toContain("не подготовлен");

    const before = calls.length;
    now += ELEVENLABS_SYNC_RETRY_PAUSE_MS - 1;
    expect(await ensureElevenLabsAgentReady("sk_test", "agent_1", [TOOL])).toBeNull();
    expect(calls.length).toBe(before);

    now += 1;
    failWhen = () => null;
    expect(await ensureElevenLabsAgentReady("sk_test", "agent_1", [TOOL])).toEqual(new Map([["search_properties", "tool_new"]]));
    expect(calls.length).toBeGreaterThan(before);
  });

  it("сменился таджикский голос — агент готовится заново, тот же голос — из памяти", async () => {
    await ensureElevenLabsAgentReady("sk_test", "agent_1", [], { voiceIdTg: "a" });
    await ensureElevenLabsAgentReady("sk_test", "agent_1", [], { voiceIdTg: "a" });
    expect(calls.filter(isTuning)).toHaveLength(1);
    await ensureElevenLabsAgentReady("sk_test", "agent_1", [], { voiceIdTg: "b" });
    expect(calls.filter(isTuning)).toHaveLength(2);
  });
});
