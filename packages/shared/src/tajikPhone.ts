/**
 * МОЖНО ЛИ НАБРАТЬ НОМЕР: ОДНО ПРАВИЛО — ОДНО МЕСТО.
 *
 * Это правило было написано дважды, и стороны отвечают на него по разным
 * поводам: сервер решает, ЗВОНИТЬ ли (`lib/telephony/ariClient.ts`), сайт
 * решает, показывать ли КНОПКУ звонка (`lib/phone.ts`). Именно поэтому
 * расхождение здесь особенно неприятно: разойдутся — агент видит кнопку,
 * жмёт, а звонок не уходит, и выглядит это как поломка телефонии, а не как
 * разная проверка номера.
 */

import { CLIENT_PHONE_MASK_CHAR, isMaskedClientPhone } from "./maskContacts.js";

/** Только цифры: набирают их, а не скобки, пробелы и плюс. */
export function phoneDigits(phone: string): string {
  return String(phone ?? "").replace(/\D/g, "");
}

/**
 * Три формы таджикского номера, которые станция умеет набрать:
 *   992 XX XXX XX XX — двенадцать цифр с кодом страны;
 *   0 XX XXX XX XX   — десять цифр с ведущим нулём (местная запись);
 *   XX XXX XX XX     — девять цифр без всего.
 */
export function isDialableTajikNumber(phone: string): boolean {
  // Закрытый маской номер не набирается никогда. Без этой строки `+791612••567`
  // (иностранный, скрыты две цифры) давал ровно девять цифр и сходил за местный.
  if (isMaskedClientPhone(phone)) return false;
  const digits = phoneDigits(phone);
  if (digits.length === 12 && digits.startsWith("992")) return true;
  if (digits.length === 10 && digits.startsWith("0")) return true;
  return digits.length === 9;
}

/**
 * Девять национальных цифр таджикского номера (без 992 и без ведущего нуля) или
 * null, если запись не из трёх форм выше. Одно место, где номер раскладывается:
 * провайдер СМС (`apps/api/src/lib/sms/phone.ts`) собирает из него 992XXXXXXXXX.
 */
export function tajikNationalNumber(phone: string | null | undefined): string | null {
  if (isMaskedClientPhone(phone ?? "")) return null;
  const digits = phoneDigits(phone ?? "");
  if (digits.length === 12 && digits.startsWith("992")) return digits.slice(3);
  if (digits.length === 10 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 9) return digits;
  return null;
}

/**
 * Мобильный ли таджикский номер: СМС доставляется только на него (городские
 * 37/44/3xx СМС не принимают, деньги за такое СМС уходят впустую). Мобильные коды
 * Таджикистана начинаются на 5, 7, 8, 9 (50/55, 70/77/78, 80/87/88, 90-93/98/99).
 * ОЦЕНКА по плану нумерации, не по списку оператора: ошибка в сторону «не слать»
 * стоит одной СМС, ошибка в сторону «слать» — 0,045 сомони.
 */
export function isTajikMobileNumber(phone: string | null | undefined): boolean {
  const national = tajikNationalNumber(phone);
  return national !== null && /^[5789]/.test(national);
}

/**
 * ИНОСТРАННЫЙ ЛИ НОМЕР (17.11.2026, «53 „не ответил“ — 0 звонков»).
 *
 * Станция агентства набирает только Таджикистан: единственный исходящий маршрут
 * FreePBX (`outrt-1`, шаблон `_.`) отдаёт транку цифры как есть, и номер
 * `79•••••••84` уходит оператору без международного выхода. Журнал станции:
 * все такие вызовы — NO ANSWER за 0 секунд и сразу «номер не обслуживается».
 * CRM при этом писала клиенту «не ответил», хотя его телефон не звонил ни разу.
 *
 * Понимает и закрытый номер (`+791612••567` — у смотрящего нет права видеть цифры):
 * маска оставляет начало номера (всё, кроме двух цифр середины и трёх последних), и «+» без 992 в начале — это другая страна.
 * Закрытый номер без «+» по маске не опознать — тогда «не знаем» (false), и
 * решает сервер, у которого есть настоящие цифры.
 */
export function isForeignPhone(phone: string | null | undefined): boolean {
  const raw = String(phone ?? "").trim();
  if (!raw) return false;
  if (isMaskedClientPhone(raw)) {
    const head = raw.split(CLIENT_PHONE_MASK_CHAR)[0] ?? "";
    const headDigits = phoneDigits(head);
    // У короткой записи голова до маски может оказаться короче кода страны («+99»): это
    // начало таджикского кода, не другая страна. Иностранным считаем только голову,
    // которая уже разошлась с 992 (ложный отказ хуже недозвона).
    return head.trimStart().startsWith("+") && headDigits.length > 0 && !"992".startsWith(headDigits) && !headDigits.startsWith("992");
  }
  if (isDialableTajikNumber(raw)) return false;
  const digits = phoneDigits(raw);
  // Десять и больше цифр в не таджикской записи — код другой страны (`7…`, `1…`,
  // российское `8…`, международный выход `00…`). Короче — не «заграница», а
  // обрывок. Начинается с 992 или с одиночного 0, но длина не та — это таджикский
  // номер с опечаткой, а не иностранный: о нём другая ошибка.
  if (digits.length < 10) return false;
  if (digits.startsWith("992")) return false;
  if (digits.startsWith("0") && !digits.startsWith("00")) return false;
  return true;
}

/** Иностранный номер: что сказать сотруднику вместо звонка. Один текст на сервер и сайт. */
export const FOREIGN_PHONE_CALL_ERROR =
  "Номер не таджикский: станция агентства звонит только по Таджикистану. Напишите клиенту в чате (WhatsApp, Instagram) или попросите таджикский номер.";

/** Номер записан неверно (не таджикская запись и не похож на иностранный). */
export const INVALID_PHONE_CALL_ERROR = "Номер записан неверно — станция не сможет его набрать. Исправьте номер в карточке клиента.";

/**
 * ОДНА ДВЕРЬ «МОЖНО ЛИ ЗВОНИТЬ НА ЭТОТ НОМЕР КЛИЕНТА»: null — можно, строка —
 * почему нельзя (её и показывать сотруднику). Звонок, который станция заведомо не
 * наберёт, не заводится вовсе: иначе он кончается исходом «клиент не ответил»,
 * задачами «перезвонить» и переводом клиента в «не отвечает» без единого гудка.
 */
export function stationDialRefusal(phone: string | null | undefined): string | null {
  const raw = String(phone ?? "");
  if (isDialableTajikNumber(raw)) return null;
  return isForeignPhone(raw) ? FOREIGN_PHONE_CALL_ERROR : INVALID_PHONE_CALL_ERROR;
}

/**
 * ЕДИНЫЙ ВИД НОМЕРА СОТРУДНИКА В БАЗЕ (23.11.2026): `+992XXXXXXXXX`.
 *
 * Номер — логин входа по СМС (`Agent.phone`, @unique), и искать его `phoneCandidates` в
 * `routes/auth.ts` должен по одной записи. Раньше сохранялось как ввели: у двух новых
 * сотрудников легло `97XXXXXXX`, они вписали «+992 97…», учётка не нашлась, СМС не ушла.
 *
 * Таджикский номер в любой из трёх записей (`tajikNationalNumber`) приводится к
 * `+992` + девять цифр. Иностранный остаётся как введён (обрезан по краям): так уже
 * допускалось, СМС на него просто не идёт. Остальное (обрывок, закрытый маской номер,
 * таджикский с опечаткой в длине) — null: сохранять такое нельзя.
 */
export function normalizeStaffPhone(phone: string | null | undefined): string | null {
  const raw = String(phone ?? "").trim();
  if (!raw) return null;
  const national = tajikNationalNumber(raw);
  if (national) return `+992${national}`;
  return isForeignPhone(raw) ? raw : null;
}

/**
 * Все записи, в которых один и тот же номер сотрудника мог лечь в базу: «как ввели»,
 * `+992N`, `992N`, `0N` и голые девять цифр. Единственный источник для поиска учётки
 * по номеру (вход по СМС, проверка занятости, звонок сотрудника) — закрывает и уже
 * записанные кривые номера, пока их не привели к одному виду.
 */
export function staffPhoneLookupForms(phone: string | null | undefined): string[] {
  const raw = String(phone ?? "").trim();
  if (!raw) return [];
  const national = tajikNationalNumber(raw);
  const forms = national ? [`+992${national}`, `992${national}`, national, `0${national}`] : [];
  return [...new Set([raw, ...forms])];
}
