/**
 * ДЕНЬГИ: ОДНО ПРАВИЛО — ОДНО МЕСТО.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ ПОЯВИЛСЯ (22.09.2026). Перевод суммы в сомони был написан
 * ДВАЖДЫ, с одинаковым именем `toTjs` и разным поведением:
 *
 *   apps/api/src/lib/money.ts  → через целые сотые, с округлением до копейки;
 *   apps/web/src/lib/format.ts → `n * курс`, без округления вовсе.
 *
 * Серверная версия округляет не для красоты: её собственный комментарий
 * объясняет, что без этого 9.53 × 11.27 даёт 107.40310000000001, и этот хвост
 * складывается, сравнивается и уезжает в JSON, в выгрузку и в денежные колонки
 * базы. Ровно та поломка, которую на сервере починили, во фронте оставалась
 * живой: доска сделок считала сумму по-своему, и её итог мог не сойтись с
 * отчётом.
 *
 * Запасной курс `FALLBACK_USD_TO_TJS = 11` был объявлен тоже дважды, и во
 * фронте рядом стоял комментарий «см. apps/api/src/lib/money.ts» — то есть
 * расхождение видели, но развести его было негде.
 *
 * Теперь правило живёт здесь, в общем пакете, и обе стороны его импортируют.
 * Это и есть способ, которым «правка в одном месте» перестаёт ломать второе:
 * второго места просто нет.
 *
 * ЧТО СЮДА КЛАСТЬ. Только чистые правила без базы и без запросов: перевод
 * валюты, округление, сложение. Всё, что читает Настройки или Prisma,
 * остаётся в `apps/api/src/lib/money.ts` — общий пакет собирается и для
 * браузера, и туда серверному коду нельзя.
 */
import type { Currency } from "./enums.js";

/**
 * Запасной курс, если в Настройках он ещё ни разу не проставлен. Заведомо
 * грубый, но неизмеримо ближе к правде, чем «1 доллар = 1 сомони», которое
 * получалось при простом сложении.
 */
export const FALLBACK_USD_TO_TJS = 11;

/** Сумма (Decimal из Prisma, строка, число) → целое число сотых. */
export function toCents(amount: unknown): number {
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value)) return 0;
  // Суммы хранятся с двумя знаками (Decimal(12,2)), поэтому умножение на 100
  // даёт целое с точностью до 1e-9 — округление снимает двоичный хвост.
  return Math.round(value * 100);
}

/** Целые сотые → число с двумя знаками, каким оно уйдёт в JSON и на экран. */
export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Сотые в валюте хранения → сотые в сомони. Единственное место, где происходит
 * округление при переводе валюты: дальше суммы только складываются, без потерь.
 */
export function centsToTjs(
  cents: number,
  currency: Currency | string | null | undefined,
  usdToTjs: number,
): number {
  return currency === "USD" ? Math.round(cents * usdToTjs) : Math.round(cents);
}

/**
 * Сумма в валюте хранения → сумма в сомони, ровно до копейки.
 *
 * Та самая функция, которая раньше была написана двумя способами. Курс
 * передаётся числом: на сервере он приезжает из Настроек через
 * `loadMoneyContext()`, во фронте — из ответа профиля; откуда именно, этот
 * файл знать не должен.
 */
export function convertToTjs(
  amount: unknown,
  currency: Currency | string | null | undefined,
  usdToTjs: number,
): number {
  return fromCents(centsToTjs(toCents(amount), currency, usdToTjs));
}

/**
 * ЦЕНА ОБЪЕКТА В СОМОНИ — ОДНО ЧИСЛО ДЛЯ ГОЛОСА, МОНТАЖЁРА, ОБЛОЖКИ И ПЛАШКИ НА РОЛИКЕ (21.11.2026, ревью #348).
 * Раньше было три правила: голос округлял до тысячи, монтажёр получал точную сумму, обложка брала запасной курс.
 *  · сомони карточки — как есть (целые);
 *  · доллары — по курсу из Настроек (`usdToTjs`) и до тысячи: курс меняется каждый день, точность до сомони —
 *    ложная, а голос и плашка на ролике должны говорить одно и то же число;
 *  · курса нет — null: цену не говорим и не пишем НИГДЕ (запасного курса здесь нет и быть не должно).
 * Речь и текст — разные записи одного этого числа (словами или «1 179 000 с.»), а не разные округления.
 */
export function propertyPriceTjs(price: unknown, currency: Currency | string | null | undefined, usdToTjs: number | null | undefined): number | null {
  const amount = Number(price === null || price === undefined ? NaN : String(price));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (currency !== "USD") return Math.round(amount);
  if (!usdToTjs || !Number.isFinite(usdToTjs) || usdToTjs <= 0) return null;
  return Math.round(convertToTjs(amount, "USD", usdToTjs) / 1000) * 1000;
}

/** Округление уже посчитанной суммы до копейки — для итогов, собранных сложением. */
export function roundMoney(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/**
 * ЦЕНА КВАРТИРЫ В ЧУЖОЙ ВАЛЮТЕ (21.11.2026, объект №213). Агент вписал «107 400»
 * с валютой «сомони», а это были доллары: 1 200 сомони за м² (≈130 $) в Душанбе не
 * бывает. Цена ушла в подпись, в задание монтажёру и в озвучку. Пороги грубые нарочно:
 * ловят перепутанную валюту, а не дешёвые и дорогие варианты.
 *  · сомони дешевле APARTMENT_MIN_TJS_PER_SQM за м² — похоже на доллары;
 *  · доллары дороже APARTMENT_MAX_USD_PER_SQM за м² — похоже на сомони.
 * Только квартира с площадью: у дома площадь стройки, у участка сотки, у коммерции разброс.
 */
export const APARTMENT_MIN_TJS_PER_SQM = 2_000;
export const APARTMENT_MAX_USD_PER_SQM = 5_000;
export function apartmentPriceCurrencySuspect(p: {
  type: string | null | undefined;
  price: unknown;
  currency: Currency | string | null | undefined;
  areaSqm: unknown;
}): "LOOKS_USD" | "LOOKS_TJS" | null {
  if (p.type !== "APARTMENT") return null;
  const price = Number(p.price ?? 0), area = Number(p.areaSqm ?? 0);
  if (!Number.isFinite(price) || !Number.isFinite(area) || price <= 0 || area <= 0) return null;
  const perSqm = price / area;
  if (p.currency === "USD") return perSqm > APARTMENT_MAX_USD_PER_SQM ? "LOOKS_TJS" : null;
  return perSqm < APARTMENT_MIN_TJS_PER_SQM ? "LOOKS_USD" : null;
}

/** Текст для агента: одна строка, без технических слов. */
export function apartmentPriceCurrencyHint(suspect: "LOOKS_USD" | "LOOKS_TJS"): string {
  return suspect === "LOOKS_USD"
    ? "Проверьте валюту: за квартиру такая цена в сомони слишком мала. Если это доллары, выберите «Доллары»"
    : "Проверьте валюту: за квартиру такая цена в долларах слишком велика. Если это сомони, выберите «Сомони»";
}
