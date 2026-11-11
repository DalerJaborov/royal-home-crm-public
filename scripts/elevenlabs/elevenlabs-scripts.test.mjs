#!/usr/bin/env node
// node --test scripts/elevenlabs/elevenlabs-scripts.test.mjs   (входит в npm run test:scripts)
//
// Скрипты проверки ElevenLabs (preflight / patch-check / suite) с подменой fetch: ни одного
// настоящего запроса. Главное, что держит тест: КЛЮЧ НЕ ПЕЧАТАЕТСЯ даже тогда, когда сервис
// эхом вернул его в теле ответа, а сравнение PATCH с ответом GET краснеет на потерянных полях.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collateralLoss, compareSent, makeClient, makePrinter, redact } from "./lib.mjs";
import { runPreflight } from "./preflight.mjs";
import { runPatchCheck } from "./patch-check.mjs";
import { evaluateTranscript, matchExpect, runSuite, toolCallsOf, waitInvocation } from "./suite.mjs";
import { loadAgentSync, loadCrmCallKinds } from "./crm-prompts.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Ключ собран из кусков, чтобы сам файл не выглядел секретом для сторожей.
const KEY = "sk_" + "test" + "0123456789abcdef0123456789abcdef";
const json = (status, body) => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const collect = () => {
  const lines = [];
  return { lines, say: (...p) => lines.push(redact(p.join(" "), KEY)), text: () => lines.join("\n") };
};

// ── lib ────────────────────────────────────────────────────────────────────
test("redact вычищает ключ и всё, похожее на ключ", () => {
  assert.equal(redact(`ключ ${KEY} тут`, KEY), "ключ [ключ] тут");
  assert.ok(!redact("xi-api-key: sk_abcdefgh12345678", "").includes("sk_abcdefgh12345678"));
});

test("compareSent: принято, потеряно, изменено; массивы строк — «содержит»", () => {
  const sent = { a: { b: 1, c: "x", d: ["p", "q"] }, e: { f: true }, g: 1.15 };
  const got = { a: { b: 1, c: "другое", d: ["p", "q", "r"] }, g: "1.15" };
  const r = compareSent(sent, got);
  assert.deepEqual(r.accepted.sort(), ["a.b", "a.d", "g"]);
  assert.deepEqual(r.lost, ["e"]);
  assert.equal(r.changed.length, 1);
  assert.equal(r.changed[0].path, "a.c");
});

test("collateralLoss: замена подобъекта целиком видна, отправленное и служебное не считается", () => {
  const before = { tts: { voice_id: "v", similarity: 0.8 }, turn: { eagerness: "normal", x: 1 }, version_id: "1" };
  const after = { tts: { voice_id: "v" }, turn: { eagerness: "eager", x: 1 }, version_id: "2" };
  const lost = collateralLoss(before, after, { turn: { eagerness: "eager" } });
  assert.deepEqual(lost.map((l) => l.path), ["tts.similarity"]);
});

test("makeClient не бросает на сетевой ошибке и чистит ключ из текста ошибки", async () => {
  const request = makeClient({ apiKey: KEY, fetchImpl: async () => { throw new Error(`boom ${KEY}`); } });
  const r = await request("GET", "/v1/user");
  assert.equal(r.status, null);
  assert.ok(!r.error.includes(KEY));
});

// ── preflight ──────────────────────────────────────────────────────────────
const TUNING = { tts: { model_id: "eleven_v4_turbo" } };
function preflightFetch({ user = json(200, { subscription: { tier: "creator" } }), agent, voice, models } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/user")) return user;
    if (u.includes("/v1/convai/agents/")) return agent ?? json(200, { name: "Робот", conversation_config: { agent: { language: "ru", prompt: { llm: "gemini-2.5-flash", tool_ids: ["a"] } }, tts: { voice_id: "v1" } } });
    if (u.includes("/v1/voices/")) return voice ?? json(200, { name: "Larisa", verified_languages: [{ language: "ru" }, { language: "tg" }] });
    if (u.endsWith("/v1/models")) return models ?? json(200, [{ model_id: "eleven_v4_turbo", languages: [{ language_id: "ru" }, { language_id: "tg" }] }]);
    return json(404, {});
  };
}
const PF_ENV = { ELEVENLABS_API_KEY: KEY, ELEVENLABS_AGENT_ID: "agent_1", ELEVENLABS_VOICE_ID_RU: "v_ru", ELEVENLABS_VOICE_ID_TG: "v_tg" };

test("preflight: всё в порядке — код 0, ключ не в выводе", async () => {
  const c = collect();
  const r = await runPreflight({ env: PF_ENV, fetchImpl: preflightFetch(), tuning: TUNING, say: c.say });
  assert.equal(r.failed, 0);
  assert.match(c.text(), /таджикский у eleven_v4_turbo/);
  assert.ok(!c.text().includes(KEY));
});

test("preflight: ключ не принят (401), агента нет (404), tg у модели нет — три провала, без утечки ключа", async () => {
  const c = collect();
  const r = await runPreflight({
    env: PF_ENV,
    fetchImpl: preflightFetch({
      user: json(401, { detail: { status: "invalid_api_key", message: `bad ${KEY}` } }),
      agent: json(404, { detail: "not found" }),
      models: json(200, [{ model_id: "eleven_v4_turbo", languages: [{ language_id: "ru" }] }]),
    }),
    tuning: TUNING,
    say: c.say,
  });
  assert.equal(r.failed, 3);
  assert.ok(!c.text().includes(KEY));
});

test("preflight: сервис отвечает страницей защиты — понятный провал про страну, дальше не идёт", async () => {
  const c = collect();
  const r = await runPreflight({ env: PF_ENV, fetchImpl: async () => json(403, "<!doctype html><title>Just a moment</title>"), tuning: TUNING, say: c.say });
  assert.equal(r.failed, 1);
  assert.match(c.text(), /не пускает|защиты/);
});

test("preflight: ключ без права user_read — предупреждение, а не провал", async () => {
  const c = collect();
  const r = await runPreflight({ env: PF_ENV, fetchImpl: preflightFetch({ user: json(401, { detail: { status: "missing_permissions" } }) }), tuning: TUNING, say: c.say });
  assert.equal(r.failed, 0);
  assert.match(c.text(), /WARN.*user_read/);
});

test("preflight --dry: сети нет вообще", async () => {
  const c = collect();
  const r = await runPreflight({ env: PF_ENV, flags: new Set(["dry"]), fetchImpl: async () => { throw new Error("сеть запрещена"); }, tuning: TUNING, say: c.say });
  assert.equal(r.failed, 0);
  assert.match(c.text(), /План/);
});

// ── patch-check на подставном сервере ──────────────────────────────────────
function deepMerge(a, b) {
  if (!a || typeof a !== "object" || Array.isArray(a) || !b || typeof b !== "object" || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}
/** mode: merge — глубокое слияние; replace — разделы conversation_config заменяются целиком; strip — поле language_detection отбрасывается. */
function fakeServer(mode) {
  const agent = {
    name: "Тест",
    conversation_config: {
      agent: { prompt: { prompt: "p", llm: "gemini-2.5-flash", tool_ids: [], built_in_tools: { end_call: { name: "end_call" } } }, language: "ru" },
      tts: { voice_id: "v1", similarity_boost: 0.8 },
      asr: { provider: "elevenlabs", quality: "high" },
      turn: { turn_eagerness: "normal", turn_timeout: 7 },
    },
    platform_settings: { overrides: {} },
  };
  let n = 0;
  const calls = [];
  const savedTools = [];
  const fetchImpl = async (url, init) => {
    const u = String(url).replace("https://api.elevenlabs.io", "");
    const method = init?.method || "GET";
    calls.push(`${method} ${u}`);
    const body = init?.body ? JSON.parse(init.body) : null;
    // Функции помнятся, как у настоящего сервиса: повторная подготовка не должна заводить новые.
    if (u === "/v1/convai/tools" && method === "GET") return json(200, { tools: savedTools });
    if (u === "/v1/convai/tools" && method === "POST") {
      const id = `tool_${++n}`;
      savedTools.push({ id, tool_config: body.tool_config });
      return json(200, { id });
    }
    if (u.startsWith("/v1/convai/agents/")) {
      if (method === "GET") return json(200, JSON.parse(JSON.stringify(agent)));
      let patch = body;
      if (mode === "replace" && patch.conversation_config) {
        for (const [k, v] of Object.entries(patch.conversation_config)) agent.conversation_config[k] = v;
        delete patch.conversation_config;
      } else if (mode === "strip") {
        patch = JSON.parse(JSON.stringify(patch));
        delete patch.conversation_config?.agent?.prompt?.built_in_tools?.language_detection;
      }
      const merged = deepMerge(agent, patch);
      Object.assign(agent, merged);
      return json(200, {});
    }
    return json(404, {});
  };
  return { fetchImpl, calls, agent };
}

const FAKE_TOOLS = [{ name: "end_call", description: "d", parameters: { type: "OBJECT", properties: { reason: { type: "STRING", description: "r" } } } }];
const PC_ENV = { ELEVENLABS_API_KEY: KEY, ELEVENLABS_TEST_AGENT_ID: "agent_test", ELEVENLABS_AGENT_ID: "agent_prod", ELEVENLABS_VOICE_ID_TG: "v_tg" };

test("patch-check: сервер сливает глубоко — всё принято, код 0", async () => {
  const sync = await loadAgentSync();
  const srv = fakeServer("merge");
  const c = collect();
  const r = await runPatchCheck({ env: PC_ENV, fetchImpl: srv.fetchImpl, sync, tools: FAKE_TOOLS, say: c.say, writeFiles: false });
  assert.equal(r.failed, 0, c.text());
  assert.equal(r.report.keyFields.every((k) => k.ok), true);
  assert.ok(!c.text().includes(KEY));
});

test("patch-check: сервер заменяет разделы целиком — расхождение: пропали не отправленные поля", async () => {
  const sync = await loadAgentSync();
  const c = collect();
  const r = await runPatchCheck({ env: PC_ENV, fetchImpl: fakeServer("replace").fetchImpl, sync, tools: FAKE_TOOLS, say: c.say, writeFiles: false });
  assert.equal(r.failed, 1);
  const paths = r.report.collateral.map((x) => x.path);
  assert.ok(paths.includes("conversation_config.tts.similarity_boost"), paths.join(","));
  assert.ok(paths.includes("conversation_config.asr.quality"));
});

test("patch-check: сервер молча отбросил language_detection — ключевое поле красное", async () => {
  const sync = await loadAgentSync();
  const c = collect();
  const r = await runPatchCheck({ env: PC_ENV, fetchImpl: fakeServer("strip").fetchImpl, sync, tools: FAKE_TOOLS, say: c.say, writeFiles: false });
  assert.equal(r.failed, 1);
  const bad = r.report.keyFields.filter((k) => !k.ok).map((k) => k.field);
  assert.ok(bad.includes("conversation_config.agent.prompt.built_in_tools.language_detection"), bad.join(","));
});

test("patch-check: PATCH №2 отклонён (422) — провал с причиной, ключ не в выводе", async () => {
  const sync = await loadAgentSync();
  const srv = fakeServer("merge");
  let patches = 0;
  const fetchImpl = async (url, init) => {
    if (init?.method === "PATCH" && String(url).includes("/agents/") && ++patches === 2) return json(422, { detail: [{ loc: ["body", "conversation_config", "turn"], msg: `bad ${KEY}`, type: "x" }] });
    return srv.fetchImpl(url, init);
  };
  const c = collect();
  const r = await runPatchCheck({ env: PC_ENV, fetchImpl, sync, tools: FAKE_TOOLS, say: c.say, writeFiles: false });
  assert.equal(r.failed, 1);
  assert.match(c.text(), /PATCH №2.*422|код 422/);
  assert.ok(!c.text().includes(KEY));
});

test("patch-check: совпадение тестового и боевого агента — отказ ДО любого запроса", async () => {
  const sync = await loadAgentSync();
  let requests = 0;
  const c = collect();
  const r = await runPatchCheck({ env: { ...PC_ENV, ELEVENLABS_TEST_AGENT_ID: "agent_prod" }, fetchImpl: async () => (requests++, json(200, {})), sync, tools: FAKE_TOOLS, say: c.say, writeFiles: false });
  assert.equal(r.failed, 1);
  assert.equal(requests, 0);
});

// ── suite ──────────────────────────────────────────────────────────────────
test("matchExpect: равенство, oneOf, num, present, contains", () => {
  assert.ok(matchExpect("BUY", "buy"));
  assert.ok(matchExpect("answered", { oneOf: ["answered", "refused"] }));
  assert.ok(matchExpect("70000", { num: 70000 }));
  assert.ok(!matchExpect("", { present: true }));
  assert.ok(matchExpect("в Сино", { contains: "сино" }));
});

const agentTurn = (message, calls = []) => ({ role: "agent", message, tool_calls: calls.map(([tool_name, args]) => ({ tool_name, params_as_json: JSON.stringify(args) })) });
const buyScenario = SCENARIOS.find((s) => s.id === "client-buy-full");
const FULL_ARGS = { intent: "buy", district: "Сино", type: "APARTMENT", rooms: 2, budget_max: 70000, currency: "USD", floor: "не первый", market: "NEW_BUILD", timeframe: "до весны" };

test("evaluateTranscript: полная save_client_request проходит", () => {
  const r = evaluateTranscript(buyScenario, [agentTurn("Записала", [["save_client_request", FULL_ARGS]])]);
  assert.deepEqual(r.failures, []);
});
test("evaluateTranscript: неполные поля, «лутфан», запрещённая функция и молчание — красные", () => {
  const partial = evaluateTranscript(buyScenario, [agentTurn("Хорошо", [["save_client_request", { intent: "buy", district: "Сино" }]])]);
  assert.match(partial.failures[0], /поля не те или не заполнены: .*rooms/);
  assert.ok(evaluateTranscript(buyScenario, [agentTurn("Лутфан, скажите", [["save_client_request", FULL_ARGS]])]).failures.some((f) => /лутфан/.test(f)));
  assert.ok(evaluateTranscript(buyScenario, [agentTurn("ок")]).failures.some((f) => /не дошёл до функции/.test(f)));
  const move = SCENARIOS.find((s) => s.id === "client-move-showing");
  assert.ok(evaluateTranscript(move, [agentTurn("Записала", [["book_showing", {}]])]).failures.some((f) => /запрещённую/.test(f)));
  assert.ok(evaluateTranscript(buyScenario, []).failures.some((f) => /ни слова/.test(f)));
});
test("toolCallsOf разбирает params_as_json, битый JSON даёт пустые поля", () => {
  const calls = toolCallsOf([{ role: "agent", tool_calls: [{ tool_name: "x", params_as_json: "{oops" }, { tool_name: "y", params_as_json: '{"a":1}' }] }]);
  assert.deepEqual(calls, [{ name: "x", args: {} }, { name: "y", args: { a: 1 } }]);
});

test("waitInvocation ждёт, пока не уйдёт pending", async () => {
  let n = 0;
  const request = async () => ({ ok: true, json: { test_runs: [{ status: ++n < 3 ? "pending" : "passed" }] } });
  const r = await waitInvocation(request, "inv", { pollMs: 1, limitMs: 100, sleepFn: async () => {} });
  assert.equal(r.invocation.test_runs[0].status, "passed");
  assert.equal(n, 3);
});

test("suite --dry печатает план по всем пяти видам звонков и не ходит в сеть", async () => {
  const kinds = await loadCrmCallKinds();
  const c = collect();
  const r = await runSuite({ env: { ELEVENLABS_API_KEY: KEY }, flags: new Set(["dry"]), fetchImpl: async () => { throw new Error("сеть запрещена"); }, kinds, say: c.say });
  assert.equal(r.failed, 0);
  for (const k of ["invite-ru", "invite-tg", "post-showing", "seller-probe", "consultant", "client"]) assert.match(c.text(), new RegExp(`\\[${k}\\]`));
  assert.ok(!c.text().includes(KEY));
});

test("suite целиком на подставном сервере: сценарий проходит, а другой краснеет на «лутфан»", async () => {
  const sync = await loadAgentSync();
  const kinds = [{ kind: "consultant", label: "Консультант", prompt: "ПРОМПТ", tools: [{ name: "save_client_request", description: "d", parameters: { type: "OBJECT", properties: {} } }] }];
  const created = new Map();
  let nextTest = 0;
  const deleted = [];
  const fetchImpl = async (url, init) => {
    const u = String(url).replace("https://api.elevenlabs.io", "");
    const method = init?.method || "GET";
    if (u === "/v1/convai/tools") return method === "GET" ? json(200, { tools: [] }) : json(200, { id: "tool_1" });
    if (u === "/v1/convai/agent-testing/create") {
      const id = `t${++nextTest}`;
      created.set(id, JSON.parse(init.body));
      return json(200, { id });
    }
    if (u.startsWith("/v1/convai/agent-testing/") && method === "DELETE") return (deleted.push(u), json(200, {}));
    if (u.endsWith("/run-tests")) return json(200, { id: "inv1", test_runs: [] });
    if (u === "/v1/convai/test-invocations/inv1") {
      const runs = [...created.entries()].map(([id, spec]) => {
        const bad = spec.name.endsWith("client-sell");
        return {
          test_id: id,
          status: "passed",
          condition_result: { result: "success", rationale: "ок" },
          agent_responses: [agentTurn(bad ? "Лутфан, да" : "Записала", [["save_client_request", spec.name.endsWith("client-sell") ? { intent: "sell", district: "Фирдавси", type: "APARTMENT", rooms: 3, budget_max: 90000, currency: "USD" } : FULL_ARGS]])],
        };
      });
      return json(200, { id: "inv1", test_runs: runs });
    }
    if (u.startsWith("/v1/convai/agents/")) return json(200, { conversation_config: { agent: { prompt: { llm: "x" } } } });
    return json(404, {});
  };
  const c = collect();
  const r = await runSuite({ env: { ELEVENLABS_API_KEY: KEY, ELEVENLABS_TEST_AGENT_ID: "agent_test", ELEVENLABS_AGENT_ID: "agent_prod" }, values: { only: "client-buy-full,client-sell" }, fetchImpl, kinds, sync, say: c.say, sleepFn: async () => {}, writeFiles: false });
  assert.equal(r.results.length, 2);
  assert.equal(r.results.find((x) => x.id === "client-buy-full").pass, true, c.text());
  const sell = r.results.find((x) => x.id === "client-sell");
  assert.equal(sell.pass, false);
  assert.match(sell.failures.join(), /лутфан/);
  assert.equal(r.failed, 1);
  assert.equal(deleted.length, 2, "созданные тесты убраны");
  const spec = [...created.values()][0];
  assert.equal(spec.type, "simulation");
  assert.ok(spec.success_conditions.length > 0 && spec.simulation_scenario.length > 0);
});

test("suite: тестовый агент равен боевому — отказ до запросов", async () => {
  let requests = 0;
  const c = collect();
  const r = await runSuite({ env: { ELEVENLABS_API_KEY: KEY, ELEVENLABS_TEST_AGENT_ID: "a", ELEVENLABS_AGENT_ID: "a" }, fetchImpl: async () => (requests++, json(200, {})), kinds: [], say: c.say, writeFiles: false });
  assert.equal(r.failed, 1);
  assert.equal(requests, 0);
});


// ── сторож: скрипты не печатают ключ ───────────────────────────────────────
test("сторож: ни один скрипт не отдаёт ключ в печать, весь вывод идёт через makePrinter/say", () => {
  const files = ["lib.mjs", "preflight.mjs", "patch-check.mjs", "suite.mjs", "crm-prompts.mjs", "scenarios.mjs"];
  for (const f of files) {
    const body = readFileSync(path.join(HERE, f), "utf8");
    body.split("\n").forEach((line, i) => {
      if (printsKey(line)) assert.fail(`${f}:${i + 1}: ключ рядом с печатью: ${line.trim()}`);
    });
    assert.ok(!/console\.(log|error|warn|info)/.test(body.replace(/\/\/.*$/gm, "")), `${f}: console.* в обход makePrinter`);
  }
});

/** Печать (out/say), где ключ подставлен в строку (${apiKey}) или передан аргументом. Проверка «есть ли ключ» (${apiKey ? …}) не в счёт. */
function printsKey(line) {
  const code = line.replace(/\/\/.*$/, "");
  if (!/\b(out|say)\s*\(/.test(code)) return false;
  const withoutChecks = code.replace(/\$\{\s*(apiKey|env\.ELEVENLABS_API_KEY)\s*\?[^}]*\}/g, "");
  const interpolated = /\$\{[^}]*\b(apiKey|ELEVENLABS_API_KEY)\b[^}]*\}/.test(withoutChecks);
  const asArgument = /\b(out|say)\s*\(\s*(apiKey|env\.ELEVENLABS_API_KEY)\b/.test(code);
  return interpolated || asArgument;
}

test("сторож проверен нарочной поломкой: печать с ключом он ловит, проверку «задан ли» пропускает", () => {
  assert.ok(printsKey("  out(`ключ ${apiKey}`);"));
  assert.ok(printsKey("  out(apiKey);"));
  assert.ok(!printsKey("  out(`ключ ${apiKey ? 'задан' : 'нет'}`);"));
});

test("ключ в окружении есть, а в плане --dry его нет", async () => {
  const c = collect();
  await runPreflight({ env: { ELEVENLABS_API_KEY: KEY }, flags: new Set(["dry"]), tuning: TUNING, say: makePrinter(KEY, (l) => c.lines.push(l)) });
  assert.ok(!c.text().includes(KEY));
});

// ── живой прогон 11.11: повторы, причина судьи, обрыв симуляции, зеркало prompt.tools, --llm ──
import { formatRationale } from "./lib.mjs";
import { splitToolMirror } from "./patch-check.mjs";
import { SIM_PERSONA_SUFFIX } from "./suite.mjs";

const connectError = () => Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });

test("makeClient: сбой соединения повторяется с растущей паузой даже у POST, потом успех", async () => {
  let n = 0;
  const pauses = [];
  const request = makeClient({
    apiKey: KEY,
    fetchImpl: async () => {
      if (++n < 3) throw connectError();
      return json(200, { id: "t1" });
    },
    sleepFn: async (ms) => void pauses.push(ms),
    pauseMs: 100,
  });
  const r = await request("POST", "/v1/convai/agent-testing/create", { name: "x" });
  assert.equal(r.ok, true);
  assert.equal(n, 3);
  assert.deepEqual(pauses, [100, 200]);
});

test("makeClient: после лимита повторов отдаёт ошибку, а не зацикливается", async () => {
  let n = 0;
  const request = makeClient({ apiKey: KEY, fetchImpl: async () => (n++, Promise.reject(connectError())), sleepFn: async () => {}, retries: 2 });
  const r = await request("GET", "/v1/user");
  assert.equal(r.ok, false);
  assert.equal(r.error, "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(n, 3);
});

test("makeClient: 503 повторяется у GET, но НЕ у POST (дубль теста не заводим); таймаут ответа POST не повторяется", async () => {
  let gets = 0;
  const g = makeClient({ apiKey: KEY, fetchImpl: async () => (++gets < 2 ? json(503, "busy") : json(200, {})), sleepFn: async () => {} });
  assert.equal((await g("GET", "/x")).ok, true);
  assert.equal(gets, 2);
  let posts = 0;
  const p = makeClient({ apiKey: KEY, fetchImpl: async () => (posts++, json(503, "busy")), sleepFn: async () => {} });
  assert.equal((await p("POST", "/x", {})).status, 503);
  assert.equal(posts, 1);
  let timeouts = 0;
  const t = makeClient({ apiKey: KEY, fetchImpl: async () => (timeouts++, Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }))), sleepFn: async () => {} });
  await t("POST", "/x", {});
  assert.equal(timeouts, 1);
});

test("formatRationale: объект судьи читается текстом, а не [object Object]", () => {
  const text = formatRationale({ messages: ["Criterion 1 failed: выдумал номер", "The simulated user ended the conversation."], summary: "Evaluation failed" });
  assert.equal(text, "Criterion 1 failed: выдумал номер");
  assert.equal(formatRationale("просто строка"), "просто строка");
  assert.equal(formatRationale({ summary: "итог" }), "итог");
  assert.ok(!formatRationale({ a: 1 }).includes("[object Object]"));
  assert.equal(formatRationale(null), "");
});

test("evaluateTranscript: разговор оборван на вопросе агента — «неопределённо», а с прощанием — настоящий провал", () => {
  const agree = SCENARIOS.find((s) => s.id === "invite-ru-agree");
  const cut = evaluateTranscript(agree, [agentTurn("Ждём вас в субботу. Получится прийти?")]);
  assert.equal(cut.inconclusive, true);
  const bye = evaluateTranscript(agree, [agentTurn("Отлично, ждём вас. До свидания!")]);
  assert.equal(bye.inconclusive, false);
  assert.ok(bye.failures.some((f) => /не дошёл до функции/.test(f)));
  assert.match(SIM_PERSONA_SUFFIX, /не прощайся первым/);
});

test("splitToolMirror: зеркало prompt.tools — INFO, если все функции на месте; иначе остаётся провалом", () => {
  const collateral = [{ path: "conversation_config.agent.prompt.tools", was: "[…]", now: "[…]" }, { path: "conversation_config.tts.x", was: "1", now: "нет" }];
  const after = { conversation_config: { agent: { prompt: { tools: [{ name: "end_call" }, { name: "save_client_request" }] } } } };
  const ok = splitToolMirror(collateral, after, ["end_call", "save_client_request"]);
  assert.deepEqual(ok.real.map((c) => c.path), ["conversation_config.tts.x"]);
  assert.match(ok.mirrorInfo, /все 2 функций на месте/);
  const bad = splitToolMirror(collateral, after, ["end_call", "book_showing"]);
  assert.equal(bad.mirrorInfo, null);
  assert.equal(bad.real.length, 2);
});

test("patch-check: пересобранное зеркало prompt.tools не краснит проверку, а даёт INFO", async () => {
  const sync = await loadAgentSync();
  const srv = fakeServer("merge");
  let patches = 0;
  const fetchImpl = async (url, init) => {
    const res = await srv.fetchImpl(url, init);
    if (init?.method === "PATCH" && String(url).includes("/agents/")) {
      patches++;
      // после первого PATCH зеркало с лишним полем, после второго — пересобрано без него
      srv.agent.conversation_config.agent.prompt.tools = FAKE_TOOLS.map((t) => (patches === 1 ? { name: t.name, type: "client", extra: 1 } : { name: t.name, type: "client" }));
    }
    return res;
  };
  const c = collect();
  const r = await runPatchCheck({ env: PC_ENV, fetchImpl, sync, tools: FAKE_TOOLS, say: c.say, writeFiles: false });
  assert.equal(r.failed, 0, c.text());
  assert.match(c.text(), /INFO prompt\.tools пересобран/);
});

test("suite --llm: модель записывается в тестового агента вместе с промптом, итог называет модель", async () => {
  const sync = await loadAgentSync();
  const kinds = [{ kind: "consultant", label: "Консультант", prompt: "ПРОМПТ", tools: [{ name: "save_client_request", description: "d", parameters: { type: "OBJECT", properties: {} } }] }];
  const patched = [];
  let createdId = null;
  const fetchImpl = async (url, init) => {
    const u = String(url).replace("https://api.elevenlabs.io", "");
    const method = init?.method || "GET";
    if (u === "/v1/convai/tools") return method === "GET" ? json(200, { tools: [] }) : json(200, { id: "tool_1" });
    if (u === "/v1/convai/agent-testing/create") return json(200, { id: (createdId = "t1") });
    if (method === "DELETE") return json(200, {});
    if (u.endsWith("/run-tests")) return json(200, { id: "inv1" });
    if (u === "/v1/convai/test-invocations/inv1") {
      return json(200, { test_runs: [{ test_id: createdId, status: "failed", condition_result: { result: "failure", rationale: { messages: ["Criterion 1 failed: выдумал"], summary: "Evaluation failed" } }, agent_responses: [{ ...agentTurn("Записала", [["save_client_request", FULL_ARGS]]), producing_llm: "gemini-3.8-flash" }] }] });
    }
    if (u.startsWith("/v1/convai/agents/")) {
      if (method === "PATCH") patched.push(JSON.parse(init.body));
      return json(200, { conversation_config: { agent: { prompt: { llm: "deepseek-v41-flash" } } } });
    }
    return json(404, {});
  };
  const c = collect();
  const r = await runSuite({ env: { ELEVENLABS_API_KEY: KEY, ELEVENLABS_TEST_AGENT_ID: "agent_test" }, values: { only: "client-buy-full", llm: "gemini-3.8-flash" }, fetchImpl, kinds, sync, say: c.say, sleepFn: async () => {}, writeFiles: false });
  assert.equal(patched[0].conversation_config.agent.prompt.llm, "gemini-3.8-flash");
  assert.match(c.text(), /ИТОГ \[gemini-3\.8-flash\]: 0\/1/);
  assert.ok(!c.text().includes("[object Object]"));
  assert.match(r.results[0].failures.join(), /Criterion 1 failed: выдумал/);
});

import { loadElevenLabsEnv } from "./load-env.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("load-env: значение из .env перекрывает устаревшее из оболочки, чужие переменные не трогает, значения не возвращает", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "el-env-"));
  const file = path.join(dir, ".env");
  writeFileSync(file, `ELEVENLABS_API_KEY=${KEY}\nELEVENLABS_AGENT_ID=agent_new\nOTHER=1\n`);
  const env = { ELEVENLABS_API_KEY: "sk_old_stale_value", ELEVENLABS_AGENT_ID: "agent_new", OTHER: "0" };
  const replaced = loadElevenLabsEnv(env, file);
  assert.equal(env.ELEVENLABS_API_KEY, KEY);
  assert.equal(env.OTHER, "0");
  assert.deepEqual(replaced, ["ELEVENLABS_API_KEY"]);
  assert.ok(!JSON.stringify(replaced).includes(KEY));
  assert.deepEqual(loadElevenLabsEnv({}, path.join(dir, "нет.env")), []);
  rmSync(dir, { recursive: true, force: true });
});

// ── П2 (11.11.2026): функции по содержимому, у каждого вида звонка свой end_call ─────────
import { ensureTools, perKindToolViolations } from "./patch-check.mjs";

const END_A = { name: "end_call", description: "конец", parameters: { type: "OBJECT", properties: { reason: { type: "STRING", description: "r", enum: ["answered", "refused"] } }, required: ["reason"] } };
const END_B = { ...END_A, parameters: { type: "OBJECT", properties: { reason: { type: "STRING", description: "r", enum: ["answered", "wrong_person"] } }, required: ["reason"] } };
const TWO_KINDS = [
  { kind: "invite", tools: [END_A] },
  { kind: "post", tools: [END_B] },
];

test("patch-check по видам звонка: одно имя end_call с разными параметрами — разные id, повтор не заводит новых", async () => {
  const sync = await loadAgentSync();
  const srv = fakeServer("merge");
  const c = collect();
  const r = await runPatchCheck({ env: PC_ENV, fetchImpl: srv.fetchImpl, sync, kinds: TWO_KINDS, say: c.say, writeFiles: false });
  assert.equal(r.failed, 0, c.text());
  assert.match(c.text(), /OK\s+у каждого вида звонка свои функции/);
  assert.match(c.text(), /OK\s+повторная подготовка не заводит новых функций/);
  assert.match(c.text(), /OK\s+conversation_config\.agent\.prompt\.built_in_tools\.end_call/);
  assert.match(c.text(), /OK\s+platform_settings\.privacy\.retention_days/);
  // Функции не правились: ни одного PATCH /v1/convai/tools/…
  assert.equal(srv.calls.filter((x) => x.startsWith("PATCH /v1/convai/tools/")).length, 0);
  assert.equal(srv.calls.filter((x) => x === "POST /v1/convai/tools").length, 2);
});

test("patch-check: сервис хранит функцию иначе, чем мы её сравниваем — повтор заводит дубли, проверка краснеет", async () => {
  const sync = await loadAgentSync();
  const srv = fakeServer("merge");
  const fetchImpl = async (url, init) => {
    const res = await srv.fetchImpl(url, init);
    if ((init?.method || "GET") === "GET" && String(url).endsWith("/v1/convai/tools")) {
      const body = JSON.parse(await res.text());
      for (const t of body.tools) t.tool_config = { ...t.tool_config, description: t.tool_config.description + "!" };
      return json(200, body);
    }
    return res;
  };
  const c = collect();
  const r = await runPatchCheck({ env: PC_ENV, fetchImpl, sync, kinds: TWO_KINDS, say: c.say, writeFiles: false });
  assert.equal(r.failed, 1);
  assert.match(c.text(), /FAIL повторная подготовка не заводит новых функций — заведено повторно: 2/);
});

test("patch-check: сервис не принял срок хранения — ключевое поле PATCH №1 красное", async () => {
  const sync = await loadAgentSync();
  const srv = fakeServer("merge");
  const fetchImpl = async (url, init) => {
    if (init?.method === "PATCH" && String(url).includes("/agents/")) {
      const body = JSON.parse(init.body);
      delete body.platform_settings?.privacy;
      return srv.fetchImpl(url, { ...init, body: JSON.stringify(body) });
    }
    return srv.fetchImpl(url, init);
  };
  const c = collect();
  const r = await runPatchCheck({ env: PC_ENV, fetchImpl, sync, kinds: TWO_KINDS, say: c.say, writeFiles: false });
  assert.equal(r.failed, 1);
  assert.match(c.text(), /FAIL platform_settings\.privacy\.retention_days/);
});

test("perKindToolViolations: прежняя выдача по имени (один id на оба end_call) — нарушение; одно содержимое — нет", async () => {
  const sync = await loadAgentSync();
  const { elevenLabsToolContentKey } = await import("../../apps/api/src/ai/elevenLabsAgentSync.ts");
  const byName = [
    { kind: "invite", tools: [END_A], idByName: { end_call: "tool_1" } },
    { kind: "post", tools: [END_B], idByName: { end_call: "tool_1" } },
  ];
  assert.equal(perKindToolViolations(byName, sync.toElevenLabsClientTool, elevenLabsToolContentKey).length, 1);
  const same = [
    { kind: "a", tools: [END_A], idByName: { end_call: "tool_1" } },
    { kind: "b", tools: [END_A], idByName: { end_call: "tool_1" } },
  ];
  assert.deepEqual(perKindToolViolations(same, sync.toElevenLabsClientTool, elevenLabsToolContentKey), []);
});

test("ensureTools без явного ключа берёт ключ сервера (один источник правила) и читает список постранично", async () => {
  const sync = await loadAgentSync();
  const pages = [];
  const fetchImpl = async (url, init) => {
    const u = String(url).replace("https://api.elevenlabs.io", "");
    const method = init?.method || "GET";
    if (method === "GET") {
      pages.push(u);
      return u.includes("cursor=") ? json(200, { tools: [], has_more: false }) : json(200, { tools: [], has_more: true, next_cursor: "c2" });
    }
    return json(200, { id: "tool_new" });
  };
  const request = makeClient({ apiKey: KEY, fetchImpl, retries: 0 });
  const e = await ensureTools(request, [END_A], sync.toElevenLabsClientTool);
  assert.equal(e.error, null);
  assert.deepEqual(pages, ["/v1/convai/tools", "/v1/convai/tools?cursor=c2"]);
  assert.equal(e.idByName.end_call, "tool_new");
});

test("patch-check: PATCH №1 заменил privacy целиком (пропал флаг владельца) — «чужие поля целы» краснеет", async () => {
  const sync = await loadAgentSync();
  const srv = fakeServer("merge");
  srv.agent.platform_settings.privacy = { record_voice: true, retention_days: -1, user_memory: { enabled: true } };
  const fetchImpl = async (url, init) => {
    const res = await srv.fetchImpl(url, init);
    const body = init?.body ? JSON.parse(init.body) : null;
    if (init?.method === "PATCH" && String(url).includes("/agents/") && body?.platform_settings?.privacy) {
      srv.agent.platform_settings.privacy = body.platform_settings.privacy; // замена подобъекта, а не слияние
    }
    return res;
  };
  const c = collect();
  const r = await runPatchCheck({ env: PC_ENV, fetchImpl, sync, kinds: TWO_KINDS, say: c.say, writeFiles: false });
  assert.equal(r.failed, 1);
  assert.match(c.text(), /FAIL PATCH №1: чужие поля целы — .*platform_settings\.privacy\.user_memory\.enabled/);
});

test("patch-check: сервис слил PATCH №1 глубоко — «чужие поля целы» зелёный", async () => {
  const sync = await loadAgentSync();
  const srv = fakeServer("merge");
  srv.agent.platform_settings.privacy = { record_voice: true, retention_days: -1, user_memory: { enabled: true } };
  const c = collect();
  const r = await runPatchCheck({ env: PC_ENV, fetchImpl: srv.fetchImpl, sync, kinds: TWO_KINDS, say: c.say, writeFiles: false });
  assert.equal(r.failed, 0, c.text());
  assert.match(c.text(), /OK\s+PATCH №1: чужие поля целы/);
});
