/**
 * КОРОТКАЯ ПАМЯТЬ О СОБЕСЕДНИКЕ МЕЖДУ СООБЩЕНИЯМИ ВЕБХУКА (02.10.2026).
 *
 * Два случая из переписок владельца 02.10, где смысл одного сообщения живёт в
 * ДРУГОМ, соседнем:
 *
 *  1. ПЕРЕХОД С РЕКЛАМЫ ОТДЕЛЬНЫМ СОБЫТИЕМ. Meta шлёт клик по объявлению событием
 *     `referral` БЕЗ `message`, а сами слова или пересланный ролик — следующим
 *     событием, уже без метки рекламы. Разбор (messengers/meta.ts) такое событие
 *     выбрасывал целиком, и бот не знал, что человек пришёл с НАШЕЙ рекламы:
 *     отвечал «видео не открылось» и спрашивал, какую квартиру он ищет.
 *  2. ЧУЖОЙ РОЛИК, А СЛЕДОМ «ЛАЙК». Накрутку проверка ловит только когда ролик и
 *     просьба в одном сообщении; присланные двумя сообщениями, они проходили, и
 *     бот вежливо отвечал спамеру.
 *
 * В памяти процесса, а не в базе — по той же причине, что messengers/clientSharedPosts.ts:
 * связка живёт секунды-минуты, а перезапуск стоит ровно прежнего поведения.
 */

export interface RememberedAdReferral {
  adId?: string;
  adRef?: string;
  adPostId?: string;
  adTitle?: string;
}
export interface AdReferralSnapshot { readonly ref: RememberedAdReferral; readonly at: number }
export function peekAdReferral(channel: string, senderId: string, accountScope: string, now = Date.now(), maxAgeMs = AD_TTL_MS): AdReferralSnapshot | null {
  const entry = adByPeer.get(JSON.stringify([channel, senderId, accountScope]));
  return entry && now - entry.at < Math.min(maxAgeMs, AD_TTL_MS) ? entry : null;
}
/** Compare the stored entry identity, so a newer referral survives an await. */
export function consumeAdReferral(channel: string, senderId: string, accountScope: string, expected: AdReferralSnapshot): boolean {
  const k = JSON.stringify([channel, senderId, accountScope]);
  if (adByPeer.get(k) !== expected) return false;
  adByPeer.delete(k); return true;
}

const AD_TTL_MS = 30 * 60 * 1000;
const FOREIGN_SHARE_TTL_MS = 10 * 60 * 1000;
const MAX_PEERS = 5000;

const adByPeer = new Map<string, { ref: RememberedAdReferral; at: number }>();
const foreignShareByPeer = new Map<string, number>();
const silentShareByPeer = new Map<string, number>();

const key = (channel: string, senderId: string) => `${channel}:${senderId}`;

function trim<T>(map: Map<string, T>): void {
  while (map.size > MAX_PEERS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * ОБЪЯВЛЕНИЕ, ПРИВЯЗАННОЕ К КОНКРЕТНОМУ СООБЩЕНИЮ (30.10.2026, полоса CORE). Приём CORE разбирает одно и то же
 * сообщение несколько раз (маршрут, запись, повторная доставка), а память о клике по рекламе меняется со временем.
 * Первый разбор фиксирует итог для этого MID (метка или её отсутствие), и все следующие разборы получают тот же итог:
 * иначе повторная доставка старого сообщения подхватила бы чужую, пришедшую позже метку и не совпала бы с записанным.
 */
const adByEvent = new Map<string, { ref: RememberedAdReferral | null; at: number }>();
export function adReferralBoundToEvent(channel: string, senderId: string, accountScope: string, eventId: string,
  choose: () => RememberedAdReferral | null): RememberedAdReferral | null {
  const k = JSON.stringify([channel, senderId, accountScope, eventId]);
  const known = adByEvent.get(k);
  if (known) return known.ref;
  const ref = choose();
  adByEvent.set(k, { ref, at: Date.now() });
  trim(adByEvent);
  return ref;
}

export function rememberAdReferral(channel: string, senderId: string, ref: RememberedAdReferral, now = Date.now(), accountScope?: string): void {
  const k = accountScope ? JSON.stringify([channel, senderId, accountScope]) : key(channel, senderId);
  adByPeer.delete(k);
  adByPeer.set(k, { ref, at: now });
  trim(adByPeer);
}

/** Метка рекламы, пришедшая отдельным событием, — забирается ОДИН раз: дальше
 *  объект и объявление живут в самом диалоге (BotConversation.adPropertyId/adExternalId). */
export function takeAdReferral(channel: string, senderId: string, now = Date.now(), accountScope?: string): RememberedAdReferral | null {
  const k = accountScope ? JSON.stringify([channel, senderId, accountScope]) : key(channel, senderId);
  const entry = adByPeer.get(k);
  if (!entry) return null;
  adByPeer.delete(k);
  return now - entry.at < AD_TTL_MS ? entry.ref : null;
}

export function rememberForeignShare(channel: string, senderId: string, now = Date.now()): void {
  const k = key(channel, senderId);
  foreignShareByPeer.delete(k);
  foreignShareByPeer.set(k, now);
  trim(foreignShareByPeer);
}

/** Человек только что прислал чужую публикацию — следующее «лайк» относится к ней. */
export function recentForeignShare(channel: string, senderId: string, now = Date.now()): boolean {
  const at = foreignShareByPeer.get(key(channel, senderId));
  return at != null && now - at < FOREIGN_SHARE_TTL_MS;
}

/**
 * 3. ЧУЖОЙ РОЛИК, НА КОТОРЫЙ МЫ ПРОМОЛЧАЛИ, А СЛЕДОМ ПОДПИСЬ ОТДЕЛЬНЫМ СООБЩЕНИЕМ
 *    (03.10.2026, продавец игровых аккаунтов: пост, потом «Ишам капен ку 🔥»).
 *    Instagram шлёт пересылку и приписанные к ней слова двумя событиями, и вторые
 *    шли боту как обычный текст. Подпись без дела к промолчанному ролику — тоже молчим.
 */
export function rememberSilentShare(channel: string, senderId: string, now = Date.now()): void {
  const k = key(channel, senderId);
  silentShareByPeer.delete(k);
  silentShareByPeer.set(k, now);
  trim(silentShareByPeer);
}

export function recentSilentShare(channel: string, senderId: string, now = Date.now()): boolean {
  const at = silentShareByPeer.get(key(channel, senderId));
  return at != null && now - at < FOREIGN_SHARE_TTL_MS;
}

/** Только для тестов. */
export function resetMetaPeerMemory(): void {
  adByPeer.clear();
  adByEvent.clear();
  foreignShareByPeer.clear();
  silentShareByPeer.clear();
}
