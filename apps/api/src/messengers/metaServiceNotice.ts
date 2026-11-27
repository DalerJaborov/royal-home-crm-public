/**
 * СЛУЖЕБНОЕ УВЕДОМЛЕНИЕ САМОЙ META — НЕ КЛИЕНТ (27.11.2026).
 *
 * Живой случай: на наш второй номер WhatsApp пришёл обычный `type: "text"` от
 * американского номера с именем профиля «WhatsApp Business»: «Continue setting up your
 * account … your number +992 87 791 4444 … Setup guidance … business.facebook.com/…».
 * Бот принял это за клиента: «Спасибо, номер получил, агент вам позвонит», а в карточку
 * ушёл номер из текста уведомления (наш собственный номер) — заявка ПК-001102.
 *
 * СТРУКТУРНОГО ПРИЗНАКА В ВЕБХУКЕ НЕТ: это не `system` и не `request_welcome`, а обычный
 * текст от обычного wa_id (проверено по телу переписки на проде). Поэтому признаков три,
 * все узкие, и ни один случайный не выбрасывает живого человека:
 *  1. ссылка на кабинет Meta (business.facebook.com / business.whatsapp.com), ведущая в
 *     WhatsApp Manager: клиенту агентства недвижимости слать такое незачем;
 *  2. имя профиля отправителя официальное («WhatsApp Business», «Meta» …) И в тексте ссылка
 *     на площадку Meta;
 *  3. известный служебный номер Meta (тот, что прислал живое уведомление 26.11.2026).
 * Имя профиля задаёт сам пользователь, поэтому ОДНО имя без ссылки признаком не является.
 */

/** Номера, с которых Meta шлёт служебные уведомления (wa_id без «+»). Пополняются только по живому случаю. */
const META_OFFICIAL_SENDER_IDS: ReadonlySet<string> = new Set([
  "16465894168", // 26.11.2026, «WhatsApp Business»: «Continue setting up your account»
]);

/** Имена профиля, которыми подписывается сама Meta (нормализованные: нижний регистр, одинарные пробелы). */
const META_OFFICIAL_PROFILE_NAMES: ReadonlySet<string> = new Set([
  "whatsapp",
  "whatsapp business",
  "whatsapp business team",
  "whatsapp business support",
  "meta",
  "meta business",
  "meta business suite",
  "facebook",
  "facebook business",
]);

/** Кабинеты Meta, куда ведут служебные уведомления. */
const META_BUSINESS_HOSTS: ReadonlySet<string> = new Set(["business.facebook.com", "business.whatsapp.com"]);

/** Площадки Meta вообще: для признака 2 (имя профиля + любая такая ссылка). */
const META_OWNED_DOMAINS = ["facebook.com", "whatsapp.com", "meta.com", "fb.com", "instagram.com"];

/** Путь кабинета, относящийся к WhatsApp: whatsapp_manager, wa/manage, setup_guidance. */
const WHATSAPP_MANAGER_PATH = /whatsapp[_-]?manager|\/wa\/(manage|whatsapp)|setup[_-]?guidance/i;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hostIsOneOf(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Ссылки текста: хост (нижний регистр, без www.) и декодированные путь с запросом. Битые пропускаются. */
function linksOf(text: string): { host: string; rest: string }[] {
  const out: { host: string; rest: string }[] = [];
  for (const raw of text.match(URL_RE) ?? []) {
    try {
      const u = new URL(raw);
      out.push({ host: u.hostname.toLowerCase().replace(/^www\./, ""), rest: safeDecode(`${u.pathname}${u.search}`) });
    } catch {
      /* не ссылка */
    }
  }
  return out;
}

/**
 * Причина, по которой входящее — служебное уведомление Meta, а не реплика клиента; null — обычное сообщение.
 * Чистая функция: зовётся из messengers/meta.ts (parseIncoming), единственной двери приёма WhatsApp для
 * старого пути и для ядра. Instagram и Messenger её не зовут: признаков для них нет (см. журнал правки).
 */
export function metaServiceNoticeReason(input: {
  /** wa_id отправителя (цифры без «+»). */
  senderId?: string;
  /** Имя профиля отправителя из `contacts[].profile.name`. */
  profileName?: string;
  /** Текст сообщения. */
  text?: string;
}): string | null {
  if (input.senderId && META_OFFICIAL_SENDER_IDS.has(input.senderId.replace(/\D/g, ""))) {
    return "служебный номер Meta";
  }
  const links = linksOf(input.text ?? "");
  if (links.some((l) => META_BUSINESS_HOSTS.has(l.host) && WHATSAPP_MANAGER_PATH.test(l.rest))) {
    return "уведомление WhatsApp Manager от Meta";
  }
  const name = (input.profileName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (name && META_OFFICIAL_PROFILE_NAMES.has(name) && links.some((l) => hostIsOneOf(l.host, META_OWNED_DOMAINS))) {
    return "официальный отправитель Meta со ссылкой на Meta";
  }
  return null;
}
