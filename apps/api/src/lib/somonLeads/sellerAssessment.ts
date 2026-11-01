import { BW, EW, TAIL } from "../../ai/wordBoundary.js";

/** Посредник-человек/фирма. «Комиссия» в перечень НЕ входит: в «без посредников, комиссия 2%»
 * запятая не должна превращать комиссию в отрицание. */
const AGENT_PERSON = String.raw`(?:посредник|риелтор|риэлтор|маклер|агентств)${TAIL}`;
/** Перечень: «посредников и риелторов», «риелторов/агентствам», «агентств, риелторов». */
const AGENT_LIST = String.raw`${AGENT_PERSON}(?:\s*(?:,|/|\s(?:и|или)\s)\s*${AGENT_PERSON})*`;
/**
 * Отрицания — это сигнал собственника, а не агентства: убираем их ДО поиска маркеров.
 * «Комиссия не включена» / «комиссия включена» — НЕ отрицание: комиссия есть, это маркер
 * посредника. Поэтому после «комиссии» отрицанием считаем только «нет», «отсутствует»,
 * «не берём/не взимается», а не любое «не».
 */
const NEGATED_AGENCY = new RegExp([
  // «без комиссии», «бе комиссия», «не агентство», «без посредников и риелторов»,
  // «без услуг риелтора», «без участия агентства»
  String.raw`${BW}(?:без|бе|не|исключая)\s+(?:(?:услуг|участи)${TAIL}\s+)?(?:комисс${TAIL}|${AGENT_LIST})`,
  // «комиссии нет», «комиссия отсутствует», «комиссию не берём»
  String.raw`${BW}комисс${TAIL}\s+(?:нет${EW}|отсутств${TAIL}|не\s+(?:бер|взима)${TAIL})`,
  // «риелторов не беспокоить», «агентствам просьба не звонить», «посредникам, просьба не беспокоить»
  String.raw`${BW}${AGENT_LIST}[\s,.:—-]*(?:просьба\s+)?не\s+(?:беспоко|звон)${TAIL}`,
  // «просьба риелторам не звонить»
  String.raw`${BW}просьба\s+${AGENT_LIST}\s+не\s+(?:беспоко|звон)${TAIL}`,
].join("|"), "gu");
/** Автор называет себя посредником: «я риелтор», «мы агентство». */
const SELF_AGENT = new RegExp(String.raw`${BW}(?:я|мы|наше)\s+(?:риелтор|риэлтор|агентств)`, "u");
/** Маркеры посредника в тексте объявления или имени автора. */
const AGENCY_TEXT = new RegExp(String.raw`${BW}(?:комисс|посредник|риелтор|риэлтор|маклер|агентств)${TAIL}|${BW}(?:realtor|real\s*estate)|${BW}агент${TAIL}\s+по\s+недвижимост|${BW}наша\s+компани|${BW}звоните\s+в\s+офис|${BW}агентии\s+амвол`, "u");

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
  if (SELF_AGENT.test(text)) return { status: "agency", reasons: ["Продавец представился посредником"] };
  if (AGENCY_TEXT.test(`${name} ${text}`.replace(NEGATED_AGENCY, " "))) return { status: "agency", reasons: ["В тексте объявления признаки посредника"] };
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
