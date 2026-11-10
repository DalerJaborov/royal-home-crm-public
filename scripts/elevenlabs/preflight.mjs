#!/usr/bin/env node
// Проверка готовности ElevenLabs одной командой: npm run voice:preflight [-- --dry]
//   ELEVENLABS_API_KEY        ключ (не печатается никогда)
//   ELEVENLABS_AGENT_ID       боевой агент (из Настроек → голос робота)
//   ELEVENLABS_VOICE_ID_RU / ELEVENLABS_VOICE_ID_TG   голоса из Настроек (необязательно)
//   ELEVENLABS_API_BASE       адрес API, если ходим через посредника (необязательно)
// Только ЧТЕНИЕ: ни одного запроса, который меняет что-то у ElevenLabs или тратит деньги.
// --dry — без сети: печатает, что будет проверено, и какие переменные не заданы.
// Запуск с сервера rh-new — только с «да» владельца (там проверяется как раз доступ из Германии).
import { pathToFileURL } from "node:url";
import { baseUrl, describeFailure, looksGeoBlocked, makeClient, makePrinter, parseArgv } from "./lib.mjs";

const ENV_NAMES = ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID"];

/** Возвращает { failed, lines }. fetchImpl и tuning подменяются в тестах. */
export async function runPreflight({ env, flags = new Set(), fetchImpl, tuning, say }) {
  const apiKey = env.ELEVENLABS_API_KEY?.trim() || "";
  const out = say || makePrinter(apiKey);
  const results = [];
  const rec = (level, name, detail) => {
    results.push({ level, name, detail });
    out(`${level.padEnd(4)} ${name}${detail ? " — " + detail : ""}`);
  };

  const base = baseUrl(env);
  const model = tuning?.tts?.model_id || "eleven_v4_turbo";
  const agentId = env.ELEVENLABS_AGENT_ID?.trim();
  const voices = [
    ["русский голос", env.ELEVENLABS_VOICE_ID_RU?.trim()],
    ["таджикский голос", env.ELEVENLABS_VOICE_ID_TG?.trim()],
  ].filter(([, id]) => id);

  if (flags.has("dry")) {
    out("План (без сети, --dry):");
    out(`  1. доступ к ${base}: GET /v1/user — код ответа и задержка`);
    out("  2. ключ валиден (тот же ответ; 401 — не принят; нет права user_read — предупреждение)");
    out(`  3. агент: GET /v1/convai/agents/${agentId ? "<ELEVENLABS_AGENT_ID>" : "(id не задан)"} — существует, модель, голос, язык`);
    out(`  4. голоса из Настроек: ${voices.length ? voices.map(([n]) => n).join(", ") : "не заданы (ELEVENLABS_VOICE_ID_RU/TG)"} — GET /v1/voices/<id>`);
    out(`  5. модель ${model} знает таджикский (tg): GET /v1/models, поле languages`);
    for (const n of ENV_NAMES) out(`  переменная ${n}: ${env[n]?.trim() ? "задана" : "НЕ ЗАДАНА"}`);
    return { failed: 0, results };
  }

  const missing = ENV_NAMES.filter((n) => !env[n]?.trim());
  if (missing.length) {
    rec("FAIL", "переменные окружения", `не заданы: ${missing.join(", ")}`);
    return { failed: 1, results };
  }
  const request = makeClient({ apiKey, base, fetchImpl });

  // 1–2. Доступ и ключ.
  const user = await request("GET", "/v1/user");
  if (user.error || looksGeoBlocked(user)) {
    rec("FAIL", "доступ к api.elevenlabs.io", user.error ? `нет ответа (${user.error}), ${user.ms} мс` : `страница защиты / редирект по странам (код ${user.status}) — с этого адреса сервис не пускает`);
    return { failed: 1, results };
  }
  rec("OK", "доступ к API", `код ${user.status}, ${user.ms} мс`);
  if (user.ok) rec("OK", "ключ валиден", user.json?.subscription?.tier ? `тариф ${user.json.subscription.tier}` : "");
  else if (user.status === 401 && /missing_permissions/.test(user.text)) rec("WARN", "ключ принят, но без права user_read", "агентов проверим отдельно");
  else rec("FAIL", "ключ валиден", describeFailure(user));

  // 3. Агент.
  const agent = await request("GET", `/v1/convai/agents/${encodeURIComponent(agentId)}`);
  if (agent.ok) {
    const cc = agent.json?.conversation_config ?? {};
    const toolIds = cc.agent?.prompt?.tool_ids;
    rec(
      "OK",
      "агент найден",
      `${agent.json?.name ?? "без имени"}; язык ${cc.agent?.language ?? "?"}; модель ${cc.agent?.prompt?.llm ?? "?"}; голос ${cc.tts?.voice_id ? "задан" : "НЕ ЗАДАН"}; функций ${Array.isArray(toolIds) ? toolIds.length : 0}`
    );
  } else rec("FAIL", "агент найден", agent.status === 404 ? "404 — проверьте ELEVENLABS_AGENT_ID" : describeFailure(agent));

  // 4. Голоса.
  if (!voices.length) rec("WARN", "голоса из Настроек", "ELEVENLABS_VOICE_ID_RU/TG не заданы — не проверены");
  for (const [label, id] of voices) {
    const v = await request("GET", `/v1/voices/${encodeURIComponent(id)}`);
    if (v.ok) {
      const langs = (v.json?.verified_languages ?? []).map((x) => x.language).filter(Boolean);
      rec("OK", label, `${v.json?.name ?? "без имени"}${langs.length ? "; проверенные языки: " + [...new Set(langs)].join(",") : ""}`);
      if (label.startsWith("таджик") && langs.length && !langs.includes("tg")) rec("WARN", "таджикский голос", "в проверенных языках голоса нет tg — звучать может с акцентом");
    } else rec("FAIL", label, v.status === 404 || v.status === 400 ? "не найден в аккаунте (голос из библиотеки сначала надо добавить в «Мои голоса»)" : describeFailure(v));
  }

  // 5. Таджикский у модели.
  const models = await request("GET", "/v1/models");
  if (!models.ok || !Array.isArray(models.json)) rec("WARN", `модель ${model}`, `список моделей не получен (${describeFailure(models)})`);
  else {
    const m = models.json.find((x) => x.model_id === model);
    if (!m) rec("FAIL", `модель ${model}`, "в списке моделей аккаунта нет");
    else {
      const tg = (m.languages ?? []).some((l) => l.language_id === "tg");
      rec(tg ? "OK" : "FAIL", `таджикский у ${model}`, tg ? "в списке языков модели есть tg (озвучка)" : "tg в списке языков модели НЕТ");
    }
    rec("INFO", "распознавание таджикского", "API его не отдаёт — только слух на живом звонке (Scribe v2: «Good», WER 10–20 % по документации)");
  }

  const failed = results.filter((r) => r.level === "FAIL").length;
  out(failed ? `\nИТОГ: не готово, провалов ${failed}` : "\nИТОГ: готово к проверке PATCH");
  return { failed, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { flags } = parseArgv(process.argv.slice(2));
  const { loadAgentSync } = await import("./crm-prompts.mjs");
  const { tuning } = await loadAgentSync();
  const { failed } = await runPreflight({ env: process.env, flags, tuning });
  process.exit(failed ? 1 : 0);
}
