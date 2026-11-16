import { centsToTjs, fromCents, toCents } from "./money.js";
import { EXPENSE_VENDOR_LABELS, isAiEstimateVendor, vendorOfText, type ExpenseVendor } from "./expenseVendors.js";

/**
 * РАСХОД, КОТОРЫЙ CRM УЖЕ СЧИТАЕТ САМА, НЕ ВНОСИТСЯ ВТОРОЙ РАЗ РУКАМИ (14.11.2026).
 *
 * Случай: директор прислал помощнице фото таблицы расходов за октябрь, в ней строка
 * «ТАРГЕТ (инстаграм-фейсбук) 7278» — а реклама Meta за октябрь уже стояла в Расходах
 * автоматической строкой `ads:META:2026-10` (905,92 $). Пачка записала строку молча, и
 * расходы октября выросли на 7 278 с. Владелец: «такие похожие классы тоже надо исправить».
 *
 * Автоматические строки Expense — те, у которых есть `autoKey`:
 *   ads:<ПЛОЩАДКА>:<месяц>     — рекламный кабинет (сейчас синхронизируется только Meta);
 *   ai:<месяц>                 — обращения к ИИ через CRM (журнал AiLog);
 *   salary:<агент>:<месяц>     — доля агента по закрытым сделкам;
 *   rec:<шаблон>:<дата|месяц>  — повторяющийся платёж из шаблона.
 *
 * Правило одно для всех дверей (форма, Шабнам, пачка из фото/Excel, чек из Telegram) и для
 * обратной стороны (автоматическая строка появилась после ручной): ручная строка того же
 * вида за тот же месяц — «возможно, уже учтено». Ручную не пишем молча: человек видит,
 * сколько CRM уже насчитала, и подтверждает, что это ДРУГОЙ расход.
 */

export type AutoExpenseKind = "ads_meta" | "ads_other" | "ai" | "deal_salary" | "recurring" | "subscription";

export interface AutoExpenseRowLike {
  autoKey: string;
  category: string;
  amount: unknown;
  currency: string;
  exchangeRate?: unknown;
  agentId?: string | null;
  source?: string | null;
  /** Поставщик подписки (Expense.vendor, 17.11.2026): у строки из шаблона-подписки. */
  vendor?: string | null;
}

export interface ManualExpenseLike {
  category: string;
  source?: string | null;
  agentId?: string | null;
  note?: string | null;
  counterparty?: string | null;
  amount: unknown;
  currency?: string | null;
  exchangeRate?: unknown;
  /** Поставщик, выбранный человеком или узнанный помощницей (Expense.vendor). */
  vendor?: string | null;
}

export interface AutoExpenseOverlap {
  kind: AutoExpenseKind;
  autoKey: string;
  /** Сумма автоматической строки, как она хранится (кабинет Meta — в долларах). */
  autoAmount: number;
  autoCurrency: string;
  /** Она же в сомони по курсу CRM — человеку показываем обе. */
  autoAmountTjs: number;
  /** Ручная сумма в сомони. */
  manualAmountTjs: number;
  /** Суммы почти совпадают (±10 %) — почти наверняка одна и та же трата. */
  amountClose: boolean;
  /** Для вида subscription: поставщик подписки. */
  vendor?: string | null;
}

/** Вид автоматической строки по её ключу. */
export function autoExpenseKindOf(autoKey: string | null | undefined): AutoExpenseKind | null {
  if (!autoKey) return null;
  if (autoKey.startsWith("ads:META:")) return "ads_meta";
  if (autoKey.startsWith("ads:")) return "ads_other";
  if (autoKey.startsWith("ai:")) return "ai";
  if (autoKey.startsWith("salary:")) return "deal_salary";
  if (autoKey.startsWith("rec:")) return "recurring";
  return null;
}

/**
 * Граница слова — «начало строки или не буква и не цифра»: `\b` в JavaScript видит только
 * латиницу («реклама инста» с `инста\b` не ловилось), «ИИ» бывает в кавычках-ёлочках, а взгляд
 * назад `(?<!…)` старый Safari не знает (сторож noRegexLookbehind — файл попадает в сайт).
 */
/** Реклама в Meta словами строки: таргет, Instagram/Facebook, Meta (ru/tg/латиница). */
const META_WORDS = /instagram|(?:^|[^\p{L}\p{N}])insta(?![\p{L}\p{N}])|инстаграм|(?:^|[^\p{L}\p{N}])инста(?![\p{L}\p{N}])|facebook|фейсбук|фэйсбук|(?:^|[^\p{L}\p{N}])(?:fb|фб|meta|мета)(?![\p{L}\p{N}])|таргет(?!олог)|(?:^|[^\p{L}\p{N}])target(?!olog)/iu;
const AD_WORDS = /реклам|таблиғ|таблиг|таргет(?!олог)|(?:^|[^\p{L}\p{N}])target(?!olog)|(?:^|[^\p{L}\p{N}])ads?(?![\p{L}\p{N}])|reklama|продвижен|boost|буст/iu;
/** Не кабинет Meta, а люди и посевы: блогер, таргетолог, СММщик — их оплата не дублирует кабинет. */
const NOT_CABINET = /блогер|blogger|инфлюенс|influenc|посев|коллаб|таргетолог|targetolog|(?:^|[^\p{L}\p{N}])(?:смм|smm)|дизайн|съёмк|съемк|видеограф/iu;
/** ИИ словами строки: «оплата ИИ», Claude, Gemini, ChatGPT, нейросеть. */
const AI_WORDS = /(?:^|[^\p{L}\p{N}])(?:ии|ai)(?![\p{L}\p{N}])|искусствен\p{L}*\s+интеллект|нейросет|claude|клод|gemini|джемини|openai|chat\s*gpt|чат\s*gpt|(?:^|[^\p{L}\p{N}])gpt|deepseek|anthropic/iu;
/** Подписки и мероприятия — не обращения CRM к ИИ (их журнал AiLog не видит). */
const NOT_AI_USAGE = /подписк|subscription|(?:^|[^\p{L}\p{N}])(?:plus|pro|max|team)(?![\p{L}\p{N}])|конференц|обучени|тренинг|(?:^|[^\p{L}\p{N}])курс/iu;
/** Ручная зарплата — доля по сделке, а не оклад или аванс. */
const DEAL_SHARE_WORDS = /(?:^|[^\p{L}\p{N}])дол[яиюей](?![\p{L}\p{N}])|процент|%|комисси|бонус|сделк/iu;

function textOf(row: ManualExpenseLike): string {
  return `${row.note ?? ""} ${row.counterparty ?? ""}`;
}

/** На какой вид автоматического расхода похожа ручная строка (может быть несколько). */
export function manualExpenseAutoKinds(row: ManualExpenseLike): AutoExpenseKind[] {
  const text = textOf(row);
  const kinds: AutoExpenseKind[] = [];
  const metaChannel = row.source === "INSTAGRAM" || row.source === "FACEBOOK";
  // Явно выбранный канал сильнее слов: «таргет» в TikTok — не кабинет Meta.
  const otherChannel = row.category === "ADVERTISING" && !!row.source && !metaChannel;
  if (row.category !== "SALARY" && !otherChannel && !NOT_CABINET.test(text)
    && ((row.category === "ADVERTISING" && (metaChannel || META_WORDS.test(text)))
      || (row.category !== "ADVERTISING" && META_WORDS.test(text) && AD_WORDS.test(text)))) {
    kinds.push("ads_meta");
  }
  if (row.category === "ADVERTISING" && !kinds.includes("ads_meta")) kinds.push("ads_other");
  if (row.category !== "SALARY" && AI_WORDS.test(text) && !NOT_AI_USAGE.test(text)) kinds.push("ai");
  if (row.category === "SALARY" && row.agentId) kinds.push("deal_salary");
  return kinds;
}

const amountTjs = (amount: unknown, currency: string | null | undefined, rate: unknown, usdToTjs: number) =>
  fromCents(centsToTjs(toCents(amount), currency, currency === "USD" && Number(rate) > 0 ? Number(rate) : usdToTjs));

/**
 * Автоматическая строка того же месяца, которую ручная, скорее всего, повторяет. `autoRows` —
 * ТОЛЬКО строки этого месяца, не удалённые. null — пересечения нет, можно писать.
 *
 * Реклама Meta, ИИ и зарплата из сделок совпадают по ВИДУ (сумма у человека и у кабинета
 * почти всегда разная: курс, день списания, НДС). Остальное (повторяющийся платёж, реклама
 * другой площадки) — по разделу и близкой сумме (±10 %), иначе слишком много ложных тревог.
 */
/**
 * Какого поставщика записать в ручную строку: выбранного человеком, иначе узнанного по словам —
 * только поставщика ИИ (его счёт снимает оценку CRM за месяц, splitAiEstimate). Прочих по словам
 * не пишем: «сервер» в заметке офиса ещё не подписка.
 */
export function manualExpenseVendor(row: Pick<ManualExpenseLike, "vendor" | "note" | "counterparty">): ExpenseVendor | null {
  if (row.vendor) return row.vendor as ExpenseVendor;
  const found = vendorOfText(`${row.note ?? ""} ${row.counterparty ?? ""}`);
  return isAiEstimateVendor(found) ? found : null;
}

export function findAutoExpenseOverlap(
  manual: ManualExpenseLike,
  autoRows: readonly AutoExpenseRowLike[],
  usdToTjs: number,
): AutoExpenseOverlap | null {
  const kinds = manualExpenseAutoKinds(manual);
  const manualTjs = amountTjs(manual.amount, manual.currency ?? "TJS", manual.exchangeRate, usdToTjs);
  const close = (a: number, b: number) => a > 0 && b > 0 && Math.abs(a - b) <= Math.max(a, b) * 0.1;
  // Поставщик ручной строки: выбран явно или узнан по словам («Оплата Gemini», «синяя галочка»).
  const manualVendor = manual.vendor ?? vendorOfText(textOf(manual));
  // Явный счёт поставщика ИИ — это правда о расходе, а не повтор оценки: оценку этого
  // поставщика за месяц CRM сама перестаёт считать (splitAiEstimate, 17.11.2026).
  // «Оплата ИИ» без поставщика по-прежнему спрашивается: непонятно, счёт это или повтор оценки.
  const billedAiVendor = isAiEstimateVendor(manualVendor);
  let best: AutoExpenseOverlap | null = null;
  for (const auto of autoRows) {
    const kind = autoExpenseKindOf(auto.autoKey);
    if (!kind) continue;
    const autoTjs = amountTjs(auto.amount, auto.currency, auto.exchangeRate, usdToTjs);
    if (autoTjs <= 0) continue;
    const amountClose = close(manualTjs, autoTjs);
    // Доля по сделкам: тот же сотрудник и либо слова «доля/процент/сделка», либо близкая сумма —
    // оклад и аванс того же агента в том же месяце не переспрашиваем.
    // Подписка с поставщиком: ручная строка того же поставщика — повтор при любой сумме
    // (курс, налог банка, смена тарифа), слова «подписка» тут не спасают.
    if (kind === "recurring" && auto.vendor) {
      if (manualVendor !== auto.vendor) continue;
      const overlap: AutoExpenseOverlap = {
        kind: "subscription", autoKey: auto.autoKey, autoAmount: Number(auto.amount), autoCurrency: auto.currency,
        autoAmountTjs: autoTjs, manualAmountTjs: manualTjs, amountClose, vendor: auto.vendor,
      };
      if (!best || best.kind !== "subscription" || (amountClose && !best.amountClose)) best = overlap;
      continue;
    }
    if (kind === "ai" && billedAiVendor) continue;
    const byKind = (kind === "ads_meta" || kind === "ai") && kinds.includes(kind)
      || kind === "deal_salary" && kinds.includes("deal_salary") && auto.agentId === manual.agentId
        && (amountClose || DEAL_SHARE_WORDS.test(textOf(manual)));
    // Шаблон и прочие площадки — тот же раздел, тот же сотрудник и канал, близкая сумма.
    const byAmount = (kind === "recurring" || kind === "ads_other") && auto.category === manual.category && amountClose
      && (auto.agentId ?? null) === (manual.agentId ?? null) && (auto.source ?? null) === (manual.source ?? null);
    if (!byKind && !byAmount) continue;
    const overlap: AutoExpenseOverlap = {
      kind, autoKey: auto.autoKey, autoAmount: Number(auto.amount), autoCurrency: auto.currency,
      autoAmountTjs: autoTjs, manualAmountTjs: manualTjs, amountClose,
    };
    if (!best || (best.kind !== "subscription" && amountClose && !best.amountClose)) best = overlap;
  }
  return best;
}

const KIND_RU: Record<AutoExpenseKind, string> = {
  ads_meta: "Реклама Meta (Instagram/Facebook) из рекламного кабинета",
  ads_other: "Реклама из рекламного кабинета",
  ai: "Расход на ИИ (обращения CRM к Claude и Gemini)",
  deal_salary: "Доля этого сотрудника по закрытым сделкам",
  recurring: "Повторяющийся платёж из шаблона",
  subscription: "Подписка",
};

const MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

const num = (value: number) => value.toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).replace(/ /g, " ");

/** «2026-10» → «октябрь 2026». */
export function expenseMonthWords(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTHS_RU[Number(m) - 1] ?? month} ${y}`;
}

/**
 * Один текст для формы, помощницы и чека: что уже учтено, сколько и за какой месяц, и что
 * делать. Без тире-«ИИ-признаков» в тексте для людей (правило владельца).
 */
export function autoExpenseOverlapText(overlap: AutoExpenseOverlap, month: string): string {
  const auto = overlap.autoCurrency === "USD"
    ? `${num(overlap.autoAmount)} $ (≈ ${num(overlap.autoAmountTjs)} с.)`
    : `${num(overlap.autoAmountTjs)} с.`;
  const what = overlap.kind === "subscription" && overlap.vendor
    ? `Подписка «${EXPENSE_VENDOR_LABELS[overlap.vendor as ExpenseVendor] ?? overlap.vendor}», CRM записывает её каждый месяц сама`
    : KIND_RU[overlap.kind];
  const hint = overlap.kind === "ai"
    ? "Если это подписка или другой сервис, а не обращения CRM, подтвердите запись."
    : overlap.kind === "subscription"
      ? "Если это разовая доплата сверх подписки, подтвердите запись."
      : overlap.kind === "deal_salary"
      ? "Если это оклад или премия сверх доли, подтвердите запись."
      : "Если это другой платёж, подтвердите запись.";
  return `Этот расход, похоже, уже учтён автоматически: ${what} за ${expenseMonthWords(month)}, ${auto}. Второй раз не записываю. ${hint}`;
}

/** Код ответа API, по которому форма предлагает «Всё равно записать». */
export const AUTO_EXPENSE_OVERLAP_CODE = "AUTO_EXPENSE_OVERLAP";
