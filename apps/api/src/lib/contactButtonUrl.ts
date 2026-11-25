/**
 * Единственное правило ссылки в кнопке ответа бота (владелец 25.11.2026: «в Instagram давай ссылку на наш WhatsApp»):
 * только `https://wa.me/<номер цифрами>` и, по желанию, предзаполненный текст `?text=…` (уже закодированный, без пробелов).
 * Его зовут и схема очереди отправки (lib/customerDeliveryContracts.ts), и дверь отправки (messengers/meta.ts): никакая
 * другая ссылка в кнопку не проходит, даже если её туда положит ошибка в коде выше.
 */
export const CONTACT_BUTTON_URL_RE = /^https:\/\/wa\.me\/\d{9,15}(?:\?text=[^\s#]{1,600})?$/u;

export function isAllowedContactButtonUrl(url: string): boolean {
  return CONTACT_BUTTON_URL_RE.test(url);
}
