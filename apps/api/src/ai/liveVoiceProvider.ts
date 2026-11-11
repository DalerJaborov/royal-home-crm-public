import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";
import { LiveVoiceClient } from "./liveVoiceClient.js";
import { ElevenLabsVoiceClient, fetchElevenLabsSignedUrl } from "./elevenLabsVoiceClient.js";
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
    voiceIdRu: row.elevenLabsVoiceIdRu?.trim() || null,
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

/** Сколько верить «кредиты кончились» до новой пробы: пополнение или новый месяц
 *  подхватывается сам, без перезапуска, а очередь не спрашивает ElevenLabs на каждый номер. */
export const ELEVENLABS_QUOTA_RECHECK_MS = 30 * 60_000;
let elevenLabsQuotaOutUntil = 0;

/** Кредиты ElevenLabs кончились (по последнему ответу) — робозвонок остановлен до новой пробы. */
export function elevenLabsQuotaExhausted(now: number = Date.now()): boolean {
  return now < elevenLabsQuotaOutUntil;
}

/** Ответ ElevenLabs сказал «нет кредитов» — запомнить и ОДНОЙ тревогой сказать директору. */
export function noteElevenLabsQuotaExhausted(reason: string, now: number = Date.now()): void {
  elevenLabsQuotaOutUntil = now + ELEVENLABS_QUOTA_RECHECK_MS;
  void logSystemError(
    "ai",
    "КРИТИЧНО: Робозвонок остановлен: у ElevenLabs закончились минуты (кредиты). Звонки переносятся, " +
      "входящие идут на автоответчик станции. Пополните баланс или включите оплату сверх лимита в кабинете " +
      `ElevenLabs; CRM проверит снова через ${ELEVENLABS_QUOTA_RECHECK_MS / 60_000} мин. Ответ ElevenLabs: ${reason.slice(0, 200)}`,
    { dedupKey: "elevenlabs-quota-exhausted" }
  );
}

function clearElevenLabsQuota(): void {
  elevenLabsQuotaOutUntil = 0;
}

type SignedUrlFetcher = (apiKey: string, agentId: string) => Promise<string>;

const probeDone = new Map<string, { result: LiveVoiceProbeResult; at: number }>();
const probeInFlight = new Map<string, Promise<LiveVoiceProbeResult>>();

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
  // Кредиты кончились недавно — не спрашиваем снова до ELEVENLABS_QUOTA_RECHECK_MS.
  if (!opts.fresh && elevenLabsQuotaExhausted(now())) {
    return { ok: false, quota: true, reason: "у ElevenLabs закончились кредиты" };
  }
  const key = probeKey(config.apiKey, config.agentId);
  const done = probeDone.get(key);
  if (!opts.fresh && done && now() - done.at < LIVE_VOICE_PROBE_CACHE_MS) return done.result;
  const existing = probeInFlight.get(key);
  if (existing) return existing;
  const agentId = config.agentId;
  const pending = runElevenLabsProbe(config.apiKey, agentId, opts.fetchSignedUrl ?? fetchElevenLabsSignedUrl).then((raw) => {
    const result: LiveVoiceProbeResult = raw.ok ? raw : isElevenLabsQuotaError(raw.reason) ? { ...raw, quota: true } : raw;
    probeDone.set(key, { result, at: now() });
    // Удачная проба отметку «кредиты кончились» НЕ снимает: НЕТ ДАННЫХ, отказывает ли
    // signed URL при нуле кредитов, — отметку могло поставить подключение (после «алло»),
    // и снятие здесь снова пускало бы звонки, которые оборвутся на подключении.
    // Отметка гаснет сама (ELEVENLABS_QUOTA_RECHECK_MS) или при правке Настроек.
    if (!result.ok && result.quota) {
      noteElevenLabsQuotaExhausted(result.reason, now());
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
  probeDone.clear();
  probeInFlight.clear();
  clearElevenLabsQuota();
}
