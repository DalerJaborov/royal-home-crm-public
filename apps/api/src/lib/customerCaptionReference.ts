/**
 * «ОБЪЕКТ №N» ИЗ ПОДПИСИ ПОСТА ИЛИ СО СКРИНШОТА — ТОЛЬКО С НАШЕЙ МЕТКОЙ (16–17.11.2026).
 *
 * Живой случай Instagram 16.11: клиент прислал наш пост объекта №178 двумя картинками и спросил «видео есть?».
 * Номер был на картинке, но до ответа не доходил. Ревью #225 (17.11): одного номера мало — номера объектов у нас
 * плотные (1…max), и «Объект №45» с поста ЧУЖОГО агентства почти всегда совпадёт с каким-то нашим объектом. Поэтому
 * номер из подписи/текста на картинке принимается, только если в том же тексте есть НАША метка: имя компании или
 * страницы из CRM («Royal Home», «Arvan»…), или телефон компании/агента из CRM. Поля, которые подпись называет
 * (комнаты, площадь, район), сверяются с карточкой в CRM отдельно (customerCaptionReferenceMatchesCard).
 * Чистые функции; метки из базы читает lib/customerOwnBrandMarks.ts.
 */
import { BW } from "../ai/wordBoundary.js";
import { captionPropertyNumber } from "./customerPropertyReferenceText.js";

export interface CustomerOwnBrandMarks {
  /** Folded names (lowercase letters and digits only), at least 4 characters. */
  readonly names: readonly string[];
  /** Last nine digits of CRM phones (company line, agents). */
  readonly phoneTails: readonly string[];
}
export interface CustomerCaptionFields { rooms?: number; areaSqm?: number; district?: string }
export interface CustomerCaptionReference { shortId: number; fields: CustomerCaptionFields }

const fold = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
export function foldBrandName(value: string): string | null {
  const folded = fold(value);
  return folded.length >= 4 ? folded : null;
}

/** Our mark in the text: a CRM name of the company/page, or a CRM phone (any spacing: «+992 44 650-14-14»). */
export function customerTextHasOwnMark(text: string, marks: CustomerOwnBrandMarks): boolean {
  const folded = fold(text);
  if (marks.names.some(name => name.length >= 4 && folded.includes(name))) return true;
  const tails = new Set(marks.phoneTails);
  for (const match of text.matchAll(/\+?\d[\d\s()‑–-]{7,20}\d/gu)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 9 && tails.has(digits.slice(-9))) return true;
  }
  return false;
}

/** «№ 77» on a listing card: the bare number form is accepted only there (plus the same own mark). */
const BARE_NUMBER = new RegExp(`${BW}[№#]\\s*([1-9]\\d{0,8})(?!\\d)`, "gu");
function cardNumber(text: string): string | null {
  const numbers = new Set([...text.matchAll(BARE_NUMBER)].map(match => match[1]));
  return numbers.size === 1 ? [...numbers][0] : null;
}

/** What the caption says about the object, to compare with the CRM card. Only clear «Label: value» forms. */
export function customerCaptionFields(text: string): CustomerCaptionFields {
  const fields: CustomerCaptionFields = {};
  const rooms = /(?:количество\s+комнат|комнат(?:ы|а)?|ҳуҷра(?:ҳо)?|хучра(?:хо)?)\s*:\s*(\d{1,2})(?!\d)/iu.exec(text) ??
    /(?<!\d)(\d{1,2})\s*-?\s*(?:комн(?:атн\p{L}*|\.)?|ҳуҷрагӣ|хучраги)(?!\p{L})/iu.exec(text);
  if (rooms) fields.rooms = Number(rooms[1]);
  const area = /(?:площадь|масоҳат|масохат)\s*:\s*(\d{1,4}(?:[.,]\d{1,2})?)/iu.exec(text) ??
    /(?<![\d.,])(\d{2,4}(?:[.,]\d{1,2})?)\s*(?:м²|м2|кв\.?\s*м)/iu.exec(text);
  if (area) fields.areaSqm = Number(area[1].replace(",", "."));
  const district = /(?:район|ноҳия|нохия)\s*:\s*([^\n,.;]{2,60})/iu.exec(text);
  if (district) fields.district = district[1].trim();
  return fields;
}

/**
 * The object of a caption / readable text of OUR post: exactly one number and our own mark, else null.
 * `listingCard` also accepts the bare «№N» form of a printed listing card.
 */
export function customerCaptionReference(text: string | null | undefined, marks: CustomerOwnBrandMarks,
  options: { listingCard?: boolean } = {}): CustomerCaptionReference | null {
  if (!text || !customerTextHasOwnMark(text, marks)) return null;
  const explicit = captionPropertyNumber(text);
  const number = explicit ?? (options.listingCard ? cardNumber(text) : null);
  return number ? { shortId: Number(number), fields: customerCaptionFields(text) } : null;
}

/** The fields the caption names must match the CRM card; a field the card or the caption lacks is not a conflict. */
export function customerCaptionReferenceMatchesCard(fields: CustomerCaptionFields,
  card: { rooms: number | null; areaSqm: { toString(): string } | string | number | null; districtName: string | null }): boolean {
  if (fields.rooms !== undefined && card.rooms && card.rooms > 0 && fields.rooms !== card.rooms) return false;
  if (fields.areaSqm !== undefined && card.areaSqm !== null) {
    const area = Number(card.areaSqm.toString());
    if (area > 0 && Math.abs(area - fields.areaSqm) > 1) return false;
  }
  if (fields.district && card.districtName) {
    const a = fold(fields.district), b = fold(card.districtName);
    if (a && b && !a.includes(b) && !b.includes(a)) return false;
  }
  return true;
}
