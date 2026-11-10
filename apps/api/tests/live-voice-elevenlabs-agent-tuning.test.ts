import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ELEVENLABS_PHONE_AGENT_TUNING,
  buildAgentSyncPatch,
  ensureElevenLabsAgentReady,
  resetElevenLabsSyncCacheForTests,
  syncElevenLabsAgent,
} from "../src/ai/elevenLabsAgentSync.js";
import type { LiveVoiceFunctionDeclaration } from "../src/ai/liveVoiceClient.js";

/**
 * НАСТРОЙКИ ТЕЛЕФОННОГО РАЗГОВОРА АГЕНТА ELEVENLABS (10.11.2026). Без сети:
 * проверяется ТЕЛО, которое CRM отправит агенту (PATCH /v1/convai/agents/{id}),
 * и что подготовка идёт даже у звонка без функций. Значения — передача 24.10
 * (docs/journal/2026-11-10-voice-elevenlabs-switch.md).
 */

type Patch = {
  conversation_config: {
    agent: { prompt: Record<string, unknown> };
    tts: Record<string, unknown>;
    asr: Record<string, unknown>;
    turn: Record<string, unknown> & { interruption_ignore_terms: string[]; soft_timeout_config: Record<string, unknown> };
    language_presets: Record<string, { overrides: Record<string, unknown> }>;
  };
};

const OWNER_AGENT = {
  name: "Larisa",
  conversation_config: {
    agent: {
      language: "ru",
      prompt: {
        prompt: "кабинет",
        llm: "gemini-3.8-flash",
        tool_ids: ["own_tool"],
        built_in_tools: { end_call: { type: "system", name: "end_call" } },
      },
    },
    tts: { voice_id: "larisa", model_id: "eleven_flash_v2_5", speed: 1, stability: 0.5, expressive_mode: true, similarity_boost: 0.8 },
    asr: { provider: "scribe_realtime", quality: "high", keywords: ["Сино"], user_input_audio_format: "pcm_16000" },
    turn: {
      turn_timeout: 7,
      turn_eagerness: "normal",
      interruption_ignore_terms: ["окей"],
      soft_timeout_config: { timeout_seconds: 3, message: "Мм...", use_llm_generated_message: false },
    },
    language_presets: { en: { overrides: { agent: { first_message: "Hi" } } } },
  },
};

describe("тело правки агента: настройки из передачи 24.10", () => {
  const patch = buildAgentSyncPatch(OWNER_AGENT, ["tool_1"], { voiceIdTg: " manzura " }) as unknown as Patch;
  const cc = patch.conversation_config;

  it("голос: eleven_v4_turbo, скорость 1.15, стабильность 0.45, эмоции выкл, ulaw 8 кГц", () => {
    expect(cc.tts).toMatchObject({
      model_id: "eleven_v4_turbo",
      speed: 1.15,
      stability: 0.45,
      expressive_mode: false,
      agent_output_audio_format: "ulaw_8000",
      text_normalisation_type: "elevenlabs",
    });
    expect(cc.asr.user_input_audio_format).toBe("ulaw_8000");
  });

  it("очередь реплик: eager, turn_timeout 5, turn_v3 + speculative_turn; заполнители выкл", () => {
    expect(cc.turn).toMatchObject({ turn_eagerness: "eager", turn_timeout: 5, turn_model: "turn_v3", speculative_turn: true });
    expect(cc.turn.soft_timeout_config.timeout_seconds).toBe(-1);
  });

  it("поддакивания ru/tg не перебивают агента, «нет/стоп/подождите» — перебивают", () => {
    for (const w of ["ага", "угу", "ҳа", "хуб"]) expect(cc.turn.interruption_ignore_terms).toContain(w);
    for (const w of ["нет", "стоп", "подождите", "не надо"]) expect(cc.turn.interruption_ignore_terms).not.toContain(w);
  });

  it("ответ не длиннее 120 токенов, часовой пояс Душанбе, определение языка включено", () => {
    expect(cc.agent.prompt).toMatchObject({ max_tokens: 120, timezone: "Asia/Dushanbe" });
    expect((cc.agent.prompt.built_in_tools as Record<string, unknown>).language_detection).toEqual({
      type: "system",
      name: "language_detection",
      description: "",
      params: { system_tool_type: "language_detection" },
    });
  });

  it("второй язык tg — пресет с таджикским голосом из Настроек (пробелы срезаны)", () => {
    expect(cc.language_presets.tg).toEqual({ overrides: { tts: { voice_id: "manzura" } } });
  });

  it("своё владельца цело: модель разговора, голос, основной язык, его функции, слова, ASR, пресет en", () => {
    expect(cc.agent.prompt).toMatchObject({ prompt: "кабинет", llm: "gemini-3.8-flash", tool_ids: ["own_tool", "tool_1"] });
    expect((cc.agent.prompt.built_in_tools as Record<string, unknown>).end_call).toEqual({ type: "system", name: "end_call" });
    expect(cc.tts).toMatchObject({ voice_id: "larisa", similarity_boost: 0.8 });
    expect(cc.asr).toMatchObject({ provider: "scribe_realtime", quality: "high", keywords: ["Сино"] });
    expect(cc.turn.interruption_ignore_terms[0]).toBe("окей");
    expect(cc.turn.soft_timeout_config).toMatchObject({ message: "Мм...", use_llm_generated_message: false });
    expect(cc.language_presets.en).toEqual({ overrides: { agent: { first_message: "Hi" } } });
    // Основной язык агента не подменяется: его выбирает владелец (обычно ru).
    expect(cc.agent).not.toHaveProperty("language");
  });

  it("повторная правка ничего не меняет и не дублирует слова (агент после первой правки)", () => {
    const once = buildAgentSyncPatch(OWNER_AGENT, ["tool_1"], { voiceIdTg: "manzura" }) as unknown as Patch;
    const agentAfter = { conversation_config: once.conversation_config };
    const twice = buildAgentSyncPatch(agentAfter, ["tool_1"], { voiceIdTg: "manzura" }) as unknown as Patch;
    expect(twice.conversation_config).toEqual(once.conversation_config);
    const terms = twice.conversation_config.turn.interruption_ignore_terms;
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("таджикский голос не задан — пресет tg есть, голос в нём не подменяется; свой голос пресета цел", () => {
    const bare = buildAgentSyncPatch({}, []) as unknown as Patch;
    expect(bare.conversation_config.language_presets.tg).toEqual({ overrides: {} });
    const own = buildAgentSyncPatch(
      { conversation_config: { language_presets: { tg: { overrides: { tts: { voice_id: "own_tg" } }, first_message_translation: { text: "Салом" } } } } },
      []
    ) as unknown as Patch;
    expect(own.conversation_config.language_presets.tg).toEqual({
      overrides: { tts: { voice_id: "own_tg" } },
      first_message_translation: { text: "Салом" },
    });
  });

  it("значения — одна константа: тело собирается из ELEVENLABS_PHONE_AGENT_TUNING", () => {
    expect(cc.tts).toMatchObject(ELEVENLABS_PHONE_AGENT_TUNING.tts);
    expect(cc.turn).toMatchObject(ELEVENLABS_PHONE_AGENT_TUNING.turn);
    for (const w of ELEVENLABS_PHONE_AGENT_TUNING.interruptionIgnoreTerms) expect(cc.turn.interruption_ignore_terms).toContain(w);
  });
});

describe("подготовка агента по сети (fetch подменён)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetElevenLabsSyncCacheForTests();
  });

  function stubFetch() {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method: String(init.method), url: String(url), body });
        const json =
          init.method === "GET" && String(url).includes("/v1/convai/tools")
            ? { tools: [] }
            : init.method === "POST"
              ? { id: "tool_new" }
              : init.method === "GET"
                ? OWNER_AGENT
                : {};
        return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
      })
    );
    return calls;
  }

  it("звонок без функций: список инструментов не читается, но агент получает настройки разговора", async () => {
    const calls = stubFetch();
    const ids = await ensureElevenLabsAgentReady("sk_test", "agent_1", [], { voiceIdTg: "manzura" });
    expect(ids).toEqual(new Map());
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /v1/convai/agents/agent_1",
      "PATCH /v1/convai/agents/agent_1",
    ]);
    const patch = calls[1].body as Patch;
    expect(patch.conversation_config.tts.model_id).toBe("eleven_v4_turbo");
    expect(patch.conversation_config.language_presets.tg.overrides).toEqual({ tts: { voice_id: "manzura" } });
  });

  it("с функциями: инструмент заводится, его id и настройки уходят одной правкой агента", async () => {
    const calls = stubFetch();
    const tool: LiveVoiceFunctionDeclaration = {
      name: "search_properties",
      description: "Поиск",
      parameters: { type: "OBJECT", properties: { district: { type: "STRING", description: "Район" } }, required: [] },
    };
    const ids = await syncElevenLabsAgent("sk_test", "agent_1", [tool]);
    expect(ids.get("search_properties")).toBe("tool_new");
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/agents/"))!.body as Patch;
    expect(patch.conversation_config.agent.prompt.tool_ids).toEqual(["own_tool", "tool_new"]);
    expect(patch.conversation_config.turn.turn_timeout).toBe(5);
  });

  it("сменился таджикский голос — агент готовится заново, тот же голос — из памяти", async () => {
    const calls = stubFetch();
    await ensureElevenLabsAgentReady("sk_test", "agent_1", [], { voiceIdTg: "a" });
    await ensureElevenLabsAgentReady("sk_test", "agent_1", [], { voiceIdTg: "a" });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    await ensureElevenLabsAgentReady("sk_test", "agent_1", [], { voiceIdTg: "b" });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
  });
});
