import { pluralizeRu, type AdLeadStats } from "@royal-home/shared";
import { formatMoneyExact } from "./format";

/**
 * СЛОВАРИ РАЗДЕЛА «РЕКЛАМА» — один источник подписей на все его экраны.
 *
 * Живут отдельно от компонентов по той же причине, что и словари «Вакансий»
 * (lib/vacanciesView.ts): подпись состояния показывают и список объявлений, и
 * плашка в карточке объекта, и расходиться им нельзя.
 */

/** Состояние объявления, как его считает сервер (api: lib/ads/adDelivery.ts). */
export type AdDelivery = "RUNNING" | "STALLED" | "FINISHED" | "PAUSED" | "REVIEW" | "REJECTED" | "NEVER";

/**
 * ПОДПИСЬ И ЦВЕТ СОСТОЯНИЯ.
 *
 * Цвет несёт только точка перед подписью — тот же приём, что в «Вакансиях»:
 * в строке уже есть деньги и число обращений, и третий закрашенный элемент
 * заставляет глаз выбирать, куда смотреть.
 *
 * Зелёный ровно один — «Идёт»: до 03.09.2026 его получали все объявления со
 * статусом ACTIVE от Meta, а таких было 33 из 41 при шести реально тративших.
 */
export const DELIVERY: Record<AdDelivery, { label: string; dot: string; hint: string }> = {
  RUNNING: { label: "Идёт", dot: "bg-green", hint: "тратит деньги прямо сейчас" },
  STALLED: {
    label: "Не тратит",
    dot: "bg-amber",
    hint: "включено, но денег не тратит: кончился бюджет, аудитория или идёт проверка",
  },
  FINISHED: { label: "Завершено", dot: "bg-gray-300", hint: "срок показа вышел" },
  PAUSED: { label: "Остановлено", dot: "bg-gray-300", hint: "выключено руками в кабинете" },
  REVIEW: { label: "На проверке", dot: "bg-amber", hint: "Meta ещё не пропустила объявление" },
  REJECTED: { label: "Отклонено", dot: "bg-red", hint: "Meta не пропустила объявление" },
  NEVER: { label: "Без трат", dot: "bg-gray-300", hint: "запущено, но не потратило ничего ни разу" },
};

/** Цель кампании человеческими словами — коды Meta директору ничего не говорят. */
export const OBJECTIVE_LABEL: Record<string, string> = {
  OUTCOME_ENGAGEMENT: "на переписки",
  OUTCOME_TRAFFIC: "на переходы",
  OUTCOME_AWARENESS: "на охват",
  OUTCOME_LEADS: "на заявки",
  OUTCOME_SALES: "на продажи",
};

export type AdPeriodPreset = "today" | "yesterday" | "7d" | "30d" | "month" | "prev_month" | "all";

/**
 * ПЕРИОД — ОДИН НА ВЕСЬ РАЗДЕЛ, И ВЫБИРАЕТСЯ СПИСКОМ.
 *
 * Было два переключателя сразу: месяц стрелками в шапке (для вкладки «по
 * объектам») и семь кнопок-пресетов внутри списка объявлений. Они жили каждый
 * своей жизнью, и на экране одновременно стояли «август» и «последние 30 дней» —
 * цифры сверху и снизу относились к разным отрезкам времени.
 */
export const PERIODS: { key: AdPeriodPreset; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7d", label: "7 дней" },
  { key: "30d", label: "30 дней" },
  { key: "month", label: "Этот месяц" },
  { key: "prev_month", label: "Прошлый месяц" },
  { key: "all", label: "Всё время" },
];

/** «3 сент.» — короткая дата для сроков показа. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "short" });
}

/**
 * Кто может менять данные «Рекламы» (сверка с кабинетом и т. п.) — ровно как
 * requireAdsWrite на сервере (apps/api/src/routes/ads.ts): роль MARKETING или
 * право finance.manage. Раньше кнопка «Сверить с кабинетом» была видна всем,
 * кто видит экран (finance.view), и отвечала им 403 (F10, 02.10.2026).
 */
export { canWriteAds } from "@royal-home/shared";

/* ───────── Несколько объектов в одном объявлении (03.10.2026) ───────── */

/** Максимум объектов в объявлении — тот же предел, что в `setAdPropertiesBodySchema`. */
export const AD_MAX_PROPERTIES = 20;
/** Предел веса одного объекта — тот же, что в `adPropertyShareSchema`. */
export const AD_MAX_WEIGHT = 1000;

/**
 * Поровну между `n` объектами: доли в процентах с двумя знаками, сумма ровно 100.
 * Остаток от деления (100 / 3 = 33,33 + 33,33 + 33,34) уходит первым объектам,
 * чтобы живая сумма в окне не показывала «99,99 %».
 */
export function splitEvenly(n: number): number[] {
  if (n <= 0) return [];
  const cents = 10000;
  const base = Math.floor(cents / n);
  const rest = cents - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < rest ? 1 : 0)) / 100);
}

/** Допуск сравнения суммы долей с 100 %, в процентных пунктах (одна сотая от «33,33 × 3»). */
export const SHARE_SUM_TOLERANCE = 0.05;

/**
 * Начальные доли окна из долей сервера (`share`, сумма ≈ 1) в процентах с двумя
 * знаками и суммой РОВНО 100. Просто округлить каждую нельзя: три равных объекта
 * дали бы 33,33 × 3 = 99,99 и окно загоралось бы «сумма 99,99 %» без единого
 * касания, а шесть — 16,67 × 6 = 100,02. Метод наибольших остатков: целые сотые
 * процента получают все, лишние сотые раздаются тем, у кого остаток больше; при
 * равных остатках — первым (поэтому 3 равных → 33,34 / 33,33 / 33,33).
 * Доли нормируются на их сумму, так что 0,3333 × 3 тоже даёт ровно 100.
 * Пустой список, нулевая или нечисловая сумма — пустой результат/нули, не NaN.
 */
export function sharesToWeights(shares: number[]): number[] {
  const total = shares.reduce((acc, s) => acc + (Number.isFinite(s) && s > 0 ? s : 0), 0);
  if (shares.length === 0 || total <= 0) return shares.map(() => 0);
  const units = 10000;
  const exact = shares.map((s) => ((Number.isFinite(s) && s > 0 ? s : 0) / total) * units);
  const floors = exact.map((v) => Math.floor(v + 1e-9));
  let left = units - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, rest: v - floors[i] }))
    // Сначала больший остаток; при равенстве (с запасом на шум плавающей запятой) — кто раньше.
    .sort((a, b) => (Math.abs(b.rest - a.rest) < 1e-7 ? a.i - b.i : b.rest - a.rest));
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors.map((v) => v / 100);
}

/** Вес из поля ввода: запятая или точка; пусто, ноль, минус и «выше предела» — null. */
export function parseWeight(raw: string): number | null {
  const n = Number(raw.trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0 || n > AD_MAX_WEIGHT) return null;
  return n;
}

/** «33,33» — доля для поля ввода без хвоста из нулей. */
export function weightToField(weight: number): string {
  return String(Math.round(weight * 100) / 100).replace(".", ",");
}

/** Доля в процентах для подписи: «25 %», «33,3 %», «0,3 %». */
export function formatPct(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} %`;
}

/**
 * Число клиентов/показов для подписи: целое — «3», доля общего объявления — «0,25»
 * (не больше двух знаков, без хвоста нулей). Сервер делит клиентов общего объявления
 * между объектами дробно (api: lib/ads/adLeadAttribution.ts), поэтому «0,25 кл.» — норма.
 */
export function formatLeadCount(value: number): string {
  return (Math.round(value * 100) / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

/** «5 минут назад» — по часам браузера; меньше минуты — «только что». */
export function agoRu(iso: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} ${pluralizeRu(minutes, ["минуту", "минуты", "минут"])} назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${pluralizeRu(hours, ["час", "часа", "часов"])} назад`;
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Asia/Dushanbe",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface LeaderboardLike {
  propertyId: string;
  spendTjs: number;
  conversations: number;
  costPerConversationTjs: number | null;
}

/**
 * ДВА ТОПА ПО ЦЕНЕ ОБРАЩЕНИЯ.
 *
 * Дешёвые — только те, у кого обращения БЫЛИ (цена null — это «обращений нет», а
 * не «ноль сомони»: ноль уехал бы на первое место как самый выгодный). Дорогие —
 * все остальные, на которые деньги тратились: сперва те, где обращений нет совсем
 * (по размеру траты), затем те, где обращение дорогое. Один объект не бывает в
 * обоих списках: при малом числе строк «дорогие» не повторяют «дешёвых».
 */
export function pickLeaderboard<T extends LeaderboardLike>(rows: T[], size = 5): { cheap: T[]; costly: T[] } {
  const priced = rows.filter((r) => r.conversations > 0 && r.costPerConversationTjs != null);
  const cheap = [...priced]
    .sort((a, b) => (a.costPerConversationTjs ?? 0) - (b.costPerConversationTjs ?? 0))
    .slice(0, size);
  const taken = new Set(cheap.map((r) => r.propertyId));
  const costly = rows
    .filter((r) => !taken.has(r.propertyId) && r.spendTjs > 0)
    .sort((a, b) => {
      const aNone = a.conversations === 0 || a.costPerConversationTjs == null;
      const bNone = b.conversations === 0 || b.costPerConversationTjs == null;
      if (aNone !== bNone) return aNone ? -1 : 1;
      if (aNone) return b.spendTjs - a.spendTjs;
      return (b.costPerConversationTjs ?? 0) - (a.costPerConversationTjs ?? 0);
    })
    .slice(0, size);
  return { cheap, costly };
}

/**
 * ЧЕМ «КЛИЕНТ В CRM» ОТЛИЧАЕТСЯ ОТ «ОБРАЩЕНИЯ» META (волна 1, 03.10.2026). Одна
 * подсказка на все места экрана: обращение — это переписка, которую начал человек по
 * версии Meta (её Ads Manager называет «Результат»); клиент — тот, чья карточка
 * реально появилась в CRM с этим объявлением. Первых всегда не меньше, чем вторых.
 */
export const LEAD_VS_META_HINT =
  "Обращение — переписка, начатая по версии Meta. Клиент — человек, который реально попал в CRM с этого объявления. Цена клиента обычно выше цены обращения.";

/** Что написать про клиентов объявления/объекта. */
export interface LeadStatsText {
  /** Главная строка: «клиентов в CRM: 3 · цена клиента 120,00 с.» или «клиентов в CRM нет». */
  primary: string;
  /** Дальше по воронке: «до показа 2 · сделок 1 · комиссия …»; пусто, если дошедших нет. */
  funnel: string;
  /** true — расход есть, а клиентов в CRM нет (экран красит это иначе). */
  noLeads: boolean;
}

/**
 * Текст «клиентов: N · цена клиента X». Ноль клиентов при расходе — честное «клиентов в
 * CRM нет», а не «0 с. за клиента»: ноль цены читался бы как «бесплатно». null — сказать
 * нечего (сервер не прислал поле, либо ни расхода, ни клиентов).
 */
export function describeLeadStats(stats: AdLeadStats | null | undefined, spendTjs: number): LeadStatsText | null {
  if (!stats) return null;
  if (stats.leads === 0) {
    return spendTjs > 0 ? { primary: "клиентов в CRM нет", funnel: "", noLeads: true } : null;
  }
  const primary =
    `клиентов в CRM: ${formatLeadCount(stats.leads)}` +
    (stats.costPerLeadTjs != null ? ` · цена клиента ${formatMoneyExact(stats.costPerLeadTjs, "TJS")}` : "");
  const funnel = [
    stats.showings > 0 ? `до показа ${formatLeadCount(stats.showings)}` : null,
    stats.deals > 0 ? `${stats.deals} ${pluralizeRu(stats.deals, ["сделка", "сделки", "сделок"])}` : null,
    stats.commissionTjs > 0 ? `комиссия ${formatMoneyExact(stats.commissionTjs, "TJS")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { primary, funnel, noLeads: false };
}
