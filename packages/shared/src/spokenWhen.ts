import { DUSHANBE_OFFSET_MS } from "./dushanbeDay.js";
import { numberToWords, ruPlural, type SpokenLanguage } from "./spokenNumber.js";

/**
 * ДЕНЬ И ВРЕМЯ СЛОВАМИ — ДЛЯ ГОЛОСА (09.10.2026, робот-консультант: показ, перезвон).
 *
 * Та же причина, что у spokenPrice (spokenNumber.ts): «11.10 в 14:00» синтезатор читает
 * как попало, а модель переводит в речь через раз. Сервер отдаёт готовое «завтра, в два
 * часа дня» / «пагоҳ, соати чордаҳ», модель его только произносит.
 *
 * Всё по часам Душанбе (UTC+5), а не по часовому поясу процесса: контейнер живёт в UTC.
 * Дальше недели — день недели и дата цифрами («в пятницу, 23 октября»): порядковые
 * числительные в падеже собирать незачем, такое число синтезатор читает правильно.
 */

const RU_WEEKDAYS_ACC = ["в воскресенье", "в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу"];
const TG_WEEKDAYS = ["якшанбе", "душанбе", "сешанбе", "чоршанбе", "панҷшанбе", "ҷумъа", "шанбе"];
const RU_MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const TG_MONTHS = ["январ", "феврал", "март", "апрел", "май", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];

function wall(at: Date): Date {
  return new Date(at.getTime() + DUSHANBE_OFFSET_MS);
}

function dayIndex(w: Date): number {
  return Math.floor(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) / 86_400_000);
}

/** «завтра», «в субботу», «в пятницу, 23 октября» / «пагоҳ», «шанбе», «ҷумъа, 23 октябр». */
export function spokenDay(at: Date, now: Date, language: SpokenLanguage): string {
  const w = wall(at);
  const diff = dayIndex(w) - dayIndex(wall(now));
  const weekday = w.getUTCDay();
  if (language === "tg") {
    if (diff === 0) return "имрӯз";
    if (diff === 1) return "пагоҳ";
    if (diff === 2) return "пасфардо";
    const day = TG_WEEKDAYS[weekday];
    return diff > 0 && diff < 7 ? day : `${day}, ${w.getUTCDate()} ${TG_MONTHS[w.getUTCMonth()]}`;
  }
  if (diff === 0) return "сегодня";
  if (diff === 1) return "завтра";
  if (diff === 2) return "послезавтра";
  const day = RU_WEEKDAYS_ACC[weekday];
  return diff > 0 && diff < 7 ? day : `${day}, ${w.getUTCDate()} ${RU_MONTHS_GEN[w.getUTCMonth()]}`;
}

/** «в два часа дня», «в одиннадцать тридцать утра», «в шесть вечера» / «соати чордаҳ», «соати ёздаҳ ва сӣ дақиқа». */
export function spokenClock(at: Date, language: SpokenLanguage): string {
  const w = wall(at);
  const h = w.getUTCHours();
  const m = w.getUTCMinutes();
  if (language === "tg") {
    return `соати ${numberToWords(h, "tg")}${m ? ` ва ${numberToWords(m, "tg")} дақиқа` : ""}`;
  }
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const part = h < 5 ? "ночи" : h < 12 ? "утра" : h < 17 ? "дня" : "вечера";
  // «в час дня», а не «в один час дня».
  if (h12 === 1 && !m) return `в час ${part}`;
  const hour = numberToWords(h12, "ru");
  const middle = m ? ` ${numberToWords(m, "ru")}` : ` ${ruPlural(h12, "час", "часа", "часов")}`;
  return `в ${hour}${middle} ${part}`;
}

/** День и время одной фразой: «завтра, в два часа дня» / «пагоҳ, соати чордаҳ». */
export function spokenWhen(at: Date, now: Date, language: SpokenLanguage): string {
  return `${spokenDay(at, now, language)}, ${spokenClock(at, language)}`;
}
