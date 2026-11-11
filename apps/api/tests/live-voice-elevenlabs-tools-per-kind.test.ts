import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

/**
 * У КАЖДОГО ВИДА ЗВОНКА — СВОИ ФУНКЦИИ (11.11.2026, пачка П2 робозвонка).
 *
 * Было: функции ElevenLabs искались по ИМЕНИ и правились PATCH-ем. У приглашения
 * кандидата и опроса после показа одно имя end_call, но разные слова причины, — кто
 * готовился последним, тот и отдавал агенту своё описание; кеш подготовки потом
 * держал id, но содержимое функции уже было чужим. Стало: функция заводится по
 * содержимому (имя + описание + параметры), существующие не правятся.
 *
 * Сеть подменена: поддельный сервис хранит функции и, как настоящий (замер 11.11),
 * отдаёт tool_config шире отправленного (enum: null, служебные поля).
 */

const logged = vi.hoisted(() => ({ messages: [] as { key?: string; text: string }[] }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async (_source: string, message: string, opts?: { dedupKey?: string }) => {
    logged.messages.push({ key: opts?.dedupKey, text: String(message) });
  },
}));

const sync = await import("../src/ai/elevenLabsAgentSync.js");
const {
  ELEVENLABS_AGENT_CRM_POLICY,
  buildAgentPrivacyPatch,
  buildAgentSyncPatch,
  buildAgentTuningPatch,
  elevenLabsToolContentKey,
  ensureElevenLabsAgentReady,
  forgetElevenLabsAgentSync,
  resetElevenLabsSyncCacheForTests,
  syncElevenLabsAgentDetailed,
  toElevenLabsClientTool,
} = sync;
const { INTERVIEW_INVITE_CALL_TOOLS } = await import("../src/ai/interviewInviteCallPersona.js");
const { POST_SHOWING_CALL_TOOLS } = await import("../src/ai/postShowingCallPersona.js");
const { ElevenLabsVoiceClient } = await import("../src/ai/elevenLabsVoiceClient.js");
import type { LiveVoiceFunctionDeclaration } from "../src/ai/liveVoiceClient.js";

type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, any> | undefined };

/** Так сервис хранит функцию: шире отправленного (замер GET /v1/convai/tools 11.11.2026). */
function asServerStores(cfg: Record<string, any>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [k, p] of Object.entries<Record<string, any>>(cfg.parameters?.properties ?? {})) {
    properties[k] = { enum: null, is_system_provided: false, dynamic_variable: "", allowed_values: null, ...p };
  }
  return {
    disable_interruptions: false,
    execution_mode: "immediate",
    tool_call_sound: null,
    ...cfg,
    parameters: { description: "", is_omitted: false, ...cfg.parameters, required: [...(cfg.parameters?.required ?? [])].reverse(), properties },
  };
}

function fakeElevenLabs(opts: { pageSize?: number } = {}) {
  const calls: Call[] = [];
  const tools: { id: string; tool_config: Record<string, unknown> }[] = [];
  const agent: Record<string, any> = {
    conversation_config: {
      agent: {
        prompt: {
          prompt: "кабинет",
          llm: "gemini-3.8-flash",
          tool_ids: [],
          built_in_tools: { end_call: { type: "system", name: "end_call", params: { system_tool_type: "end_call" } } },
        },
      },
    },
    platform_settings: { privacy: { record_voice: true, retention_days: -1, delete_audio: false }, overrides: {} },
  };
  let n = 0;
  const pageSize = opts.pageSize ?? 100;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(String(url));
    const call: Call = { method: String(init.method), path: u.pathname, query: u.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    let json: unknown = {};
    if (call.path === "/v1/convai/tools" && call.method === "GET") {
      const start = Number(u.searchParams.get("cursor") ?? 0);
      const page = tools.slice(start, start + pageSize);
      const more = start + pageSize < tools.length;
      json = { tools: page, has_more: more, next_cursor: more ? String(start + pageSize) : null };
    } else if (call.path === "/v1/convai/tools" && call.method === "POST") {
      const id = `tool_${++n}`;
      tools.push({ id, tool_config: asServerStores(call.body!.tool_config) });
      json = { id };
    } else if (call.path.startsWith("/v1/convai/agents/") && call.method === "GET") {
      json = JSON.parse(JSON.stringify(agent));
    } else if (call.path.startsWith("/v1/convai/agents/") && call.method === "PATCH") {
      const ids = call.body?.conversation_config?.agent?.prompt?.tool_ids;
      if (Array.isArray(ids)) agent.conversation_config.agent.prompt.tool_ids = ids;
    } else {
      return new Response(JSON.stringify({ detail: "нет такого пути в подделке" }), { status: 404 });
    }
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  });
  const contentOf = (id: string) => tools.find((t) => t.id === id)?.tool_config;
  return { calls, tools, agent, fetchImpl, contentOf };
}

const endCall = (set: LiveVoiceFunctionDeclaration[]) => set.find((t) => t.name === "end_call")!;

describe("содержимое функции: проекция на наши поля", () => {
  it("строка из списка сервиса (enum: null, служебные поля, другой порядок required) — тот же ключ, что у нашего объявления", () => {
    for (const decl of [...POST_SHOWING_CALL_TOOLS, ...INTERVIEW_INVITE_CALL_TOOLS]) {
      const ours = toElevenLabsClientTool(decl);
      expect(elevenLabsToolContentKey(asServerStores(ours))).toBe(elevenLabsToolContentKey(ours));
    }
  });

  it("одно имя, разное описание или параметры — разные ключи; имя в ключе видно", () => {
    const invite = toElevenLabsClientTool(endCall(INTERVIEW_INVITE_CALL_TOOLS));
    const post = toElevenLabsClientTool(endCall(POST_SHOWING_CALL_TOOLS));
    expect(elevenLabsToolContentKey(invite)).not.toBe(elevenLabsToolContentKey(post));
    expect(elevenLabsToolContentKey(invite)).toMatch(/^end_call:[0-9a-f]{16}$/);
    expect(elevenLabsToolContentKey({ ...post, description: post.description + " " })).not.toBe(elevenLabsToolContentKey(post));
  });

  it("не клиентская функция (встроенная, webhook) ключа не получает", () => {
    expect(elevenLabsToolContentKey({ type: "system", name: "end_call" })).toBeNull();
    expect(elevenLabsToolContentKey({ type: "webhook", name: "x" })).toBeNull();
  });
});

describe("подготовка по сети (fetch подменён)", () => {
  let srv: ReturnType<typeof fakeElevenLabs>;
  beforeEach(() => {
    logged.messages.length = 0;
    resetElevenLabsSyncCacheForTests();
    srv = fakeElevenLabs();
    vi.stubGlobal("fetch", srv.fetchImpl);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetElevenLabsSyncCacheForTests();
  });

  it("приглашение → опрос → приглашение: у приглашения его же end_call, у опроса свой; функции не правятся", async () => {
    const invite1 = await ensureElevenLabsAgentReady("sk_test", "agent_1", INTERVIEW_INVITE_CALL_TOOLS);
    const post = await ensureElevenLabsAgentReady("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS);
    const invite2 = await ensureElevenLabsAgentReady("sk_test", "agent_1", INTERVIEW_INVITE_CALL_TOOLS);
    expect(invite1!.get("end_call")).not.toBe(post!.get("end_call"));
    expect(invite2!.get("end_call")).toBe(invite1!.get("end_call"));
    // То, что хранится у сервиса под id приглашения, — описание приглашения, а не того, кто готовился последним.
    expect(elevenLabsToolContentKey(srv.contentOf(invite2!.get("end_call")!))).toBe(
      elevenLabsToolContentKey(toElevenLabsClientTool(endCall(INTERVIEW_INVITE_CALL_TOOLS)))
    );
    expect(elevenLabsToolContentKey(srv.contentOf(post!.get("end_call")!))).toBe(
      elevenLabsToolContentKey(toElevenLabsClientTool(endCall(POST_SHOWING_CALL_TOOLS)))
    );
    // Одинаковые у обоих наборов функции — один id, не две копии.
    expect(post!.get("save_contact") ?? null).toBe(invite1!.get("save_contact") ?? null);
    expect(srv.calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/v1/convai/tools/"))).toHaveLength(0);
    // К агенту прикреплены ОБА end_call: подмена на разговор принимает только прикреплённые (1008, замер 11.11).
    expect(srv.agent.conversation_config.agent.prompt.tool_ids).toEqual(expect.arrayContaining([invite1!.get("end_call"), post!.get("end_call")]));
  });

  it("после перезапуска (кеш пуст) — те же id из списка сервиса, ни одной новой функции", async () => {
    const first = await ensureElevenLabsAgentReady("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS);
    const created = srv.tools.length;
    resetElevenLabsSyncCacheForTests();
    const again = await ensureElevenLabsAgentReady("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS);
    expect(again).toEqual(first);
    expect(srv.tools.length).toBe(created);
  });

  it("список функций читается постранично (has_more / next_cursor), дублей не заводится", async () => {
    srv = fakeElevenLabs({ pageSize: 2 });
    vi.stubGlobal("fetch", srv.fetchImpl);
    const five = [1, 2, 3, 4, 5].map((i) => ({ ...endCall(POST_SHOWING_CALL_TOOLS), name: `tool_${i}` }));
    await ensureElevenLabsAgentReady("sk_test", "agent_1", five);
    const created = srv.tools.length;
    expect(created).toBe(5);
    resetElevenLabsSyncCacheForTests();
    await ensureElevenLabsAgentReady("sk_test", "agent_1", five);
    expect(srv.tools.length).toBe(created);
    const lists = srv.calls.filter((c) => c.method === "GET" && c.path === "/v1/convai/tools");
    expect(lists.some((c) => c.query.get("cursor"))).toBe(true);
    expect(lists.every((c) => c.query.get("types") === "client" && c.query.get("page_size") === "100")).toBe(true);
  });

  it("два вида звонка готовятся разом: агент получает функции обоих (очередь на агента, id не затираются)", async () => {
    const [a, b] = await Promise.all([
      syncElevenLabsAgentDetailed("sk_test", "agent_1", INTERVIEW_INVITE_CALL_TOOLS),
      syncElevenLabsAgentDetailed("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS),
    ]);
    const attached = srv.agent.conversation_config.agent.prompt.tool_ids as string[];
    for (const id of [...a.ids.values(), ...b.ids.values()]) expect(attached).toContain(id);
  });

  it("одинаковое имя дважды в одном наборе — отказ подготовки, а не молча потерянная функция", async () => {
    const twice = [endCall(POST_SHOWING_CALL_TOOLS), endCall(INTERVIEW_INVITE_CALL_TOOLS)];
    await expect(syncElevenLabsAgentDetailed("sk_test", "agent_1", twice)).rejects.toThrow(/end_call повторяется/);
  });

  it("оба PATCH агента: встроенный end_call выключен, хранение 30 дней", async () => {
    await syncElevenLabsAgentDetailed("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS);
    const patches = srv.calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/v1/convai/agents/"));
    expect(patches).toHaveLength(2);
    for (const p of patches) expect(p.body!.conversation_config.agent.prompt.built_in_tools.end_call).toBeNull();
    expect(patches[0].body!.platform_settings.privacy).toEqual({ record_voice: true, delete_audio: false, retention_days: 30 });
  });

  it("забыть подготовку агента: следующий звонок готовит заново", async () => {
    await ensureElevenLabsAgentReady("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS);
    const n = srv.calls.length;
    await ensureElevenLabsAgentReady("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS);
    expect(srv.calls.length).toBe(n);
    forgetElevenLabsAgentSync("agent_1");
    await ensureElevenLabsAgentReady("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS);
    expect(srv.calls.length).toBeGreaterThan(n);
  });
});

describe("политика CRM на агенте", () => {
  it("срок хранения: -1 и больше 30 → 30; меньший срок владельца не удлиняется", () => {
    expect(ELEVENLABS_AGENT_CRM_POLICY.retentionDays).toBe(30);
    expect(buildAgentPrivacyPatch({}).retention_days).toBe(30);
    expect(buildAgentPrivacyPatch({ platform_settings: { privacy: { retention_days: -1 } } }).retention_days).toBe(30);
    expect(buildAgentPrivacyPatch({ platform_settings: { privacy: { retention_days: 730 } } }).retention_days).toBe(30);
    expect(buildAgentPrivacyPatch({ platform_settings: { privacy: { retention_days: 7 } } }).retention_days).toBe(7);
  });

  it("прочитанный privacy целиком назад не уходит — только простые флаги и срок", () => {
    const patch = buildAgentPrivacyPatch({
      platform_settings: { privacy: { record_voice: false, retention_days: 10, user_memory: { enabled: false }, conversation_history_redaction: {} } },
    });
    expect(patch).toEqual({ record_voice: false, retention_days: 10 });
  });

  it("встроенный end_call выключен в обоих PATCH даже без built_in_tools у агента", () => {
    const first = buildAgentSyncPatch({}, ["t"]) as any;
    const second = buildAgentTuningPatch({}, ["t"]) as any;
    expect(first.conversation_config.agent.prompt.built_in_tools).toEqual({ end_call: null });
    expect(second.conversation_config.agent.prompt.built_in_tools.end_call).toBeNull();
    expect(second.conversation_config.agent.prompt.built_in_tools.language_detection).toBeTruthy();
  });
});

/**
 * СТОРОЖ: все наборы функций живого голоса находятся сами — по исходникам, без списка руками.
 * Каждый экспортированный набор (массив объявлений или одно объявление) прогоняется через
 * подготовку; у одного id не может оказаться двух разных содержимых.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
/** Наборы, которые сторож не может импортировать (не экспортированы), — с причиной. */
const NOT_EXPORTED_WITH_REASON: Record<string, string> = {
  "lib/telephony/liveVoiceBridge.ts:LIVE_VOICE_TOOLS":
    "набор исходящего звонка, мост ведёт пачка П1; механизм (ключ по содержимому) от набора не зависит — см. тест с синтетическим двойником",
  "lib/telephony/liveVoiceBridge.ts:END_CALL_TOOL": "входит в LIVE_VOICE_TOOLS",
  "lib/telephony/liveVoiceBridge.ts:ESCALATE_TO_HUMAN_TOOL": "входит в LIVE_VOICE_TOOLS",
  "lib/telephony/liveVoiceConsultant.ts:ESCALATE_AND_END": "входит в экспортированный CONSULTANT_TOOLS",
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []
  );
}

const isDecl = (v: unknown): v is LiveVoiceFunctionDeclaration =>
  !!v && typeof v === "object" && typeof (v as any).name === "string" && typeof (v as any).description === "string" && (v as any).parameters?.type === "OBJECT";

async function discoverToolSets(): Promise<{ label: string; tools: LiveVoiceFunctionDeclaration[] }[]> {
  const files = walk(SRC).filter((f) => /LiveVoiceFunctionDeclaration(\[\])?\s*=/.test(readFileSync(f, "utf8")));
  const sets: { label: string; tools: LiveVoiceFunctionDeclaration[] }[] = [];
  for (const file of files) {
    const rel = path.relative(SRC, file).replace(/\\/g, "/");
    const mod = await import(pathToFileURL(file).href);
    for (const [name, value] of Object.entries(mod)) {
      if (Array.isArray(value) && value.length > 0 && value.every(isDecl)) sets.push({ label: `${rel}:${name}`, tools: value });
      else if (isDecl(value)) sets.push({ label: `${rel}:${name}`, tools: [value] });
    }
  }
  return sets;
}

/** Содержимое объявления без кода сервера: имя, описание, параметры как есть. */
const independentContent = (d: LiveVoiceFunctionDeclaration) =>
  JSON.stringify([d.name, d.description, Object.entries(d.parameters.properties).sort(([a], [b]) => a.localeCompare(b)), [...(d.parameters.required ?? [])].sort()]);

/** Хранимая у сервиса функция совпадает с объявлением по описанию и каждому параметру. */
function storedMatches(stored: Record<string, any> | undefined, d: LiveVoiceFunctionDeclaration): boolean {
  if (!stored || stored.name !== d.name || stored.description !== d.description) return false;
  const props = stored.parameters?.properties ?? {};
  if (Object.keys(props).length !== Object.keys(d.parameters.properties).length) return false;
  return Object.entries(d.parameters.properties).every(
    ([k, p]) => props[k]?.description === p.description && JSON.stringify(props[k]?.enum ?? null) === JSON.stringify(p.enum ?? null)
  );
}

describe("сторож: одно имя с разным описанием не получает один id ни в одном наборе", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetElevenLabsSyncCacheForTests();
  });

  it("каждый объявленный набор функций либо экспортирован, либо записан в исключения с причиной", () => {
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      for (const m of readFileSync(file, "utf8").matchAll(/^const (\w+)\s*:\s*LiveVoiceFunctionDeclaration(\[\])?\s*=/gm)) {
        if (!NOT_EXPORTED_WITH_REASON[`${rel}:${m[1]}`]) missing.push(`${rel}:${m[1]}`);
      }
    }
    expect(missing, "новый набор функций не экспортирован — экспортируйте его, чтобы сторож его видел").toEqual([]);
  });

  it("все найденные наборы: имена в наборе не повторяются, у одного id одно содержимое", async () => {
    const sets = await discoverToolSets();
    const labels = sets.map((s) => s.label);
    // Найдены сами, без списка: если какой-то из них пропал, сломалось обнаружение.
    for (const known of [
      "ai/postShowingCallPersona.ts:POST_SHOWING_CALL_TOOLS",
      "ai/interviewInviteCallPersona.ts:INTERVIEW_INVITE_CALL_TOOLS",
      "lib/telephony/liveVoiceConsultant.ts:CONSULTANT_TOOLS",
    ]) {
      expect(labels).toContain(known);
    }
    const srv = fakeElevenLabs();
    vi.stubGlobal("fetch", srv.fetchImpl);
    const contentById = new Map<string, { key: string; label: string }>();
    const conflicts: string[] = [];
    for (const set of sets) {
      const names = set.tools.map((t) => t.name);
      expect(new Set(names).size, `${set.label}: имена повторяются`).toBe(names.length);
      const ids = await ensureElevenLabsAgentReady("sk_test", "agent_1", set.tools);
      expect(ids, `${set.label}: подготовка не удалась`).not.toBeNull();
      for (const decl of set.tools) {
        const id = ids!.get(decl.name)!;
        // Содержимое меряется здесь же, НЕ ключом из кода: сломанный ключ (например, только имя)
        // иначе сам себя и проверял бы — сторож был зелёным при нарочной поломке 11.11.2026.
        const key = independentContent(decl);
        const prev = contentById.get(id);
        if (prev && prev.key !== key) conflicts.push(`${decl.name}: ${prev.label} и ${set.label} — один id ${id}`);
        else if (!prev) contentById.set(id, { key, label: set.label });
        // И то, что хранится под этим id у сервиса, — содержимое этого набора.
        expect(storedMatches(srv.contentOf(id), decl), `${set.label}: ${decl.name} хранится с чужим содержимым`).toBe(true);
      }
    }
    expect(conflicts).toEqual([]);
  });

  it("синтетический двойник: одно имя, разное описание в двух наборах — разные id (механизм, а не данные)", async () => {
    const srv = fakeElevenLabs();
    vi.stubGlobal("fetch", srv.fetchImpl);
    const base = endCall(POST_SHOWING_CALL_TOOLS);
    const a = await ensureElevenLabsAgentReady("sk_test", "agent_1", [{ ...base, description: "вид А" }]);
    const b = await ensureElevenLabsAgentReady("sk_test", "agent_1", [{ ...base, description: "вид Б" }]);
    expect(a!.get("end_call")).not.toBe(b!.get("end_call"));
  });
});

class FakeSocket extends EventEmitter {
  readyState = 0;
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  server(msg: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
  closeFromServer(code: number, reason: string): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
}

describe("разговор закрыт 1008 «Tool IDs not attached» — память подготовки сбрасывается", () => {
  it.each([
    ["после метаданных (так закрывает ElevenLabs, замер 11.11)", true],
    ["до метаданных", false],
  ])("%s", async (_label, afterMetadata) => {
    const forget = vi.fn();
    const ws = new FakeSocket();
    const client = new ElevenLabsVoiceClient(
      { apiKey: "sk_test", agentId: "agent_1", voiceIdRu: null, voiceIdTg: null },
      {
        signedUrl: async () => "wss://fake",
        prepareAgent: async () => new Map([["end_call", "tool_1"]]),
        forgetAgentSync: forget,
        socketFactory: () => {
          setImmediate(() => ws.open());
          return ws as unknown as WebSocket;
        },
      }
    );
    client.on("close", () => {});
    const connecting = client.connect({ systemInstruction: "P", tools: [endCall(POST_SHOWING_CALL_TOOLS)] } as any);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    if (afterMetadata) {
      ws.server({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { conversation_id: "c" } });
      await connecting;
      ws.closeFromServer(1008, "Tool IDs not attached to this agent: ['tool_1']");
    } else {
      ws.closeFromServer(1008, "Tool IDs not attached to this agent: ['tool_1']");
      await expect(connecting).rejects.toThrow();
    }
    expect(forget).toHaveBeenCalledWith("agent_1");
    expect(logged.messages.some((m) => m.key === "elevenlabs-tools-not-attached")).toBe(true);
    client.close();
  });

  it("обычное закрытие 1000 память не трогает", async () => {
    const forget = vi.fn();
    const ws = new FakeSocket();
    const client = new ElevenLabsVoiceClient(
      { apiKey: "sk_test", agentId: "agent_1", voiceIdRu: null, voiceIdTg: null },
      {
        signedUrl: async () => "wss://fake",
        prepareAgent: async () => null,
        forgetAgentSync: forget,
        socketFactory: () => {
          setImmediate(() => ws.open());
          return ws as unknown as WebSocket;
        },
      }
    );
    client.on("close", () => {});
    const connecting = client.connect({ systemInstruction: "P", tools: [] } as any);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    ws.server({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: {} });
    await connecting;
    ws.closeFromServer(1000, "");
    expect(forget).not.toHaveBeenCalled();
    client.close();
  });
});
