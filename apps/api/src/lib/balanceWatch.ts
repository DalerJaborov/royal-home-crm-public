import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { elevenLabsRequest } from "../ai/elevenLabsAgentSync.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";
import { ELEVENLABS_QUOTA_ALARM_TAG, raiseCriticalAlarm } from "./channelKeyAlarm.js";
import { loadSmsConfig, smsBalance } from "./sms/index.js";

/**
 * ЗАРАНЕЕ О КОНЦЕ ДЕНЕГ НА ПЛАТНЫХ СЕРВИСАХ (14.11.2026, охота на «внезапно и молча», №6).
 *
 * Остаток ElevenLabs спрашивали только ПОСЛЕ отказа (робот, озвучка, Шабнам), а у СМС
 * Payom остаток (`payomBalance`) считался, но никто его не опрашивал: узнавали по
 * жалобе, когда робот уже молчал, а рассылка не уходила. Раз в сутки, ничего не меняя
 * и не тратя (только чтение остатка):
 *   - ElevenLabs по КАЖДОМУ ключу (Настройки, ключ Шабнам, .env): использовано 80% и
 *     больше, «к сведению» (по окну часов алармов); 95% и больше, срочно;
 *   - СМС: остаток ниже порога (50 TJS; `SMS_LOW_BALANCE_TJS` в .env), срочно.
 * Ключи не печатаем нигде: в тексте только название источника. Дверь одна
 * (`raiseCriticalAlarm`), повтор по метке не чаще раза в 12 часов.
 */

export const ELEVENLABS_WARN_RATIO = 0.8;
export const ELEVENLABS_CRITICAL_RATIO = 0.95;
export const SMS_LOW_BALANCE_DEFAULT_TJS = 50;
export const ELEVENLABS_LOW_ALARM_TAG = "elevenlabs-quota-low";
export const SMS_BALANCE_ALARM_TAG = "sms-balance-low";

export interface ElevenLabsKeyRef {
  /** Откуда ключ, для человека. Сам ключ в текст не попадает. */
  source: string;
  apiKey: string;
}

/** Ключи ElevenLabs без повторов: Настройки, ключ голоса Шабнам, ELEVENLABS_API_KEY. */
export async function collectElevenLabsKeys(): Promise<ElevenLabsKeyRef[]> {
  const found: ElevenLabsKeyRef[] = [];
  const add = (source: string, key: string | null | undefined) => {
    const apiKey = key?.trim();
    if (apiKey && !found.some((k) => k.apiKey === apiKey)) found.push({ source, apiKey });
  };
  const [settings, voice] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { elevenLabsApiKey: true } }),
    prisma.assistantVoiceConfig.findUnique({ where: { id: "singleton" }, select: { encryptedKey: true } }),
  ]);
  add("ключ в Настройках", decryptSecretSafe(settings?.elevenLabsApiKey ?? null));
  add("ключ голоса Шабнам", decryptSecretSafe(voice?.encryptedKey ?? null));
  add("ключ сервера (.env)", process.env.ELEVENLABS_API_KEY);
  return found;
}

export interface BalanceWatchDeps {
  listKeys?: () => Promise<ElevenLabsKeyRef[]>;
  subscription?: (apiKey: string) => Promise<{ used: number; limit: number }>;
  smsBalance?: () => Promise<{ ok: true; balance: number; currency: string } | { ok: false; error: string }>;
  smsConfigured?: () => Promise<boolean>;
}

async function readSubscription(apiKey: string): Promise<{ used: number; limit: number }> {
  const sub = await elevenLabsRequest<{ character_count?: unknown; character_limit?: unknown }>(apiKey, "GET", "/v1/user/subscription");
  const used = Number(sub.character_count);
  const limit = Number(sub.character_limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit)) throw new Error("в ответе нет character_count/character_limit");
  return { used, limit };
}

const percent = (used: number, limit: number) => Math.round((used / limit) * 100);

/** ElevenLabs: возвращает число поставленных тревог. */
export async function checkElevenLabsBalances(deps: BalanceWatchDeps = {}): Promise<number> {
  const keys = await (deps.listKeys ?? collectElevenLabsKeys)();
  const read = deps.subscription ?? readSubscription;
  const critical: string[] = [];
  const warn: string[] = [];
  for (const key of keys) {
    try {
      const { used, limit } = await read(key.apiKey);
      if (!(limit > 0)) continue; // безлимит или тариф без счётчика: нечего сравнивать
      const ratio = used / limit;
      if (ratio >= ELEVENLABS_CRITICAL_RATIO) critical.push(`${key.source}: ${percent(used, limit)}% (${used} из ${limit})`);
      else if (ratio >= ELEVENLABS_WARN_RATIO) warn.push(`${key.source}: ${percent(used, limit)}% (${used} из ${limit})`);
    } catch (err) {
      // Не вышло спросить остаток: один ключ не отменяет остальные, текст ошибки без ключа.
      void logSystemError("ai", `Остаток ElevenLabs (${key.source}) не получен: ${describeError(err)}`, {
        dedupKey: `elevenlabs-balance-read:${key.source}`,
        dedupWindowMs: 24 * 60 * 60_000,
        silent: true,
      });
    }
  }
  let alerts = 0;
  if (critical.length > 0) {
    const { alerted } = await raiseCriticalAlarm({
      tag: ELEVENLABS_QUOTA_ALARM_TAG,
      title: "Кредиты ElevenLabs почти кончились",
      body: `Использовано ${critical.join("; ")}. Пополните баланс, иначе робот и озвучка остановятся.`,
    });
    if (alerted) alerts++;
  } else if (warn.length > 0) {
    const { alerted } = await raiseCriticalAlarm({
      tag: ELEVENLABS_LOW_ALARM_TAG,
      title: "Кредиты ElevenLabs на исходе",
      body: `Использовано ${warn.join("; ")}. Стоит заранее пополнить баланс.`,
      quiet: true,
      everyMs: 24 * 60 * 60_000,
    });
    if (alerted) alerts++;
  }
  return alerts;
}

export function smsLowBalanceThreshold(): number {
  const fromEnv = Number(process.env.SMS_LOW_BALANCE_TJS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : SMS_LOW_BALANCE_DEFAULT_TJS;
}

/** СМС Payom: возвращает число поставленных тревог. Не подключены или холостой режим: ничего. */
export async function checkSmsBalance(deps: BalanceWatchDeps = {}): Promise<number> {
  if (process.env.SMS_DRY_RUN === "1") return 0;
  const configured = deps.smsConfigured ? await deps.smsConfigured() : (await loadSmsConfig()) !== null;
  if (!configured) return 0;
  const result = await (deps.smsBalance ?? smsBalance)();
  if (!result.ok) {
    void logSystemError("sms", `Остаток СМС не получен: ${result.error}`, { dedupKey: "sms-balance-read", dedupWindowMs: 24 * 60 * 60_000, silent: true });
    return 0;
  }
  if (result.currency !== "TJS") return 0;
  const threshold = smsLowBalanceThreshold();
  if (result.balance >= threshold) return 0;
  const { alerted } = await raiseCriticalAlarm({
    tag: SMS_BALANCE_ALARM_TAG,
    title: "СМС заканчиваются",
    body: `На счёте СМС осталось ${Math.round(result.balance * 100) / 100} TJS (порог ${threshold}). Пополните счёт у провайдера.`,
  });
  return alerted ? 1 : 0;
}

/** Суточный проход: каждая проверка отдельно, отказ одной не прячет другую. */
export async function runBalanceWatch(deps: BalanceWatchDeps = {}): Promise<number> {
  let alerts = 0;
  for (const run of [() => checkElevenLabsBalances(deps), () => checkSmsBalance(deps)]) {
    try {
      alerts += await run();
    } catch (err) {
      void logSystemError("cron", `Проверка остатка платных сервисов не выполнена: ${describeError(err)}`, {
        dedupKey: "balance-watch-failed",
        dedupWindowMs: 24 * 60 * 60_000,
      });
    }
  }
  return alerts;
}
