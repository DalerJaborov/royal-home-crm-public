import { amiDbDel, amiDbGet, amiDbPut, loadAmiCredentials } from "./amiClient.js";
import { normalizeDialNumber } from "./ariClient.js";

/**
 * Чёрный список номеров — на самой станции, а не в CRM.
 *
 * ЗАЧЕМ ТАМ, А НЕ ЗДЕСЬ. Спамеру, роботу-автообзвону и настойчивому «мы предлагаем
 * рекламу» бесполезно ставить пометку в карточке: телефон оператора звонит всё
 * равно, а человек всё равно снимает трубку. Отбивать такой звонок должна станция —
 * до того, как он кого-то отвлёк.
 *
 * ПОЧЕМУ ЭТО РАБОТАЕТ СРАЗУ, БЕЗ ПРАВКИ СТАНЦИИ. Входящий маршрут FreePBX уже
 * содержит проверку чёрного списка (`Gosub(app-blacklist-check,s,1())` в
 * ext-did-0002 — проверено на живой станции 13.08.2026), а сам список — это
 * семейство `blacklist` во внутренней базе Asterisk. CRM кладёт туда номер тем же
 * действием DBPut, которым записывает правило очереди. Ничего дописывать в
 * конфигурацию не нужно.
 *
 * ФОРМАТ НОМЕРА — КАК ЕГО ВИДИТ СТАНЦИЯ. В определителе входящего приходят местные
 * девять цифр (или двенадцать с кодом страны — в журнале станции встречались оба
 * вида), а в CRM номер хранится международным. Поэтому пишем ОБА варианта: лишняя
 * запись в чёрном списке безвредна, а пропущенный вариант означает, что спамер
 * дозвонится — то есть настройка, которая выглядит включённой и не работает.
 */

const BLACKLIST_FAMILY = "blacklist";

/** Оба вида одного номера: местные девять цифр и международный с кодом страны. */
export function blacklistKeys(phone: string): string[] {
  const local = normalizeDialNumber(phone);
  if (!local) return [];
  const keys = new Set<string>([local]);
  // Девять местных цифр Таджикистана → 992XXXXXXXXX. Международные номера других
  // стран остаются как есть: у них код уже в номере.
  if (local.length === 9) keys.add(`992${local}`);
  return [...keys];
}

export async function setNumberBlocked(
  phone: string,
  blocked: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const creds = await loadAmiCredentials();
  if (!creds) return { ok: false, error: "Управление станцией не настроено" };
  const keys = blacklistKeys(phone);
  if (keys.length === 0) return { ok: false, error: "Это не номер телефона" };

  for (const key of keys) {
    const result = blocked
      ? await amiDbPut(creds, BLACKLIST_FAMILY, key, "1")
      : await amiDbDel(creds, BLACKLIST_FAMILY, key);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/** Отбивает ли станция звонки с этого номера прямо сейчас. */
export async function isNumberBlocked(phone: string): Promise<{ ok: true; blocked: boolean } | { ok: false; error: string }> {
  const creds = await loadAmiCredentials();
  if (!creds) return { ok: false, error: "Управление станцией не настроено" };
  for (const key of blacklistKeys(phone)) {
    const result = await amiDbGet(creds, BLACKLIST_FAMILY, key);
    if (!result.ok) return result;
    if (result.value) return { ok: true, blocked: true };
  }
  return { ok: true, blocked: false };
}
