import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";
import { liveVoiceSpendCapHeld } from "../lib/liveVoiceSpendHold.js";
import { LiveVoiceClient } from "./liveVoiceClient.js";
import { ElevenLabsVoiceClient, fetchElevenLabsSignedUrl } from "./elevenLabsVoiceClient.js";
import { elevenLabsRequest } from "./elevenLabsAgentSync.js";
import type { VoiceGender } from "@royal-home/shared";
import type { LiveVoiceProviderClient } from "./liveVoiceProviderTypes.js";

// Договор между мостом и поставщиком — в liveVoiceProviderTypes.ts (там и разбор
// событий); здесь только выбор поставщика по Настройкам.
export type {
  LiveVoiceConnectOptions,
  LiveVoiceLanguage,
  LiveVoiceProviderClient,
  LiveVoiceProviderName,
} from "./liveVoiceProviderTypes.js";

export type LiveVoiceProviderConfig =
  | { provider: "google" }
  | {
      provider: "elevenlabs";
      apiKey: string | null;
      agentId: string | null;
      voiceIdRu: string | null;
      voiceIdTg: string | null;
      /** Пол русского голоса — для правила рода в промте (см. liveVoiceSelfGender). */
      voiceGender: VoiceGender;
    };

/** Клиент выбранного поставщика. Чистая функция — проверяется тестом без сети. */
export function createLiveVoiceProviderClient(config: LiveVoiceProviderConfig): LiveVoiceProviderClient {
  if (config.provider === "elevenlabs") {
    return new ElevenLabsVoiceClient({
      apiKey: config.apiKey,
      agentId: config.agentId,
      voiceIdRu: config.voiceIdRu,
      voiceIdTg: config.voiceIdTg,
    });
  }
  return new LiveVoiceClient();
}

/** Ключ ElevenLabs: Настройки (зашифрован) приоритетнее ELEVENLABS_API_KEY из .env —
 *  тот же порядок, что у ключей Gemini и OpenAI. */
export function resolveElevenLabsKey(encrypted: string | null | undefined): string | null {
  return decryptSecretSafe(encrypted ?? null)?.trim() || process.env.ELEVENLABS_API_KEY?.trim() || null;
}

export type ElevenLabsProviderConfig = Extract<LiveVoiceProviderConfig, { provider: "elevenlabs" }>;

const PROVIDER_SELECT = {
  liveVoiceProvider: true,
  elevenLabsApiKey: true,
  elevenLabsAgentId: true,
  elevenLabsVoiceIdRu: true,
  elevenLabsVoiceIdTg: true,
  elevenLabsVoiceGender: true,
} as const;

/** ElevenLabs «Anna - Premium Lifestyle Ads», женский русский голос: по умолчанию для телефонии. */
export const DEFAULT_PHONE_VOICE_ID = "0XJ7mts7SfzZk5uEHl4e";

function elevenLabsConfigFromRow(row: {
  elevenLabsApiKey: string | null;
  elevenLabsAgentId: string | null;
  elevenLabsVoiceIdRu: string | null;
  elevenLabsVoiceIdTg: string | null;
  elevenLabsVoiceGender: string | null;
}): ElevenLabsProviderConfig {
  return {
    provider: "elevenlabs",
    apiKey: resolveElevenLabsKey(row.elevenLabsApiKey),
    agentId: row.elevenLabsAgentId?.trim() || null,
    // Голос по умолчанию — Anna (владелец 14.11.2026); значение из Настроек перекрывает.
    voiceIdRu: row.elevenLabsVoiceIdRu?.trim() || DEFAULT_PHONE_VOICE_ID,
    voiceIdTg: row.elevenLabsVoiceIdTg?.trim() || null,
    // Не задан — женский, как для неузнанного голоса Gemini (voiceGender).
    voiceGender: row.elevenLabsVoiceGender === "male" ? "male" : "female",
  };
}

/**
 * Поставщик на ЭТОТ звонок — читается при подъёме сессии, как голос и промт:
 * переключатель посреди идущего разговора действует со следующего звонка.
 * База не ответила — Google, как до переключателя: звонок важнее сравнения.
 */
export async function loadLiveVoiceProviderConfig(): Promise<LiveVoiceProviderConfig> {
  try {
    const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: PROVIDER_SELECT });
    if (row?.liveVoiceProvider !== "elevenlabs") return { provider: "google" };
    return elevenLabsConfigFromRow(row);
  } catch (err) {
    void logSystemError(
      "telephony",
      `Живой голос: не прочитан выбор поставщика голоса (${describeError(err)}) — звонок идёт через Google.`,
      { dedupKey: "live-voice-provider-read" }
    );
    return { provider: "google" };
  }
}

/**
 * Настройки ElevenLabs НЕЗАВИСИМО от переключателя (11.11.2026): кнопка «Проверить
 * агента» готовит агента до того, как владелец переключит голос робота. Те же
 * поля и та же обработка, что у звонка (elevenLabsConfigFromRow), — иначе ключ
 * подготовки (agentSync: агент + функции + таджикский голос) разошёлся бы с ключом
 * звонка, и прогретый кеш звонку бы не достался. Сбой базы — исключение наружу.
 */
export async function loadElevenLabsProviderConfig(): Promise<ElevenLabsProviderConfig> {
  const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: PROVIDER_SELECT });
  return elevenLabsConfigFromRow(
    row ?? { elevenLabsApiKey: null, elevenLabsAgentId: null, elevenLabsVoiceIdRu: null, elevenLabsVoiceIdTg: null, elevenLabsVoiceGender: null }
  );
}

/**
 * ПРОБА ПОСТАВЩИКА ПЕРЕД НАБОРОМ (11.11.2026, П1 «не набирать в тишину»). Сессия
 * исходящего звонка поднимается ПОСЛЕ ответа человека: если ElevenLabs сейчас не
 * выдаёт разговор (ключ, агент, страна, сеть), человек снимал трубку в тишину.
 * Перед набором — запрос ссылки на разговор (signed URL, тот же, что делает
 * подключение) с потолком LIVE_VOICE_PROBE_TIMEOUT_MS; итог помнится
 * LIVE_VOICE_PROBE_CACHE_MS, чтобы очередь звонков не спрашивала ElevenLabs на
 * каждый номер. Отказ — вызывающий получает «занято» и переносит звонок, не
 * тратя попытку. У Google пробы нет: его отказы считает выключатель моста.
 */
export const LIVE_VOICE_PROBE_TIMEOUT_MS = 3_000;
export const LIVE_VOICE_PROBE_CACHE_MS = 60_000;

export type LiveVoiceProbeResult = { ok: true } | { ok: false; reason: string; quota?: boolean };

/**
 * У ELEVENLABS КОНЧИЛИСЬ КРЕДИТЫ (11.11.2026). Робозвонок — только ElevenLabs (решение
 * владельца 11.11), поэтому «нет кредитов» = робозвонок остановлен: исходящие не
 * набираются («занято», попытка не тратится), входящие идут станции, директору — одна
 * тревога, а не запись на каждый номер. Распознаётся по тексту ответа:
 *  - ФАКТ (help-center ElevenLabs «API - Error Code 400 or 401», 11.11.2026): статус
 *    `quota_exceeded` — «insufficient quota to complete the request», HTTP 400 или 401;
 *  - ОЦЕНКА (сторонний журнал Vapi, не первоисточник): сокет разговора закрывается кодом
 *    1008 с «quota_exceeded» / «This request exceeds your quota…»;
 *  - НЕТ ДАННЫХ: отказывает ли при нуле кредитов уже запрос signed URL или только сам
 *    разговор, — поэтому слово ловится на обоих путях (проба и подключение).
 * Текст ошибки HTTP несёт тело ответа (elevenLabsRequest), закрытие сокета до начала
 * разговора — код и причину (ElevenLabsSetupRejectedError), так что сличать есть с чем.
 */
const ELEVENLABS_QUOTA_RE =
  /quota[_ ]exceeded|exceeds your quota|insufficient (?:quota|credits?)|not enough credits|out of credits|credits? (?:are )?exhausted/i;

export function isElevenLabsQuotaError(text: string | null | undefined): boolean {
  return !!text && ELEVENLABS_QUOTA_RE.test(text);
}

/**
 * Отметка «нет минут» НЕ гаснет по часам (ревью П1, 11.11.2026). Прежде через 30 мин
 * решала снова проба ссылки — а НЕТ ДАННЫХ, отказывает ли ссылка при нуле кредитов:
 * если выдаётся, живой человек получал «алло → отбой», а проверка собственника теряла
 * попытку. Теперь остаток перепроверяется запросом подписки, без звонка
 * (recheckElevenLabsQuota, раз в ELEVENLABS_QUOTA_RECHECK_MS), а отметку снимают:
 * остаток снова есть, удачный разговор ElevenLabs (мост), правка Настроек
 * (resetLiveVoiceProviderProbe), ручной проверочный звонок (свежая проба).
 *  - ФАКТ (elevenlabs.io/docs/api-reference/user/subscription/get, 11.11.2026):
 *    GET /v1/user/subscription, поля `character_count` (израсходовано) и
 *    `character_limit` (предел периода), `next_character_count_reset_unix`.
 *  - ОЦЕНКА: кредиты разговоров считаются в тех же полях (отдельного поля кредитов в
 *    ответе нет). НЕТ ДАННЫХ, как они ведут себя при включённой оплате сверх лимита —
 *    тогда ElevenLabs и `quota_exceeded` не отдаёт, и отметка не ставится вовсе.
 */
export const ELEVENLABS_QUOTA_RECHECK_MS = 30 * 60_000;
let elevenLabsQuotaMarked = false;
let quotaRecheckTimer: ReturnType<typeof setTimeout> | null = null;
/** Чем перепроверять: ключ последнего звонка, получившего «нет минут». */
let quotaRecheckKey: string | null = null;

/**
 * Кредиты ElevenLabs кончились — робозвонок остановлен, пока перепроверка не скажет иное.
 * П5 (11.11.2026): или наш потолок минут робота за сутки/месяц (lib/liveVoiceSpend.ts) —
 * та же дверь «у ElevenLabs нет минут»: мост по ней не берёт входящий и не набирает
 * исходящий, второй проверки в мосте нет. Удачный разговор, перепроверка остатка и правка
 * ключа снимают только отметку «кредиты кончились», потолок — нет: он гаснет сам в конце
 * периода или когда владелец поднимет его в Настройках.
 */
export function elevenLabsQuotaExhausted(now: number = Date.now()): boolean {
  return elevenLabsQuotaMarked || liveVoiceSpendCapHeld(now);
}

function scheduleQuotaRecheck(): void {
  if (quotaRecheckTimer) clearTimeout(quotaRecheckTimer);
  quotaRecheckTimer = setTimeout(() => {
    quotaRecheckTimer = null;
    void recheckElevenLabsQuota();
  }, ELEVENLABS_QUOTA_RECHECK_MS);
  quotaRecheckTimer.unref?.();
}

/** Ответ ElevenLabs сказал «нет кредитов» — запомнить и ОДНОЙ тревогой сказать директору.
 *  `apiKey` — чем потом спросить остаток (без него отметку снимут Настройки или удачный звонок). */
export function noteElevenLabsQuotaExhausted(reason: string, apiKey?: string | null): void {
  elevenLabsQuotaMarked = true;
  if (apiKey) quotaRecheckKey = apiKey;
  scheduleQuotaRecheck();
  void logSystemError(
    "ai",
    "КРИТИЧНО: Робозвонок остановлен: у ElevenLabs закончились минуты (кредиты). Звонки переносятся, " +
      "входящие идут на автоответчик станции. Пополните баланс или включите оплату сверх лимита в кабинете " +
      `ElevenLabs; CRM проверяет остаток раз в ${ELEVENLABS_QUOTA_RECHECK_MS / 60_000} мин и возобновит звонки сама. ` +
      `Ответ ElevenLabs: ${reason.slice(0, 200)}`,
    { dedupKey: "elevenlabs-quota-exhausted" }
  );
}

/** Снять отметку «нет минут»: удачный разговор ElevenLabs, остаток снова есть, правка Настроек. */
export function clearElevenLabsQuotaMark(): void {
  elevenLabsQuotaMarked = false;
  quotaRecheckKey = null;
  if (quotaRecheckTimer) clearTimeout(quotaRecheckTimer);
  quotaRecheckTimer = null;
}

/**
 * Перепроверить остаток запросом подписки — без звонка человеку. «cleared» — минуты
 * есть, отметка снята; «still» — по-прежнему ноль, следующая перепроверка взведена;
 * «failed» — спросить не вышло (сеть, права ключа): отметка остаётся, звонить вслепую
 * хуже, чем подождать, и одна запись в журнале.
 */
export async function recheckElevenLabsQuota(): Promise<"cleared" | "still" | "failed" | "idle"> {
  if (!elevenLabsQuotaMarked) return "idle";
  const apiKey = quotaRecheckKey;
  if (!apiKey) {
    scheduleQuotaRecheck();
    return "failed";
  }
  try {
    const sub = await elevenLabsRequest<{ character_count?: unknown; character_limit?: unknown }>(
      apiKey,
      "GET",
      "/v1/user/subscription"
    );
    const used = Number(sub.character_count);
    const limit = Number(sub.character_limit);
    if (!Number.isFinite(used) || !Number.isFinite(limit)) throw new Error("в ответе нет character_count/character_limit");
    if (used < limit) {
      clearElevenLabsQuotaMark();
      console.log(`[живой голос] у ElevenLabs снова есть минуты (${used} из ${limit}) — робозвонок возобновлён`);
      return "cleared";
    }
    scheduleQuotaRecheck();
    return "still";
  } catch (err) {
    scheduleQuotaRecheck();
    void logSystemError(
      "ai",
      `Робозвонок остановлен: не удалось проверить остаток минут ElevenLabs (${describeError(err)}). ` +
        "Звонки ждут; после пополнения сохраните ключ ElevenLabs в Настройках или сделайте проверочный звонок.",
      { dedupKey: "elevenlabs-quota-recheck-failed" }
    );
    return "failed";
  }
}

type SignedUrlFetcher = (apiKey: string, agentId: string) => Promise<string>;

const probeDone = new Map<string, { result: LiveVoiceProbeResult; at: number }>();
const probeInFlight = new Map<string, Promise<LiveVoiceProbeResult>>();
/** Номер сброса проб: итог пробы, начатой ДО сброса (правка Настроек), в память не
 *  кладётся и отметок не ставит — иначе старый отказ пережил бы починку ключа. */
let probeEpoch = 0;

function probeKey(apiKey: string, agentId: string): string {
  // Ключ — отпечатком: сам ключ в памяти кеша не нужен, а смена ключа обязана дать новую пробу.
  return `${agentId}:${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

async function runElevenLabsProbe(apiKey: string, agentId: string, fetchSignedUrl: SignedUrlFetcher): Promise<LiveVoiceProbeResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const request = fetchSignedUrl(apiKey, agentId);
  // Потолок наш, а запрос живёт до своего (ELEVENLABS_HTTP_TIMEOUT_MS): его поздний
  // отказ не должен стать unhandledRejection.
  request.catch(() => {});
  try {
    await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`нет ответа за ${LIVE_VOICE_PROBE_TIMEOUT_MS / 1000} с`)),
          LIVE_VOICE_PROBE_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: describeError(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Поднимется ли выбранный поставщик прямо сейчас. Не бросает. `fresh` — пропустить
 * память (ручной тестовый звонок: владелец только что мог починить агента).
 */
export async function probeLiveVoiceProvider(
  config: LiveVoiceProviderConfig,
  opts: { fresh?: boolean; fetchSignedUrl?: SignedUrlFetcher; now?: () => number } = {}
): Promise<LiveVoiceProbeResult> {
  if (config.provider !== "elevenlabs") return { ok: true };
  if (!config.apiKey || !config.agentId) {
    const reason = !config.apiKey ? "ключ ElevenLabs не задан" : "не указан id агента ElevenLabs";
    void logSystemError(
      "telephony",
      `Робозвонок остановлен: ${reason}. Звонки переносятся; впишите ключ и агента ElevenLabs в Настройках.`,
      { dedupKey: "elevenlabs-probe-config" }
    );
    return { ok: false, reason };
  }
  const now = opts.now ?? Date.now;
  // Кредиты кончились — ссылку не спрашиваем вовсе: остаток перепроверяет recheckElevenLabsQuota.
  if (!opts.fresh && elevenLabsQuotaExhausted(now())) {
    return { ok: false, quota: true, reason: "у ElevenLabs закончились кредиты" };
  }
  const key = probeKey(config.apiKey, config.agentId);
  const done = probeDone.get(key);
  if (!opts.fresh && done && now() - done.at < LIVE_VOICE_PROBE_CACHE_MS) return done.result;
  const existing = probeInFlight.get(key);
  if (existing) return existing;
  const { agentId, apiKey } = config;
  const epoch = probeEpoch;
  const pending = runElevenLabsProbe(apiKey, agentId, opts.fetchSignedUrl ?? fetchElevenLabsSignedUrl).then((raw) => {
    const result: LiveVoiceProbeResult = raw.ok ? raw : isElevenLabsQuotaError(raw.reason) ? { ...raw, quota: true } : raw;
    // Настройки поменяли, пока шла проба: её итог относится к прежним ключу/агенту.
    if (epoch !== probeEpoch) return result;
    probeDone.set(key, { result, at: now() });
    // Удачная проба отметку «кредиты кончились» НЕ снимает: НЕТ ДАННЫХ, отказывает ли
    // signed URL при нуле кредитов, — отметку могло поставить подключение (после «алло»),
    // и снятие здесь снова пускало бы звонки, которые оборвутся на подключении.
    // Отметку снимают перепроверка остатка, удачный разговор и правка Настроек.
    if (!result.ok && result.quota) {
      noteElevenLabsQuotaExhausted(result.reason, apiKey);
    } else if (!result.ok) {
      // Одна проблема на все отказы подряд (dedupKey), а не запись на каждый номер очереди.
      void logSystemError(
        "telephony",
        `Робозвонок остановлен: ElevenLabs недоступен — не выдал разговор для агента ${agentId} (${result.reason}). ` +
          "Звонки переносятся и пробуются снова через минуту. Не пройдёт — проверьте ключ и агента кнопкой " +
          "«Проверить агента» в Настройках.",
        { dedupKey: "elevenlabs-probe-failed" }
      );
    }
    return result;
  });
  probeInFlight.set(key, pending);
  void pending.finally(() => {
    if (probeInFlight.get(key) === pending) probeInFlight.delete(key);
  });
  return pending;
}

/** Забыть итоги проб и отметку «кредиты кончились»: смена поставщика, ключа или агента
 *  в Настройках (settingsSideEffects) — владелец мог как раз пополнить баланс или сменить ключ. */
export function resetLiveVoiceProviderProbe(): void {
  probeEpoch += 1;
  probeDone.clear();
  probeInFlight.clear();
  clearElevenLabsQuotaMark();
}
