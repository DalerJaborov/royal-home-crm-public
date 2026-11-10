import type { ExpenseCategory } from "@royal-home/shared";

/**
 * СТАТЬИ РАСХОДОВ ДЛЯ КАРТОЧКИ ШАБНАМ — ОДИН СЛОВАРЬ (10.11.2026, выбор владельца «А, по статьям»).
 *
 * Иконка и название статьи на русском и таджикском берутся отсюда и только отсюда: по
 * названию подраздела CRM («Расходы → Категории»), а если его нет — по словам строки.
 * Таджикские названия — живые, как говорят в офисе (скилл tajik-phrasebook), не калька.
 * Незнакомая статья — 🏷 и название раздела CRM.
 */

export type CardLang = "ru" | "tg";

interface Article { key: string; icon: string; ru: string; tg: string; match: RegExp }

/** Порядок важен: первое совпадение выигрывает («аренда офиса» — аренда, а не офис). */
export const EXPENSE_ARTICLES: readonly Article[] = [
  { key: "rent", icon: "🏢", ru: "Аренда", tg: "Иҷора", match: /аренд|иҷора|ijara|\brent/iu },
  { key: "internet", icon: "🌐", ru: "Интернет и связь", tg: "Интернет ва алоқа", match: /интернет|internet|wi-?fi|связь|алоқа|телефон|мобильн|tcell|мегафон|babilon|zet/iu },
  { key: "fuel", icon: "⛽", ru: "Бензин", tg: "Бензин", match: /бензин|топлив|заправк|солярк|газ\s*для\s*машин|сӯзишворӣ|benzin|fuel|petrol|gasoline/iu },
  { key: "taxi", icon: "🚕", ru: "Такси", tg: "Такси", match: /такси|taxi|yandex\s*go|maxim/iu },
  { key: "ads", icon: "📣", ru: "Реклама", tg: "Реклама", match: /реклам|таргет|instagram|facebook|tiktok|somon\.tj|\bads?\b|reklama/iu },
  { key: "utilities", icon: "💡", ru: "Свет и коммуналка", tg: "Барқ ва коммуналӣ", match: /свет|электр|коммунал|вода|отоплен|барқ|об\b|kommunal|electric|utilit/iu },
  { key: "cleaning", icon: "🧹", ru: "Уборка", tg: "Тозакунӣ", match: /уборк|клининг|тоза|cleaning|farrosh|фаррош/iu },
  { key: "salary", icon: "👥", ru: "Зарплата", tg: "Музди меҳнат", match: /зарплат|оклад|аванс|премия|музд|маош|ish haqi|salary/iu },
  { key: "food", icon: "🍽", ru: "Еда", tg: "Хӯрок", match: /еда|обед|ужин|кофе|чай|продукт|хӯрок|хурок|ovqat|food|lunch|coffee/iu },
  { key: "stationery", icon: "🖨", ru: "Канцелярия", tg: "Канселярия", match: /канц|бумаг|принтер|картридж|ручк|печат|коғаз|stationery|paper/iu },
  { key: "repair", icon: "🔧", ru: "Ремонт", tg: "Таъмир", match: /ремонт|починк|мастер|сантехник|таъмир|ta'mir|repair/iu },
];

const ROOT_NAMES: Record<ExpenseCategory, { ru: string; tg: string }> = {
  ADVERTISING: { ru: "Реклама", tg: "Реклама" },
  SALARY: { ru: "Зарплата", tg: "Музди меҳнат" },
  OFFICE: { ru: "Офис", tg: "Офис" },
  OTHER: { ru: "Прочее", tg: "Дигар харҷҳо" },
};

export interface ArticleView { key: string; icon: string; name: string }

/**
 * Статья строки: сначала подраздел CRM, потом слова строки, потом раздел.
 * Подраздел CRM без совпадения в словаре остаётся своим названием с 🏷 — его назвал директор.
 */
export function articleOf(lang: CardLang, row: { title: string; category: ExpenseCategory; categoryTitle?: string | null }): ArticleView {
  const own = row.categoryTitle?.trim();
  const known = EXPENSE_ARTICLES.find((a) => (own && a.match.test(own)) || (!own && a.match.test(row.title)))
    ?? (row.category === "ADVERTISING" ? EXPENSE_ARTICLES.find((a) => a.key === "ads")
      : row.category === "SALARY" ? EXPENSE_ARTICLES.find((a) => a.key === "salary") : undefined);
  if (known) return { key: known.key, icon: known.icon, name: known[lang] };
  if (own) return { key: `crm:${own.toLowerCase()}`, icon: "🏷", name: own };
  return { key: `root:${row.category}`, icon: "🏷", name: ROOT_NAMES[row.category][lang] };
}

const MONTHS: Record<CardLang, { short: string[]; long: string[] }> = {
  ru: {
    short: ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"],
    long: ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"],
  },
  tg: {
    short: ["январ", "феврал", "март", "апрел", "май", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"],
    long: ["Январ", "Феврал", "Март", "Апрел", "Май", "Июн", "Июл", "Август", "Сентябр", "Октябр", "Ноябр", "Декабр"],
  },
};

/** «1 ноя» / «1 ноябр» — день оплаты словами (дата расхода уже по Душанбе: YYYY-MM-DD без времени). */
export function dayWords(lang: CardLang, isoDay: string): string {
  const [, m, d] = isoDay.split("-").map(Number);
  return `${d} ${MONTHS[lang].short[(m ?? 1) - 1]}`;
}

/** «Ноябрь» или «Ноябрь 2025», если год не текущий. */
export function monthWords(lang: CardLang, month: string, currentYear: string): string {
  const [y, m] = month.split("-");
  const name = MONTHS[lang].long[Number(m) - 1] ?? month;
  return y === currentYear ? name : `${name} ${y}`;
}

const OFFICE_ARTICLES = new Set(["rent", "internet", "utilities", "cleaning", "stationery", "repair"]);

/**
 * Раздел CRM для строки без явного раздела (таблица, фото): офисные статьи — «Офис», остальное —
 * «Прочее». Рекламу и зарплату сами не ставим: REST требует к ним канал и сотрудника, которых в
 * таблице нет, — такие строки уходят в «Прочее» со своим названием, директор поправит раздел.
 */
export function defaultRootCategory(title: string): "OFFICE" | "OTHER" {
  const article = EXPENSE_ARTICLES.find((a) => a.match.test(title));
  return article && OFFICE_ARTICLES.has(article.key) ? "OFFICE" : "OTHER";
}
