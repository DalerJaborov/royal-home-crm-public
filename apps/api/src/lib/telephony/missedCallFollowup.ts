import { isTajikMobileNumber, isWhatsappCallSource } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { sendSms, smsConfigured, toSmsPhone } from "../sms/index.js";
import { findStaffPhone } from "../staffPhoneGuard.js";
import { phoneTail } from "../clientPhones.js";
import { PUBLIC_AGENCY_CONTACT } from "../publicAgencyContact.js";
import { closeAutoTasks } from "../autoTasks.js";
import { logTimeline } from "../timeline.js";
import { SERVICE_NUMBER_IRRELEVANT_MARKS } from "./incomingCallConstants.js";

/**
 * ПРОПУЩЕННЫЙ ВХОДЯЩИЙ ЗВОНОК НЕ ТЕРЯЕТСЯ (18.11.2026).
 *
 * Разведка 18.11: за 30 дней 150 входящих, 75 пропущено, клиенту после пропущенного
 * не уходило ничего. Переадресовать звонок «на WhatsApp» нельзя (у городского номера
 * агентства нет WhatsApp), можно одно: после неотвеченного звонка прислать СМС со
 * ссылкой «напишите нам в WhatsApp». Клиент пишет первым, окно переписки открыто,
 * дальше отвечает бот.
 *
 * РУБИЛЬНИК А — Settings.missedCallSmsEnabled, по умолчанию ВЫКЛЮЧЕН. Выключено — эта
 * функция ничего не читает и не пишет, кроме одной строки настроек.
 *
 * РЕШЕНИЯ ВЛАДЕЛЬЦА 18.11.2026 (дословно): «если звонок идёт, но никто не отвечает,
 * тогда пусть будет пропущенный и отправить смс сразу на двух языках… таджикский
 * первый, пускай идёт с нашим WhatsApp. Ссылку можно просто поставить». Поэтому:
 *   - ОДНА СМС на двух языках, текст один, лежит в Настройках (missedCallSmsText);
 *   - отправка СРАЗУ, в любое время суток;
 *   - любой неотвеченный входящий, в том числе клиент с закреплённым агентом (задача и
 *     пуш агенту остаются как были — это другая ветка finishIncomingCall).
 *
 * ЗАЩИТЫ (умолчания координатора, владельцу показываются отдельно): не чаще одной СМС на
 * номер за 24 часа; только мобильный таджикский номер (общее правило из packages/shared);
 * не сотрудник, не номер самой компании, не служебный номер (дважды «не по делу»); не
 * писавшему нам в WhatsApp за последние 24 часа; потолок на сутки против волны
 * автообзвона (деньги: каждая СМС платная). Отказ провайдера пишется в журнал ошибок
 * (sendSms) и НЕ повторяется: следующая попытка — только со следующим звонком.
 *
 * ОТПРАВКА — единственная дверь `sendSms` (lib/sms/index.ts): та же Payom, тот же журнал
 * SmsMessage. Имя отправителя («RoyalHome») подставляет payomSend из Settings.smsSender в
 * каждое СМС проекта, поэтому в тексте названия компании нет.
 */

export const MISSED_CALL_SMS_PURPOSE = "MISSED_CALL_WA" as const;
/** Не чаще одной СМС на номер за это время. */
export const MISSED_CALL_SMS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Писал нам в WhatsApp за это время — звать в WhatsApp незачем, он уже там. */
export const MISSED_CALL_WA_RECENT_MS = 24 * 60 * 60 * 1000;
/** Предохранитель на деньги: больше столько СМС за 24 часа не уйдёт ни при какой волне звонков
 *  (в среднем реально 2-3 в сутки, разведка 18.11). */
export const MISSED_CALL_SMS_DAILY_CAP = 100;

export type MissedCallSmsStatus =
  | "sent"
  | "failed"
  | "disabled"
  | "no_phone"
  | "not_mobile"
  | "company_number"
  | "staff"
  | "service_number"
  | "wrote_whatsapp"
  | "whatsapp_call"
  | "cooldown"
  | "daily_cap"
  | "no_text"
  | "sms_not_configured"
  | "in_flight"
  | "error";

export interface MissedCallSmsResult {
  status: MissedCallSmsStatus;
  smsId?: string;
  parts?: number | null;
}

/** Номера, которые уже отправляются прямо сейчас: два звонка подряд не должны слать две СМС. */
const inFlight = new Set<string>();

const LONG_DASHES = /[‒–—―−]/g;

/** Длинных тире в тексте нет ни при каких условиях (владелец): страховка сверх проверки при сохранении. */
export function normalizeMissedCallSmsText(text: string): string {
  return text.replace(LONG_DASHES, "-").trim();
}

/** Номер WhatsApp из ссылки wa.me в тексте: звонок С него — это звонок самой компании. */
function waNumbersInText(text: string): string[] {
  return [...text.matchAll(/wa\.me\/(\d{7,15})/g)].map((m) => m[1]);
}

function companyTails(text: string, forwardPhone: string | null): Set<string> {
  const tails = new Set<string>();
  const add = (value: string | null | undefined) => {
    const digits = (value ?? "").replace(/\D/g, "");
    if (digits.length >= 9) tails.add(phoneTail(digits));
  };
  add(PUBLIC_AGENCY_CONTACT.digits);
  add(forwardPhone);
  for (const n of waNumbersInText(text)) add(n);
  // Номер WhatsApp компании (он же прежний контакт бота): звонок с него тоже «свой», даже если в тексте ссылки нет.
  add("992777776001");
  return tails;
}

/** Номер самой компании (контакт агентства, WhatsApp, номер переадресации): ему не пишем и не звоним. */
export function isCompanyPhone(phone: string, forwardPhone: string | null): boolean {
  return companyTails("", forwardPhone).has(phoneTail(phone));
}

/** Рубильник Б: пропущенный с незнакомого номера заводит карточку и общую задачу «Перезвонить». */
/**
 * ПРОПУЩЕННЫЙ ЗВОНОК ИЗ WHATSAPP — БЕЗ СМС (решение владельца 18.11.2026).
 *
 * СМС после пропущенного зовёт человека написать нам в WhatsApp. Если сам звонок
 * пришёл через шлюз WhatsApp (канал `PJSIP/whatsapp-gw-…`, `IncomingCall.source =
 * "whatsapp"`), клиент уже в WhatsApp — СМС лишняя, а для иностранного номера ещё и
 * платная впустую. Единственное место этого решения; обычная линия — без изменений.
 */
export function missedCallSmsSkipForSource(callSource: string | null | undefined): "whatsapp_call" | null {
  return isWhatsappCallSource(callSource) ? "whatsapp_call" : null;
}

export async function isMissedCallTaskEnabled(): Promise<boolean> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { missedCallCallbackTaskEnabled: true } });
  return s?.missedCallCallbackTaskEnabled === true;
}

/**
 * Решить и отправить СМС звонившему. Не бросает: звонок и его итог важнее СМС.
 * `clientId` — карточка звонившего, если она есть: в её хронологию ляжет строка об отправке.
 */
export async function sendMissedCallSms(input: {
  phone: string | null | undefined;
  clientId?: string | null;
  now?: Date;
  /** `IncomingCall.source`: "phone" | "whatsapp" (lib/telephony/callSource.ts). Нет — обычная линия. */
  callSource?: string | null;
}): Promise<MissedCallSmsResult> {
  const now = input.now ?? new Date();
  let claimed: string | null = null;
  // Звонок пришёл ИЗ WhatsApp: человек уже там, и СМС «напишите нам в WhatsApp»
  // ему не нужна (владелец 18.11.2026). Первой проверкой — до настроек и базы.
  const sourceSkip = missedCallSmsSkipForSource(input.callSource);
  if (sourceSkip) return { status: sourceSkip };
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { missedCallSmsEnabled: true, missedCallSmsText: true, incomingForwardPhone: true },
    });
    if (!settings?.missedCallSmsEnabled) return { status: "disabled" };

    const smsPhone = toSmsPhone(input.phone);
    if (!smsPhone) return { status: "no_phone" };
    if (!isTajikMobileNumber(smsPhone)) return { status: "not_mobile" };

    const text = normalizeMissedCallSmsText(settings.missedCallSmsText ?? "");
    if (!text) return { status: "no_text" };

    if (companyTails(text, settings.incomingForwardPhone).has(phoneTail(smsPhone))) return { status: "company_number" };

    // Занимаем номер до первого await-а на базу: второй звонок, пришедший, пока идёт проверка, уходит отсюда.
    if (inFlight.has(smsPhone)) return { status: "in_flight" };
    inFlight.add(smsPhone);
    claimed = smsPhone;

    if (await findStaffPhone([smsPhone])) return { status: "staff" };

    const marks = await prisma.incomingCall.count({ where: { phone: input.phone ?? "", irrelevant: true } });
    if (marks >= SERVICE_NUMBER_IRRELEVANT_MARKS) return { status: "service_number" };

    // Любая запись о попытке (и неудачная) считается: отказ провайдера не повторяется циклом.
    const recentSms = await prisma.smsMessage.count({
      where: { phone: smsPhone, purpose: MISSED_CALL_SMS_PURPOSE, createdAt: { gte: new Date(now.getTime() - MISSED_CALL_SMS_COOLDOWN_MS) } },
    });
    if (recentSms > 0) return { status: "cooldown" };

    const national = smsPhone.slice(3);
    const wroteWhatsapp = await prisma.botConversation.findFirst({
      where: {
        channel: "WHATSAPP",
        subscriberId: { endsWith: national },
        lastMessageAt: { gte: new Date(now.getTime() - MISSED_CALL_WA_RECENT_MS) },
      },
      select: { id: true },
    });
    if (wroteWhatsapp) return { status: "wrote_whatsapp" };

    const sentToday = await prisma.smsMessage.count({
      where: { purpose: MISSED_CALL_SMS_PURPOSE, createdAt: { gte: new Date(now.getTime() - MISSED_CALL_SMS_COOLDOWN_MS) } },
    });
    if (sentToday >= MISSED_CALL_SMS_DAILY_CAP) {
      void logSystemError("sms", `СМС после пропущенного звонка не отправлено: достигнут предел ${MISSED_CALL_SMS_DAILY_CAP} за сутки, проверьте, нет ли волны звонков`, {
        dedupKey: "missed-call-sms-daily-cap",
      });
      return { status: "daily_cap" };
    }

    if (!(await smsConfigured())) {
      void logSystemError("sms", "Рубильник СМС после пропущенного звонка включён, но СМС не подключены (Настройки, Каналы связи, СМС)", {
        dedupKey: "missed-call-sms-not-configured",
      });
      return { status: "sms_not_configured" };
    }

    const result = await sendSms({ phone: smsPhone, text, purpose: MISSED_CALL_SMS_PURPOSE, clientId: input.clientId ?? null });
    if (!result.ok) return { status: "failed" };

    if (input.clientId) {
      try {
        await logTimeline({
          clientId: input.clientId,
          actor: { kind: "system", source: "missed-call-sms" },
          type: "SYSTEM",
          notes: "Звонил и не дозвонился: отправили СМС со ссылкой на WhatsApp",
        });
      } catch (err) {
        void logSystemError("telephony", `СМС после пропущенного звонка ушло, но в хронологию карточки не записано: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { status: "sent", smsId: result.id, parts: result.parts };
  } catch (err) {
    void logSystemError("telephony", `СМС после пропущенного звонка: непредвиденная ошибка: ${err instanceof Error ? err.message : err}`, {
      dedupKey: "missed-call-sms-unexpected",
    });
    return { status: "error" };
  } finally {
    if (claimed) inFlight.delete(claimed);
  }
}

/**
 * Сколько СМС этого вида ушло за 7 дней: строка «включено, отправлено N» в реестре функций.
 * Считаются только ушедшие к провайдеру (не отказы).
 */
export async function countMissedCallSmsSent(days = 7, now: Date = new Date()): Promise<number> {
  return prisma.smsMessage.count({
    where: {
      purpose: MISSED_CALL_SMS_PURPOSE,
      status: { in: ["SENT", "DRY_RUN"] },
      createdAt: { gte: new Date(now.getTime() - days * 24 * 60 * 60 * 1000) },
    },
  });
}

/**
 * ЗАДАЧА «ПЕРЕЗВОНИТЬ» ПО НЕЗНАКОМОМУ ПРОПУЩЕННОМУ закрывается и тогда, когда человек сам
 * написал нам в WhatsApp (рубильник Б). Дозвонился — закрывает finishIncomingCall
 * (closeAutoTasks), перезвонили — callTracker. Остаётся переписка: бот отвечает ему, но
 * диалог мог ещё не быть связан с карточкой, поэтому закрываем по номеру отдельным проходом.
 * Берём только общие задачи (у карточки нет ответственного): задачи агентов не трогаем.
 */
export async function closeMissedCallTasksAnsweredInWhatsapp(now: Date = new Date()): Promise<number> {
  const open = await prisma.interaction.findMany({
    where: {
      autoTaskKind: "inbound_missed_callback",
      nextAction: { not: null },
      completedAt: null,
      taskCancelledAt: null,
      createdAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
      client: { deletedAt: null, assignedAgentId: null },
    },
    select: { id: true, clientId: true, createdAt: true, client: { select: { phone: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  let closed = 0;
  for (const task of open) {
    const national = toSmsPhone(task.client?.phone)?.slice(3);
    if (!national) continue;
    const wrote = await prisma.botConversation.findFirst({
      where: { channel: "WHATSAPP", subscriberId: { endsWith: national }, lastMessageAt: { gt: task.createdAt } },
      select: { id: true },
    });
    if (!wrote) continue;
    closed += await closeAutoTasks(task.clientId, ["inbound_missed_callback"], now);
  }
  return closed;
}
