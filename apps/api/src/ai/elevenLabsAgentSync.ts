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
 *     инструментами ПО СОДЕРЖИМОМУ (11.11.2026): ищется функция с тем же именем,
 *     описанием и параметрами (elevenLabsToolContentKey), нет такой — POST
 *     /v1/convai/tools. Существующие функции НЕ ПРАВЯТСЯ (PATCH tools убран): у
 *     приглашения, опроса после показа и консультанта одно имя end_call с разным
 *     описанием, и правка по имени отдавала всем видам звонка описание того,
 *     кто готовился последним; функции общие на весь аккаунт, правка задевала бы
 *     и других агентов;
 *  2. их id добавляются к агенту (conversation_config.agent.prompt.tool_ids) —
 *     PATCH /v1/convai/agents/{agent_id};
 *  3. там же включаются разрешения на подмену: системный промт, первая фраза,
 *     язык, набор функций, голос (platform_settings.overrides…).
 *
 *  4. (10.11.2026) ВТОРЫМ, отдельным PATCH — настройки телефонного разговора из
 *     ELEVENLABS_PHONE_AGENT_TUNING ниже: модель и темп голоса, формат звука
 *     линии, очередь реплик, заполнители, слова-поддакивания, потолок ответа,
 *     часовой пояс, определение языка ru/tg. Его отказ не отменяет шаги 1–3 и
 *     не роняет звонок: только запись в журнал (buildAgentTuningPatch).
 *
 * Шаги 2–3 шлют промт агента обратно с добавленными id (как до 10.11). Шаг 4
 * шлёт только белый список своих полей. Модель разговора (llm), голос, основной
 * язык и функции владельца не трогаются. Поля из ELEVENLABS_PHONE_AGENT_TUNING
 * ведёт CRM: правка их в кабинете ElevenLabs перезапишется при следующей
 * подготовке агента (первый звонок после перезапуска сервера).
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
 * Замер 11.11.2026 на тестовом агенте (docs/journal/2026-11-11-voice-p2-end-call-per-kind.md):
 *  - две клиентские функции end_call с разным описанием заводятся (разные id),
 *    агент принимает обе в tool_ids, разговор с ними идёт, end_call вызывается;
 *  - подмена tool_ids на разговор принимает ТОЛЬКО прикреплённые к агенту id:
 *    чужой id — закрытие 1008 «Tool IDs not attached to this agent» сразу после
 *    метаданных. Поэтому к агенту прикрепляется объединение функций всех видов
 *    звонка, а на разговор подменяется набор своего вида;
 *  - built_in_tools.end_call = null и platform_settings.privacy.retention_days = 30
 *    принимаются (PATCH 200, GET возвращает).
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

/**
 * СОДЕРЖИМОЕ КЛИЕНТСКОЙ ФУНКЦИИ — ТОЛЬКО ТО, ЧТО ЗАДАЁМ МЫ (11.11.2026).
 * GET /v1/convai/tools отдаёт tool_config шире, чем мы его отправляли: сервис
 * дописывает disable_interruptions, execution_mode, enum: null и т.п. (замер
 * 11.11). Поэтому «полное совпадение» — совпадение проекции на наши поля, одной
 * и той же функцией для нашего объявления и для строки из списка сервиса.
 * enum null / [] — то же, что нет enum; порядок свойств и required не важен.
 */
export function canonicalClientToolContent(cfg: unknown): Json | null {
  if (!isObj(cfg) || cfg.type !== "client" || !str(cfg.name)) return null;
  const params = isObj(cfg.parameters) ? cfg.parameters : {};
  const propsIn = isObj(params.properties) ? params.properties : {};
  const properties: Json = {};
  for (const name of Object.keys(propsIn).sort()) {
    const p = isObj(propsIn[name]) ? propsIn[name] : {};
    const values = Array.isArray(p.enum) ? p.enum.filter((v): v is string => typeof v === "string") : [];
    properties[name] = {
      type: typeof p.type === "string" ? p.type.toLowerCase() : null,
      description: typeof p.description === "string" ? p.description : "",
      ...(values.length > 0 ? { enum: values } : {}),
    };
  }
  const required = Array.isArray(params.required) ? [...new Set(params.required.filter(str))].sort() : [];
  return {
    type: "client",
    name: cfg.name,
    description: typeof cfg.description === "string" ? cfg.description : "",
    parameters: { properties, required },
    expects_response: cfg.expects_response === true,
    response_timeout_secs: typeof cfg.response_timeout_secs === "number" ? cfg.response_timeout_secs : null,
  };
}

/** Ключ функции: имя + хеш содержимого. Одно имя с разным описанием — разные ключи. */
export function elevenLabsToolContentKey(cfg: unknown): string | null {
  const content = canonicalClientToolContent(cfg);
  if (!content) return null;
  return `${String(content.name)}:${createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16)}`;
}

/**
 * ЧТО CRM ДЕРЖИТ НА АГЕНТЕ ПОМИМО ЗВУЧАНИЯ — ОДНО МЕСТО (11.11.2026).
 * Отдельно от ELEVENLABS_PHONE_AGENT_TUNING: тот ведёт звучание, этот — политику.
 *  - retentionDays: разговоры у ElevenLabs хранятся не дольше 30 дней (по
 *    умолчанию -1 — «без предела», api-reference/agents/update). Меньший срок,
 *    заданный владельцем в кабинете, не удлиняется. На прошлые разговоры не
 *    распространяется (apply_to_existing_conversations не шлём — решение владельца).
 *  - disabledBuiltInTools: встроенный end_call выключен — трубку кладёт мост по
 *    НАШЕЙ функции end_call с причиной; встроенный закрыл бы разговор мимо CRM
 *    (без причины), а с нашей функцией того же имени модель видела бы две.
 */
export const ELEVENLABS_AGENT_CRM_POLICY = {
  retentionDays: 30,
  disabledBuiltInTools: ["end_call"],
} as const;

/** Встроенные инструменты агента с выключенными по политике (значение null). */
function withCrmBuiltInPolicy(builtIn: Json): Json {
  const out: Json = { ...builtIn };
  for (const name of ELEVENLABS_AGENT_CRM_POLICY.disabledBuiltInTools) out[name] = null;
  return out;
}

/**
 * platform_settings.privacy для PATCH: срок хранения по политике и простые флаги
 * владельца как были (на случай, если PATCH заменяет подобъект целиком).
 * Прочитанный объект целиком назад не уходит — та же осторожность, что у PATCH №2.
 */
export function buildAgentPrivacyPatch(agent: unknown): Json {
  const platform = isObj(agent) && isObj(agent.platform_settings) ? agent.platform_settings : {};
  const privacy = isObj(platform.privacy) ? platform.privacy : {};
  const out: Json = {};
  for (const flag of ["record_voice", "delete_transcript_and_pii", "delete_audio", "zero_retention_mode"]) {
    if (typeof privacy[flag] === "boolean") out[flag] = privacy[flag];
  }
  const max = ELEVENLABS_AGENT_CRM_POLICY.retentionDays;
  const own = privacy.retention_days;
  out.retention_days = typeof own === "number" && own > 0 && own <= max ? own : max;
  return out;
}

/**
 * НАСТРОЙКИ ТЕЛЕФОННОГО РАЗГОВОРА АГЕНТА — ОДИН ИСТОЧНИК (10.11.2026).
 *
 * Откуда значения: передача 24.10.2026
 * (ветка feat/elevenlabs-voice-agents-24-10, docs/handoff-2026-10-24-elevenlabs-voice-agents.md):
 * подобраны владельцем на живых звонках и 28 симуляциях ElevenLabs —
 * «эмоции звучали наигранно» (expressive выкл), «Мм/Так» раздражали
 * (заполнители выкл), пауза 2 с — долго (eager, turn_timeout 5, speculative_turn).
 * Решение 07.11.2026: голос робота — ElevenLabs (таджикский у Gemini звучит как персидский).
 *
 * Имена полей и допустимые значения — справочник API
 * https://elevenlabs.io/docs/api-reference/agents/create (сверено 10.11.2026):
 *  - tts.model_id: eleven_v4_turbo — по умолчанию у агентов и рекомендован для них;
 *    в его списке языков есть «Tajik (tg)» (https://elevenlabs.io/docs/overview/models,
 *    https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4);
 *  - tts.expressive_mode (по умолчанию true; для моделей не v3 выключается сам — ставим явно);
 *  - tts.agent_output_audio_format / asr.user_input_audio_format: ulaw_8000 —
 *    родной формат телефонной линии, мост тогда не пересчитывает частоту;
 *  - tts.text_normalisation_type: elevenlabs (числа и даты читает сам сервис);
 *  - turn.turn_eagerness: eager, turn.turn_timeout (по умолчанию 7), turn.turn_model,
 *    turn.speculative_turn, turn.soft_timeout_config.timeout_seconds (-1 — выкл),
 *    turn.interruption_ignore_terms (точное совпадение без учёта регистра);
 *  - agent.prompt.max_tokens (-1 — без потолка), agent.prompt.timezone;
 *  - agent.prompt.built_in_tools.language_detection —
 *    https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/language-detection;
 *  - language_presets — второй язык агента, без него подмена языка «tg» на звонок
 *    может быть отклонена (см. повтор без языка в elevenLabsVoiceClient.ts).
 *
 * ⚠️ НЕ ПРОВЕРЕНО на настоящем агенте этим кодом: сверено с документацией и
 * скриптом 24.10 (scripts/elevenlabs/style.mjs, он менял те же поля tts/turn).
 */
export const ELEVENLABS_PHONE_AGENT_TUNING = {
  tts: {
    model_id: "eleven_v4_turbo",
    speed: 1.15,
    stability: 0.45,
    expressive_mode: false,
    agent_output_audio_format: "ulaw_8000",
    text_normalisation_type: "elevenlabs",
  },
  asr: { user_input_audio_format: "ulaw_8000" },
  turn: {
    turn_model: "turn_v3",
    speculative_turn: true,
    turn_eagerness: "eager",
    turn_timeout: 5,
    soft_timeout_config: { timeout_seconds: -1 },
  },
  /**
   * Поддакивания, на которые агент НЕ прерывает свою реплику. Список — ОЦЕНКА по
   * передаче 24.10 («ага/угу/ҳа/хуб…»), владельцу стоит дополнить. Только короткие
   * отклики: «нет», «стоп», «подождите» сюда нельзя — человек должен уметь перебить.
   */
  interruptionIgnoreTerms: [
    "ага", "угу", "мгм", "ммм", "ну да", "да-да", "ясно", "понятно",
    "ҳа", "ҳаа", "ха", "хуб", "бале", "майлӣ", "аҳа",
  ],
  /**
   * max_tokens 300, а не 120 из передачи 24.10: потолок режет и вызов функции, а
   * save_client_request несёт 12 параметров кириллицей (~150–250 токенов) — при 120
   * вызов обрезался бы и заявка не сохранилась. Краткость реплик держит промт.
   */
  prompt: { max_tokens: 300, timezone: "Asia/Dushanbe" },
  /** Второй язык агента (основной — тот, что владелец выбрал в кабинете, обычно ru). */
  secondLanguage: "tg",
} as const;

/** Встроенный инструмент «определить язык» — формат со страницы language-detection. */
const LANGUAGE_DETECTION_TOOL = {
  type: "system",
  name: "language_detection",
  description: "",
  params: { system_tool_type: "language_detection" },
} as const;

export interface ElevenLabsAgentTuningOptions {
  /** Голос для таджикского (Настройки → elevenLabsVoiceIdTg): уходит в пресет языка tg. */
  voiceIdTg?: string | null;
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
 * ПЕРВЫЙ PATCH агента — только то, без чего звонок не работает: его же промт с
 * добавленными id наших функций (старые id не выбрасываются — у владельца могут
 * быть свои) и включённые разрешения на подмену. Форма — как до 10.11.2026.
 * Чистая функция — проверяется тестом.
 */
export function buildAgentSyncPatch(agent: unknown, toolIds: string[]): Json {
  const prompt: Json = { ...readPrompt(agent) };
  // Устаревшее поле `tools` вместе с `tool_ids` API не принимает — оставляем только id.
  delete prompt.tools;
  prompt.tool_ids = mergedToolIds(prompt, toolIds);
  // 11.11.2026: встроенный end_call выключен (ELEVENLABS_AGENT_CRM_POLICY) — в первом PATCH,
  // потому что он и есть «без чего звонок не работает как надо»: иначе агент кладёт трубку мимо CRM.
  prompt.built_in_tools = withCrmBuiltInPolicy(isObj(prompt.built_in_tools) ? prompt.built_in_tools : {});
  const platform = isObj(agent) && isObj(agent.platform_settings) ? agent.platform_settings : {};
  return {
    conversation_config: { agent: { prompt } },
    platform_settings: {
      overrides: deepMerge(platform.overrides ?? {}, ELEVENLABS_REQUIRED_OVERRIDES),
      privacy: buildAgentPrivacyPatch(agent),
    },
  };
}

function readConfig(agent: unknown): Json {
  return isObj(agent) && isObj(agent.conversation_config) ? agent.conversation_config : {};
}

function readPrompt(agent: unknown): Json {
  const agentCfg = readConfig(agent).agent;
  return isObj(agentCfg) && isObj(agentCfg.prompt) ? agentCfg.prompt : {};
}

function mergedToolIds(prompt: Json, toolIds: string[]): string[] {
  const existing = Array.isArray(prompt.tool_ids) ? prompt.tool_ids.filter((x): x is string => typeof x === "string") : [];
  return [...new Set([...existing, ...toolIds])];
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * ВТОРОЙ PATCH агента — настройки телефонного разговора (ELEVENLABS_PHONE_AGENT_TUNING).
 * Прочитанные tts/asr/turn/language_presets ЦЕЛИКОМ обратно НЕ уходят: схема ответа
 * GET и схема ввода PATCH могут расходиться, и чужое поле уронило бы всю правку.
 * Уходит белый список: наши поля плюс несколько простых полей владельца
 * (строки, числа, списки строк), которые нельзя потерять.
 *
 * НЕТ ДАННЫХ: сливает ли PATCH /v1/convai/agents вложенные объекты глубоко или
 * заменяет подобъект целиком — справочник (api-reference/agents/update, 10.11.2026)
 * об этом молчит. Поэтому в каждый подобъект добавлено то, что нельзя потерять при
 * замене: в prompt — текст, llm, temperature, tool_ids и встроенные инструменты
 * (end_call и прочие); в tts — voice_id; в asr — provider и keywords. При замене
 * целиком сбросятся к умолчаниям прочие поля tts/asr/turn и прочие пресеты языков
 * (кроме tg), а у prompt — база знаний и прочее, чего нет в списке. Проверить на
 * тестовом агенте до включения на проде.
 * Чистая функция — проверяется тестом.
 */
export function buildAgentTuningPatch(agent: unknown, toolIds: string[], opts: ElevenLabsAgentTuningOptions = {}): Json {
  const T = ELEVENLABS_PHONE_AGENT_TUNING;
  const config = readConfig(agent);
  const promptIn = readPrompt(agent);

  const prompt: Json = {};
  if (str(promptIn.prompt)) prompt.prompt = promptIn.prompt;
  if (str(promptIn.llm)) prompt.llm = promptIn.llm;
  if (typeof promptIn.temperature === "number") prompt.temperature = promptIn.temperature;
  prompt.tool_ids = mergedToolIds(promptIn, toolIds);
  prompt.max_tokens = T.prompt.max_tokens;
  prompt.timezone = T.prompt.timezone;
  const builtIn = isObj(promptIn.built_in_tools) ? promptIn.built_in_tools : {};
  // Политика CRM поверх: снимок агента взят ДО первого PATCH, и без неё второй PATCH вернул бы
  // встроенный end_call, если он был включён в кабинете.
  prompt.built_in_tools = withCrmBuiltInPolicy({ ...builtIn, language_detection: LANGUAGE_DETECTION_TOOL });

  const ttsIn = isObj(config.tts) ? config.tts : {};
  const tts: Json = { ...T.tts };
  if (str(ttsIn.voice_id)) tts.voice_id = ttsIn.voice_id;

  const asrIn = isObj(config.asr) ? config.asr : {};
  const asr: Json = { ...T.asr };
  if (str(asrIn.provider)) asr.provider = asrIn.provider;
  if (Array.isArray(asrIn.keywords)) asr.keywords = asrIn.keywords.filter(str);

  const turnIn = isObj(config.turn) ? config.turn : {};
  const ownTerms = Array.isArray(turnIn.interruption_ignore_terms) ? turnIn.interruption_ignore_terms.filter(str) : [];
  const turn: Json = {
    ...T.turn,
    soft_timeout_config: { ...T.turn.soft_timeout_config },
    // Слова владельца не теряются: объединение, а не замена.
    interruption_ignore_terms: [...new Set([...ownTerms, ...T.interruptionIgnoreTerms])],
  };

  const voiceIdTg = opts.voiceIdTg?.trim();
  const presetOverrides: Json = voiceIdTg ? { tts: { voice_id: voiceIdTg } } : {};

  return {
    conversation_config: {
      agent: { prompt },
      tts,
      asr,
      turn,
      language_presets: { [T.secondLanguage]: { overrides: presetOverrides } },
    },
  };
}

interface ElevenLabsToolRow {
  id?: string;
  tool_config?: unknown;
}

/** Страниц списка функций не больше этого (по 100 — потолок page_size, замер 11.11: 101 → 422). */
const TOOL_LIST_MAX_PAGES = 10;

/** Все клиентские функции аккаунта. Список постраничный (has_more / next_cursor): прежнее
 *  чтение одной страницы (30 по умолчанию) с ростом числа функций заводило бы дубли. */
async function listElevenLabsClientTools(apiKey: string): Promise<ElevenLabsToolRow[]> {
  const rows: ElevenLabsToolRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < TOOL_LIST_MAX_PAGES; page++) {
    const q = new URLSearchParams({ types: "client", page_size: "100" });
    if (cursor) q.set("cursor", cursor);
    const res = await elevenLabsRequest<{ tools?: ElevenLabsToolRow[]; has_more?: boolean; next_cursor?: string | null }>(
      apiKey,
      "GET",
      `/v1/convai/tools?${q.toString()}`
    );
    rows.push(...(res.tools ?? []));
    if (!res.has_more || !res.next_cursor) return rows;
    cursor = res.next_cursor;
  }
  void logSystemError(
    "telephony",
    `Живой голос (ElevenLabs): функций в аккаунте больше ${TOOL_LIST_MAX_PAGES * 100} — список прочитан не весь, ` +
      "возможны дубли функций. Удалите в кабинете ElevenLabs старые клиентские функции.",
    { dedupKey: "elevenlabs-tool-list-cap" }
  );
  return rows;
}

/** Заведение функции в полёте по ключу содержимого: два вида звонка, готовящиеся разом,
 *  с одинаковой функцией (save_contact) не заводят две копии. */
const toolCreateInFlight = new Map<string, Promise<string>>();

function createToolOnce(apiKey: string, key: string, tool_config: Record<string, unknown>, name: string): Promise<string> {
  const existing = toolCreateInFlight.get(key);
  if (existing) return existing;
  const pending = elevenLabsRequest<{ id?: string }>(apiKey, "POST", "/v1/convai/tools", { tool_config }).then((created) => {
    if (!created.id) throw new ElevenLabsHttpError(`ElevenLabs: инструмент ${name} создан без id`, null);
    return created.id;
  });
  toolCreateInFlight.set(key, pending);
  void pending.finally(() => {
    if (toolCreateInFlight.get(key) === pending) toolCreateInFlight.delete(key);
  }).catch(() => {});
  return pending;
}

/**
 * id функций этого набора: по ключу содержимого среди уже заведённых (предпочтение —
 * уже прикреплённым к агенту), иначе новая функция. Существующие не правятся.
 */
async function ensureElevenLabsTools(
  apiKey: string,
  tools: LiveVoiceFunctionDeclaration[],
  attachedIds: ReadonlySet<string>
): Promise<Map<string, string>> {
  const names = tools.map((t) => t.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  // Внутри одного звонка имя — ключ ответа (ids по имени) и имя вызова: двойник потерялся бы молча.
  if (dup) throw new ElevenLabsHttpError(`ElevenLabs: в наборе функций звонка имя ${dup} повторяется`, null);
  const byContent = new Map<string, string>();
  for (const row of await listElevenLabsClientTools(apiKey)) {
    const key = row.id ? elevenLabsToolContentKey(row.tool_config) : null;
    if (!key || !row.id) continue;
    if (!byContent.has(key) || (attachedIds.has(row.id) && !attachedIds.has(byContent.get(key)!))) byContent.set(key, row.id);
  }
  const ids = new Map<string, string>();
  await Promise.all(
    tools.map(async (decl) => {
      const tool_config = toElevenLabsClientTool(decl);
      const key = elevenLabsToolContentKey(tool_config)!;
      ids.set(decl.name, byContent.get(key) ?? (await createToolOnce(apiKey, key, tool_config, decl.name)));
    })
  );
  return ids;
}

/**
 * Подготовки одного агента идут по очереди (11.11.2026). Каждая читает агента и пишет
 * tool_ids = прочитанные ∪ свои; две разом (консультант и исходящий в одну минуту)
 * затирали бы id друг друга, и подмена набора у проигравшего падала бы 1008
 * «Tool IDs not attached». Очередь — в пределах процесса.
 */
const agentSyncQueue = new Map<string, Promise<unknown>>();

function serializePerAgent<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = agentSyncQueue.get(agentId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  agentSyncQueue.set(agentId, tail);
  void tail.then(() => {
    if (agentSyncQueue.get(agentId) === tail) agentSyncQueue.delete(agentId);
  });
  return run;
}

/** Итог подготовки агента: id функций и приняты ли настройки разговора. */
export interface ElevenLabsAgentSyncOutcome {
  ids: Map<string, string>;
  /** Второй PATCH (настройки разговора) принят. */
  tuned: boolean;
  /** Почему не принят — для кнопки проверки в Настройках. */
  tuningError: string | null;
}

/**
 * Завести или обновить наши функции, прикрепить их к агенту (первый PATCH), затем
 * выставить настройки разговора (второй PATCH). Бросает только при отказе первой
 * части: без неё подмена промта и функций на звонок не работает.
 */
export async function syncElevenLabsAgentDetailed(
  apiKey: string,
  agentId: string,
  tools: LiveVoiceFunctionDeclaration[],
  opts: ElevenLabsAgentTuningOptions = {}
): Promise<ElevenLabsAgentSyncOutcome> {
  return serializePerAgent(agentId, () => syncElevenLabsAgentNow(apiKey, agentId, tools, opts));
}

async function syncElevenLabsAgentNow(
  apiKey: string,
  agentId: string,
  tools: LiveVoiceFunctionDeclaration[],
  opts: ElevenLabsAgentTuningOptions
): Promise<ElevenLabsAgentSyncOutcome> {
  const agentPath = `/v1/convai/agents/${encodeURIComponent(agentId)}`;
  const agent = await elevenLabsRequest(apiKey, "GET", agentPath);
  // Без функций список инструментов не нужен, а настройки разговора — нужны.
  const ids =
    tools.length > 0 ? await ensureElevenLabsTools(apiKey, tools, new Set(mergedToolIds(readPrompt(agent), []))) : new Map<string, string>();
  await elevenLabsRequest(apiKey, "PATCH", agentPath, buildAgentSyncPatch(agent, [...ids.values()]));
  try {
    await elevenLabsRequest(apiKey, "PATCH", agentPath, buildAgentTuningPatch(agent, [...ids.values()], opts));
    return { ids, tuned: true, tuningError: null };
  } catch (err) {
    const detail = describeError(err);
    void logSystemError(
      "telephony",
      `Живой голос (ElevenLabs): агент ${agentId} не принял настройки разговора (${detail}) — функции и подмены ` +
        "заведены, звонки идут со звучанием из кабинета. Повтор — не раньше чем через " +
        `${ELEVENLABS_SYNC_RETRY_PAUSE_MS / 60_000} мин.`,
      { dedupKey: "elevenlabs-agent-tuning" }
    );
    return { ids, tuned: false, tuningError: detail };
  }
}

/** То же, что syncElevenLabsAgentDetailed, — только id функций. */
export async function syncElevenLabsAgent(
  apiKey: string,
  agentId: string,
  tools: LiveVoiceFunctionDeclaration[],
  opts: ElevenLabsAgentTuningOptions = {}
): Promise<Map<string, string>> {
  return (await syncElevenLabsAgentDetailed(apiKey, agentId, tools, opts)).ids;
}

/**
 * Пауза после неудачи (10.11.2026): без неё каждый звонок при сломанном ключе или
 * сети тратил до ELEVENLABS_SYNC_BUDGET_MS на повтор, а человек ждал в тишине.
 * Отказ первой части — звонки без подготовки до конца паузы; отказ только
 * настроек — id функций берутся из памяти, настройки повторяются в фоне после паузы.
 */
export const ELEVENLABS_SYNC_RETRY_PAUSE_MS = 5 * 60_000;

/** Подготовка в полёте: агент + набор функций + настройки → итог. */
const syncInFlight = new Map<string, Promise<ElevenLabsAgentSyncOutcome>>();
/** Готовые подготовки в этом процессе. Набор функций у консультанта, исходящего
 *  звонка и сценариев разный — каждый готовится один раз. */
const syncDone = new Map<string, { outcome: ElevenLabsAgentSyncOutcome; at: number }>();
/** До какого времени не пытаться снова после отказа первой части (или потолка времени). */
const syncPausedUntil = new Map<string, number>();

function syncKey(agentId: string, tools: LiveVoiceFunctionDeclaration[], opts: ElevenLabsAgentTuningOptions): string {
  // Сменился таджикский голос или настройки — агент готовится заново.
  // Ключ — по СОДЕРЖИМОМУ набора (имя + описание + параметры каждой функции): у приглашения
  // и опроса после показа одно имя end_call, но наборы разные — каждый готовится и
  // помнится отдельно со своими id (11.11.2026).
  const toolKeys = tools.map((t) => elevenLabsToolContentKey(toElevenLabsClientTool(t)));
  const payload = JSON.stringify([toolKeys, opts.voiceIdTg?.trim() || null, ELEVENLABS_PHONE_AGENT_TUNING, ELEVENLABS_AGENT_CRM_POLICY]);
  return `${agentId}:${createHash("sha256").update(payload).digest("hex")}`;
}

/**
 * Забыть подготовки агента (11.11.2026): ElevenLabs закрыл разговор 1008 «Tool IDs not
 * attached to this agent» — значит, наши id с агента сняли (правка в кабинете, другой
 * скрипт). Без этого память процесса отдавала бы те же id до перезапуска, и каждый
 * звонок падал бы так же. Следующий звонок подготовит агента заново.
 */
export function forgetElevenLabsAgentSync(agentId: string): void {
  const prefix = `${agentId}:`;
  for (const map of [syncDone, syncPausedUntil]) {
    for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
  }
}

/** Закрытие разговора ElevenLabs из-за того, что подменённые функции не прикреплены к агенту
 *  (замер 11.11: код 1008, «Tool IDs not attached to this agent: [...]»). */
export function isElevenLabsToolsNotAttachedClose(code: number, reason: string): boolean {
  return code === 1008 && /tool ids? not attached/i.test(reason);
}

function startSync(
  key: string,
  apiKey: string,
  agentId: string,
  tools: LiveVoiceFunctionDeclaration[],
  opts: ElevenLabsAgentTuningOptions
): Promise<ElevenLabsAgentSyncOutcome> {
  const existing = syncInFlight.get(key);
  if (existing) return existing;
  const pending = syncElevenLabsAgentDetailed(apiKey, agentId, tools, opts);
  syncInFlight.set(key, pending);
  pending.then(
    (outcome) => {
      syncDone.set(key, { outcome, at: Date.now() });
      syncPausedUntil.delete(key);
    },
    () => {
      syncPausedUntil.set(key, Date.now() + ELEVENLABS_SYNC_RETRY_PAUSE_MS);
    }
  ).finally(() => {
    if (syncInFlight.get(key) === pending) syncInFlight.delete(key);
  });
  return pending;
}

/**
 * Подготовка агента перед звонком — не бросает: не вышло (ключ без прав, сеть,
 * потолок времени) — в журнал и null. Звонок тогда идёт без подмены набора
 * функций: если владелец завёл их в кабинете руками, они всё равно сработают.
 */
export async function ensureElevenLabsAgentReady(
  apiKey: string,
  agentId: string,
  tools: LiveVoiceFunctionDeclaration[],
  opts: ElevenLabsAgentTuningOptions = {}
): Promise<Map<string, string> | null> {
  // Звонок без функций тоже готовит агента: настройки разговора (темп, очередь
  // реплик, язык) нужны любому звонку. Прежний ранний выход их пропускал.
  const key = syncKey(agentId, tools, opts);
  const now = Date.now();
  const paused = (syncPausedUntil.get(key) ?? 0) > now;
  const done = syncDone.get(key);
  if (done) {
    // Настройки не приняты — повтор в фоне после паузы; звонок не ждёт.
    if (!done.outcome.tuned && !paused && now - done.at >= ELEVENLABS_SYNC_RETRY_PAUSE_MS) {
      startSync(key, apiKey, agentId, tools, opts).catch(() => {});
    }
    return done.outcome.ids;
  }
  // Недавно не вышло — звонок идёт сразу, без нового ожидания (в журнале уже есть).
  if (paused) return null;
  const pending = startSync(key, apiKey, agentId, tools, opts);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const outcome = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`не уложились в ${ELEVENLABS_SYNC_BUDGET_MS / 1000} с`)), ELEVENLABS_SYNC_BUDGET_MS);
        timer.unref?.();
      }),
    ]);
    return outcome.ids;
  } catch (err) {
    // Потолок времени: подготовка ещё идёт, но следующие звонки её не ждут.
    // Успеет позже — пауза снимется сама (startSync).
    if (!syncDone.has(key)) syncPausedUntil.set(key, Date.now() + ELEVENLABS_SYNC_RETRY_PAUSE_MS);
    void logSystemError(
      "telephony",
      `Живой голос (ElevenLabs): агент ${agentId} не подготовлен под наши функции (${describeError(err)}) — ` +
        "звонок идёт с теми функциями и настройками, что заведены у агента в кабинете. Повтор — не раньше чем через " +
        `${ELEVENLABS_SYNC_RETRY_PAUSE_MS / 60_000} мин.`,
      { dedupKey: "elevenlabs-agent-sync" }
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Только для тестов. */
export function resetElevenLabsSyncCacheForTests(): void {
  syncInFlight.clear();
  syncDone.clear();
  syncPausedUntil.clear();
  toolCreateInFlight.clear();
  agentSyncQueue.clear();
}
