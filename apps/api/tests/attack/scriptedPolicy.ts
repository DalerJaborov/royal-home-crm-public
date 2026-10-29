import { customerAgentDecisionSchema, type CustomerAgentDecision } from "@royal-home/shared";
import { customerAgentQuestionCatalog } from "../../src/ai/customerAgentRenderer.js";

// `--model scripted`: a deliberately crude router standing in for Gemini so that the CORE, renderer, outbox and the judge can be
// exercised without a model or a key. It reads the request the real core built (declared tools, evidence already in the
// transcript) and returns the most plausible minimal structured decision. It makes no claim about model quality.

export interface ScriptedContext { input: string; surface: "dm" | "public_comment"; perception: Record<string, unknown> | null }
type Part = { text: string } | { functionCall: { name: string; args: unknown; id: string } };
interface Request { contents?: Array<{ role: string; parts: Array<Record<string, unknown>> }> }

const has = (text: string, pattern: RegExp) => pattern.test(text.toLowerCase().replaceAll("ё", "е"));
const ABUSE = /идиот|дурак|тупой|урод|сволоч|мошенник|лохотрон|обман\p{L}*|аҳмақ|ахмак|беақл|дуруғгӯ|шарм надор|убь\p{L}*|прибью|сожгу|найду вас|угрожа\p{L}*|тебя найд|ҳалок мекунам/iu;
const SPAM = /подпишись|подписывайся|переходи в профиль|в профиле\s+(?:ссылка|заработок)|заработок|казино|ставки|крипт\p{L}*|bit\.ly|t\.me\/|накрутк\p{L}*|в\s+директ\s+за\s+бесплатн|подпишитесь|follow\s*me|obuna\s+bo/iu;
const PRAISE = /^[\s\p{Extended_Pictographic}\p{P}]*(?:спасибо|рахмат|ташаккур|супер|класс\p{L}*|огонь|молодц\p{L}*|красив\p{L}*|отличн\p{L}*|зур|офарин|барекалло|👍|❤|🔥)[\s\p{Extended_Pictographic}\p{P}]*$/iu;
const JOB = /работ[аеуы]|вакан\p{L}*|резюме|портфолио|маош|зарплат\p{L}*|\bкор\b|ҷойи кор|кор мехоҳам|стаж|smm|смм|видеограф|монтаж\p{L}*|без опыта|студент|возраст|сколько лет|ман\s+\d+\s*сола/iu;
const SELLER = /продам|продаю|продать|продаж|сдам|сдаю|фурӯшам|фурухтан|фурӯхтан|фуруш|дорам\p{L}*.*(?:фуруш|реклама)|хавли дорам|хонаи фуруш|хочу сдать|сдать\s+(?:квартир|дом)/iu;
const BUY = /купить|куплю|хочу квартиру|ищу|нужна\p{L}*\s+(?:квартир|дом|двушк|однушк)|харидан|харам|мехоҳам хона|хона мехоҳам|квартир\p{L}*|двушк\p{L}*|однушк\p{L}*|трешк\p{L}*|участок|дом\b|хона|хавли/iu;
const GREETING = /^(?:привет|здравствуй\p{L}*|добрый\s+\p{L}+|салом|асалом\p{L}*|ассалом\p{L}*|салам|hi|hello|salom)[\s!.,?]*$/iu;
const DISTRICTS = ["Сино", "Исмоили Сомони", "Шохмансур", "Шоҳмансур", "Фирдавсӣ", "Фирдавси"];

function declared(names: readonly string[], name: string) { return names.includes(name); }
function call(name: string, args: unknown, id: string): Part { return { functionCall: { name, args, id } }; }
function decision(value: unknown): Part { return { text: JSON.stringify(customerAgentDecisionSchema.parse(value) satisfies CustomerAgentDecision) }; }

export function scriptedParts(request: Request, context: ScriptedContext, tools: readonly string[]): Part[] {
  const contents = request.contents ?? [];
  const serialized = JSON.stringify(contents);
  const refs = [...new Set([...serialized.matchAll(/ref\\*"\s*:\s*\\*"(e\d+)/g)].map(match => match[1]))];
  const toolResultSeen = contents.some(content => content.parts.some(part => "functionResponse" in part));
  const protocolError = serialized.includes("serverProtocolError");
  const text = context.input, pub = context.surface === "public_comment";

  if (!toolResultSeen && !protocolError && !refs.length) {
    if (declared(tools, "get_company_policy")) {
      const topic = has(text, /комисси|ҳаққи хизмат|хизмат чанд|нархи хизмат|процент|сколько берете|сколько берёте/) ? "commission"
        : has(text, /рассрочк|ипотек|кредит|нисия|қарз|пардохт|оплат/) ? "payment"
        : has(text, /аренд|иҷора|ичора|снять|сниму/) && !has(text, /сдам|сдаю/) ? "rental"
        : has(text, /торг|скидк|уступ|дешевле|арзонтар|тахфиф/) ? "negotiation"
        : has(text, /юридич|кафолат|гарант|чист\p{L}* документ|хуҷҷат|ҳуҷҷат/u) ? "legal"
        : has(text, /чем занимаетесь|какие услуги|ваши услуги|хизматҳо|в каких городах|други шаҳр|другие города/) ? "service_scope" : null;
      if (topic) return [call("get_company_policy", { topic }, `attack-policy-${topic}`)];
    }
    if (declared(tools, "search_public_properties")) {
      const district = DISTRICTS.find(name => text.toLowerCase().includes(name.toLowerCase()));
      if (district && has(text, /квартир|двушк|однушк|трешк|вариант|дом|хона|хавли|ҳавлӣ|участок/)) {
        return [call("search_public_properties", { type: has(text, /дом|хавли|ҳавлӣ/) ? "HOUSE" : "APARTMENT", districtName: district }, "attack-search")];
      }
    }
  }
  if (protocolError) return [decision({ kind: "reply", refs, social: "none", question: refs.length ? "none" : "topic" })];

  if (pub) {
    if (ABUSE.test(text) || SPAM.test(text)) return [decision({ kind: "moderation_proposal", action: "hide", reason: SPAM.test(text) ? "spam" : "abuse" })];
    if (!text.includes("?") && !refs.length && !PRAISE.test(text) && !has(text, JOB) && !has(text, /цен|нарх|сколько|скока|где|адрес|комисси|рассрочк|ипотек|телефон|номер|рақам/)) return [decision({ kind: "skip", reason: "no_reply_needed" })];
  } else if (ABUSE.test(text) || SPAM.test(text)) {
    return [decision({ kind: "reply", refs: [], social: "acknowledge", question: "none" })];
  }
  const social = GREETING.test(text.trim()) ? "greet" : PRAISE.test(text) ? "thank" : "none";
  if (refs.length) return [decision({ kind: "reply", refs, social, question: "none" })];
  // History-aware routing: the real model sees the dialogue, so the crude router does too. It never repeats a question the bot
  // already asked and never asks for what the customer already said.
  const userTexts: string[] = [], botTexts: string[] = [];
  for (const content of contents) for (const part of content.parts) {
    const value = part.text;
    if (typeof value !== "string" || !value.trim()) continue;
    if (value.startsWith("{")) {
      try { const media = (JSON.parse(value) as { untrustedCustomerMedia?: { transcript?: string; readableText?: string } }).untrustedCustomerMedia;
        if (media) userTexts.push(media.transcript ?? "", media.readableText ?? ""); } catch { /* not a media envelope */ }
      continue;
    }
    (content.role === "model" ? botTexts : userTexts).push(value);
  }
  const everything = [...userTexts, text].join(" | "), lowered = botTexts.join(" | ").toLowerCase();
  const asked = new Set<string>();
  for (const language of ["ru", "tg"] as const) for (const { question, text: sentence } of customerAgentQuestionCatalog(language)) if (sentence && lowered.includes(sentence.toLowerCase())) asked.add(question);
  // The seller prompt is rendered from the intake progress ("Для продажи напишите ..."), so it is not one fixed catalogue sentence.
  if (/для продажи напишите|расскажите о недвижимости|барои фурӯш/u.test(lowered)) asked.add("seller_details");
  const next = (order: readonly string[], given: (question: string) => boolean = () => false) => order.find(question => !asked.has(question) && !given(question)) ?? "none";
  const topic = has(text, JOB) || has(String(context.perception?.readableText ?? ""), JOB) ? "job" : has(text, SELLER) ? "seller" : has(text, BUY) ? "buyer"
    : has(everything, JOB) ? "job" : has(everything, SELLER) ? "seller" : has(everything, BUY) ? "buyer" : "unknown";
  const given = (question: string) => question === "location" ? DISTRICTS.some(name => everything.toLowerCase().includes(name.toLowerCase()))
    : question === "rooms" ? /[1-5]\s*[- ]?\s*(?:комн|хона|ҳуҷр)|двушк|однушк|трешк|трёшк|ду\s*хона|двух|трех|трёх/iu.test(everything)
    : question === "budget" ? /\d[\d ]{2,}\s*(?:сомон|сом|\$|usd|tjs)|бюджет|буҷет|до\s*\d{5,}|то\s*\d{5,}/iu.test(everything) : false;
  const pick = topic === "job" ? (pub ? "job_required" : next(["job_position", "job_experience", "job_portfolio", "job_tools", "job_format", "job_start"]))
    : topic === "seller" ? (pub ? "topic" : next(["seller_details"]))
    : topic === "buyer" ? (pub ? "property" : next(["location", "rooms", "budget", "preferences"], given))
    : PRAISE.test(text) ? "none" : next(["topic"]);
  return [decision({ kind: "reply", refs: [], social: pick === "none" && social === "none" ? "acknowledge" : social, question: pick })];
}
