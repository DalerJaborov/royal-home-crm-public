import { createHash } from "node:crypto";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";
import type { LiveVoiceFunctionDeclaration } from "./liveVoiceClient.js";

/**
 * ПОДГОТОВКА АГЕНТА ELEVENLABS ПОД НАШИ ФУНКЦИИ (02.10.2026).
 *
 * Агент ElevenLabs вызывает «клиентские функции» (client tools) только если они
 * ЗАРАНЕЕ объявлены у агента, а подменять промт, первую фразу, язык и голос на
 * один разговор можно только если это разрешено в его настройках безопасности
 * (по умолчанию всё запрещено). Владелец заводит агента в своём кабинете сам —
 * этот модуль доделывает остальное через REST API ElevenLabs:
 *
 *  1. наши объявления функций (те же, что получает Gemini) заводятся отдельными
 *     инструментами: POST /v1/convai/tools, при совпадении имени — PATCH
 *     /v1/convai/tools/{id};
 *  2. их id добавляются к агенту (conversation_config.agent.prompt.tool_ids) —
 *     PATCH /v1/convai/agents/{agent_id};
 *  3. там же включаются разрешения на подмену: системный промт, первая фраза,
 *     язык, набор функций, голос (platform_settings.overrides…).
 *
 * Агент читается целиком и отправляется обратно с правкой только этих полей:
 * выбранная владельцем модель (llm), голос, языки и прочее не трогаются.
 *
 * Источники (сверено 02.10.2026):
 *  - https://elevenlabs.io/docs/api-reference/tools/create — POST /v1/convai/tools,
 *    тело { tool_config: { type: "client", name, description, parameters,
 *    expects_response, response_timeout_secs } };
 *  - https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides
 *    — какие поля можно подменять и что они выключены по умолчанию;
 *  - модели SDK elevenlabs-python (types/client_tool_config_input.py,
 *    prompt_agent_api_model_input.py: tool_ids; agent_config_override_config.py,
 *    prompt_agent_api_model_override_config.py, tts_conversational_config_override_config.py,
 *    conversation_initiation_client_data_config_input.py) — точные имена полей;
 *  - ключ — заголовок xi-api-key (core/client_wrapper.py).
 *
 * ⚠️ НЕ ПРОВЕРЕНО НА НАСТОЯЩЕМ КЛЮЧЕ: из облачной сессии api.elevenlabs.io закрыт.
 */

/** Адрес REST API. Рычаг на случай, если сервер ходит к ElevenLabs через прокси. */
export function elevenLabsApiBase(): string {
  return (process.env.ELEVENLABS_API_BASE?.trim() || "https://api.elevenlabs.io").replace(/\/+$/, "");
}

/** Потолок одного запроса к REST API: звонок ждёт подготовку, тянуть нельзя. */
export const ELEVENLABS_HTTP_TIMEOUT_MS = 8_000;
/** Потолок всей подготовки агента перед звонком. */
export const ELEVENLABS_SYNC_BUDGET_MS = 12_000;
/** Сколько агент ждёт ответа нашей функции (поиск квартир ходит в базу). */
const TOOL_RESPONSE_TIMEOUT_SECS = 30;

export class ElevenLabsHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
  }
}

/** Один запрос к REST API ElevenLabs с явным таймаутом. Ответ — разобранный JSON. */
export async function elevenLabsRequest<T = unknown>(
  apiKey: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${elevenLabsApiBase()}${path}`, {
      method,
      headers: { "xi-api-key": apiKey, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(ELEVENLABS_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ElevenLabsHttpError(`ElevenLabs ${method} ${path}: нет ответа (${describeError(err)})`, null);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    // 10.10.2026: ElevenLabs не пускает адреса некоторых стран (сервер CRM — у хостера в РФ): запрос
    // уходит редиректом на страницу «ограничения по странам», а за ней стоит защита Cloudflare («Just a
    // moment…», 403). Раньше это читалось как «у ключа нет прав» — владелец искал ошибку в ключе.
    if (res.redirected || /help\.elevenlabs\.io/.test(res.url) || /^\s*<(!doctype|html)/i.test(text)) {
      throw new ElevenLabsHttpError(
        `ElevenLabs ${method} ${path}: сервис не пускает запросы с адреса сервера CRM (ответ — страница защиты, а не ответ API). ` +
          "Дело не в ключе: нужен посредник в поддерживаемой стране (ELEVENLABS_API_BASE) или другой исходящий адрес.",
        res.status
      );
    }
    const hint =
      res.status === 401
        ? "ключ не принят"
        : res.status === 403
          ? "у ключа нет прав на агентов"
          : res.status === 404
            ? "не найдено (проверьте id агента)"
            : `код ${res.status}`;
    throw new ElevenLabsHttpError(`ElevenLabs ${method} ${path}: ${hint}. ${text.slice(0, 300)}`, res.status);
  }
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new ElevenLabsHttpError(`ElevenLabs ${method} ${path}: ответ не JSON`, res.status);
  }
}

/** Наше объявление функции (формат Gemini) → клиентский инструмент ElevenLabs.
 *  Типы Gemini пишутся заглавными (STRING), JSON Schema ElevenLabs — строчными. */
export function toElevenLabsClientTool(decl: LiveVoiceFunctionDeclaration): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [name, prop] of Object.entries(decl.parameters.properties)) {
    properties[name] = {
      type: prop.type.toLowerCase(),
      description: prop.description,
      ...(prop.enum && prop.enum.length > 0 ? { enum: prop.enum } : {}),
    };
  }
  return {
    type: "client",
    name: decl.name,
    description: decl.description,
    parameters: { type: "object", properties, required: decl.parameters.required ?? [] },
    // Ответ нашей функции нужен модели (найденные квартиры, «СМС ушла»), поэтому
    // разговор ждёт его — как блокирующий вызов у Gemini.
    expects_response: true,
    response_timeout_secs: TOOL_RESPONSE_TIMEOUT_SECS,
  };
}

/** Разрешения на подмену, которые нужны нашему разговору. */
export const ELEVENLABS_REQUIRED_OVERRIDES = {
  conversation_config_override: {
    agent: { prompt: { prompt: true, tool_ids: true }, first_message: true, language: true },
    tts: { voice_id: true },
  },
} as const;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Глубокое слияние: значения b поверх a, вложенные объекты сливаются. */
function deepMerge(a: unknown, b: unknown): unknown {
  if (!isObj(a) || !isObj(b)) return b;
  const out: Json = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}

/**
 * Тело PATCH агента: его же промт с добавленными id наших функций (старые id не
 * выбрасываются — у владельца могут быть свои), и включённые разрешения на
 * подмену. Чистая функция — проверяется тестом.
 */
export function buildAgentSyncPatch(agent: unknown, toolIds: string[]): Json {
  const config = isObj(agent) && isObj(agent.conversation_config) ? agent.conversation_config : {};
  const agentCfg = isObj(config.agent) ? config.agent : {};
  const prompt: Json = isObj(agentCfg.prompt) ? { ...agentCfg.prompt } : {};
  const existingIds = Array.isArray(prompt.tool_ids) ? prompt.tool_ids.filter((x): x is string => typeof x === "string") : [];
  // Устаревшее поле `tools` вместе с `tool_ids` API не принимает — оставляем только id.
  delete prompt.tools;
  prompt.tool_ids = [...new Set([...existingIds, ...toolIds])];
  const platform = isObj(agent) && isObj(agent.platform_settings) ? agent.platform_settings : {};
  return {
    conversation_config: { agent: { prompt } },
    platform_settings: { overrides: deepMerge(platform.overrides ?? {}, ELEVENLABS_REQUIRED_OVERRIDES) },
  };
}

interface ElevenLabsToolRow {
  id?: string;
  tool_config?: { type?: string; name?: string };
}

/** Завести или обновить наши функции и прикрепить их к агенту. Имя функции → id. */
export async function syncElevenLabsAgent(
  apiKey: string,
  agentId: string,
  tools: LiveVoiceFunctionDeclaration[]
): Promise<Map<string, string>> {
  const listed = await elevenLabsRequest<{ tools?: ElevenLabsToolRow[] }>(apiKey, "GET", "/v1/convai/tools");
  const byName = new Map<string, string>();
  for (const row of listed.tools ?? []) {
    if (row.id && row.tool_config?.type === "client" && row.tool_config.name) byName.set(row.tool_config.name, row.id);
  }
  const ids = new Map<string, string>();
  await Promise.all(
    tools.map(async (decl) => {
      const tool_config = toElevenLabsClientTool(decl);
      const existing = byName.get(decl.name);
      if (existing) {
        await elevenLabsRequest(apiKey, "PATCH", `/v1/convai/tools/${encodeURIComponent(existing)}`, { tool_config });
        ids.set(decl.name, existing);
      } else {
        const created = await elevenLabsRequest<{ id?: string }>(apiKey, "POST", "/v1/convai/tools", { tool_config });
        if (!created.id) throw new ElevenLabsHttpError(`ElevenLabs: инструмент ${decl.name} создан без id`, null);
        ids.set(decl.name, created.id);
      }
    })
  );
  const agentPath = `/v1/convai/agents/${encodeURIComponent(agentId)}`;
  const agent = await elevenLabsRequest(apiKey, "GET", agentPath);
  await elevenLabsRequest(apiKey, "PATCH", agentPath, buildAgentSyncPatch(agent, [...ids.values()]));
  return ids;
}

/** Готовые подготовки в этом процессе: агент + набор функций → имя→id. Набор
 *  функций у консультанта, исходящего звонка и сценариев разный — каждый
 *  готовится один раз, дальше звонки идут без лишних запросов. */
const syncCache = new Map<string, Promise<Map<string, string>>>();

function syncKey(agentId: string, tools: LiveVoiceFunctionDeclaration[]): string {
  return `${agentId}:${createHash("sha256").update(JSON.stringify(tools)).digest("hex")}`;
}

/**
 * Подготовка агента перед звонком — не бросает: не вышло (ключ без прав, сеть,
 * потолок времени) — в журнал и null. Звонок тогда идёт без подмены набора
 * функций: если владелец завёл их в кабинете руками, они всё равно сработают.
 */
export async function ensureElevenLabsAgentReady(
  apiKey: string,
  agentId: string,
  tools: LiveVoiceFunctionDeclaration[]
): Promise<Map<string, string> | null> {
  if (tools.length === 0) return new Map();
  const key = syncKey(agentId, tools);
  let pending = syncCache.get(key);
  if (!pending) {
    pending = syncElevenLabsAgent(apiKey, agentId, tools);
    syncCache.set(key, pending);
    // Неудача не кешируется: следующий звонок попробует заново.
    pending.catch(() => syncCache.delete(key));
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`не уложились в ${ELEVENLABS_SYNC_BUDGET_MS / 1000} с`)), ELEVENLABS_SYNC_BUDGET_MS);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    void logSystemError(
      "telephony",
      `Живой голос (ElevenLabs): агент ${agentId} не подготовлен под наши функции (${describeError(err)}) — ` +
        "звонок идёт с теми функциями, что заведены у агента в кабинете.",
      { dedupKey: "elevenlabs-agent-sync" }
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Только для тестов. */
export function resetElevenLabsSyncCacheForTests(): void {
  syncCache.clear();
}
