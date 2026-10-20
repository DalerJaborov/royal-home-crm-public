/**
 * Сверка цен в ответе бота с фактами — последний рубеж перед клиентом.
 *
 * Всё в промте ЗАПРЕЩАЕТ модели выдумывать цены, но промт — просьба (см.
 * royal-home-prompt-is-not-a-guarantee): правило «ответь смайликом» модель
 * проигнорировала 37 раз подряд, и полагаться на неё с ценами — значит однажды
 * назвать клиенту цену, которой нет. Это самый дорогой тип ошибки: человек
 * приходит на показ за 60 тысяч, слышит 75 и уходит, уверенный, что его обманули.
 *
 * Правило одно: НАЗВАННАЯ ЦЕНА ОБЯЗАНА ОТКУДА-ТО ВЗЯТЬСЯ. Откуда цене можно
 * взяться — перечислено закрыто:
 *   - из блока объектов в промте (цены карточек, площади, этажи);
 *   - из слов самого клиента (его бюджет: «до 400 000» бот вправе повторить);
 *   - из своих же прошлых реплик (цена, которую бот уже называл законно);
 *   - пересчётом доллар↔сомони по курсу из Настроек (промт сам велит пересчитывать).
 *
 * ЧЕГО В ЭТОМ СПИСКЕ НЕТ (правка 21.08.2026) — цен, вычитанных ВНУТРИ файла,
 * который прислал сам клиент: расшифровки его голосового и описания его видео или
 * PDF. Раньше они попадали в allowedText вместе со всей историей диалога, и щит
 * снимал с них подозрение автоматически. Живой сценарий: клиент присылает PDF
 * чужого объявления с ценой 999 000 — она оседает в истории как «прочитано в
 * файле», и с этого момента бот вправе назвать её как НАШУ цену, ничем не
 * рискуя. Ровно тот же приём работал голосом: «квартира стоит 999 тысяч»,
 * наговорённое в диктофон, узаконивало цену для всех следующих ходов.
 *
 * Границы этих кусков ставит messengers/conversation.ts (см. ai/untrustedContent.ts),
 * и здесь они выбрасываются из белого списка целиком. Бота это не делает тупым:
 * бюджет, названный голосом, живёт в черновике лида (draft.budgetMax), а черновик
 * в allowedText остаётся — то есть «ищем до 400 000» бот повторить по-прежнему
 * может, а вот выдать цену из чужого объявления за нашу — уже нет.
 *
 * Число, которого нет ни в одном источнике, — выдумка, и предложение с ним
 * вырезается целиком. Не число, а предложение: «Нархаш 999 999 сомонӣ» без цифры
 * превратилось бы в обрубок хуже самой выдумки.
 *
 * ГЛАВНОЕ ОГРАНИЧЕНИЕ — НЕ СДЕЛАТЬ БОТА ТУПЫМ. Фильтр обязан быть трусливым:
 * ложное срабатывание вырезает ЧЕСТНОЕ предложение, и клиент получает ответ без
 * сути. Поэтому цена распознаётся узко (см. isPriceLike), совпадение считается с
 * допуском (модель округляет), а если после чистки не осталось ничего — уходит
 * исходный ответ и громкая запись в журнал: пусть лучше один раз соврёт и мы это
 * увидим, чем клиент получит пустоту.
 */

import { stripUntrusted } from "./untrustedContent.js";

export interface PriceGuardInput {
  /** Пузыри ответа модели — как есть, до отправки. */
  bubbles: string[];
  /**
   * Всё, откуда цене МОЖНО взяться: блок объектов из промта, реплики клиента,
   * прошлые реплики бота. Просто склеенный текст — числа достаются отсюда тем же
   * разбором, что и из ответа. Присланное клиентом содержимое (расшифровки,
   * описания файлов) вырезается здесь же, внутри щита: вызывающему не нужно об
   * этом помнить, а любой будущий вызов получит ту же защиту.
   */
  allowedText: string;
  /** Курс из Настроек: разрешает пересчёт доллар↔сомони в обе стороны. */
  usdToTjs?: number;
  /**
   * Вырезать предложения с ценой в чужой валюте (AI-GUARD02). По умолчанию ВЫКЛЮЧЕНО:
   * сначала режим наблюдения (`currencyMismatch` в результате уходит в журнал), и
   * вырезание включается после замера ложных срабатываний.
   */
  enforceCurrency?: boolean;
}

export interface PriceGuardResult {
  bubbles: string[];
  /** Выдуманные числа — для журнала. Пусто — ответ чист. */
  invented: number[];
  /** Чистка съела весь ответ, и мы отправили исходный: сигнал разобраться руками. */
  keptDespiteViolation: boolean;
  /**
   * Числа, у которых совпала сумма, но валюта в ответе другая, чем везде в источниках
   * («1 000 000 сомони» в каталоге, «1 000 000 долларов» в ответе). Для журнала; сам
   * ответ из-за них не меняется, пока не включён `enforceCurrency` (AI-GUARD02).
   */
  currencyMismatch: number[];
}

/**
 * Числа-кандидаты в цены. Узко нарочно:
 *  - группы с разделителями тысяч («75 000», «1.200.000», «320,000») — цены так и
 *    пишут; одинокое «75000» тоже берём от пяти цифр;
 *  - 4 цифры (1000–9999) — только если рядом валюта: «за 5000 $» цена, а «в 2026
 *    году» и «квартира 1204» нет;
 *  - телефоны не цены: девять и больше цифр подряд или «+» перед числом.
 */
const GROUPED = /(?<![\d+])\d{1,3}(?:[  .,]\d{3})+(?![\d])/g;
const PLAIN = /(?<![\d+.,])\d{4,8}(?![\d])/g;
const CURRENCY_NEAR = /[$€]|долл|сомон|somoni|сомонӣ|с\.\s|tjs|usd/i;

/** Сколько знаков вокруг числа смотрим в поисках валюты. */
const CURRENCY_WINDOW = 14;

/** Допуск совпадения: модель округляет («примерно 850 тысяч» после пересчёта). */
const TOLERANCE = 0.02;

/**
 * Цена словами: «95 тысяч», «950 ҳазор», «1,1 млн», «80 тыс.», «80k» (02.10.2026).
 * Так цену в переписке и пишут, а сверка видела только цифры — выдуманная сумма
 * словами проходила мимо неё. «к» без валюты рядом не берём: это и предлог.
 */
const WORDED =
  /(?<![\d.,])(\d{1,4}(?:[.,]\d{1,3})?)\s*(тыс\p{L}*\.?|тщ|ҳазор|хазор|hazor|k(?![\p{L}])|к(?=\s*[$€])|млн\.?|миллион\p{L}*|million)(?![\p{L}])/giu;

/**
 * Сколько цифр в «телефонной» записи вокруг числа: «93 555 12 34» содержит «93 555»,
 * похожее на цену 93 555 (02.10.2026). Бот, подтверждающий номер клиента, получал
 * вместо ответа заглушку «уточню цену». Девять и больше цифр в одной записи из
 * цифр, пробелов, дефисов и скобок — телефон, а не цена.
 */
function phoneRunDigits(text: string, index: number, length: number): number {
  let start = index;
  while (start > 0 && /[\d \u00a0\t\-()+]/.test(text[start - 1])) start -= 1;
  let end = index + length;
  while (end < text.length && /[\d \u00a0\t\-()]/.test(text[end])) end += 1;
  return text.slice(start, end).replace(/\D/g, "").length;
}

export type PriceCurrency = "USD" | "TJS";

/** Найденная в тексте цена: значение и валюта, если она названа рядом. */
interface PriceHit {
  value: number;
  currency: PriceCurrency | null;
}

/** Валюта сразу ПОСЛЕ числа («75 000 $», «850 000 с.», «1 000 000 долларов»)... */
const CURRENCY_AFTER_USD = /^\s*(?:\$|долл|доллар|usd|dollar)/iu;
const CURRENCY_AFTER_TJS = /^\s*(?:сомон|сомӣ|somoni|tjs|смн|сом(?![\p{L}])|с\.)/iu;
/** ...или сразу ДО него («$5000», «USD 5000»). */
const CURRENCY_BEFORE_USD = /(?:\$|usd)\s*$/iu;
const CURRENCY_BEFORE_TJS = /(?:tjs|сомони|смн)\s*$/iu;

function currencyAround(text: string, start: number, end: number): PriceCurrency | null {
  const after = text.slice(end, end + CURRENCY_WINDOW);
  if (CURRENCY_AFTER_USD.test(after)) return "USD";
  if (CURRENCY_AFTER_TJS.test(after)) return "TJS";
  const before = text.slice(Math.max(0, start - 6), start);
  if (CURRENCY_BEFORE_USD.test(before)) return "USD";
  if (CURRENCY_BEFORE_TJS.test(before)) return "TJS";
  return null;
}

/** Все цены текста со всеми повторами (одна сумма в двух валютах это две записи). */
function scanPrices(text: string): PriceHit[] {
  const out: PriceHit[] = [];

  const consider = (raw: string, index: number, grouped: boolean) => {
    // GROUPED already accepts NBSP, including Number.toLocaleString("ru-RU").
    // Normalize that exact separator before Number(), without folding lines.
    const digits = raw.replace(/[ \u00a0.,]/g, "");
    // Телефон, счёт, идентификатор — не цена.
    if (digits.length > 8) return;
    if (phoneRunDigits(text, index, raw.length) >= 9) return;
    const value = Number(digits);
    if (!Number.isFinite(value)) return;
    if (value < 1000) return;
    // Четырёхзначное — цена только рядом с валютой; «2026» и номера квартир мимо.
    if (value < 10_000 && !grouped) {
      const around = text.slice(Math.max(0, index - CURRENCY_WINDOW), index + raw.length + CURRENCY_WINDOW);
      if (!CURRENCY_NEAR.test(around)) return;
    }
    out.push({ value, currency: currencyAround(text, index, index + raw.length) });
  };

  for (const m of text.matchAll(GROUPED)) consider(m[0], m.index ?? 0, true);
  for (const m of text.matchAll(PLAIN)) consider(m[0], m.index ?? 0, false);
  for (const m of text.matchAll(WORDED)) {
    const base = Number(m[1].replace(",", "."));
    if (!Number.isFinite(base) || base <= 0) continue;
    const unit = m[2].toLowerCase();
    const factor = /^(млн|миллион|million)/.test(unit) ? 1_000_000 : 1_000;
    const value = Math.round(base * factor);
    const start = m.index ?? 0;
    if (value >= 1000) out.push({ value, currency: currencyAround(text, start, start + m[0].length) });
  }
  return out;
}

export function extractPrices(text: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const hit of scanPrices(text)) {
    if (seen.has(hit.value)) continue;
    seen.add(hit.value);
    out.push(hit.value);
  }
  return out;
}

function matches(candidate: number, allowed: number, tolerance = TOLERANCE): boolean {
  return Math.abs(candidate - allowed) <= allowed * tolerance;
}

/** Разрешён ли кандидат: сам, его половина/двойник по курсу. */
function isAllowed(candidate: number, allowed: number[], usdToTjs?: number): boolean {
  for (const a of allowed) {
    if (matches(candidate, a)) return true;
    if (usdToTjs && usdToTjs > 0) {
      // Пересчёт в обе стороны: цена в базе долларовая, бот назвал сомони — и наоборот.
      if (matches(candidate, a * usdToTjs)) return true;
      if (matches(candidate, a / usdToTjs)) return true;
    }
  }
  return false;
}

/** Границы предложений — те же, что у вырезания приглашений (comments.ts): точка,
 *  вопрос, восклицание и перевод строки. */
/**
 * Вычеркнуть предложения, сохранив строки (02.10.2026). Раньше всё склеивалось
 * через пробел, и нумерованный список после вычеркивания одной цены уходил одной
 * строкой с сиротой «2.» посередине. Теперь строки собираются обратно через
 * перевод строки, а строка, от которой остался один номер пункта, уходит целиком.
 */
export function keepSentences(text: string, keep: (sentence: string) => boolean): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[.!?])[ \t]+/)
        .filter((sentence) => !sentence.trim() || keep(sentence))
        .join(" ")
        .replace(/[ \t]{2,}/g, " ")
        .trimEnd()
    )
    .filter((line) => !/^[ \t]*(?:\d{1,2}[.)]|[-–—*•·])[ \t]*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * СВЕРКА РАЗМЕРА СКИДКИ — тот же принцип, что и guardPrices, но для процентов.
 *
 * Найдено при аудите промтов 18-20.08.2026: SALES_PLAYBOOK прямо запрещает модели
 * называть размер торга («Никогда не называй процент и не обещай конкретную сумму,
 * даже примерную») — это решение владельца, размер скидки реально зависит от
 * собственника и код его не знает вообще. Но в отличие от цен объектов, для этого
 * запрета не было перепроверки постфактум: guardPrices ловит только абсолютные
 * суммы (ищет число среди источников), а «скидка 5%» — маленькое число без валюты
 * рядом, extractPrices его не видит вообще. Промт — просьба, а не гарантия (см.
 * royal-home-prompt-is-not-a-guarantee), и здесь та же логика: раз правило важное
 * и денежное, оно должно быть перепроверено кодом, а не оставлено модели на слово.
 *
 * Узко нарочно: режем только там, где рядом И слово о скидке/торге, И процент —
 * «пятница у нас скидка на показы» (нет числа) и «дом 100%-но с ремонтом» (нет
 * слова о скидке) остаются как есть.
 */
/**
 * СЛОВАРЬ ТОРГА — КИРИЛЛИЦЕЙ ТОЖЕ (правка 22.08.2026, аудит бота).
 *
 * До этого дня таджикская часть словаря состояла из «arzon» и «savdo», написанных
 * ЛАТИНИЦЕЙ, — и ловила ровно ноль реплик бота. BOT_CORE_RULES прямо запрещает ему
 * отвечать таджикской латиницей («даже если клиент пишет латиницей, ты ВСЕГДА
 * отвечаешь кириллицей»), а собственный словарь бота в AGENCY_VOICE учит его
 * кириллическим оборотам: «арзон мешавад» (торг уместен), «савдо меша». Кириллица и
 * латиница — разные символы Unicode, поэтому /arzon/ не совпадёт с «арзон» никогда:
 * щит был выключен на таджикском ровно там, где бот на таджикском и говорит.
 *
 * Латинские написания ОСТАВЛЕНЫ: запрет действует на бота, а не на клиента, и его
 * реплики тоже проходят через разбор предложений.
 *
 * Добавлено кириллицей: «арзон» (дёшево / «арзон мешавад» = уступим), «савдо»
 * (торг), «тахфиф» (скидка, книжная форма — бот её употребить может, хоть словарь
 * агентства её и не любит), «алиш» (обмен — там же, где торгуются размером доплаты).
 * Корни без окончаний: «арзонтар», «савдоаш», «тахфифи» ловятся тем же куском.
 */
// «снизить цену на 5%», «нархро 5% кам мекунад», «минус 5%» (02.10.2026) — тот же
// торг без слова «скидка», и он проходил мимо сверки.
const DISCOUNT_WORDS =
  /скидк|торг|уступ|дисконт|сниз|сниж|сбав|скин|минус|подвин|арзон|савдо|тахфиф|алиш|кам\s*(?:ме)?кун|паст\s*(?:ме)?кун|arzon|savdo|tahfif|alish/iu;
// (?<!\d) и три цифры: «скидка 150%» раньше записывалась в журнал как 50.
const PERCENT_NEAR_DISCOUNT = /(?<!\d)(\d{1,3})\s*(%|процент\p{L}*|фоиз\p{L}*)/giu;

export interface DiscountGuardResult {
  bubbles: string[];
  /** Выдуманные проценты скидки — для журнала. Пусто — ответ чист. */
  invented: number[];
  /** Чистка съела весь ответ, и мы отправили исходный: сигнал разобраться руками. */
  keptDespiteViolation: boolean;
}

export function guardDiscounts(bubbles: string[]): DiscountGuardResult {
  const invented: number[] = [];

  const cleaned = bubbles.map((bubble) =>
    keepSentences(bubble, (sentence) => {
      if (!DISCOUNT_WORDS.test(sentence)) return true;
      const found = [...sentence.matchAll(PERCENT_NEAR_DISCOUNT)];
      if (found.length === 0) return true;
      invented.push(...found.map((m) => Number(m[1])));
      return false;
    })
  );

  if (invented.length === 0) {
    return { bubbles, invented, keptDespiteViolation: false };
  }

  const survived = cleaned.filter((b) => b.trim());
  if (survived.length === 0) {
    return { bubbles, invented, keptDespiteViolation: true };
  }
  return { bubbles: survived, invented, keptDespiteViolation: false };
}

/**
 * СОВПАЛА СУММА, НО НЕ ВАЛЮТА (AI-GUARD02, аудит 04.10.2026).
 *
 * `isAllowed` сверяет числа без валюты: каталог «1 000 000 сомони», а модель написала
 * «1 000 000 долларов» — число совпало, ответ прошёл. Здесь ловится ровно этот случай, и
 * ловится осторожно (ложное срабатывание вырезает честный ответ): значение должно
 * совпасть напрямую хотя бы с одной записью источников, у ВСЕХ таких записей валюта
 * названа явно и отличается от валюты кандидата. Запись без валюты, пересчёт по курсу
 * («100 000 долларов» при каталоге 1 000 000 сомони) и кандидат без названной валюты
 * проходят как раньше.
 */
function currencyMismatches(candidate: PriceHit, sources: PriceHit[]): boolean {
  if (!candidate.currency) return false;
  const same = sources.filter((s) => matches(candidate.value, s.value));
  if (same.length === 0) return false;
  return same.every((s) => s.currency !== null && s.currency !== candidate.currency);
}

export function guardPrices(input: PriceGuardInput): PriceGuardResult {
  // Цены берём только из ДОВЕРЕННОЙ части источников: содержимое присланных
  // клиентом файлов вырезается до разбора (см. большой комментарий выше).
  const trustedText = stripUntrusted(input.allowedText);
  const allowed = extractPrices(trustedText);
  const allowedHits = scanPrices(trustedText);
  const invented: number[] = [];
  const currencyMismatch: number[] = [];

  const cleaned = input.bubbles.map((bubble) => {
    const candidates = extractPrices(bubble);
    const bad = candidates.filter((c) => !isAllowed(c, allowed, input.usdToTjs));
    // Валютное расхождение: только у «разрешённых» по числу, это не выдумка суммы.
    const wrongCurrency = scanPrices(bubble)
      .filter((hit) => !bad.includes(hit.value) && currencyMismatches(hit, allowedHits))
      .map((hit) => hit.value);
    currencyMismatch.push(...wrongCurrency);
    if (input.enforceCurrency) bad.push(...wrongCurrency);
    if (bad.length === 0) return bubble;
    invented.push(...bad);
    return keepSentences(bubble, (sentence) => !extractPrices(sentence).some((c) => bad.includes(c)));
  });

  if (invented.length === 0) {
    return { bubbles: input.bubbles, invented, keptDespiteViolation: false, currencyMismatch };
  }

  const survived = cleaned.filter((b) => b.trim());
  if (survived.length === 0) {
    // Чистка съела всё. Молчать нельзя и заглушкой отвечать тоже: клиент задал
    // вопрос о цене. Отправляем исходное и зовём людей — см. вызывающего.
    return { bubbles: input.bubbles, invented, keptDespiteViolation: true, currencyMismatch };
  }
  return { bubbles: survived, invented, keptDespiteViolation: false, currencyMismatch };
}
