import { isMaskedClientPhone } from "@royal-home/shared";

/** Только цифры номера — чтобы «+992 90 000 00 01» и «992900000001» считались одним. */
export const digitsOf = (phone: string) => phone.replace(/[^\d]/g, "");

/** Наберёт ли транк этот номер. Проверка ОДНА на сервер и сайт и лежит в общем
 *  пакете: здесь она нужна, чтобы не показывать кнопку «Позвонить» там, где
 *  станция откажет, а на сервере — чтобы решить, звонить ли. Разойдись эти две —
 *  кнопка есть, звонок не идёт (packages/shared/src/tajikPhone.ts, правка #752).
 *  Окончательно решает всё равно сервер. */
import { isDialableTajikNumber } from "@royal-home/shared";
export { isDialableTajikNumber };

/** Показывать ли кнопку «Позвонить» на этот номер.
 *
 *  Замаскированный номер (`+992•••••57` — у смотрящего нет права
 *  `clients.viewPhone`) даёт при подсчёте цифр «99257», 5 знаков — ни один
 *  формат isDialableTajikNumber не подходит, и кнопка не рисовалась вовсе,
 *  хотя звонок работает: сервер сам разворачивает маску по клиенту и
 *  проверяет принадлежность номера (routes/clients/communications.ts),
 *  агенту цифры не нужны и не видны (владелец 30.08.2026, исправлено сперва
 *  на мобильной версии — MobileClientPhones). */
export function isCallableClientPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  return isMaskedClientPhone(phone) || isDialableTajikNumber(phone);
}

/** Ссылка «открыть в WhatsApp» для номера, который транк не наберёт (не таджикский
 *  формат) — запасной путь для звонка через CRM (см. isDialableTajikNumber выше).
 *  wa.me принимает только цифры, код страны без «+»/пробелов/скобок; маскированный
 *  номер сюда не попадает — isCallableClientPhone для маски возвращает true, и
 *  вызывающий код рисует обычную кнопку звонка, а не эту ссылку. */
export function waLink(phone: string): string {
  return `https://wa.me/${digitsOf(phone)}`;
}

/** Запасные номера клиента одним списком — WhatsApp (если отличается от основного)
 *  и ручные extraPhones, в порядке показа. Единая нумерация «Доп. номер» /
 *  «Доп. номер N» вместо раздельных подписей WhatsApp/«Ещё номер» (владелец
 *  25.08.2026) — используется и в «Деталях клиента», и в подсказке после недозвона,
 *  список должен совпадать в обоих местах. */
export function secondaryPhones(client: { phone: string; whatsappPhone?: string | null; extraPhones?: string[] | null }): string[] {
  return [
    ...(client.whatsappPhone && digitsOf(client.whatsappPhone) !== digitsOf(client.phone) ? [client.whatsappPhone] : []),
    ...(client.extraPhones ?? []),
  ];
}
