import { convertToTjs, type Currency, type PropertyStatus } from "@royal-home/shared";
import { pluralizeRu } from "@royal-home/shared";
import { dushanbeDate, dushanbeDayKey, dushanbeTime } from "./date";

export { PROPERTY_TYPE_LABELS, PROPERTY_CONDITION_LABELS, pluralizeRu } from "@royal-home/shared";

/** Display precision only: retain the stored area for pricing and matching. */
export function formatArea(value: number | string | null | undefined): string {
  if (value == null || value === "") return "—";
  const area = Number(value);
  return Number.isFinite(area) && area >= 0
    ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(area)
    : "—";
}

/**
 * Деньги «по-человечески»: копейки показываются, только когда они есть.
 *
 * До 03.09.2026 здесь стоял `Intl.NumberFormat("ru-RU")` без настроек, а это
 * «до трёх знаков после запятой»: одна и та же колонка печатала 2 000, 1 999,5
 * и 1 999,499 — три разных вида денег подряд. Хвост от плавающей точки при этом
 * выводился как значащая цифра, а настоящие копейки в круглых суммах пропадали.
 *
 * Теперь: нет копеек — «2 000 с.», есть — «1 999,50 с.». Ничего не отбрасывается
 * молча, и при этом крупные плитки не превращаются в «2 000,00 с.» без нужды.
 * Там, где деньги стоят колонкой и обязаны сходиться в итог (Финансы, Реклама,
 * отчёты), используется formatMoneyExact — он всегда печатает две цифры.
 */
export function formatMoney(value: number | string, currency: Currency | string) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  const hasCents = Math.round(Math.abs(safe) * 100) % 100 !== 0;
  const formatted = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(safe);
  return currency === "USD" ? `$${formatted}` : `${formatted} с.`;
}

/**
 * ДЕНЬГИ ДО КОПЕЙКИ — там, где сумма обязана сходиться.
 *
 * formatMoney выше округляет по-человечески: в списке объектов «12 500 $» и
 * «12 500,00 $» читаются одинаково, а первое короче. В отчётах, где столбец
 * складывается в итог, это не годится: строки, округлённые до сомони, не дают
 * итога, округлённого до сомони, и владелец видит расхождение в пару единиц там,
 * где никакой ошибки нет. Поэтому раздел «Реклама» показывает две цифры после
 * запятой всегда — ровно те, что посчитал сервер в целых сотых.
 */
export function formatMoneyExact(value: number | string, currency: Currency | string) {
  const n = Number(value);
  const formatted = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
  return currency === "USD" ? `$${formatted}` : `${formatted} с.`;
}

/**
 * Приводит сумму к сомони — отчётной валюте компании. Нужен там, где на экране
 * СКЛАДЫВАЮТСЯ суммы из разных сделок: цены и комиссии хранятся в валюте объекта,
 * и без приведения доллары суммировались с сомони один к одному.
 * Курс берётся из Настроек (usdToTjsRate, обновляется автоматически с alif.tj).
 *
 * ПРАВИЛО ОДНО И ЛЕЖИТ В ОБЩЕМ ПАКЕТЕ (22.09.2026). Здесь было своё вычисление
 * `n * курс` — без округления, в отличие от серверного, где округление до
 * копейки сделано намеренно (9.53 × 11.27 = 107.40310000000001, и этот хвост
 * уезжал в отчёты). Из-за этого доска сделок могла не сойтись с отчётом по той
 * же сумме. Считает теперь общий `convertToTjs`, тот же самый, что на сервере.
 */
export function toTjs(value: number | string | null | undefined, currency: Currency | string | null | undefined, usdToTjsRate: number) {
  return convertToTjs(value, currency, usdToTjsRate);
}

/**
 * Сумма комиссий нескольких сделок в сомони — каждая приводится из своей
 * валюты. Пульт («Ждут подписи») складывал их как есть и подписывал доллары
 * как сомони (аудит 23.09.2026, №19).
 */
export function sumCommissionTjs(
  deals: { commissionAmount?: number | string | null; currency?: Currency | string | null }[],
  usdToTjsRate: number
): number {
  return deals.reduce((sum, d) => sum + toTjs(d.commissionAmount, d.currency ?? "TJS", usdToTjsRate), 0);
}

/**
 * Запасной курс — из общего пакета, не своей копией.
 *
 * До 22.09.2026 здесь стояло собственное `= 11` с комментарием «см.
 * apps/api/src/lib/money.ts»: то есть второй экземпляр правила, про который
 * знали и надеялись, что его не забудут поправить вместе с первым. Теперь
 * забыть нечего — экземпляр один.
 */
export { FALLBACK_USD_TO_TJS } from "@royal-home/shared";

/** Полных дней с даты — подпись «N дн» на карточке сделки (десктопная доска в
 *  pages/Deals.tsx и мобильная в components/mobile/MobileDeals.tsx делят одну
 *  формулу, чтобы возраст сделки не расходился между обликами). */
export function daysSince(date: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));
}

export function formatPricePerSqm(price: number | string, area: number | string, currency: Currency) {
  const perSqm = Number(price) / Number(area);
  return `${formatMoney(Math.round(perSqm), currency)} / м²`;
}

/**
 * «41 минуту», «2 ч 10 мин», «3 дня» — сколько карточка клиента ждёт агента.
 *
 * Общая для десктопа (pages/Clients.tsx) и телефона
 * (pages/Clients.tsx): строка «ждёт агента N» и число на
 * плитке «Без агента» обязаны читаться одинаково на обоих обликах — раньше
 * жила только в Clients.tsx, а телефон эту строку не рисовал вовсе (баг
 * класса «desktop и mobile ship together», CLAUDE.md).
 */
export function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes} ${pluralizeRu(minutes, ["минуту", "минуты", "минут"])}`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
  const days = Math.floor(minutes / (24 * 60));
  return `${days} ${pluralizeRu(days, ["день", "дня", "дней"])}`;
}

export const PROPERTY_STATUS_LABELS: Record<PropertyStatus, string> = {
  PENDING_REVIEW: "На проверке",
  AWAITING_PHOTOS: "Ждём фото",
  AWAITING_VIDEO: "Ждём видео",
  EDITING: "На монтаже",
  AVAILABLE: "В продаже",
  RESERVED: "Резерв · задаток",
  SOLD: "Продано",
  WITHDRAWN: "Снято с продажи",
};

/**
 * Цвет состояния. Жёлтый — в работе, зелёный — готов, синий и серый — вышел из
 * оборота (таблица владельца). Красным этапы конвейера красит не эта таблица, а
 * просрочка: она приходит с сервера отдельным признаком (stage.overdue), потому
 * что зависит от сроков в Настройках, а не от самого состояния.
 */
export const PROPERTY_STATUS_CLASSES: Record<PropertyStatus, string> = {
  PENDING_REVIEW: "text-amber bg-amber-bg",
  AWAITING_PHOTOS: "text-amber bg-amber-bg",
  AWAITING_VIDEO: "text-amber bg-amber-bg",
  EDITING: "text-amber bg-amber-bg",
  AVAILABLE: "text-green bg-green-bg",
  RESERVED: "text-amber bg-amber-bg",
  SOLD: "text-blue bg-blue/10",
  WITHDRAWN: "text-gray-500 bg-line-soft",
};

/**
 * Те же статусы в языке темы «Royal Home 2026»: классы пилюли `.chip` из
 * прототипа (apps/web/src/theme-2026-proto.css), а не утилиты Tailwind. Живут
 * рядом с PROPERTY_STATUS_CLASSES, чтобы подписи и тона задавались в одном
 * месте, пока часть экранов на старом оформлении, а часть на новом.
 */
export const PROPERTY_STATUS_CHIP: Record<PropertyStatus, string> = {
  PENDING_REVIEW: "chip warn",
  AWAITING_PHOTOS: "chip warn",
  AWAITING_VIDEO: "chip warn",
  EDITING: "chip warn",
  AVAILABLE: "chip ok",
  RESERVED: "chip warn",
  SOLD: "chip",
  WITHDRAWN: "chip mute",
};

/** Кто отвечает за этап — подпись для карточки и списка. */
export const STAGE_OWNER_LABELS: Record<string, string> = {
  MARKETING: "Маркетинг",
  EDITOR: "Монтажёр",
  AGENT: "Агент",
};

/** Дата в шапке Главной — одинаковая у всех обликов и у всех ролей. По Душанбе:
 *  цифры под шапкой (задачи, KPI) сервер режет по Душанбе, и около полуночи у
 *  зрителя вне UTC+5 шапка показывала не тот день, за который они собраны.
 *  greetingLabel ниже — сознательно по устройству, его не трогать. */
export function todayLabel() {
  return new Date().toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Asia/Dushanbe",
  });
}

/** "Доброе утро" в час ночи выглядит как баг, а не забота — приветствие должно совпадать
 * с реальным временем на устройстве агента. */
export function greetingLabel() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Доброе утро";
  if (h >= 12 && h < 18) return "Добрый день";
  if (h >= 18 && h < 23) return "Добрый вечер";
  return "Доброй ночи";
}

/**
 * ТОЧНАЯ ДАТА И ВРЕМЯ — «20.08 14:32», а не «4 часа назад».
 *
 * ПОЧЕМУ ТАК (владелец 20.08.2026, дословно): «везде, где используется типа
 * сколько часов или дней назад, замени — чтобы по всему CRM была дата точная и
 * время без секунд, а то считаешь, пока 4 часа назад и так далее, слишком долго».
 *
 * Относительная подпись требует от человека арифметики, причём каждый раз заново
 * и в уме: «4 часа назад» при взгляде в 15:40 — это 11:40, но чтобы это узнать,
 * надо сначала вспомнить, сколько сейчас времени. На экране, где таких подписей
 * десяток (список клиентов, журнал звонков, уведомления), это десять маленьких
 * вычислений вместо десяти прочтений. Точное время читается сразу и, в отличие
 * от относительного, не устаревает, пока вкладка открыта.
 *
 * ГОД — ТОЛЬКО ЧУЖОЙ. В текущем году он одинаков у всех строк и не несёт ничего,
 * кроме четырёх лишних знаков в узкой колонке; у прошлогодней записи он появляется
 * и тем самым сам себя объясняет. Двусмысленности не возникает: раз год не
 * написан — значит нынешний.
 *
 * ПОЯС — ДУШАНБИНСКИЙ, как во всём остальном интерфейсе (см. lib/date.ts). Прежняя
 * реализация печатала дату часами устройства: у владельца, открывшего CRM из
 * Стамбула, она расходилась с датами, которые собирает сервер.
 */
export function exactDateTime(date: string | Date): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = dushanbeYear(d) === dushanbeYear(new Date());
  return `${dushanbeDate(d, sameYear ? { day: "2-digit", month: "2-digit" } : undefined)} ${dushanbeTime(d)}`;
}

/**
 * Время для СТРОКИ СПИСКА (чаты, уведомления) — как в мессенджерах (10.09.2026):
 * сегодня → «14:05», вчера → «вчера», в этом году → «10 сент», иначе «10.09.25».
 * `exactDateTime` печатала «10.09 08:59» в каждой строке — восемь символов там,
 * где глаз ждёт три-пять, и дата без смысла для сегодняшних диалогов. Полная
 * дата остаётся в title строки — см. Rh2DialogRow.
 */
export function listTime(date: string | Date): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const day = dushanbeDayKey(d);
  if (day === dushanbeDayKey(now)) return dushanbeTime(d);
  if (day === dushanbeDayKey(new Date(now.getTime() - 86_400_000))) return "вчера";
  if (dushanbeYear(d) === dushanbeYear(now)) {
    // «10 сент.» → без точки: короче и ровнее в правой колонке.
    return dushanbeDate(d, { day: "numeric", month: "short" }).replace(".", "");
  }
  return dushanbeDate(d, { day: "2-digit", month: "2-digit", year: "2-digit" });
}

/** Год по Душанбе — чтобы решить, показывать его в подписи или нет. */
function dushanbeYear(d: Date): string {
  return dushanbeDayKey(d).slice(0, 4);
}

/**
 * Прежнее имя той же подписи. Оставлено намеренно: этой функцией пользуются 128
 * мест в 47 файлах, и переименование одним махом столкнулось бы с правками
 * параллельных сессий в тех же файлах. Поведение у неё теперь общее — точная
 * дата и время; в новом коде зовите `exactDateTime`, имя честнее.
 *
 * @deprecated Используйте exactDateTime.
 */
export const relativeTime = exactDateTime;
