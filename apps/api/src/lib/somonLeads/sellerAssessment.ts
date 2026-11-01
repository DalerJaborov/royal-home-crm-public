import { BW, EW, TAIL } from "../../ai/wordBoundary.js";

/** Плата посредника — только сами формы слова «комиссия»/«комиссионные»: «комиссионный
 * магазин» к оплате посредника отношения не имеет. */
const COMMISSION = String.raw`комисси(?:я|и|ю|ей|й|ям|ями|ях)${EW}|комиссионн(?:ые|ых|ыми?)${EW}`;
/** Посредник (человек/фирма) или его плата — то, что собственник обычно ОТРИЦАЕТ. */
const AGENCY_WORD = String.raw`(?:(?:посредник|риелтор|риэлтор|маклер|агентств)${TAIL}|${COMMISSION})`;
/** Перечень: «посредников и комиссии», «риелторов/агентствам», «агентств, риелторов, маклеров». */
const AGENCY_LIST = String.raw`${AGENCY_WORD}(?:\s*(?:,|/|\s(?:и|или)\s)\s*${AGENCY_WORD})*`;
/** Слова между отрицанием и целью: «без ВСЯКИХ риелторов», «без УСЛУГ риелтора», «не ЧЕРЕЗ агентство». */
const FILLER = String.raw`(?:(?:всяк|каких|любых|услуг|участи|помощ|через)${TAIL}\s+)*`;
/**
 * Отрицания — сигнал собственника, а не агентства: вырезаем их ДО поиска маркеров.
 * Отрицание распространяется на весь перечень («без X и Y»). «Комиссия (не) включена» —
 * НЕ отрицание: комиссия есть, это маркер посредника (см. COMMISSION_FEE).
 */
const NEGATED_AGENCY = new RegExp([
  // «без комиссии и посредников», «не через агентство», «без всяких риелторов», «исключая посредников»
  String.raw`${BW}(?:без|бе|не|исключая)\s+${FILLER}${AGENCY_LIST}`,
  // «комиссии нет», «комиссия не нужна», «услуги риелтора не нужны», «риелторов не беспокоить»,
  // «агентствам просьба не звонить», «риелторы - мимо», «комиссию не берём»
  String.raw`${BW}${FILLER}${AGENCY_LIST}[\s,.:—–-]*(?:просьба\s+)?(?:нет${EW}|мимо${EW}|отсутств${TAIL}|не\s+(?:нужн|надо|требу|беспоко|звон|бер|взима)${TAIL})`,
  // «просьба риелторам не звонить»
  String.raw`${BW}просьба\s+${AGENCY_LIST}\s+не\s+(?:беспоко|звон)${TAIL}`,
].join("|"), "gu");
/** Явное самопредставление посредника или его плата — жёсткий отказ (как бизнес-аккаунт):
 * «я риелтор», «мы агентство», «агент по недвижимости», «наша компания», «комиссия 2%»,
 * «комиссия (не) включена». Ищется в исходном тексте: отрицанием это не бывает. */
const SELF_AGENT = new RegExp([
  String.raw`${BW}(?:я|мы|наше)\s+(?:риелтор|риэлтор|маклер|посредник|агентств)`,
  String.raw`${BW}агент${TAIL}\s+по\s+недвижимост`,
  String.raw`${BW}наша\s+компани`,
  String.raw`${BW}комисси(?:я|ю|и)\s+(?:\d|составля|включ|не\s+включ)`,
].join("|"), "u");
/** Прочие упоминания посредника (после вырезания отрицаний) — не доказательство:
 * карточка уходит на ручную проверку (как в PR56), а не в отказ. */
const AGENCY_TEXT = new RegExp(String.raw`${BW}${AGENCY_WORD}|${BW}(?:realtor|real\s*estate)|${BW}звоните\s+в\s+офис|${BW}агентии\s+амвол`, "u");

/** «Вероятно собственник» — только при ровно одном объявлении автора в категории. */
export const SOMON_OWNER_CATEGORY_ADVERTS = 1;
/** Мягкий потолок по ВСЕМ объявлениям автора на сайте (`active_adverts`, без разбивки
 * по категориям): владелец одной квартиры с пятью чужими вещами уже сомнителен. */
export const SOMON_OWNER_MAX_TOTAL_ADVERTS = 5;
/** Единственное место правила «ровно одно объявление в категории»: им же пользуется
 * обработчик очереди, чтобы не тратить запросы к сайту на заведомо не-собственника. */
export const somonCategoryCountAllowsOwner = (count: number | null) => count === SOMON_OWNER_CATEGORY_ADVERTS;

/** Evidence for a review queue, never proof of legal ownership. */
export type SellerEvidence = {
  businessAccount: boolean | null;
  /** Объявлений автора в «Квартиры, продажа, Душанбе» по нашей выдаче; null — неизвестно. */
  categoryAdverts: number | null;
  /** Все активные объявления автора на сайте (из карточки); null — неизвестно. */
  totalActiveAdverts: number | null;
  name: string;
  description: string;
};
export type SellerAssessment = { status: "likely_owner" | "review" | "agency"; reasons: string[] };

export function assessSeller(e: SellerEvidence): SellerAssessment {
  const name = e.name.toLocaleLowerCase("ru");
  const text = e.description.toLocaleLowerCase("ru");
  const agencyName = /агентств|риелтор|риэлтор|realtor|real\s*estate|недвижимость|агентии амвол/.test(name);
  if (e.businessAccount === true || agencyName) return { status: "agency", reasons: ["Признак агентства в профиле"] };
  // С границей слова: без неё «участиЯ агентства» читалось как «я агентство».
  if (SELF_AGENT.test(`${name} ${text}`)) return { status: "agency", reasons: ["Продавец представился посредником"] };
  if (AGENCY_TEXT.test(`${name} ${text}`.replace(NEGATED_AGENCY, " "))) return { status: "review", reasons: ["В тексте объявления признаки посредника"] };
  if (e.categoryAdverts === null) return { status: "review", reasons: ["Число объявлений автора в категории неизвестно"] };
  if (e.categoryAdverts > SOMON_OWNER_CATEGORY_ADVERTS) {
    return { status: "review", reasons: [`У автора ${e.categoryAdverts} объявлений о продаже квартир в Душанбе — проверить продавца`] };
  }
  if (e.totalActiveAdverts === null) return { status: "review", reasons: ["Общее число объявлений автора неизвестно"] };
  if (e.totalActiveAdverts > SOMON_OWNER_MAX_TOTAL_ADVERTS) {
    return { status: "review", reasons: [`У автора ${e.totalActiveAdverts} объявлений на сайте — проверить продавца`] };
  }
  const combined = `${name} ${text}`;
  if (/не\s+(?:собственник|хозяин)/.test(combined)) {
    return { status: "review", reasons: ["Автор указывает, что не является собственником"] };
  }
  // Слово «собственник» не требуется (PR56, 28.10): частный профиль, ровно одно объявление
  // в категории и не больше пяти на сайте. Недвижимость в других категориях при 3+
  // объявлениях проверяет `checkSellerProperties` (профиль автора) в `processSomonPending`.
  if (e.businessAccount === false && somonCategoryCountAllowsOwner(e.categoryAdverts)) {
    return { status: "likely_owner", reasons: ["Одно объявление автора в категории", "Собственника необходимо проверить"] };
  }
  return { status: "review", reasons: ["Собственник не подтверждён"] };
}
