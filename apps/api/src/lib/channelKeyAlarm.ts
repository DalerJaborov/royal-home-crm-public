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

/**
 * ОБЩАЯ ДВЕРЬ СРОЧНОЙ ТРЕВОГИ ДИРЕКТОРУ (14.11.2026, охота на «внезапно и молча», №3).
 *
 * Тот же приём, что у мёртвого ключа, но для любой тихой поломки: крон замолчал,
 * внешний доступ перешёл в «сломан», кончились кредиты озвучки, не пришла копия
 * базы, оборвался Telegram-бот. С 02.10 общий пуш «Новая проблема» отключён
 * (владелец: спам) и возвращать его НЕЛЬЗЯ; вместо него такая поломка идёт сюда:
 * CRITICAL (мимо часов алармов, см. directorAlertQueue.ts), одна метка на
 * поломку, не чаще `everyMs` (по умолчанию 12 ч), пока она живёт.
 *
 * Метка — стабильная и несекретная: «cron-silent:<тик>», «integration:<имя>»,
 * «backup:<вид>», «telegram-poller», «elevenlabs-quota». Журнал ошибок вызывающий
 * код ведёт сам (своим источником и текстом); дверь только доставляет тревогу.
 * Замок на метку внутри транзакции: проверка и запись идут по очереди и между
 * процессами (api и worker). Никогда не бросает.
 */
export interface CriticalAlarmInput {
  /** Метка поломки (до 160 знаков). */
  tag: string;
  title: string;
  body: string;
  /** Куда ведёт нажатие; по умолчанию Настройки, вкладка «Система». */
  url?: string;
  /** Повтор по той же метке не чаще; по умолчанию ALERT_EVERY_MS. */
  everyMs?: number;
  /** «К сведению»: колокольчик сразу, звонок телефона только в часы алармов (не срочно). */
  quiet?: boolean;
  now?: Date;
}

export const SILENT_FAILURE_URL = "/settings?tab=system";
/** Метка тревоги «кончились кредиты ElevenLabs»: озвучка, робозвонок и суточная проверка остатка делят её (не чаще раза в 12 ч). */
export const ELEVENLABS_QUOTA_ALARM_TAG = "elevenlabs-quota";

export async function raiseCriticalAlarm(input: CriticalAlarmInput): Promise<{ alerted: boolean }> {
  try {
    const tag = input.tag.slice(0, 160);
    const now = input.now ?? new Date();
    const everyMs = input.everyMs ?? ALERT_EVERY_MS;
    const { enqueueDirectorAlert } = await import("./directorAlertQueue.js");
    /**
     * БЕЗ ГОНКИ (ревью #161): десять одновременных отказов одной метки иначе все
     * видят «тревоги ещё нет» и ставят десять.
     */
    const alerted = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${tag}))::text AS locked`;
      const already = await tx.pendingDirectorAlert.findFirst({
        where: { tag, createdAt: { gte: new Date(now.getTime() - everyMs) } },
        select: { id: true },
      });
      if (already) return false;
      const params = {
        title: input.title,
        body: input.body.replace(/\s+/g, " ").slice(0, 220),
        url: input.url ?? SILENT_FAILURE_URL,
        level: "CRITICAL" as const,
        severity: "critical" as const,
        tag,
        recipientRoles: ["DIRECTOR" as const, "ADMIN" as const],
      };
      return enqueueDirectorAlert(input.quiet ? { ...params, level: undefined, severity: "info" as const } : params, tx);
    });
    return { alerted };
  } catch (err) {
    console.error("[criticalAlarm] тревога не поставлена:", err instanceof Error ? err.message : String(err));
    return { alerted: false };
  }
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
    return await raiseCriticalAlarm({
      tag,
      title: "Ключ канала перестал работать",
      body: `${input.label}: ${detail.slice(0, 160)}. ${fix}`,
      url: "/settings?tab=channels",
      now,
    });
  } catch (err) {
    console.error("[channelKeyAlarm] тревога о ключе не поставлена:", err instanceof Error ? err.message : String(err));
    return { alerted: false };
  }
}
