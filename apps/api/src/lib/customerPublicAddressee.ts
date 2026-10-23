import { prisma } from "../db.js";
import { recruitmentKeyword } from "@royal-home/shared";
import { BW, TAIL } from "../ai/wordBoundary.js";
import { isCustomerPublicAppreciation, customerPublicReaction, customerRequestedAgencyContact } from "../ai/customerAgentConversationPolicy.js";
import { classifyCustomerPropertyFactIntent } from "./customerPropertyFactIntent.js";
import { readRecruitmentPositions } from "./recruitmentPositions.js";

/** Who a public comment is talking to. Server-side structure only (thread parent,
 * @mentions, the text itself); never a model label, grant or permission. */
export type PublicCommentAddressee = "company_question" | "ad_keyword" | "reply_to_other" | "reaction" | "self_promo" | "unspecified";
export type PublicParentKind = "none" | "own_comment" | "own_reply" | "other_person" | "unknown";
export interface PublicAddresseeVerdict { kind: PublicCommentAddressee; companyQuestion: boolean;
  /** Permitted no-reply outcome: someone else's conversation or a bare reaction. Never an object card. */
  skip: boolean }

// Wide on purpose: any hint of a question to the company keeps the existing
// answering path, so a vacancy/object question in a comment is never skipped.
const COMPANY_HINT = new RegExp(`${BW}(?:цен|нарх|сколько|скок|почем|почём|стоим|адрес|где|район|вакан|работ|хочу|интерес|подскаж|скажите|пришлите|напишите|номер|телефон|контакт|муфассал|подроб|ипотек|рассрочк|аренд|снять|купить|продается|продаётся|продаеться|есть|остал|чанд|чи\\s+қадар|кадом|дастрас|хоҳам|мехоҳам|мехохам|квартир|объект|дом|хона|участок|офис|вариант|показ|просмотр|запис|услуг${TAIL})`, "iu");
// Criticism, a complaint or a price/appearance remark is addressed to the company even when it tags
// someone or sits under another person's comment: it is answered, never skipped.
const CRITICISM = new RegExp(`${BW}(?:безеб|бе\\s+зеб|некрасив|не\\s+нравит|ужас|плох|обман|развод|мошенн|жалоб|недовол|разочар|стыд|позор|отврат|дорог|кимат|қимат|ика\\s+бардакай|бардакай|нархаш\\s+баланд${TAIL})`, "iu");
const PROMO =new RegExp(`(?:https?:\\/\\/|www\\.|t\\.me\\/|${BW}(?:подписывайс|подпишись|переходи|заходи\\s+на\\s+(?:мо|стран)|мой\\s+(?:профиль|канал|магазин)|в\\s+профиле|пиши\\s+в\\s+директ|заработок|раскрутк|накрутк)${TAIL})`, "iu");
const MENTION = /@([\p{L}\p{N}_.-]+)/gu;
const normalizeName = (value: string) => value.trim().replace(/^@/, "").toLowerCase();

/** `adKeyword`: the whole comment is a configured campaign keyword (a bare word alone proves nothing). */
export function classifyPublicCommentAddressee(input: { text: string; parent: PublicParentKind; ownUsernames?: ReadonlySet<string>; adKeyword?: boolean }): PublicAddresseeVerdict {
  const text = input.text.normalize("NFKC"), own = input.ownUsernames ?? new Set<string>();
  const mentions = [...text.matchAll(MENTION)].map(m => normalizeName(m[1]));
  const mentionsCompany = mentions.some(name => own.has(name));
  const hasLetters = /[\p{L}\p{N}]/u.test(text.replace(MENTION, " "));
  const phoneLike = /\d[\d\s().-]{5,}\d/u.test(text);
  const companyQuestion = mentionsCompany || CRITICISM.test(text) || !!customerPublicReaction(text) || /[?？]/u.test(text) || phoneLike || COMPANY_HINT.test(text) ||
    !!classifyCustomerPropertyFactIntent(text, { hasPropertyContext: true }) || customerRequestedAgencyContact(text);
  if (input.adKeyword) return { kind: "ad_keyword", companyQuestion: true, skip: false };
  // A reply under another person's comment, or a comment that only tags someone
  // else, is their conversation unless it also asks the company something.
  const taggedOther = own.size > 0 && mentions.length > 0 && !mentionsCompany && /^\s*@/u.test(text);
  if ((input.parent === "other_person" || taggedOther) && !companyQuestion) return { kind: "reply_to_other", companyQuestion, skip: true };
  // Bare non-praise emoji/punctuation. Praise and price/appearance remarks keep
  // their dedicated replies elsewhere (customerAgentCore).
  if (!hasLetters && !companyQuestion && !isCustomerPublicAppreciation(text) && !customerPublicReaction(text) && text.trim()) {
    return { kind: "reaction", companyQuestion, skip: true };
  }
  if (PROMO.test(text) && !companyQuestion) return { kind: "self_promo", companyQuestion, skip: false };
  return { kind: companyQuestion ? "company_question" : "unspecified", companyQuestion, skip: false };
}

/** Thread parent relative to this comment. Unresolvable/ambiguous parents are
 * "unknown": the existing answering path stays in force. */
export async function readPublicParentKind(source: { channel: string; targetResource: string | null; publicationId: string; parentId: string | null; authorId: string }): Promise<PublicParentKind> {
  if (!source.parentId) return "none";
  if (!source.targetResource) return "unknown";
  const rows = await prisma.instagramComment.findMany({ where: { channel: source.channel, accountExternalId: source.targetResource,
    mediaId: source.publicationId, OR: [{ commentId: source.parentId }, { replyCommentId: source.parentId }] },
    select: { commentId: true, replyCommentId: true, authorId: true }, take: 2 });
  if (rows.length !== 1) return "unknown";
  const row = rows[0];
  if (row.replyCommentId === source.parentId) return "own_reply";
  if (row.authorId === source.authorId) return "own_comment";
  if (row.authorId === source.targetResource) return "own_reply";
  return "other_person";
}

export async function readOwnMessengerUsernames(): Promise<Set<string>> {
  const rows = await prisma.messengerAccount.findMany({ select: { username: true }, take: 129 });
  return new Set(rows.map(row => row.username).filter((value): value is string => !!value).map(normalizeName));
}

export async function readCustomerPublicAddressee(source: { channel: string; targetResource: string | null; publicationId: string;
  parentId: string | null; authorId: string; text: string }): Promise<PublicAddresseeVerdict> {
  const keyword = recruitmentKeyword(source.text);
  const [parent, ownUsernames, positions] = await Promise.all([readPublicParentKind(source), readOwnMessengerUsernames(),
    keyword ? readRecruitmentPositions() : Promise.resolve([])]);
  return classifyPublicCommentAddressee({ text: source.text, parent, ownUsernames, adKeyword: !!keyword && positions.some(row => row.keywords.includes(keyword)) });
}
