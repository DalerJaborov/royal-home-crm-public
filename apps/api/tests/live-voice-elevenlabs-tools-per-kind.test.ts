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
  ELEVENLABS_TOOLS_CREATED_ALARM,
  ELEVENLABS_TOOLS_NOT_ATTACHED_WINDOW_MS,
  clearElevenLabsToolOverridePause,
  hasDefaultToolBehavior,
  forgetElevenLabsAgentSync,
  isElevenLabsToolOverridePaused,
  noteElevenLabsToolsNotAttached,
  resetElevenLabsSyncCacheForTests,
  syncElevenLabsAgentDetailed,
  toElevenLabsClientTool,
} = sync;
const { INTERVIEW_INVITE_CALL_TOOLS } = await import("../src/ai/interviewInviteCallPersona.js");
const { POST_SHOWING_CALL_TOOLS } = await import("../src/ai/postShowingCallPersona.js");
const { ElevenLabsVoiceClient, ElevenLabsCallToolsUnavailableError } = await import("../src/ai/elevenLabsVoiceClient.js");
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
  sent: Record<string, any>[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
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

const METADATA = { type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { conversation_id: "c" } };
const NOT_ATTACHED = "Tool IDs not attached to this agent: ['tool_1']";
const tick = () => new Promise((r) => setImmediate(r));

/** Клиент на поддельных сокетах: каждый сокет сам «открывается»; список — в sockets. */
function makeClient(over: Partial<{ signedUrl: () => Promise<string>; paused: boolean; ids: Map<string, string> | null }> = {}) {
  const sockets: FakeSocket[] = [];
  const note = vi.fn(() => "resync" as const);
  const client = new ElevenLabsVoiceClient(
    { apiKey: "sk_test", agentId: "agent_1", voiceIdRu: null, voiceIdTg: null },
    {
      signedUrl: over.signedUrl ?? (async () => "wss://fake"),
      prepareAgent: async () => (over.ids === undefined ? new Map([["end_call", "tool_1"]]) : over.ids),
      noteToolsNotAttached: note,
      toolOverridePaused: () => over.paused ?? false,
      socketFactory: () => {
        const ws = new FakeSocket();
        sockets.push(ws);
        setImmediate(() => ws.open());
        return ws as unknown as WebSocket;
      },
    }
  );
  const closes: { code: number; normal: boolean }[] = [];
  client.on("close", (info: { code: number; normal: boolean }) => closes.push(info));
  const initOf = (ws: FakeSocket) => ws.sent.find((m) => m.type === "conversation_initiation_client_data");
  return { client, sockets, note, closes, initOf };
}
const TOOLS = [endCall(POST_SHOWING_CALL_TOOLS)];

const INBOUND = { systemInstruction: "P", tools: TOOLS, direction: "inbound" } as const;
/** Направление не задано — строгий режим (так зовёт мост сегодня). */
const OUTBOUND = { systemInstruction: "P", tools: TOOLS } as const;

describe("исходящий без своего набора функций не начинается (строгий режим по умолчанию)", () => {
  it.each([
    ["подготовка не удалась", { ids: null }],
    ["подмена на паузе", { paused: true }],
    ["заведены не все функции", { ids: new Map<string, string>() }],
  ])("%s — отказ connect «наш сбой», сокет не открыт", async (_label, over) => {
    const { client, sockets } = makeClient(over as any);
    const err = await client.connect(OUTBOUND as any).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElevenLabsCallToolsUnavailableError);
    expect((err as { ourFault?: boolean }).ourFault).toBe(true);
    expect(sockets).toHaveLength(0);
    client.close();
  });

  it("1008 до метаданных — отказ connect, без повтора с функциями агента", async () => {
    const { client, sockets } = makeClient();
    const connecting = client.connect(OUTBOUND as any);
    await tick();
    await tick();
    sockets[0].closeFromServer(1008, NOT_ATTACHED);
    await expect(connecting).rejects.toBeInstanceOf(ElevenLabsCallToolsUnavailableError);
    expect(sockets).toHaveLength(1);
  });

  it("1008 сразу после метаданных — без повтора, закрытие-сбой наружу", async () => {
    const { client, sockets, closes } = makeClient();
    const connecting = client.connect(OUTBOUND as any);
    await tick();
    await tick();
    sockets[0].server(METADATA);
    await connecting;
    sockets[0].closeFromServer(1008, NOT_ATTACHED);
    await tick();
    await tick();
    expect(sockets).toHaveLength(1);
    expect(closes).toEqual([expect.objectContaining({ code: 1008, normal: false })]);
    client.close();
  });

  it("свой набор подготовлен — исходящий идёт с подменой", async () => {
    const { client, sockets, initOf } = makeClient();
    const connecting = client.connect(OUTBOUND as any);
    await tick();
    await tick();
    sockets[0].server(METADATA);
    await connecting;
    expect(initOf(sockets[0]).conversation_config_override.agent.prompt.tool_ids).toEqual(["tool_1"]);
    client.close();
  });
});

describe("входящий, 1008 «Tool IDs not attached»: этот звонок — повтор без подмены функций", () => {
  it("закрытие сразу после метаданных: новый сокет без tool_ids, служебная реплика повторена, мост закрытия не видит", async () => {
    const { client, sockets, note, closes, initOf } = makeClient();
    const connecting = client.connect(INBOUND as any);
    await tick();
    await tick();
    sockets[0].server(METADATA);
    await connecting;
    expect(initOf(sockets[0]).conversation_config_override.agent.prompt.tool_ids).toEqual(["tool_1"]);
    client.sendText("(Собеседник снял трубку.)");
    sockets[0].closeFromServer(1008, NOT_ATTACHED);
    await tick();
    await tick();
    expect(sockets).toHaveLength(2);
    sockets[1].server(METADATA);
    await tick();
    expect(initOf(sockets[1]).conversation_config_override.agent.prompt).not.toHaveProperty("tool_ids");
    expect(sockets[1].sent.some((m) => m.type === "user_message" && m.text === "(Собеседник снял трубку.)")).toBe(true);
    expect(note).toHaveBeenCalledTimes(1);
    expect(closes).toEqual([]);
    // Второй 1008 в этом звонке не повторяется — закрытие уходит наружу сбоем.
    sockets[1].closeFromServer(1006, "");
    expect(closes).toEqual([expect.objectContaining({ code: 1006, normal: false })]);
    client.close();
  });

  it("закрытие до метаданных: connect сам повторяет без tool_ids и подключается", async () => {
    const { client, sockets, note, initOf } = makeClient();
    const connecting = client.connect(INBOUND as any);
    await tick();
    await tick();
    sockets[0].closeFromServer(1008, NOT_ATTACHED);
    await tick();
    await tick();
    sockets[1].server(METADATA);
    await connecting;
    expect(initOf(sockets[1]).conversation_config_override.agent.prompt).not.toHaveProperty("tool_ids");
    expect(note).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("повтор не открылся — закрытие-сбой наружу (мост заканчивает звонок как обычно)", async () => {
    let urls = 0;
    const { client, sockets, closes } = makeClient({
      signedUrl: async () => {
        if (++urls > 1) throw new Error("нет сети");
        return "wss://fake";
      },
    });
    const connecting = client.connect(INBOUND as any);
    await tick();
    await tick();
    sockets[0].server(METADATA);
    await connecting;
    sockets[0].closeFromServer(1008, NOT_ATTACHED);
    await vi.waitFor(() => expect(closes).toEqual([expect.objectContaining({ code: 1008, normal: false })]));
    client.close();
  });

  it("агент уже говорил — повтора нет, закрытие наружу", async () => {
    const { client, sockets, closes } = makeClient();
    const connecting = client.connect(INBOUND as any);
    await tick();
    await tick();
    sockets[0].server(METADATA);
    await connecting;
    sockets[0].server({ type: "audio", audio_event: { audio_base_64: Buffer.from([1, 2, 3, 4]).toString("base64"), event_id: 1 } });
    sockets[0].closeFromServer(1008, NOT_ATTACHED);
    await tick();
    expect(sockets).toHaveLength(1);
    expect(closes).toHaveLength(1);
    client.close();
  });

  it("подмена на паузе — разговор без tool_ids, хотя функции подготовлены", async () => {
    const { client, sockets, initOf } = makeClient({ paused: true });
    const connecting = client.connect(INBOUND as any);
    await tick();
    await tick();
    sockets[0].server(METADATA);
    await connecting;
    expect(initOf(sockets[0]).conversation_config_override.agent.prompt).not.toHaveProperty("tool_ids");
    client.close();
  });

  it("обычное закрытие 1000 после разговора — без повтора и без отметки 1008", async () => {
    const { client, sockets, note, closes } = makeClient({ ids: null });
    const connecting = client.connect({ systemInstruction: "P", tools: [] } as any);
    await tick();
    await tick();
    sockets[0].server(METADATA);
    await connecting;
    sockets[0].closeFromServer(1000, "");
    expect(note).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    expect(closes).toHaveLength(1);
    client.close();
  });
});

describe("1008 повторяется — пауза подмены функций, одна тревога", () => {
  let now = 1_800_000_000_000;
  beforeEach(() => {
    logged.messages.length = 0;
    resetElevenLabsSyncCacheForTests();
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetElevenLabsSyncCacheForTests();
  });

  it("первый раз — переподготовка; второй за окно — пауза и тревога; после паузы — снова переподготовка", () => {
    expect(noteElevenLabsToolsNotAttached("agent_1")).toBe("resync");
    expect(isElevenLabsToolOverridePaused("agent_1")).toBe(false);
    now += 60_000;
    expect(noteElevenLabsToolsNotAttached("agent_1")).toBe("paused");
    expect(isElevenLabsToolOverridePaused("agent_1")).toBe(true);
    expect(logged.messages.filter((m) => m.key === "elevenlabs-tools-override-paused")).toHaveLength(1);
    // Другой агент паузу не делит.
    expect(isElevenLabsToolOverridePaused("agent_2")).toBe(false);
    now += ELEVENLABS_TOOLS_NOT_ATTACHED_WINDOW_MS + 1;
    expect(isElevenLabsToolOverridePaused("agent_1")).toBe(false);
    now += ELEVENLABS_TOOLS_NOT_ATTACHED_WINDOW_MS + 1;
    expect(noteElevenLabsToolsNotAttached("agent_1")).toBe("resync");
  });
});

describe("сверка после PATCH и очередь подготовок (fetch подменён)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetElevenLabsSyncCacheForTests();
  });

  it("агент ответил 200, но наших id в tool_ids нет — подготовка не готова, звонок без подмены (null)", async () => {
    const srv = fakeElevenLabs();
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const res = await srv.fetchImpl(url, init);
      // Сервис «принял» PATCH, но функции не сохранил (живой случай: функции на другой ветке агента).
      if (init.method === "PATCH") srv.agent.conversation_config.agent.prompt.tool_ids = [];
      return res;
    });
    vi.stubGlobal("fetch", fetchImpl);
    await expect(syncElevenLabsAgentDetailed("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS)).rejects.toThrow(/не сохранил наши функции/);
    expect(await ensureElevenLabsAgentReady("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS)).toBeNull();
  });

  it("кнопка «Проверить агента» и звонок разом, разные наборы: у агента оба набора, функций без дублей", async () => {
    const { CONSULTANT_TOOLS } = await import("../src/lib/telephony/liveVoiceConsultant.js");
    const srv = fakeElevenLabs();
    vi.stubGlobal("fetch", srv.fetchImpl);
    const [button, call, again] = await Promise.all([
      syncElevenLabsAgentDetailed("sk_test", "agent_1", CONSULTANT_TOOLS),
      ensureElevenLabsAgentReady("sk_test", "agent_1", INTERVIEW_INVITE_CALL_TOOLS),
      ensureElevenLabsAgentReady("sk_test", "agent_1", CONSULTANT_TOOLS),
    ]);
    const attached = srv.agent.conversation_config.agent.prompt.tool_ids as string[];
    for (const id of [...button.ids.values(), ...call!.values(), ...again!.values()]) expect(attached).toContain(id);
    const distinct = new Set([...CONSULTANT_TOOLS, ...INTERVIEW_INVITE_CALL_TOOLS].map((t) => elevenLabsToolContentKey(toElevenLabsClientTool(t))));
    expect(srv.tools).toHaveLength(distinct.size);
    expect(new Set(attached).size).toBe(attached.length);
  });
});

const REPO = path.join(SRC, "..", "..", "..");
const SCRIPTS = path.join(REPO, "scripts", "elevenlabs");
const sourceFiles = () => [
  ...walk(SRC),
  ...readdirSync(SCRIPTS)
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .map((f) => path.join(SCRIPTS, f)),
];
/** Окно из соседних строк: метод и путь часто стоят в разных строках одного вызова. */
function nearby(text: string, index: number, span = 300): string {
  return text.slice(Math.max(0, index - span), index + span);
}

describe("сторожа переходного периода: правка общих функций аккаунта и запись агента — только одной дверью", () => {
  it("нигде в apps/api/src и scripts/elevenlabs нет PATCH на /convai/tools (функции общие на аккаунт)", () => {
    const bad: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/convai\/tools\//g)) {
        if (/["'`]PATCH["'`]/.test(nearby(text, m.index!))) bad.push(path.relative(REPO, file).replace(/\\/g, "/"));
      }
    }
    expect([...new Set(bad)], "функции правятся по месту — заводите новую по содержимому (elevenLabsToolContentKey)").toEqual([]);
  });

  it("запись агента и функций ElevenLabs в apps/api/src — только в ai/elevenLabsAgentSync.ts, и только через очередь агента", () => {
    const bad: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      if (rel === "ai/elevenLabsAgentSync.ts") continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/convai\/(agents|tools)/g)) {
        if (/["'`](PATCH|POST|DELETE)["'`]/.test(nearby(text, m.index!))) bad.push(rel);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
    const syncSrc = readFileSync(path.join(SRC, "ai", "elevenLabsAgentSync.ts"), "utf8");
    const calls = syncSrc.split("\n").filter((l) => /syncElevenLabsAgentNow\(/.test(l) && !/async function syncElevenLabsAgentNow/.test(l));
    expect(calls.length, "подготовка агента вызывается мимо очереди").toBeGreaterThan(0);
    for (const line of calls) expect(line).toMatch(/serializePerAgent\(/);
  });

  it("каждый набор функций звонка несёт end_call (встроенный выключен — иначе трубку не положит никто)", async () => {
    const { CONSULTANT_TOOLS } = await import("../src/lib/telephony/liveVoiceConsultant.js");
    const { SELLER_PROBE_CALL_TOOLS } = await import("../src/ai/sellerProbeCallPersona.js");
    for (const [label, set] of Object.entries({ CONSULTANT_TOOLS, POST_SHOWING_CALL_TOOLS, INTERVIEW_INVITE_CALL_TOOLS, SELLER_PROBE_CALL_TOOLS })) {
      expect(set.map((t) => t.name), label).toContain("end_call");
    }
    // Набор исходящего звонка в мосту не экспортирован — по исходнику: END_CALL_TOOL внутри LIVE_VOICE_TOOLS.
    const bridge = readFileSync(path.join(SRC, "lib", "telephony", "liveVoiceBridge.ts"), "utf8");
    const block = /const LIVE_VOICE_TOOLS: LiveVoiceFunctionDeclaration\[\] = \[([\s\S]*?)\n\];/.exec(bridge)?.[1] ?? "";
    expect(block, "LIVE_VOICE_TOOLS не найден в мосту").not.toBe("");
    expect(block).toMatch(/\bEND_CALL_TOOL\b/);
    expect(bridge).toMatch(/const END_CALL_TOOL: LiveVoiceFunctionDeclaration = \{\s*name: "end_call"/);
  });
});

describe("содержимое функции: поля, которых мы не задаём, в ключ не входят (повторное ревью 11.11)", () => {
  const ours = () => toElevenLabsClientTool(endCall(POST_SHOWING_CALL_TOOLS)) as any;
  afterEach(() => {
    vi.unstubAllGlobals();
    resetElevenLabsSyncCacheForTests();
  });

  it("сервис сменил умолчания (pre_tool_speech, execution_mode…) — ключ тот же, новых функций не заводится", async () => {
    resetElevenLabsSyncCacheForTests();
    const srv = fakeElevenLabs();
    vi.stubGlobal("fetch", srv.fetchImpl);
    await ensureElevenLabsAgentReady("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS);
    const n = srv.tools.length;
    for (const t of srv.tools) Object.assign(t.tool_config, { pre_tool_speech: "off", execution_mode: "async", interruption_mode: "none" });
    resetElevenLabsSyncCacheForTests();
    await ensureElevenLabsAgentReady("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS);
    expect(srv.tools.length).toBe(n);
  });

  it("из двух одинаковых по нашим полям берётся не поправленная в кабинете", async () => {
    resetElevenLabsSyncCacheForTests();
    const srv = fakeElevenLabs();
    vi.stubGlobal("fetch", srv.fetchImpl);
    const edited = { ...asServerStores(ours()), disable_interruptions: true };
    srv.tools.push({ id: "tool_edited", tool_config: edited }, { id: "tool_clean", tool_config: asServerStores(ours()) });
    const ids = await ensureElevenLabsAgentReady("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS);
    expect(ids!.get("end_call")).toBe("tool_clean");
    expect(hasDefaultToolBehavior(edited)).toBe(false);
    expect(hasDefaultToolBehavior(asServerStores(ours()))).toBe(true);
    const constant = asServerStores(ours()) as any;
    constant.parameters.properties.reason = { ...constant.parameters.properties.reason, constant_value: "answered" };
    expect(hasDefaultToolBehavior(constant)).toBe(false);
  });

  it("больше ELEVENLABS_TOOLS_CREATED_ALARM новых функций за подготовку — одна тревога", async () => {
    resetElevenLabsSyncCacheForTests();
    logged.messages.length = 0;
    const srv = fakeElevenLabs();
    vi.stubGlobal("fetch", srv.fetchImpl);
    const many = Array.from({ length: ELEVENLABS_TOOLS_CREATED_ALARM + 1 }, (_, i) => ({ ...endCall(POST_SHOWING_CALL_TOOLS), name: `t_${i}` }));
    await ensureElevenLabsAgentReady("sk_test", "agent_1", many.slice(0, ELEVENLABS_TOOLS_CREATED_ALARM));
    expect(logged.messages.some((m) => m.key === "elevenlabs-tools-created-many")).toBe(false);
    await ensureElevenLabsAgentReady("sk_test", "agent_2", many.map((d) => ({ ...d, description: d.description + " v2" })));
    expect(logged.messages.filter((m) => m.key === "elevenlabs-tools-created-many")).toHaveLength(1);
  });
});

describe("пауза подмены снимается удачной сверкой и общим сбросом", () => {
  let now = 1_800_000_000_000;
  beforeEach(() => {
    resetElevenLabsSyncCacheForTests();
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetElevenLabsSyncCacheForTests();
  });

  it("кнопка «Проверить агента» (удачная подготовка со сверкой tool_ids) снимает паузу сразу", async () => {
    noteElevenLabsToolsNotAttached("agent_1");
    now += 1000;
    expect(noteElevenLabsToolsNotAttached("agent_1")).toBe("paused");
    const srv = fakeElevenLabs();
    vi.stubGlobal("fetch", srv.fetchImpl);
    await syncElevenLabsAgentDetailed("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS);
    expect(isElevenLabsToolOverridePaused("agent_1")).toBe(false);
    // Счётчик 1008 не сброшен: следующий 1008 в окне — снова пауза, а не круг переподготовок.
    now += 1000;
    expect(noteElevenLabsToolsNotAttached("agent_1")).toBe("paused");
  });

  it("сверка не прошла — пауза остаётся", async () => {
    noteElevenLabsToolsNotAttached("agent_1");
    noteElevenLabsToolsNotAttached("agent_1");
    const srv = fakeElevenLabs();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const res = await srv.fetchImpl(url, init);
        if (init.method === "PATCH") srv.agent.conversation_config.agent.prompt.tool_ids = [];
        return res;
      })
    );
    await expect(syncElevenLabsAgentDetailed("sk_test", "agent_1", POST_SHOWING_CALL_TOOLS)).rejects.toThrow();
    expect(isElevenLabsToolOverridePaused("agent_1")).toBe(true);
  });

  it("clearElevenLabsToolOverridePause (П1: resetLiveVoiceProviderHolds): по агенту и для всех", () => {
    for (const a of ["agent_1", "agent_2"]) {
      noteElevenLabsToolsNotAttached(a);
      noteElevenLabsToolsNotAttached(a);
    }
    clearElevenLabsToolOverridePause("agent_1");
    expect(isElevenLabsToolOverridePaused("agent_1")).toBe(false);
    expect(isElevenLabsToolOverridePaused("agent_2")).toBe(true);
    expect(noteElevenLabsToolsNotAttached("agent_1")).toBe("resync");
    clearElevenLabsToolOverridePause();
    expect(isElevenLabsToolOverridePaused("agent_2")).toBe(false);
  });
});
