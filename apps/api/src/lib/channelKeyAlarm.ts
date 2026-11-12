import { prisma } from "../db.js";
import { logSystemError, type SystemErrorSource } from "./systemError.js";

/**
 * СТОРОЖ МЁРТВЫХ КЛЮЧЕЙ КАНАЛОВ (12.11.2026).
 *
 * Случай: 11.11 владелец сменил пароль Instagram, личный маркер ответил 401
 * «session has been invalidated», и бот сутки молчал всем клиентам. В журнале
 * ошибок легла 91 строка — и тишина: пуш «Новая проблема» уходит только на
 * ПЕРВЫЙ в истории текст (systemError.ts, everSeen), а «Сообщение в INSTAGRAM
 * не отправлено…» видели и раньше. Журнал никто не читает.
 *
 * Класс: ключ канала умер — узнают по жалобе клиента. Поэтому отказ ключа
 * (HTTP 401, код Meta 190/102, Telegram 401) — отдельная тревога директору:
 * CRITICAL, своя метка на ключ, не чаще раза в ALERT_EVERY_MS, пока поломка
 * живёт. Одна дверь для всех каналов: Meta (callGraph, проверки), реклама,
 * Telegram-бот.
 *
 * Никогда не бросает: сторож не должен ронять то, о чём сторожит.
 */

/** Пока ключ мёртв, напоминаем не чаще: чаще — шум, реже — забудут. */
export const ALERT_EVERY_MS = 12 * 60 * 60_000;
const LOG_EVERY_MS = 60 * 60_000;
export const CHANNEL_KEY_ALERT_TAG_PREFIX = "channel-key-dead:";

/** Признаки «ключ не принят» в ответе Meta Graph (HTTP или тело). */
export function isMetaAuthFailure(status: number | undefined, bodyText: string | undefined): boolean {
  if (status === 401) return true;
  const text = bodyText ?? "";
  try {
    const parsed = JSON.parse(text) as { error?: { code?: number; type?: string } };
    const code = parsed.error?.code;
    if (code === 190 || code === 102) return true;
  } catch {
    // Не JSON — смотрим текстом ниже.
  }
  return /"code"\s*:\s*(190|102)\b|(code|код) (190|102)(?!\d)|session has been invalidated|Error validating access token|access token has expired/i.test(text);
}

/** То же по тексту ошибки, которую уже бросил транспорт («Graph API HTTP 401: …»). */
export function isMetaAuthFailureText(message: string): boolean {
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  return isMetaAuthFailure(status ? Number(status) : undefined, message);
}

export interface ChannelKeyAlarmInput {
  /** Стабильный НЕсекретный ключ: «ig-account:<id>», «fb-page-settings», «meta-ads»… */
  key: string;
  /** Как ключ называется для человека: «Instagram «Royal Home» (личный маркер)». */
  label: string;
  /** Что ответил сервис — без маркера. */
  detail: string;
  /** Что делать — одной строкой. По умолчанию — Настройки → Каналы. */
  fix?: string;
  source?: SystemErrorSource;
  now?: Date;
}

export async function raiseChannelKeyAlarm(input: ChannelKeyAlarmInput): Promise<{ alerted: boolean }> {
  try {
    const tag = `${CHANNEL_KEY_ALERT_TAG_PREFIX}${input.key}`.slice(0, 160);
    const now = input.now ?? new Date();
    const fix = input.fix ?? "Настройки → Каналы: проверьте ключ или включите вечный ключ через Страницу.";
    const detail = input.detail.replace(/\s+/g, " ").slice(0, 300);
    await logSystemError(input.source ?? "meta", `Ключ не работает: ${input.label} — ${detail}. ${fix}`, {
      dedupKey: tag,
      dedupWindowMs: LOG_EVERY_MS,
      // Директору уходит своя тревога ниже — пуш «Новая проблема» был бы дублем.
      silent: true,
    });
    const already = await prisma.pendingDirectorAlert.findFirst({
      where: { tag, createdAt: { gte: new Date(now.getTime() - ALERT_EVERY_MS) } },
      select: { id: true },
    });
    if (already) return { alerted: false };
    // Очередь тревог (а с ней push.ts) — по требованию, а не при загрузке: сторож
    // стоит в транспортах Telegram и Meta, и статический импорт тянул push.ts в
    // каждый модуль, который их импортирует (подмены push.js в тестах падали на
    // порядке инициализации — найдено полным прогоном 12.11).
    const { enqueueDirectorAlert } = await import("./directorAlertQueue.js");
    const alerted = await enqueueDirectorAlert({
      title: "Ключ канала перестал работать",
      body: `${input.label}: ${detail.slice(0, 160)}. ${fix}`,
      url: "/settings?tab=channels",
      level: "CRITICAL",
      tag,
      recipientRoles: ["DIRECTOR", "ADMIN"],
    });
    return { alerted };
  } catch (err) {
    console.error("[channelKeyAlarm] тревога о ключе не поставлена:", err instanceof Error ? err.message : String(err));
    return { alerted: false };
  }
}
