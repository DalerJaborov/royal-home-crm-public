#!/usr/bin/env node
// Симуляции разговоров на ТЕКУЩИХ промптах CRM: npm run voice:sim [-- --dry] [--only=invite-ru] [--keep]
//   ELEVENLABS_API_KEY, ELEVENLABS_TEST_AGENT_ID (НЕ боевой), ELEVENLABS_AGENT_ID (только для сверки «не равны»),
//   ELEVENLABS_API_BASE, VOICE_REPORT_DIR (по умолчанию ~/royalhome-voice-reports — вне git)
//
// Метод — тесты агента ElevenLabs (старый simulate-conversation снят с 31.10.2026, справочник 11.11.2026):
//   POST /v1/convai/agent-testing/create   type "simulation" (simulation_scenario, success_conditions, tool_mock_*)
//   POST /v1/convai/agents/{id}/run-tests  → id запуска
//   GET  /v1/convai/test-invocations/{id}  → test_runs[].status, condition_result, agent_responses (с tool_calls)
//   DELETE /v1/convai/agent-testing/{id}   → уборка
// Промпт и функции вида звонка пишутся в ТЕСТОВОГО агента (на боевом такое нельзя — скрипт откажется).
// Проверки: судья ElevenLabs по условиям сценария + код по расшифровке (вызвал ли агент нужную
// функцию с нужными полями, нет ли слова «лутфан», не вызвал ли запрещённую функцию).
// ВНИМАНИЕ: каждая симуляция тратит кредиты ElevenLabs (модель собеседника и судья). --dry — план без сети.
import { pathToFileURL } from "node:url";
import { ensureTools } from "./patch-check.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { baseUrl, describeFailure, looksGeoBlocked, makeClient, makePrinter, parseArgv, reportDir, stampNow, writeReport } from "./lib.mjs";

const MAX_TURNS = 12;
const POLL_MS = 5_000;
const POLL_LIMIT_MS = 8 * 60_000;
const LUTFAN = /лутфан|lutfan/i;

/** Равенство без регистра, oneOf, contains, num, present. */
export function matchExpect(value, exp) {
  if (exp && typeof exp === "object") {
    if ("present" in exp) return value !== undefined && value !== null && String(value).trim() !== "";
    if ("num" in exp) return Number(value) === exp.num;
    if ("oneOf" in exp) return exp.oneOf.some((x) => String(value).toLowerCase() === String(x).toLowerCase());
    if ("contains" in exp) return String(value ?? "").toLowerCase().includes(String(exp.contains).toLowerCase());
    return false;
  }
  return String(value ?? "").toLowerCase() === String(exp).toLowerCase();
}

/** Все вызовы функций агентом: [{ name, args }]. params_as_json — строка JSON. */
export function toolCallsOf(transcript) {
  const calls = [];
  for (const turn of transcript ?? []) {
    if (turn.role !== "agent") continue;
    for (const c of turn.tool_calls ?? []) {
      let args = {};
      try {
        args = typeof c.params_as_json === "string" && c.params_as_json ? JSON.parse(c.params_as_json) : (c.params ?? {});
      } catch {
        args = {};
      }
      calls.push({ name: c.tool_name, args });
    }
  }
  return calls;
}

/** Детерминированные проверки по расшифровке. Возвращает { ok, failures: [строки] }. */
export function evaluateTranscript(scenario, transcript) {
  const failures = [];
  const agentText = (transcript ?? []).filter((t) => t.role === "agent" && t.message).map((t) => t.message);
  if (agentText.some((m) => LUTFAN.test(m))) failures.push("агент сказал «лутфан»");
  if (agentText.length === 0) failures.push("агент не сказал ни слова");
  const calls = toolCallsOf(transcript);
  for (const bad of scenario.forbidTools ?? []) {
    if (calls.some((c) => c.name === bad)) failures.push(`агент вызвал запрещённую функцию ${bad}`);
  }
  const exp = scenario.expectTool;
  if (exp) {
    const named = calls.filter((c) => c.name === exp.name);
    if (named.length === 0) failures.push(`разговор не дошёл до функции ${exp.name} (вызваны: ${calls.map((c) => c.name).join(", ") || "никакие"})`);
    else {
      // Годится любой вызов, где все поля совпали (агент мог вызвать её дважды — сначала неполно).
      const missing = named.map((c) => Object.entries(exp.args).filter(([k, e]) => !matchExpect(c.args[k], e)).map(([k]) => k));
      const best = missing.reduce((a, b) => (b.length < a.length ? b : a));
      if (best.length) failures.push(`${exp.name}: поля не те или не заполнены: ${best.join(", ")}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

const clientToolMock = (name) =>
  ({ search_properties: "Подходящих объектов сейчас нет.", get_property: "Данных по объекту нет.", showing_slots: "Свободного времени нет.", my_status: "Данных нет." })[name] || "Записано.";

/** Тело теста-симуляции (форма — справочник agent-testing/create, 11.11.2026). */
export function buildSimulationTest(scenario, idByName, toolNames) {
  const overrides = {};
  for (const n of toolNames) if (idByName[n]) overrides[idByName[n]] = [{ mock_result: clientToolMock(n), is_error: false }];
  return {
    name: `crm-voice/${scenario.id}`,
    type: "simulation",
    simulation_scenario: scenario.persona,
    success_conditions: scenario.conditions,
    simulation_max_turns: MAX_TURNS,
    chat_history: [{ role: "user", message: scenario.seed, time_in_call_secs: 0 }],
    tool_mock_config: { mocking_strategy: "all", fallback_strategy: "raise_error" },
    tool_mock_overrides: overrides,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ждёт, пока в запуске не останется pending. Возвращает объект запуска. */
export async function waitInvocation(request, id, { pollMs = POLL_MS, limitMs = POLL_LIMIT_MS, sleepFn = sleep } = {}) {
  let waited = 0;
  for (;;) {
    const r = await request("GET", `/v1/convai/test-invocations/${encodeURIComponent(id)}`);
    if (!r.ok) return { error: describeFailure(r) };
    const runs = r.json?.test_runs ?? [];
    if (runs.length > 0 && runs.every((x) => x.status !== "pending")) return { invocation: r.json };
    if (waited >= limitMs) return { error: "запуск не закончился за отведённое время", invocation: r.json };
    await sleepFn(pollMs);
    waited += pollMs;
  }
}

function markdownReport(results, meta) {
  const lines = [`# Симуляции робозвонка ElevenLabs — ${meta.stamp}`, "", `Итог: ${results.filter((r) => r.pass).length}/${results.length}`, ""];
  for (const r of results) {
    lines.push(`## ${r.pass ? "OK" : "FAIL"} ${r.id} — ${r.name}`);
    if (r.judge) lines.push(`- судья: ${r.judge.result}${r.judge.rationale ? " — " + r.judge.rationale : ""}`);
    for (const f of r.failures) lines.push(`- ${f}`);
    lines.push("", ...(r.transcript ?? []).map((t) => `- ${t.role === "agent" ? "Робот" : "Человек"}: ${t.message ?? ""}${(t.tool_calls ?? []).length ? ` [функция: ${t.tool_calls.map((c) => c.tool_name).join(",")}]` : ""}`), "");
  }
  return lines.join("\n");
}

/**
 * deps: { env, flags, values, fetchImpl, kinds, say, sleepFn, writeFiles }.
 * kinds — результат loadCrmCallKinds() (подменяется в тестах).
 */
export async function runSuite({ env, flags = new Set(), values = {}, fetchImpl, kinds, sync: syncDep, say, sleepFn = sleep, writeFiles = true }) {
  const apiKey = env.ELEVENLABS_API_KEY?.trim() || "";
  const out = say || makePrinter(apiKey);
  const testId = env.ELEVENLABS_TEST_AGENT_ID?.trim();
  const prodId = env.ELEVENLABS_AGENT_ID?.trim();
  const only = values.only ? values.only.split(",") : null;
  const planned = SCENARIOS.filter((s) => !only || only.includes(s.kind) || only.includes(s.id));

  if (flags.has("dry")) {
    out(`План (без сети, --dry): ${planned.length} симуляций, до ${MAX_TURNS} реплик каждая; тесты создаются у ТЕСТОВОГО агента и удаляются после прогона.`);
    for (const k of kinds) {
      const list = planned.filter((s) => s.kind === k.kind);
      if (!list.length) continue;
      out(`\n${k.label} [${k.kind}] — промпт ${k.prompt.length} знаков, функции: ${k.tools.map((t) => t.name).join(", ")}`);
      for (const s of list) {
        const e = s.expectTool ? `${s.expectTool.name}(${Object.keys(s.expectTool.args).join(", ")})` : "без обязательной функции";
        out(`  - ${s.id}: ${s.name}; условий судьи ${s.conditions.length}; ожидание: ${e}${s.forbidTools ? `; запрет: ${s.forbidTools.join(",")}` : ""}`);
      }
    }
    out("\nПроверки кодом везде: нет «лутфан», агент заговорил, нужная функция вызвана с полными полями.");
    out(`Переменные: ELEVENLABS_API_KEY ${apiKey ? "задан" : "НЕ ЗАДАН"}, ELEVENLABS_TEST_AGENT_ID ${testId ? "задан" : "НЕ ЗАДАН"}.`);
    return { failed: 0, results: [] };
  }

  if (!apiKey || !testId) {
    const miss = [!apiKey && "ELEVENLABS_API_KEY", !testId && "ELEVENLABS_TEST_AGENT_ID"].filter(Boolean).join(", ");
    out(`FAIL переменные окружения — не заданы: ${miss}`);
    return { failed: 1, results: [] };
  }
  if (prodId && testId === prodId) {
    out("FAIL ELEVENLABS_TEST_AGENT_ID совпадает с боевым — прогон меняет промпт агента, на боевом нельзя.");
    return { failed: 1, results: [] };
  }
  if (planned.length === 0) {
    out("FAIL нет сценариев под фильтр --only");
    return { failed: 1, results: [] };
  }

  const request = makeClient({ apiKey, base: baseUrl(env), fetchImpl, timeoutMs: 60_000 });
  const agentPath = `/v1/convai/agents/${encodeURIComponent(testId)}`;
  const agent = await request("GET", agentPath);
  if (looksGeoBlocked(agent) || !agent.ok) {
    out(`FAIL GET тестового агента — ${looksGeoBlocked(agent) ? "страница защиты / редирект по странам" : describeFailure(agent)}`);
    return { failed: 1, results: [] };
  }
  const seen = new Set();
  const allTools = [];
  for (const t of kinds.flatMap((k) => k.tools)) if (!seen.has(t.name)) (seen.add(t.name), allTools.push(t));
  const sync = syncDep ?? (await (await import("./crm-prompts.mjs")).loadAgentSync());
  const ensured = await ensureTools(request, allTools, sync.toElevenLabsClientTool);
  if (ensured.error) {
    out(`FAIL клиентские функции — ${ensured.error}`);
    return { failed: 1, results: [] };
  }

  const results = [];
  const created = [];
  for (const kind of kinds) {
    const list = planned.filter((s) => s.kind === kind.kind);
    if (!list.length) continue;
    out(`\n${kind.label}: ${list.length} симуляций`);
    // Промпт и функции этого вида звонка — в тестового агента (как сервер подменяет их на звонок).
    const fresh = await request("GET", agentPath);
    const prevPrompt = fresh.json?.conversation_config?.agent?.prompt ?? {};
    const prompt = { ...prevPrompt, prompt: kind.prompt, tool_ids: kind.tools.map((t) => ensured.idByName[t.name]).filter(Boolean) };
    delete prompt.tools;
    const patched = await request("PATCH", agentPath, { conversation_config: { agent: { prompt } } });
    if (!patched.ok) {
      out(`FAIL PATCH промпта «${kind.kind}» — ${describeFailure(patched)}`);
      for (const s of list) results.push({ id: s.id, name: s.name, pass: false, failures: [`не записан промпт: ${describeFailure(patched)}`], transcript: [] });
      continue;
    }
    const idToScenario = new Map();
    for (const s of list) {
      const c = await request("POST", "/v1/convai/agent-testing/create", buildSimulationTest(s, ensured.idByName, kind.tools.map((t) => t.name)));
      if (!c.ok || !c.json?.id) {
        results.push({ id: s.id, name: s.name, pass: false, failures: [`тест не создан: ${describeFailure(c)}`], transcript: [] });
        continue;
      }
      created.push(c.json.id);
      idToScenario.set(c.json.id, s);
    }
    if (idToScenario.size === 0) continue;
    const run = await request("POST", `/v1/convai/agents/${encodeURIComponent(testId)}/run-tests`, { tests: [...idToScenario.keys()].map((id) => ({ test_id: id })), name: `crm-voice-${kind.kind}` });
    if (!run.ok || !run.json?.id) {
      for (const s of idToScenario.values()) results.push({ id: s.id, name: s.name, pass: false, failures: [`запуск не принят: ${describeFailure(run)}`], transcript: [] });
      continue;
    }
    const waited = await waitInvocation(request, run.json.id, { sleepFn });
    const runs = waited.invocation?.test_runs ?? [];
    for (const [testIdKey, s] of idToScenario) {
      const tr = runs.find((x) => x.test_id === testIdKey);
      if (!tr || tr.status === "pending" || tr.status === "cancelled") {
        results.push({ id: s.id, name: s.name, pass: false, failures: [waited.error || `прогон не завершён (${tr?.status ?? "нет"})`], transcript: tr?.agent_responses ?? [] });
        continue;
      }
      const code = evaluateTranscript(s, tr.agent_responses);
      const judge = tr.condition_result ?? null;
      const failures = [...code.failures];
      if (tr.status !== "passed") failures.push(`судья: ${judge?.result ?? tr.status}${judge?.rationale ? " — " + String(judge.rationale).slice(0, 300) : ""}`);
      results.push({ id: s.id, name: s.name, pass: failures.length === 0, failures, judge, transcript: tr.agent_responses ?? [] });
    }
  }

  for (const r of results) out(`${r.pass ? "OK  " : "FAIL"} ${r.id}${r.pass ? "" : " — " + r.failures.join("; ")}`);
  const passed = results.filter((r) => r.pass).length;
  out(`\nИТОГ: ${passed}/${results.length}`);

  if (!flags.has("keep")) for (const id of created) await request("DELETE", `/v1/convai/agent-testing/${encodeURIComponent(id)}`);
  if (writeFiles) {
    const stamp = stampNow();
    const dir = reportDir(env, `sim-${stamp}`);
    writeReport(dir, "results.json", results, apiKey);
    writeReport(dir, "report.md", markdownReport(results, { stamp }), apiKey);
    out(`Отчёт (вне git): ${dir}`);
  }
  return { failed: passed === results.length ? 0 : 1, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { flags, values } = parseArgv(process.argv.slice(2));
  const { loadCrmCallKinds } = await import("./crm-prompts.mjs");
  const kinds = await loadCrmCallKinds();
  const { failed } = await runSuite({ env: process.env, flags, values, kinds });
  process.exit(failed ? 1 : 0);
}
