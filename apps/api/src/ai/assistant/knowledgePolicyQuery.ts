// Keep the provider payload independent of arbitrary CRM and conversation text.
const POLICY = /(?<!\p{L})(?:правил\p{L}*|инструкц\p{L}*|регламент\p{L}*|политик\p{L}*|порядок|процедур\p{L}*|қоида\p{L}*|дастур\p{L}*|тартиб\p{L}*)(?!\p{L})/iu;
const HOW = /^(?:как (?:правильно |у нас |в CRM )?|чӣ тавр |чи тавр |чӣ хел |чи хел )/iu;
const PROCEDURE_ACTION = /(?<!\p{L})(?:передать|отправить|оформить|опубликовать|поменять|изменить|поставить|сохранить|сабт кардан|сабт кунем|фиристем|фиристодан|гузорем|гузоштан|иваз кунем|иваз кардан|нашр кунем|нашр кардан)(?!\p{L})/iu;
const PRIVATE_OR_RECORD = /[\p{N}@#\r\n]|https?:\/\/|(?:^|\W)(?:t\.me|wa\.me|somon\.tj)\/|(?:^|[^\p{L}])(?:парол\p{L}*|токен\p{L}*|рамз\p{L}*|ин клиент|мой клиент|этот объект|этот клиент|ин объект|муштарии ман)(?!\p{L})/iu;

const TOPICS = [
  {
    id: "property-video-handoff",
    match: /монтаж|перемонтаж|таҳрири навор/iu,
    providerQuery: "Порядок передачи видео монтажёру и перемонтажа. Тартиби фиристодани навор ба монтаж.",
  },
  {
    id: "property-publication",
    match: /публик|постинг|нашр/iu,
    providerQuery: "Порядок публикации объявления на сайте и в соцсетях. Тартиби нашри эълон.",
  },
  {
    id: "property-price-change",
    match: /(?<!\p{L})(?:цен\p{L}*|нарх\p{L}*)(?!\p{L})/iu,
    providerQuery: "Правила изменения цены объекта. Тартиби иваз кардани нархи хона.",
  },
  {
    id: "property-showing",
    match: /(?<!\p{L})(?:показ\p{L}*|намоиш\p{L}*)(?!\p{L})/iu,
    providerQuery: "Порядок назначения показа объекта. Тартиби таъйин кардани намоиши хона.",
  },
];

/**
 * Only product-owned topic text can leave for a policy query embedding.
 * Null means an ambiguous or operational turn stays on the normal CRM path.
 */
export function companyMemoryPolicyProjection(input: unknown): { id: string; providerQuery: string } | null {
  if (typeof input !== "string") return null;
  const text = input.normalize("NFKC").trim();
  if (!text || text.length > 200 || PRIVATE_OR_RECORD.test(text)) return null;
  if (!POLICY.test(text) && !(HOW.test(text) && PROCEDURE_ACTION.test(text))) return null;
  const candidates = TOPICS.filter(topic => topic.match.test(text));
  if (candidates.length !== 1) return null;
  const [{ id, providerQuery }] = candidates;
  return { id, providerQuery };
}
