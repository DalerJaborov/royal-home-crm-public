import { createHash } from "node:crypto";
import type { CompanyKnowledge } from "./knowledgeTypes.js";

// Keep the provider payload independent of arbitrary CRM and conversation text.
const POLICY = /(?<!\p{L})(?:правил\p{L}*|инструкц\p{L}*|регламент\p{L}*|политик\p{L}*|порядок|процедур\p{L}*|қоида\p{L}*|дастур\p{L}*|тартиб\p{L}*)(?!\p{L})/iu;
const HOW = /^(?:как (?:правильно |у нас |в CRM )?|какие данные нужны[\s,]|ч[ӣи] (?:тавр|хел|лозим аст) )/iu;
const PROCEDURE_ACTION = /(?<!\p{L})(?:передать|отправить|оформить|опубликовать|разместить|поменять|изменить|поставить|сохранить|показать|назнач\p{L}*|согласовать|заменить|сабт кардан|сабт кунем|фиристем|фиристодан|гузорем|гузоштан|иваз кунем|иваз кардан|нашр кунем|нашр кардан|нишон диҳем|нишон додан|таъйин кардан)(?!\p{L})/iu;
const PRIVATE_OR_RECORD = /[\p{N}@#\r\n]|https?:\/\/|(?:^|\W)(?:t\.me|wa\.me|somon\.tj)\/|(?:^|[^\p{L}])(?:парол\p{L}*|токен\p{L}*|рамз\p{L}*|(?:мой|наш|этот) (?:клиент|объект|ролик)|ин (?:клиент|объект|навор)|муштарии ман)(?!\p{L})/iu;

const TOPICS = [
  {
    id: "property-video-handoff",
    key: "как отличать очередь монтажа от доставки монтажёру",
    fingerprint: "78b181a8ec512ec94cd9040a4ba9b078de06c921237dee0f4a6e378e521ffbc3",
    match: /монтаж|таҳрири навор|навор\p{L}*\s+ба таҳрир/iu,
    natural: /^(?:как понять[, ]+.*(?:жд[её]т|в очереди).*(?:монтаж[её]р\p{L}*|исходник\p{L}*)|ч[ӣи] хел фаҳмем[, ]+ки навор ба дасти монтаж[её]р расид)\s*[?!.]*$/iu,
    providerQuery: "Порядок передачи видео монтажёру и перемонтажа. Тартиби фиристодани навор ба монтаж.",
  },
  {
    id: "property-publication",
    key: "как заменяются старые посты при публикации нового ролика",
    fingerprint: "1df4d4bc32d3fb4f110b63666d340a7003289efb39038890e7791444493c2d05",
    match: /публик|постинг|нашр|(?:стар\p{L}* пост\p{L}*|пост\p{L}* пешина)/iu,
    natural: /^(?:после (?:смены|изменения) цены[, ]+старый ролик (?:сразу )?убираем|навори нав барояд[, ]+пости пешинаро кай мегирем)\s*[?!.]*$/iu,
    providerQuery: "Порядок публикации объявления на сайте и в соцсетях. Тартиби нашри эълон.",
  },
  {
    id: "property-price-change",
    key: "как подтверждать изменение цены опубликованного объекта",
    fingerprint: "f2324f1ba1f5c4ac36c330707ba5323697a8231b3daf069d7266bfbd0a35b9a5",
    match: /(?<!\p{L})(?:цен\p{L}*|нарх\p{L}*)(?!\p{L})/iu,
    natural: /^(?:кто подтверждает (?:смену|изменение) цены|барои иваз кардани нарх ч[ӣи] даркор)\s*[?!.]*$/iu,
    providerQuery: "Правила изменения цены объекта. Тартиби иваз кардани нархи хона.",
  },
  {
    id: "property-showing",
    key: "какие данные нужны для назначения показа",
    fingerprint: "7c3a8fd4096f385eef4e5da177bc0483e50d479a2705d7fcc7846c7dc8d40671",
    match: /(?<!\p{L})(?:показ\p{L}*|намоиш\p{L}*|хона\p{L}* нишон|нишон додани хона)(?!\p{L})/iu,
    natural: /^барои нишон додани хона ч[ӣи] даркор\s*[?!.]*$/iu,
    providerQuery: "Порядок назначения показа объекта. Тартиби таъйин кардани намоиши хона.",
  },
] as const;

export type CompanyMemoryPolicyTopic = typeof TOPICS[number]["id"];
export const APPROVED_COMPANY_POLICY_REVISION = 1;
export const APPROVED_COMPANY_POLICY_KEYS = TOPICS.map(topic => topic.key);

export function companyMemoryPolicyForTopic(id: unknown) {
  return TOPICS.find(topic => topic.id === id);
}

/** The reviewed bilingual pilot revisions in docs/design/pilots/company-memory-workflows.json. */
export function isApprovedCompanyPolicy(row: Pick<CompanyKnowledge, "key" | "title" | "content" | "source" | "revision">): boolean {
  const policy = TOPICS.find(topic => topic.key === row.key);
  return Boolean(policy && row.revision === APPROVED_COMPANY_POLICY_REVISION &&
    createHash("sha256").update(JSON.stringify([row.title, row.content, row.source])).digest("hex") === policy.fingerprint);
}

/**
 * Only product-owned topic text can leave for a policy query embedding.
 * Null means an ambiguous or operational turn stays on the normal CRM path.
 */
export function companyMemoryPolicyProjection(input: unknown): { id: CompanyMemoryPolicyTopic; providerQuery: string } | null {
  if (typeof input !== "string") return null;
  const text = input.normalize("NFKC").trim();
  if (!text || text.length > 200 || PRIVATE_OR_RECORD.test(text)) return null;
  const natural = TOPICS.find(topic => topic.natural.test(text));
  if (natural) return { id: natural.id, providerQuery: natural.providerQuery };
  if (!POLICY.test(text) && !(HOW.test(text) && PROCEDURE_ACTION.test(text))) return null;
  let candidates = TOPICS.filter(topic => topic.match.test(text));
  // An explicit old-post replacement question is about publishing even if it mentions editing.
  if (candidates.length === 2 && /стар\p{L}* пост\p{L}*|пост\p{L}* пешина/iu.test(text)
      && candidates.some(topic => topic.id === "property-video-handoff")) {
    candidates = candidates.filter(topic => topic.id === "property-publication");
  }
  if (candidates.length !== 1) return null;
  const [{ id, providerQuery }] = candidates;
  return { id, providerQuery };
}
