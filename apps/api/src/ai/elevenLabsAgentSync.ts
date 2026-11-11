import { createHash } from "node:crypto";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";
import type { LiveVoiceFunctionDeclaration } from "./liveVoiceClient.js";
import {
  approvedTajikPronunciationRules,
  mergeAsrKeywords,
  TAJIK_ASR_KEYWORDS,
  TAJIK_DICTIONARY_NAME_PREFIX,
  tajikDictionaryName,
  tajikDictionaryRequest,
  type TajikPronunciationRule,
} from "./tajikVoiceLexicon.js";

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
    /**
     * system_prompt, а не elevenlabs (11.11.2026, замер на eleven_v4_turbo с языком tg):
     * нормализатор ElevenLabs читает таджикские цифры с ошибками — «80» распознано
     * как «82»/«800», «1 380 000» как «1 382 000», «10:30» как «даҳ сиву даҳ»; те же
     * числа словами — верно. При system_prompt сервис просит модель писать числа
     * словами в самом промте, а наши функции и так отдают цены словами
     * (packages/shared/spokenNumber). Подробно — ai/tajikPhoneSpeech.ts.
     */
    text_normalisation_type: "system_prompt",
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
  /**
   * Таджикский словарь произношения (ai/tajikVoiceLexicon.ts), найденный или
   * заведённый в аккаунте перед PATCH. Не задан — словари агента не меняются.
   */
  tajikPronunciation?: TajikPronunciationSync;
}

/** Ссылка на словарь произношения в формате агента. */
export interface PronunciationLocator {
  pronunciation_dictionary_id: string;
  version_id: string | null;
}

export interface TajikPronunciationSync {
  /** Наш словарь текущей версии; null — подтверждённых правил нет, наш словарь снять. */
  locator: PronunciationLocator | null;
  /** id всех наших словарей в аккаунте (любой версии) — их снимаем, словари владельца оставляем. */
  ourIds: string[];
}

/** Сколько словарей ElevenLabs принимает на один синтез (справочник TTS: «up to 3»). */
const PRONUNCIATION_LOCATORS_MAX = 3;

/** Словари агента после подготовки: наш первым, словари владельца целы, наши старые сняты. */
export function mergePronunciationLocators(existing: unknown, sync: TajikPronunciationSync): PronunciationLocator[] {
  const drop = new Set(sync.ourIds);
  const owner: PronunciationLocator[] = [];
  for (const raw of Array.isArray(existing) ? existing : []) {
    if (!isObj(raw) || !str(raw.pronunciation_dictionary_id) || drop.has(raw.pronunciation_dictionary_id)) continue;
    if (sync.locator && raw.pronunciation_dictionary_id === sync.locator.pronunciation_dictionary_id) continue;
    owner.push({ pronunciation_dictionary_id: raw.pronunciation_dictionary_id, version_id: str(raw.version_id) ? raw.version_id : null });
  }
  return [...(sync.locator ? [sync.locator] : []), ...owner].slice(0, PRONUNCIATION_LOCATORS_MAX);
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
  const platform = isObj(agent) && isObj(agent.platform_settings) ? agent.platform_settings : {};
  return {
    conversation_config: { agent: { prompt } },
    platform_settings: { overrides: deepMerge(platform.overrides ?? {}, ELEVENLABS_REQUIRED_OVERRIDES) },
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
  prompt.built_in_tools = { ...builtIn, language_detection: LANGUAGE_DETECTION_TOOL };

  const ttsIn = isObj(config.tts) ? config.tts : {};
  const tts: Json = { ...T.tts };
  if (str(ttsIn.voice_id)) tts.voice_id = ttsIn.voice_id;
  // Словари произношения: при замене подобъекта tts целиком словари владельца
  // пропали бы — поэтому они уходят всегда, наш таджикский — первым.
  if (opts.tajikPronunciation) {
    tts.pronunciation_dictionary_locators = mergePronunciationLocators(ttsIn.pronunciation_dictionary_locators, opts.tajikPronunciation);
  } else if (Array.isArray(ttsIn.pronunciation_dictionary_locators) && ttsIn.pronunciation_dictionary_locators.length > 0) {
    tts.pronunciation_dictionary_locators = mergePronunciationLocators(ttsIn.pronunciation_dictionary_locators, { locator: null, ourIds: [] });
  }

  const asrIn = isObj(config.asr) ? config.asr : {};
  const asr: Json = { ...T.asr };
  if (str(asrIn.provider)) asr.provider = asrIn.provider;
  // Слова распознавания: слова владельца первыми, затем таджикские районы и
  // слова рынка (ai/tajikVoiceLexicon.ts), в пределах Scribe Realtime.
  asr.keywords = mergeAsrKeywords(Array.isArray(asrIn.keywords) ? asrIn.keywords.filter(str) : []);

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
  tool_config?: { type?: string; name?: string };
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
  // Без функций список инструментов не нужен, а настройки разговора — нужны.
  const listed: { tools?: ElevenLabsToolRow[] } =
    tools.length > 0 ? await elevenLabsRequest<{ tools?: ElevenLabsToolRow[] }>(apiKey, "GET", "/v1/convai/tools") : {};
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
  const tajikPronunciation = await syncTajikPronunciationDictionary(apiKey, agent);
  try {
    await elevenLabsRequest(
      apiKey,
      "PATCH",
      agentPath,
      buildAgentTuningPatch(agent, [...ids.values()], tajikPronunciation ? { ...opts, tajikPronunciation } : opts)
    );
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

/** Сколько страниц списка словарей читаем (по 100): дальше — не наш случай. */
const DICTIONARY_LIST_MAX_PAGES = 5;

interface DictionaryRow {
  id?: string;
  name?: string;
  latest_version_id?: string;
  archived_time_unix?: number | null;
}

/**
 * Таджикский словарь произношения в аккаунте ElevenLabs (11.11.2026). Правила —
 * в коде (ai/tajikVoiceLexicon.ts, только подтверждённые владельцем); словарь
 * заводится сам под именем с отпечатком правил, правка правил — новый словарь.
 *
 * Не трогает сеть вовсе, если подтверждённых правил нет и у агента нет ни одного
 * словаря (так сейчас). Отказ — undefined и запись в журнал: словари агента
 * тогда не меняются, звонок и прочие настройки идут как обычно.
 */
export async function syncTajikPronunciationDictionary(
  apiKey: string,
  agent: unknown,
  rules: TajikPronunciationRule[] = approvedTajikPronunciationRules()
): Promise<TajikPronunciationSync | undefined> {
  const tts = readConfig(agent).tts;
  const attached = isObj(tts) && Array.isArray(tts.pronunciation_dictionary_locators) ? tts.pronunciation_dictionary_locators : [];
  if (rules.length === 0 && attached.length === 0) return undefined;
  try {
    const rows: DictionaryRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < DICTIONARY_LIST_MAX_PAGES; page++) {
      const q: string = `?page_size=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await elevenLabsRequest<{ pronunciation_dictionaries?: DictionaryRow[]; next_cursor?: string | null; has_more?: boolean }>(
        apiKey,
        "GET",
        `/v1/pronunciation-dictionaries${q}`
      );
      rows.push(...(res.pronunciation_dictionaries ?? []));
      cursor = res.has_more && res.next_cursor ? res.next_cursor : null;
      if (!cursor) break;
    }
    const ours = rows.filter((r) => str(r.id) && str(r.name) && r.name.startsWith(TAJIK_DICTIONARY_NAME_PREFIX));
    const ourIds = ours.map((r) => r.id as string);
    if (rules.length === 0) return { locator: null, ourIds };
    const name = tajikDictionaryName(rules);
    const current = ours.find((r) => r.name === name && !r.archived_time_unix && str(r.latest_version_id));
    if (current) return { locator: { pronunciation_dictionary_id: current.id as string, version_id: current.latest_version_id as string }, ourIds };
    const created = await elevenLabsRequest<{ id?: string; version_id?: string }>(
      apiKey,
      "POST",
      "/v1/pronunciation-dictionaries/add-from-rules",
      tajikDictionaryRequest(rules)
    );
    if (!str(created.id)) throw new ElevenLabsHttpError("ElevenLabs: словарь произношения создан без id", null);
    return {
      locator: { pronunciation_dictionary_id: created.id, version_id: str(created.version_id) ? created.version_id : null },
      ourIds: [...ourIds, created.id],
    };
  } catch (err) {
    void logSystemError(
      "telephony",
      `Живой голос (ElevenLabs): таджикский словарь произношения не подготовлен (${describeError(err)}) — словари агента не менялись.`,
      { dedupKey: "elevenlabs-tajik-dictionary" }
    );
    return undefined;
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
  const payload = JSON.stringify([
    tools,
    opts.voiceIdTg?.trim() || null,
    ELEVENLABS_PHONE_AGENT_TUNING,
    // Сменились подтверждённые правила произношения или слова распознавания — готовим заново.
    approvedTajikPronunciationRules(),
    TAJIK_ASR_KEYWORDS,
  ]);
  return `${agentId}:${createHash("sha256").update(payload).digest("hex")}`;
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
}
