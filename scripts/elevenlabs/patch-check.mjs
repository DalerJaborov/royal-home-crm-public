#!/usr/bin/env node
// Проверка «живого PATCH» на ТЕСТОВОМ агенте: npm run voice:patch-check [-- --dry]
//   ELEVENLABS_API_KEY, ELEVENLABS_TEST_AGENT_ID (НЕ боевой!), ELEVENLABS_API_BASE (необязательно),
//   ELEVENLABS_VOICE_ID_TG (необязательно — попадёт в пресет языка tg)
// Делает то же, что сервер перед звонком (ai/elevenLabsAgentSync.ts): заводит наши функции,
// первый PATCH (buildAgentSyncPatch), второй PATCH (buildAgentTuningPatch), и после каждого —
// GET и сравнение: какие поля приняты, какие потеряны, что пропало из НЕ отправленного
// (замена подобъекта целиком вместо глубокого слияния).
// ВНИМАНИЕ: меняет тестового агента и (как и сервер) заводит клиентские функции в аккаунте
// (по содержимому; существующие не правит, с 11.11.2026). Боевого агента не трогает: при совпадении id скрипт отказывается работать.
// Снимок агента ДО правок сохраняется в отчёт (ключа в нём нет) — для ручного отката в кабинете.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { baseUrl, collateralLoss, compareSent, describeFailure, looksGeoBlocked, makeClient, makePrinter, parseArgv, reportDir, stampNow, writeReport } from "./lib.mjs";

/** Поля, ради которых проверка затеяна (из журнала 10.11: «НЕ ПРОВЕРЕНО на настоящем агенте»). */
export const KEY_FIELDS = [
  "conversation_config.agent.prompt.built_in_tools.language_detection",
  "conversation_config.language_presets.tg",
  "conversation_config.tts.model_id",
  "conversation_config.tts.agent_output_audio_format",
  "conversation_config.asr.user_input_audio_format",
  "conversation_config.turn.turn_eagerness",
  "conversation_config.turn.interruption_ignore_terms",
  "conversation_config.agent.prompt.max_tokens",
];

/**
 * ElevenLabs сам пересобирает зеркало prompt.tools из tool_ids (проверено живым прогоном 11.11): оно «меняется»,
 * хотя мы его не отправляли. Это не потеря, если все наши функции в зеркале есть. Возвращает { real, mirrorInfo }.
 */
export function splitToolMirror(collateral, afterAgent, ourToolNames) {
  const isMirror = (c) => c.path === "conversation_config.agent.prompt.tools" || c.path.startsWith("conversation_config.agent.prompt.tools.");
  const mirror = collateral.filter(isMirror);
  if (mirror.length === 0) return { real: collateral, mirrorInfo: null };
  const listed = afterAgent?.conversation_config?.agent?.prompt?.tools;
  const names = new Set((Array.isArray(listed) ? listed : []).map((t) => t?.name).filter(Boolean));
  const missing = ourToolNames.filter((n) => !names.has(n));
  if (missing.length) return { real: collateral, mirrorInfo: null };
  return { real: collateral.filter((c) => !isMirror(c)), mirrorInfo: `prompt.tools пересобран из tool_ids, все ${ourToolNames.length} функций на месте` };
}

const getPath = (o, p) => p.split(".").reduce((a, k) => (a && typeof a === "object" ? a[k] : undefined), o);

/** Политика CRM на агенте (ELEVENLABS_AGENT_CRM_POLICY), проверяется после PATCH №1. */
export const PATCH1_KEY_FIELDS = [
  "conversation_config.agent.prompt.built_in_tools.end_call",
  "platform_settings.privacy.retention_days",
];

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Ключ содержимого функции — та же функция, что у сервера (ai/elevenLabsAgentSync.ts), а не копия. */
async function loadContentKey() {
  const { loadAgentSync } = await import("./crm-prompts.mjs");
  await loadAgentSync(); // регистрирует tsx
  const m = await import(pathToFileURL(path.join(ROOT, "apps", "api", "src", "ai", "elevenLabsAgentSync.ts")).href);
  return m.elevenLabsToolContentKey;
}

/** Все клиентские функции аккаунта, постранично (первая страница — без параметров, как раньше). */
async function listAllTools(request) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const r = await request("GET", cursor ? `/v1/convai/tools?cursor=${encodeURIComponent(cursor)}` : "/v1/convai/tools");
    if (!r.ok) return { rows, error: `список функций: ${describeFailure(r)}` };
    rows.push(...(r.json?.tools ?? []));
    if (!r.json?.has_more || !r.json?.next_cursor) break;
    cursor = r.json.next_cursor;
  }
  return { rows, error: null };
}

/**
 * Заводит клиентские функции ПО СОДЕРЖИМОМУ (как сервер, 11.11.2026): функция с тем же
 * именем, описанием и параметрами — берётся её id, иначе POST новой. Существующие НЕ правятся:
 * функции общие на аккаунт, PATCH по имени менял бы их и боевому агенту.
 * Возвращает { ids, idByName, created, error }; created — сколько функций заведено сейчас.
 */
export async function ensureTools(request, tools, toClientTool, contentKey) {
  const keyOf = contentKey ?? (await loadContentKey());
  const listed = await listAllTools(request);
  if (listed.error) return { ids: [], idByName: {}, created: 0, error: listed.error };
  const byKey = new Map();
  for (const row of listed.rows) {
    const k = row.id ? keyOf(row.tool_config) : null;
    if (k && !byKey.has(k)) byKey.set(k, row.id);
  }
  const ids = [];
  const idByName = {};
  let created = 0;
  for (const decl of tools) {
    const tool_config = toClientTool(decl);
    const k = keyOf(tool_config);
    let id = byKey.get(k);
    if (!id) {
      const r = await request("POST", "/v1/convai/tools", { tool_config });
      if (!r.ok) return { ids, idByName, created, error: `функция ${decl.name}: ${describeFailure(r)}` };
      id = r.json?.id;
      if (id) {
        byKey.set(k, id);
        created++;
      }
    }
    if (id) {
      if (!ids.includes(id)) ids.push(id);
      idByName[decl.name] = id;
    }
  }
  return { ids, idByName, created, error: null };
}

/**
 * У каждого вида звонка своя функция: одно имя с разным содержимым — разные id, одно и то же
 * содержимое — один id. perKind: [{ kind, tools, idByName }]. Возвращает список нарушений.
 */
export function perKindToolViolations(perKind, toClientTool, keyOf) {
  const seen = new Map(); // id → { key, kind, name }
  const out = [];
  for (const { kind, tools, idByName } of perKind) {
    for (const decl of tools) {
      const id = idByName[decl.name];
      if (!id) {
        out.push(`${kind}: функция ${decl.name} без id`);
        continue;
      }
      const key = keyOf(toClientTool(decl));
      const prev = seen.get(id);
      if (prev && prev.key !== key) out.push(`${decl.name}: у «${prev.kind}» и «${kind}» разное описание, но один id`);
      else if (!prev) seen.set(id, { key, kind, name: decl.name });
    }
  }
  return out;
}

/**
 * Сама проверка. deps: { env, flags, fetchImpl, sync: { buildAgentSyncPatch, buildAgentTuningPatch, toElevenLabsClientTool },
 * tools, say }. Возвращает { failed, report }.
 */
export async function runPatchCheck({ env, flags = new Set(), fetchImpl, sync, tools = [], kinds = null, say, writeFiles = true }) {
  // kinds: [{ kind, tools }] — наборы функций по видам звонка (как сервер готовит каждый отдельно).
  const perKindIn = kinds ?? [{ kind: "все", tools }];
  const allTools = perKindIn.flatMap((k) => k.tools);
  const apiKey = env.ELEVENLABS_API_KEY?.trim() || "";
  const out = say || makePrinter(apiKey);
  const testId = env.ELEVENLABS_TEST_AGENT_ID?.trim();
  const prodId = env.ELEVENLABS_AGENT_ID?.trim();
  const voiceIdTg = env.ELEVENLABS_VOICE_ID_TG?.trim() || null;
  const report = { steps: [], keyFields: [], problems: [] };

  if (flags.has("dry")) {
    out("План (без сети, --dry):");
    out(`  0. отказ, если ELEVENLABS_TEST_AGENT_ID не задан или равен боевому ELEVENLABS_AGENT_ID (тестовый: ${testId ? "задан" : "НЕ ЗАДАН"})`);
    out(`  1. завести по содержимому функции ${perKindIn.length} видов звонка (${allTools.length} шт); повторный заход не заводит новых; одно имя с разным описанием — разные id`);
    out("  2. GET агента → снимок «до» в отчёт");
    out("  3. PATCH №1 (функции + разрешения на подмену + встроенный end_call выкл + хранение) → GET → сравнение");
    for (const f of PATCH1_KEY_FIELDS) out(`     - ${f}`);
    out("  4. PATCH №2 (настройки звучания) → GET → сравнение");
    out("  5. отчёт: принято / потеряно / изменено; ключевые поля:");
    for (const f of KEY_FIELDS) out(`     - ${f}`);
    const sample = sync.buildAgentTuningPatch(
      { conversation_config: { agent: { prompt: { prompt: "x", llm: "gemini-2.5-flash" } }, tts: { voice_id: "v" } } },
      ["tool_x"],
      { voiceIdTg }
    );
    out(`  PATCH №2 несёт разделы: ${Object.keys(sample.conversation_config).join(", ")}`);
    return { failed: 0, report };
  }

  if (!apiKey || !testId) {
    const miss = [!apiKey && "ELEVENLABS_API_KEY", !testId && "ELEVENLABS_TEST_AGENT_ID"].filter(Boolean).join(", ");
    out(`FAIL переменные окружения — не заданы: ${miss}`);
    return { failed: 1, report };
  }
  if (prodId && testId === prodId) {
    out("FAIL ELEVENLABS_TEST_AGENT_ID совпадает с боевым ELEVENLABS_AGENT_ID — скрипт меняет агента, на боевом такое нельзя. Заведите отдельного тестового агента в кабинете.");
    return { failed: 1, report };
  }

  const request = makeClient({ apiKey, base: baseUrl(env), fetchImpl });
  const agentPath = `/v1/convai/agents/${encodeURIComponent(testId)}`;
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, detail });
    out(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
    if (!ok) report.problems.push(`${name}: ${detail}`);
    return ok;
  };

  const before = await request("GET", agentPath);
  if (looksGeoBlocked(before)) {
    step("GET агента (до)", false, "страница защиты / редирект по странам");
    return { failed: 1, report };
  }
  if (!step("GET агента (до)", before.ok, before.ok ? `${before.json?.name ?? "без имени"}, ${before.ms} мс` : describeFailure(before))) {
    return { failed: 1, report };
  }
  report.before = before.json;

  const keyOf = sync.elevenLabsToolContentKey ?? (await loadContentKey());
  const perKind = [];
  const unionIds = [];
  for (const k of perKindIn) {
    const e = await ensureTools(request, k.tools, sync.toElevenLabsClientTool, keyOf);
    if (!step(`клиентские функции «${k.kind}»`, !e.error, e.error || `${e.ids.length} шт, заведено новых ${e.created}`)) return { failed: 1, report };
    perKind.push({ kind: k.kind, tools: k.tools, idByName: e.idByName });
    for (const id of e.ids) if (!unionIds.includes(id)) unionIds.push(id);
  }
  const ensured = { ids: unionIds };
  const violations = perKindToolViolations(perKind, sync.toElevenLabsClientTool, keyOf);
  step("у каждого вида звонка свои функции (одно имя, разное описание — разные id)", violations.length === 0, violations.slice(0, 5).join("; "));
  // Повторный заход ничего не заводит: иначе проекция содержимого расходится с тем, что хранит
  // сервис, и каждый перезапуск сервера плодил бы новые функции.
  let again = 0;
  for (const k of perKindIn) {
    const e = await ensureTools(request, k.tools, sync.toElevenLabsClientTool, keyOf);
    if (e.error) return step("повторная подготовка", false, e.error), { failed: 1, report };
    again += e.created;
  }
  step("повторная подготовка не заводит новых функций", again === 0, again ? `заведено повторно: ${again}` : "0 новых");

  // PATCH №1.
  const patch1 = sync.buildAgentSyncPatch(before.json, ensured.ids);
  const p1 = await request("PATCH", agentPath, patch1);
  if (!step("PATCH №1 (функции и разрешения подмены)", p1.ok, p1.ok ? `код ${p1.status}` : describeFailure(p1))) return { failed: 1, report };
  const after1 = await request("GET", agentPath);
  if (!step("GET после PATCH №1", after1.ok, after1.ok ? "" : describeFailure(after1))) return { failed: 1, report };
  report.patch1 = compareSent(patch1, after1.json);
  step(
    "PATCH №1: поля приняты",
    report.patch1.lost.length === 0 && report.patch1.changed.length === 0,
    `принято ${report.patch1.accepted.length}, потеряно ${report.patch1.lost.length}, изменено ${report.patch1.changed.length}`
  );
  for (const f of PATCH1_KEY_FIELDS) {
    const sent = getPath(patch1, f);
    const got = getPath(after1.json, f);
    // null — тоже значение: встроенный end_call выключен, если в ответе null или поля нет.
    const ok = sent === null ? got === null || got === undefined : got !== undefined && String(got) === String(sent);
    out(`     ${ok ? "OK  " : "FAIL"} ${f}`);
    if (!ok) report.problems.push(`PATCH №1: ключевое поле не принято: ${f}`);
  }

  // PATCH №2.
  const patch2 = sync.buildAgentTuningPatch(after1.json, ensured.ids, { voiceIdTg });
  const p2 = await request("PATCH", agentPath, patch2);
  if (!p2.ok) {
    step("PATCH №2 (настройки звучания)", false, describeFailure(p2));
    report.rejectedPatch2 = patch2;
  } else {
    step("PATCH №2 (настройки звучания)", true, `код ${p2.status}`);
    const after2 = await request("GET", agentPath);
    if (!step("GET после PATCH №2", after2.ok, after2.ok ? "" : describeFailure(after2))) return { failed: 1, report };
    report.patch2 = compareSent(patch2, after2.json);
    step(
      "PATCH №2: поля приняты",
      report.patch2.lost.length === 0 && report.patch2.changed.length === 0,
      `принято ${report.patch2.accepted.length}, потеряно ${report.patch2.lost.length}, изменено ${report.patch2.changed.length}`
    );
    for (const f of KEY_FIELDS) {
      const sent = getPath(patch2, f);
      const got = getPath(after2.json, f);
      const present = got !== undefined && got !== null;
      const cmp = sent === undefined ? null : compareSent({ v: sent }, { v: got });
      const ok = present && (!cmp || (cmp.lost.length === 0 && cmp.changed.length === 0));
      report.keyFields.push({ field: f, ok, sent: sent === undefined ? "не отправляли" : "отправлено", got: present ? "есть" : "НЕТ" });
      out(`     ${ok ? "OK  " : "FAIL"} ${f}`);
      if (!ok) report.problems.push(`ключевое поле не принято: ${f}`);
    }
    // Не отправленное, но исчезнувшее: признак замены подобъекта целиком.
    const split = splitToolMirror(collateralLoss(after1.json, after2.json, patch2), after2.json, [...new Set(allTools.map((t) => t.name))]);
    report.collateral = split.real;
    if (split.mirrorInfo) {
      report.infos = [split.mirrorInfo];
      out(`INFO ${split.mirrorInfo}`);
    }
    step(
      "PATCH №2: глубокое слияние (чужие поля целы)",
      report.collateral.length === 0,
      report.collateral.length
        ? `изменилось не отправленных полей: ${report.collateral.length} (первые: ${report.collateral.slice(0, 5).map((c) => c.path).join(", ")})`
        : "ничего не пропало"
    );
  }

  const failed = report.problems.length;
  out(failed ? `\nИТОГ: расхождений ${failed} — смотрите отчёт` : "\nИТОГ: агент принял оба PATCH без потерь");
  if (writeFiles) {
    const dir = reportDir(env, `patch-check-${stampNow()}`);
    writeReport(dir, "report.json", report, apiKey);
    writeReport(dir, "agent-before.json", before.json, apiKey);
    out(`Отчёт (вне git): ${dir}`);
  }
  return { failed: failed ? 1 : 0, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Ключи и id из apps/api/.env; значения из .env главнее оболочки (устаревший ключ в окружении давал 401).
  const { loadElevenLabsEnv } = await import("./load-env.mjs");
  const replaced = loadElevenLabsEnv();
  if (replaced.length) process.stdout.write(`Из apps/api/.env взяты вместо значений оболочки: ${replaced.join(", ")}
`);
  const { flags } = parseArgv(process.argv.slice(2));
  const { loadAgentSync, loadCrmCallKinds } = await import("./crm-prompts.mjs");
  const sync = await loadAgentSync();
  // Каждый вид звонка — своим набором: одинаковые имена (end_call) с разным описанием не сливаются.
  const kinds = (await loadCrmCallKinds()).map((k) => ({ kind: k.kind, tools: k.tools }));
  const { failed } = await runPatchCheck({ env: process.env, flags, sync, kinds });
  process.exit(failed ? 1 : 0);
}
