// Общие части скриптов проверки ElevenLabs (preflight / patch-check / suite).
// ГЛАВНОЕ ПРАВИЛО: ключ из ELEVENLABS_API_KEY нигде не печатается — весь вывод идёт
// через say()/redact(), а тело ответа сервиса чистится от ключа и всего, похожего на ключ.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_BASE = "https://api.elevenlabs.io";
const KEY_LIKE = /\b(?:sk_[A-Za-z0-9]{8,}|xi-[A-Za-z0-9_-]{8,}|[a-f0-9]{32,})\b/g;

/** Убирает из текста сам ключ и всё, что на ключ похоже. */
export function redact(text, apiKey) {
  let out = String(text ?? "");
  if (apiKey && apiKey.length >= 6) out = out.split(apiKey).join("[ключ]");
  return out.replace(KEY_LIKE, "[ключ]");
}

/** Печать только через неё: даже случайно попавший в строку ключ не уйдёт в консоль. */
export function makePrinter(apiKey, write = (line) => process.stdout.write(line + "\n")) {
  return (...parts) => write(redact(parts.join(" "), apiKey));
}

export function baseUrl(env) {
  return (env.ELEVENLABS_API_BASE?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
}

/** Сетевые сбои, при которых запрос до сервера не дошёл: повтор безопасен для ЛЮБОГО метода. */
const CONNECT_ERRORS = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_SOCKET"]);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Клиент REST API. Не бросает на HTTP-ошибках: возвращает { ok, status, ms, json, text, error, attempts }.
 * fetchImpl и sleepFn подменяются в тестах. Текст ответа и ошибка уже очищены от ключа.
 * Повторы (retries раз, пауза pauseMs * номер попытки): сбой соединения — для любого метода (запрос не
 * ушёл); 429/502/503/504 и таймаут ответа — только для GET/DELETE, чтобы не завести дубль теста.
 */
export function makeClient({ apiKey, base = DEFAULT_BASE, fetchImpl = globalThis.fetch, timeoutMs = 20_000, retries = 3, pauseMs = 3_000, sleepFn = sleepMs }) {
  async function once(method, p, body) {
    const started = Date.now();
    try {
      const res = await fetchImpl(`${base}${p}`, {
        method,
        headers: { "xi-api-key": apiKey, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
      const text = redact(await res.text().catch(() => ""), apiKey);
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* не JSON — оставим text */
      }
      const status = res.status;
      return { ok: status >= 200 && status < 300, status, ms: Date.now() - started, json, text, error: null, connectFailure: false };
    } catch (err) {
      const code = err?.cause?.code || err?.code || "";
      return { ok: false, status: null, ms: Date.now() - started, json: null, text: "", error: redact(code || err?.message || err, apiKey), connectFailure: CONNECT_ERRORS.has(code), timedOut: err?.name === "TimeoutError" };
    }
  }
  return async function request(method, p, body) {
    const idempotent = method === "GET" || method === "DELETE";
    let r;
    for (let attempt = 1; ; attempt++) {
      r = await once(method, p, body);
      const retryable = r.connectFailure || (idempotent && (r.timedOut || [429, 502, 503, 504].includes(r.status)));
      if (!retryable || attempt > retries) break;
      await sleepFn(pauseMs * attempt);
    }
    return r;
  };
}

/** Причина судьи ElevenLabs: бывает строкой или объектом { messages: [...], summary }. */
export function formatRationale(rationale) {
  if (rationale === null || rationale === undefined) return "";
  if (typeof rationale === "string") return rationale;
  const parts = Array.isArray(rationale.messages) ? rationale.messages.filter((m) => typeof m === "string" && !/^The simulated user ended/i.test(m)) : [];
  if (parts.length) return parts.join(" | ");
  if (typeof rationale.summary === "string") return rationale.summary;
  try {
    return JSON.stringify(rationale);
  } catch {
    return String(rationale);
  }
}

/** Страница защиты / редирект по странам вместо JSON (сервер в запрещённой стране). */
export function looksGeoBlocked(r) {
  return r.status === 302 || r.status === 301 || (r.status === 403 && /^\s*<(!doctype|html)/i.test(r.text)) || /help\.elevenlabs\.io/.test(r.text);
}

/** Короткое описание отказа сервиса: detail.status/message из тела, а не весь текст. */
export function describeFailure(r) {
  if (r.error) return `нет ответа (${r.error})`;
  const d = r.json?.detail;
  const msg = typeof d === "string" ? d : d?.message || d?.status || (Array.isArray(d) ? d.map((x) => `${(x.loc || []).join(".")}: ${x.msg}`).join("; ") : "");
  return `код ${r.status}${msg ? `: ${String(msg).slice(0, 300)}` : ""}`;
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Сравнение «что отправили» и «что вернул GET»: отправленное должно ЛЕЖАТЬ в ответе.
 * Массивы строк сравниваются как «содержит все отправленные». Возвращает три списка путей:
 *  accepted — совпало; lost — в ответе нет; changed — в ответе другое значение.
 */
export function compareSent(sent, got, prefix = "") {
  const res = { accepted: [], lost: [], changed: [] };
  const walk = (s, g, p) => {
    if (isObj(s)) {
      if (!isObj(g)) return void (g === undefined || g === null ? res.lost.push(p) : res.changed.push({ path: p, sent: "{…}", got: g }));
      for (const [k, v] of Object.entries(s)) walk(v, g[k], p ? `${p}.${k}` : k);
      return;
    }
    if (Array.isArray(s)) {
      if (!Array.isArray(g)) return void (g === undefined || g === null ? res.lost.push(p) : res.changed.push({ path: p, sent: s, got: g }));
      const prim = s.every((x) => typeof x !== "object");
      if (prim) {
        const miss = s.filter((x) => !g.includes(x));
        return void (miss.length ? res.changed.push({ path: p, sent: miss, got: "нет в ответе" }) : res.accepted.push(p));
      }
      return void (JSON.stringify(s) === JSON.stringify(g) ? res.accepted.push(p) : res.changed.push({ path: p, sent: "[…]", got: "[…]" }));
    }
    if (g === undefined) return void res.lost.push(p);
    if (s === g) return void res.accepted.push(p);
    // 1.15 и "1.15", ulaw_8000 и т.п.: сравниваем строкой, чтобы не шуметь на числах в строке.
    if (String(s) === String(g)) return void res.accepted.push(p);
    res.changed.push({ path: p, sent: s, got: g });
  };
  walk(sent, got, prefix);
  return res;
}

/**
 * Что было в «до» и пропало или изменилось в «после», хотя мы это НЕ отправляли.
 * Так видна замена подобъекта целиком (PATCH без глубокого слияния). Служебные поля
 * (время, версии) не считаются.
 */
export function collateralLoss(before, after, sent) {
  const SKIP = /(^|\.)(version_id|branch_id|created_at|updated_at|main_branch_id|access_info|metadata)(\.|$)/;
  const out = [];
  const touched = (p) => {
    let cur = sent;
    for (const k of p.split(".")) {
      if (!isObj(cur) || !(k in cur)) return false;
      cur = cur[k];
    }
    return true;
  };
  const walk = (b, a, p) => {
    if (SKIP.test(p)) return;
    if (isObj(b)) {
      for (const [k, v] of Object.entries(b)) walk(v, isObj(a) ? a[k] : undefined, p ? `${p}.${k}` : k);
      return;
    }
    if (b === null || b === undefined) return;
    if (touched(p) && !Array.isArray(b)) return; // это поле мы меняли сами
    if (Array.isArray(b)) {
      if (touched(p)) return;
      if (!Array.isArray(a) || JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: p, was: short(b), now: a === undefined ? "нет" : short(a) });
      return;
    }
    if (a === undefined || a === null) out.push({ path: p, was: short(b), now: "нет" });
    else if (a !== b) out.push({ path: p, was: short(b), now: short(a) });
  };
  walk(before, after, "");
  return out;
}
const short = (v) => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > 80 ? t.slice(0, 77) + "…" : t;
};

/** Папка отчётов — ВНЕ git: домашняя папка пользователя (или VOICE_REPORT_DIR). */
export function reportDir(env, stamp) {
  const root = env.VOICE_REPORT_DIR?.trim() || path.join(homedir(), "royalhome-voice-reports");
  const dir = path.join(root, stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}
export function writeReport(dir, name, data, apiKey) {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const file = path.join(dir, name);
  writeFileSync(file, redact(body, apiKey), "utf8");
  return file;
}
export const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

export function parseArgv(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=");
    if (v !== undefined) values[k] = v;
    else flags.add(k);
  }
  return { flags, values };
}

/** Читает ключ из окружения. Возвращает { apiKey, missing: [...] } — значения не печатает. */
export function readEnv(env, names) {
  const missing = names.filter((n) => !env[n]?.trim());
  return { missing };
}
