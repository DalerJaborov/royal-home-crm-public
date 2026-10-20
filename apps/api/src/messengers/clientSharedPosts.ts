/**
 * КАКИЕ ПУБЛИКАЦИИ INSTAGRAM КЛИЕНТ ПРИСЛАЛ НАМ САМ (25.09.2026).
 *
 * Живой случай: клиент переслал наш рилс, бот узнал по нему объект и тут же
 * отправил в ответ ссылку на публикацию этого объекта (Property.instagramUrl,
 * messengers/propertyShowcase.ts) — то есть ТОТ ЖЕ рилс, который человек только
 * что прислал. Со стороны это автомат, не понявший собеседника.
 *
 * Показ объекта уже не отправлял ссылку, которую писал САМ бот (recentBotText), но
 * про присланное клиентом не знал ничего: код публикации пересылки есть только в
 * вебхуке (routes/webhooks.ts, sharedCode) — в историю диалога он не попадает, у
 * пересланного рилса нет ни текста, ни сохраняемого адреса.
 *
 * ПОЧЕМУ В ПАМЯТИ ПРОЦЕССА. Ход, на котором бот решает показать объект, идёт в
 * том же процессе, что и вебхук, через секунды после пересылки (или ходом-двумя
 * позже). Перезапуск контейнера память стирает — худшее последствие: одна лишняя
 * ссылка, то есть прежнее поведение, а не новая поломка. Колонка в базе ради этого
 * не нужна.
 */

import { instagramShortcode } from "./sharedMedia.js";

/** Сколько помним присланное: разговор о пересланном объекте редко тянется дольше. */
export const CLIENT_SHARED_POST_TTL_MS = 24 * 60 * 60 * 1000;
/** Предел записей — память процесса не должна расти без конца. */
const MAX_PEERS = 5000;
const MAX_CODES_PER_PEER = 10;

const sharedByPeer = new Map<string, { code: string; at: number }[]>();

const peerKey = (channel: string, recipientId: string): string => `${channel}:${recipientId}`;

/** Запомнить код публикации, которую клиент прислал сам (пересылкой или ссылкой). */
export function rememberClientSharedPost(
  channel: string,
  recipientId: string,
  code: string | null | undefined,
  now: number = Date.now()
): void {
  if (!code || !recipientId) return;
  const key = peerKey(channel, recipientId);
  const fresh = (sharedByPeer.get(key) ?? []).filter(
    (e) => e.code !== code && now - e.at < CLIENT_SHARED_POST_TTL_MS
  );
  fresh.push({ code, at: now });
  // delete + set — ключ уезжает в конец Map, и вытесняется самый давний собеседник.
  sharedByPeer.delete(key);
  sharedByPeer.set(key, fresh.slice(-MAX_CODES_PER_PEER));
  while (sharedByPeer.size > MAX_PEERS) {
    const oldest = sharedByPeer.keys().next().value;
    if (oldest === undefined) break;
    sharedByPeer.delete(oldest);
  }
}

/** Коды, присланные этим клиентом за последние сутки. */
export function clientSharedPostCodes(channel: string, recipientId: string, now: number = Date.now()): string[] {
  return (sharedByPeer.get(peerKey(channel, recipientId)) ?? [])
    .filter((e) => now - e.at < CLIENT_SHARED_POST_TTL_MS)
    .map((e) => e.code);
}

/**
 * Ссылка ведёт на ту же публикацию, что клиент прислал сам. Сравниваем по КОДУ, а
 * не строкой: клиент присылает адрес с хвостом `?igsh=…`/`?stkn=…` и формой
 * /reel/ или /p/, а в карточке объекта он записан без хвоста.
 */
export function isClientOwnSharedPost(url: string | null | undefined, clientCodes: readonly string[]): boolean {
  const code = instagramShortcode(url);
  return !!code && clientCodes.includes(code);
}

/** Только для тестов: очистить память между прогонами. */
export function resetClientSharedPosts(): void {
  sharedByPeer.clear();
}
