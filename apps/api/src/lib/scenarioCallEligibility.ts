import { prisma } from "../db.js";
import { isNumberBlocked } from "./telephony/stationBlacklist.js";

/**
 * КОМУ СЦЕНАРНЫЙ ЗВОНОК РОБОТА НАБИРАТЬ НЕЛЬЗЯ (02.10.2026, аудит звонков робота, А4).
 *
 * Робот звонит по трём сценариям — опрос покупателя после показа, проверка
 * собственника и приглашение кандидата, — и до сих пор ни один не спрашивал,
 * просил ли человек оставить его в покое. Два существующих «стоп» в системе:
 *
 *  1. «Не беспокойте» словами. Клиент написал «не пишите», «не беспокойте»,
 *     «отстаньте» — переписка отмечает это в `BotConversation.optedOutAt`
 *     (messengers/conversation.ts, шаблоны — isOptOutMessage в botFollowUps.ts).
 *     Отметка запрещает ИНИЦИАТИВУ с нашей стороны, а звонок робота — самая
 *     навязчивая инициатива из всех.
 *  2. Чёрный список номеров. Живёт на самой станции (Asterisk DB, семейство
 *     `blacklist`, lib/telephony/stationBlacklist.ts); кнопка «больше не звонить
 *     с этого номера» у оператора. Номер, который мы сами заблокировали как
 *     спам, исходящим тоже набирать нельзя.
 *
 * Выходные (Настройки, 11.10.2026) — не здесь, а в часах звонков (alignToCallHours /
 * isWithinPostShowingCallHours в lib/postShowingCall.ts): их используют все три
 * сценария, и воскресный набор закрыт одним местом.
 *
 * ПРОВЕРКА ЧЁРНОГО СПИСКА НЕ БЛОКИРУЕТ ЗВОНКИ ПРИ СБОЕ СТАНЦИИ: если AMI не
 * настроен или не ответил, список прочитать нечем, и молчать из-за этого
 * всем сценариям сразу было бы хуже. Отметка «не беспокойте» читается из базы и
 * от станции не зависит.
 */

export type ScenarioCallBlock = "do_not_contact" | "blacklisted";

/** Что известно о том, кому звоним: любое из полей сужает поиск отметки «не беспокойте». */
export interface ScenarioCallTarget {
  phone: string;
  /** Карточка клиента (покупатель, собственник). */
  clientId?: string | null;
  /** Диалог бота, из которого пришёл человек (у кандидата — `JobApplication.conversationId`). */
  conversationId?: string | null;
  /** Досье собеседника. */
  contactProfileId?: string | null;
}

/** Просил ли человек не писать и не звонить — по любому его диалогу с ботом. */
export async function hasOptedOutOfContact(target: Omit<ScenarioCallTarget, "phone">): Promise<boolean> {
  const or: Array<Record<string, unknown>> = [];
  if (target.conversationId) or.push({ id: target.conversationId });
  if (target.clientId) {
    or.push({ clientId: target.clientId });
    or.push({ contactProfile: { is: { clientId: target.clientId } } });
  }
  if (target.contactProfileId) or.push({ contactProfileId: target.contactProfileId });
  if (or.length === 0) return false;

  const found = await prisma.botConversation.findFirst({
    where: { optedOutAt: { not: null }, OR: or },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Сколько ждём станцию с проверкой чёрного списка. Прежде зависший AMI держал каждый
 * набор до ~10 с (две попытки по 5 с и пауза), а блокировать звонок при сбое всё равно
 * не должен (третий аудит 02.10.2026, С6): короткий предел, «не заблокирован».
 */
export const BLACKLIST_CHECK_TIMEOUT_MS = 3000;

/** Номер в чёрном списке станции. Станция недоступна или не ответила за предел — «нет», звонок не блокируем. */
export async function isOnStationBlacklist(phone: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), BLACKLIST_CHECK_TIMEOUT_MS);
    });
    const result = await Promise.race([isNumberBlocked(phone), timeout]);
    return result !== null && result.ok && result.blocked;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Причина, по которой звонить нельзя, или `null`, если можно. */
export async function scenarioCallBlockReason(target: ScenarioCallTarget): Promise<ScenarioCallBlock | null> {
  if (await hasOptedOutOfContact(target)) return "do_not_contact";
  if (await isOnStationBlacklist(target.phone)) return "blacklisted";
  return null;
}
