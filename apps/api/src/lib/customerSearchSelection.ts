import { customerDeliveryFenceSchema } from "./customerDeliveryContracts.js";
import { readCustomerAcceptedSearchCollections } from "./customerSearchHistory.js";
import { customerPrincipalAuthenticatedInput, type CustomerPrincipal } from "./customerPrincipal.js";
import { inspectAuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { clientOwnWords } from "../ai/untrustedContent.js";
import type { TxClient } from "../db.js";

/** Shape/meaning only, not presentation or focus permission. Short answers
 * need the immediately preceding ACCEPTED collection without another question. */
export function customerSearchPosition(raw: string): { position: number | null; bare: boolean } | null {
  const text = clientOwnWords(raw).trim();
  // "Object №2" is the public ID even when a previous list had a second
  // item. Leave that reference to the canonical ingress resolver, at any ID.
  if (/(?<![\p{L}])(?:объект[аеи]?|object)\s*[№#]?\s*\d+/iu.test(text)) return null;
  if (/^[1-8][.!?]?$/u.test(text)) return { position: Number(text[0]), bare: true };
  const found = new Set<number>();
  const names = ["перв(?:ый|ая|ое|ую|ого|ом)|якум|аввал(?:ин|ӣ)?", "втор(?:ой|ая|ое|ую|ого|ом)|дуюм", "трет(?:ий|ья|ье|ью|ьего|ьем)|сеюм",
    "четв[её]рт(?:ый|ая|ую|ого)|чорум", "пят(?:ый|ая|ую|ого)|панҷум", "шест(?:ой|ая|ую|ого)|шашум", "седьм(?:ой|ая|ую|ого)|ҳафтум", "восьм(?:ой|ая|ую|ого)|ҳаштум"];
  const ordinal = (name: string) => `(?<![\\p{L}\\p{N}])(?:${name})(?![\\p{L}\\p{N}])`;
  const short = text.replace(new RegExp(ordinal(names.join("|")), "giu"), " ")
    .replace(/(?<![\p{L}])(?:не|на|или|ё|а|и)(?![\p{L}])/giu, " ").replace(/[\s,;.!?]+/gu, "") === "";
  const nounBefore = /(?:^|[^\p{L}])(?:вариант[\p{L}]*|объект[\p{L}]*|квартир[\p{L}]*|дом[ае]?|хона[и]?|object)\s+$/iu;
  const nounAfter = /^\s+(?:вариант[\p{L}]*|объект[\p{L}]*|квартир[\p{L}]*|дом[ае]?|хона[и]?|object)(?![\p{L}])/iu;
  const requestBefore = /(?:покажи(?:те)?|интересует|выбираю|выбрать|выберу|беру|давай(?:те)?|расскажи(?:те)?|хочу|нишон(?:\s+диҳед)?|цена|стоимость|нархи?)\s+(?:(?:мне|про|о|об|у|лутфан)\s+)*$/iu;
  const requestAfter = /^\s+(?:интересует|понравил[\p{L}]*|нравится|подходит|сколько\s+стоит|чанд(?:\s+пул)?|нарх[\p{L}]*|поч[её]м)(?:$|[\s.!?])/iu;
  let negated = false;
  const add = (position: number, at: number) => {
    if (/(?:^|[^\p{L}])(?:не|на)\s+$/iu.test(text.slice(0, at))) negated = true;
    else found.add(position);
  };
  // Positive reference context, rather than a growing blacklist of floors,
  // payments, dates, rooms and other things that can also be first/second.
  names.forEach((name, index) => {
    for (const match of text.matchAll(new RegExp(ordinal(name), "giu"))) {
      const before = text.slice(0, match.index), after = text.slice(match.index + match[0].length);
      if (short || nounBefore.test(before) || nounAfter.test(after) || requestAfter.test(after) ||
          requestBefore.test(before) && /^[\s.!?]*$/u.test(after)) add(index + 1, match.index);
    }
  });
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])([1-8])\s*[- ]?\s*(?:й|ой|ум|юм)?\s*(?:вариант|объект)(?![\p{L}])/giu)) add(Number(match[1]), match.index);
  for (const match of text.matchAll(/(?<![\p{L}])(?:вариант|варианти)\s*[№#]?\s*([1-8])(?!\d)/giu)) add(Number(match[1]), match.index);
  if (negated || found.size > 1) return { position: null, bare: false };
  return found.size ? { position: [...found][0], bare: short } : null;
}

/** Exact actual text order, not DB ranking order or a model-selected index. */
export function customerPresentedShortIds(text: string, shortIds: readonly number[]): number[] | null {
  if (new Set(shortIds).size !== shortIds.length) return null;
  const positions = shortIds.map(shortId => ({ shortId, at: text.search(new RegExp(`№\\s*${shortId}(?!\\d)`, "u")) }));
  if (positions.some(value => value.at < 0)) return null;
  return positions.sort((a, b) => a.at - b.at).map(value => value.shortId);
}

export async function readCustomerSearchSelection(principal: CustomerPrincipal): Promise<
  { status: "none" } | { status: "ambiguous" } |
  { status: "selected"; shortId: number; assertSourceCurrent(tx: TxClient): Promise<boolean> }
> {
  const input = inspectAuthenticatedCustomerInput(customerPrincipalAuthenticatedInput(principal));
  const choice = input ? customerSearchPosition(input.inputText) : null;
  if (!choice) return { status: "none" };
  if (choice.position === null) return { status: "ambiguous" };
  const [collection] = await readCustomerAcceptedSearchCollections(principal);
  if (choice.bare && (!collection?.latestReply || /[?？]/u.test(collection.text))) return { status: "none" };
  if (!collection) return { status: "ambiguous" };
  const ids = customerPresentedShortIds(collection.text, collection.observations.flatMap(value => value.cards.map(card => card.facts.shortId)));
  const shortId = ids?.[choice.position - 1];
  if (!shortId) return { status: "ambiguous" };
  return { status: "selected", shortId, async assertSourceCurrent(tx) {
    const [part] = await tx.$queryRaw<Array<{ payloadHash: string; fenceJson: unknown }>>`
      SELECT "payloadHash","fenceJson" FROM "CustomerOutboxPart" p WHERE p."id"=${collection.partId}
        AND p."inquiryId"=${principal.authority.fence.inquiryId} AND p."endpointScopeId"=${principal.scope.endpointScopeId}
        AND p."conversationId"=${principal.scope.conversationId} AND p."originalNativeId"=${principal.scope.conversationId}
        AND p."status"='ACCEPTED' AND p."mode"='LIVE' AND p."sourceKind"='BOT_TURN'
        AND p."projectionRecordedAt" IS NOT NULL AND p."supersededAt" IS NULL AND p."cancelRequestedAt" IS NULL
        AND p."acceptedAt">=now()-interval '7 days'
        AND p."acceptedAt"<=to_timestamp(${input!.issuedAt}/1000.0)
        AND EXISTS(SELECT 1 FROM "CustomerDeliveryAttempt" a WHERE a."partId"=p."id" AND a."outcome"='ACCEPTED'
          AND a."providerMid" IS NOT NULL AND length(trim(a."providerMid"))>0 AND a."finishedAt" IS NOT NULL
          AND a."claimRevision"=p."claimRevision" AND a."endpointScopeId"=p."endpointScopeId") FOR SHARE OF p`;
    if (!part || part.payloadHash !== collection.payloadHash) return false;
    const old = customerDeliveryFenceSchema.safeParse(part.fenceJson), current = principal.authority.fence;
    return old.success && old.data.inquiryId === current.inquiryId && old.data.nativeId === current.nativeId &&
      old.data.bindingRevision === current.bindingRevision && old.data.ownershipEpoch === current.ownershipEpoch &&
      old.data.scopeRevision === current.scopeRevision && old.data.ownerToken === current.ownerToken &&
      old.data.endpoint.accountId === current.endpoint.accountId && old.data.endpoint.peerId === current.endpoint.peerId;
  } };
}
