/**
 * БОТ НЕ ОТВЕЧАЕТ САМ СЕБЕ.
 *
 * 16.08.2026, вечер: наш второй аккаунт (@royalhome.info) написал первому
 * (@royal.home.tj) — и два бота вежливо попрощались друг с другом два десятка раз
 * подряд: «Ташаккур, саломат бошед!» → «Саломат бошед!» → «Ҳамеша саломат бошед!».
 * Остановил это владелец руками, поставив оба диалога на паузу. Само оно бы не
 * кончилось: у обоих ботов на каждую реплику есть вежливый ответ, а «конца
 * разговора» в правилах нет и быть не может.
 *
 * ПОЧЕМУ НЕ СРАВНИТЬ ИДЕНТИФИКАТОРЫ. У Instagram их два вида, и это уже стоило
 * проекту одного разбора (см. accounts.ts): в вебхуке отправитель приходит как
 * IGSID, привязанный к паре «кто кому пишет», и с `externalId` нашего аккаунта он
 * не совпадает никогда. На проде это 1612728090567479 против 17841477393005072 —
 * разные числа у одного и того же аккаунта.
 *
 * ПОЭТОМУ СРАВНИВАЕМ НИК. Он у аккаунта один, приходит от Meta тем же запросом, что
 * и идентификатор (см. instagramTokenIdentity), и совпадает с ником, который мы
 * резолвим у отправителя для показа в переписке. Ник нашего аккаунта хранится в
 * `MessengerAccount.username` и заполняется сам при сверке.
 *
 * ЗАПАСНОЙ ПУТЬ. Пока ник не заполнен (сверка ещё не проходила), сравниваем
 * идентификаторы напрямую — вдруг канал ведёт себя иначе. Стоит это ноль запросов,
 * а один пойманный случай окупает всё.
 */

import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";

/** Ники и идентификаторы наших аккаунтов. Кэш на минуту: проверка стоит на пути
 *  каждого входящего, а состав аккаунтов меняется раз в месяц. */
const CACHE_MS = 60_000;
let cache: { at: number; usernames: Set<string>; externalIds: Set<string> } | null = null;

const normalize = (value: string): string => value.trim().replace(/^@/, "").toLowerCase();

async function ownIdentities(): Promise<{ usernames: Set<string>; externalIds: Set<string> }> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const rows = await prisma.messengerAccount.findMany({ select: { username: true, externalId: true } });
    const usernames = new Set(rows.map((r) => r.username).filter((v): v is string => !!v).map(normalize));
    const externalIds = new Set(rows.map((r) => r.externalId).filter(Boolean));
    cache = { at: Date.now(), usernames, externalIds };
    return cache;
  } catch (err) {
    // Отказ базы не должен ронять обработку входящего: пустые множества означают
    // «не узнали себя», то есть прежнее поведение.
    void logSystemError("meta", `Ники наших аккаунтов не прочитаны: ${err instanceof Error ? err.message : err}`);
    return { usernames: new Set(), externalIds: new Set() };
  }
}

/** Сбрасывается вместе с кэшем аккаунтов (правка в Настройках). */
export function resetOwnAccountCache(): void {
  cache = null;
}

/**
 * Это входящее — от НАС САМИХ (другой наш аккаунт)?
 *
 * @param senderId идентификатор отправителя из вебхука.
 * @param senderName ник отправителя, как он резолвится для переписки («@royalhome.info»).
 *   Может быть не известен — тогда работает только сравнение идентификаторов.
 */
export async function isOwnAccountSender(input: {
  senderId: string;
  senderName?: string | null;
}): Promise<boolean> {
  const { usernames, externalIds } = await ownIdentities();
  if (externalIds.has(input.senderId)) return true;
  if (!input.senderName) return false;
  return usernames.has(normalize(input.senderName));
}

/**
 * Насколько долго молчать в таком диалоге.
 *
 * Не «навсегда» отдельным признаком, а обычной паузой: у диалога уже есть
 * `pausedUntil`, его понимает и бот, и экран «Сообщения», и владелец может снять
 * паузу сам, если однажды захочет разговаривать между аккаунтами руками.
 */
export const OWN_ACCOUNT_PAUSE_YEARS = 10;

export function ownAccountPauseUntil(now: Date = new Date()): Date {
  const until = new Date(now);
  until.setFullYear(until.getFullYear() + OWN_ACCOUNT_PAUSE_YEARS);
  return until;
}
