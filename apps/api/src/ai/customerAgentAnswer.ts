import type { CustomerAgentAnswerDropReason, CustomerAgentSurface } from "@royal-home/shared";
import { clientOwnWords } from "./untrustedContent.js";
import { detectClientLanguage } from "./clientLanguage.js";
import { findBannedWords } from "./bannedWordsGuard.js";
import { normalizeSayText, SAY_LEXICON, foldSayText, foldSayPattern, sayTokens, sayComparable, sayEchoes } from "./customerAgentSay.js";
import { informalAddress, foreignLanguageWord, SERVICE_CLAIM_SOURCE, outsideHumanVocabulary, approvedAsk, APPROVED_ASKS, HUMAN_VOCABULARY,
  type CustomerAgentAskKind } from "./customerAgentHumanText.js";
import { BW, EW, TAIL } from "./wordBoundary.js";

/**
 * THE MODEL'S OWN WORDS AROUND THE SERVER'S FACTS (one-brain plan 16.11.2026, step 1; redesigned after review #211).
 *
 * The model writes ONLY the human part of the reply: `lead` (acknowledgement and a soft lead-in), `ask` (the one question, in its
 * own words) and `close` (warmth, only when nothing is asked). Every fact line — price, object, address, availability, commission,
 * zone, rent, contacts, receipts, links — comes VERBATIM from the template renderer. The server composes:
 *
 *   [greeting of the template unless the lead greets] + lead + template fact lines (unchanged) + (ask | template question) + close
 *
 * The human part is rejected if it carries ANY fact-bearing token: digits, spelled numbers, currency, places, yes/no or «we do X»
 * claims, documents, years, distances, contacts, promises (customerAgentHumanText.ts + the say lexicon). Word checks could not tell
 * «для продавца 2%» from «для продавца 0%» (review #211, п.1): now the model never writes a fact at all, so there is nothing to invert.
 * All or nothing: a part is never cut or repaired; any doubt and the template reply goes out unchanged.
 *
 * Pure and deterministic like customerAgentSay.ts: the core verifies once, the renderer verifies again from the same inputs, and the
 * delivery seal re-renders the identical text. No clock, randomness, database or network may ever enter this file.
 */
export const ANSWER_LEAD_MAX_CHARS = 160;
export const ANSWER_ASK_MAX_CHARS = 140;
export const ANSWER_CLOSE_MAX_CHARS = 100;
/** Russian and Tajik both (owner 16.11.2026: «Почему умному боту запрещено своими словами говорить?»). */
export const ANSWER_ENABLED_LANGUAGES: readonly ("ru" | "tg")[] = ["ru", "tg"];

/** The human part as the model sends it. */
export interface CustomerAgentAnswerParts { lead?: string; ask?: string; close?: string }

/** Examples shown to the model. Tests run every one through the validator, so the guidance never teaches a dropped part. */
export const CUSTOMER_AGENT_ANSWER_EXAMPLES = {
  ru: [{ lead: "Спасибо, что написали!", ask: "Подскажите, в каком районе вам удобнее?" },
    { lead: "Понимаю вас.", ask: "На какую сумму вы рассчитываете?" },
    { lead: "Хорошо, вот что могу сказать." }],
  tg: [{ lead: "Раҳмат, ки навиштед!", ask: "Бемалол бигӯед, чӣ қадар маблағ дар назар доред?" },
    { lead: "Фаҳмидам.", ask: "Шумо хона харидан мехоҳед ё фурӯхтан?" }],
} as const satisfies Record<"ru" | "tg", readonly CustomerAgentAnswerParts[]>;

/**
 * The rules for the optional `answer` field. They ride in the per-turn server context (`serverSurface.answerGuidance`, private
 * messages only), never in the pinned system prompt: a changed prompt hash cannot ride the routine «Обновить версию бота» path
 * (lib/customerAgentOwnerPolicy.ts, lib/customerAgentAutoRefresh.ts PINNED_FIELDS). This text is hashed with the renderer files.
 */
const vocabularyLine = (language: "ru" | "tg") => {
  const v = HUMAN_VOCABULARY[language];
  return [...new Set([...v.greeting, ...v.neutral, ...v.warm])].join(", ");
};
const asksLine = (language: "ru" | "tg") => (Object.entries(APPROVED_ASKS[language]) as [string, readonly string[]][])
  .map(([kind, list]) => `${kind}: ${list.join(" | ")}`).join("\n");
export const CUSTOMER_AGENT_ANSWER_GUIDANCE = `Исключение из «не добавляй произвольный текст»: в reply, clarify и propose можно добавить поле answer — человеческие слова вокруг фактов, на языке replyLanguage:
answer = {"lead": "...", "ask": "...", "close": "..."}; каждое поле необязательно.
- lead: одно-два коротких предложения в начале (приветствие, «понимаю», благодарность, извинение, мягкое вступление), без вопроса;
- ask: тот же вопрос, что ты выбрал в поле question, ДОСЛОВНО одной из утверждённых формулировок ниже (другой — нельзя; нет подходящей — без ask);
- close: короткая тёплая фраза в конце, только если вопроса нет.
lead и close пишутся ТОЛЬКО словами из словаря ниже (в любом порядке, с запятыми и точкой). Любое другое слово — и уйдёт шаблон.
Рядом с отказом, проданным или недоступным объектом, ответом о городе работы — только нейтральное вступление («Понимаю вас.», «Фаҳмидам.»), без радости и без close.
Все факты (цены, объекты, наличие, комиссия, город и район работы, аренда, документы, сроки, контакты, обещания) сервер вставит сам, дословно.
Только «вы» / «шумо»; никогда: «я уже писал выше», «повторяю», «дар боло навиштам», «лутфан», «мутахассис», «амвол», «я бот», ИИ, CRM, refs; без тире и списков; не здоровайся повторно.
Словарь (русский): ${vocabularyLine("ru")}
Словарь (таджикский): ${vocabularyLine("tg")}
Утверждённые вопросы (русский):
${asksLine("ru")}
Утверждённые вопросы (таджикский):
${asksLine("tg")}
Сервер принимает answer целиком или отбрасывает целиком (тогда уйдёт шаблон) и ничего в нём не правит; сомневаешься — не пиши answer.
Примеры answer на русском:
${CUSTOMER_AGENT_ANSWER_EXAMPLES.ru.map(example => JSON.stringify(example)).join("\n")}
Примеры answer на таджикском:
${CUSTOMER_AGENT_ANSWER_EXAMPLES.tg.map(example => JSON.stringify(example)).join("\n")}`;

/** The template reply split by the renderer: only `facts` and `question.line` carry server facts; they are copied verbatim. */
export interface CustomerAgentAnswerTemplate {
  /** Leading greeting / thanks / acknowledgement lines of the template. */
  social: readonly string[];
  /** Every other line, in order: copied unchanged. */
  facts: readonly string[];
  /** The final fixed question line the model may word itself, with its kind. null: no such line (any other question stays in `facts`). */
  question: { line: string; kind: CustomerAgentAskKind } | null;
  /** A refusal, sold / reserved / unavailable object, a zone limit or «can't confirm» is among the facts: only a neutral lead, no close. */
  negative?: boolean;
}
export type CustomerAgentAnswerVerdict =
  | { ok: true; text: string; /** The kind of the question the composed text ends with (structural, for the delivery seal). */ asked: CustomerAgentAskKind | null }
  | { ok: false; reason: Exclude<CustomerAgentAnswerDropReason, "shadow"> };
type Reason = Exclude<CustomerAgentAnswerDropReason, "shadow">;
export interface CustomerAgentAnswerInput {
  answer: unknown;
  /** The server's own reply for the same decision and evidence, split into lines. null = nothing to compose with. */
  template: CustomerAgentAnswerTemplate | null;
  language: "ru" | "tg";
  surface: CustomerAgentSurface;
  inputText?: string;
  priorAssistantTurns?: readonly string[];
  maxOutputChars: number;
  /** The decision asked the planner for a file: the template carries that notice and the file follows it. */
  attachment?: boolean;
  enabledLanguages?: readonly ("ru" | "tg")[];
}

const f = foldSayText;
const rx = (source: string) => new RegExp(foldSayPattern(source), "iu");
const w = (alternatives: string) => rx(`${BW}(?:${alternatives})${EW}`);
const INVISIBLE = /[\p{Cf}\u00AD\u180E\uFE00-\uFE0F]/gu;
const NEWLINE = /[\r\n\u0085\u2028\u2029\v\f]/u;
/** Letters (Cyrillic incl. Tajik), spaces and plain punctuation. Anything else (digits, %, №, $, Latin, @, emoji, *, #) is refused. */
const PLAIN = /^[\p{Script=Cyrillic}\s.,!?:;«»"'’()…—–-]+$/u;

// ── tone: the live bad replies of the audit 16.11.2026 (tone.md, language.md) ──────────────────────────────────────────
/** «Писал выше / повторяю / бори дигар такрор мекунам / агар саволи ман дар боло номафҳум буд» — 96 replies in 5 days. */
const REPEAT_RUDE = w([`писал${TAIL}\\s+выше`, `написал${TAIL}\\s+выше`, `уже\\s+(?:писал${TAIL}|написал${TAIL}|ответил${TAIL}|говорил${TAIL}|сказал${TAIL}|объяснял${TAIL})`,
  "повтор(?:ю|яю|юсь|яюсь|ю\\s+ещ[её]\\s+раз)", `как\\s+я\\s+(?:уже\\s+)?(?:писал${TAIL}|сказал${TAIL}|говорил${TAIL})`, `(?:читайте|смотрите|см\\.?)\\s+выше`,
  `дар\\s+боло`, `боло\\s+навишт${TAIL}`, `такрор\\s+мекун${TAIL}`, `бозам\\s+такрор`, `номафҳум\\s+буд${TAIL}`, `агар\\s+саволи\\s+ман`].join("|"));
/** Service receipts and system talk instead of a person: «Заявка на связь с сотрудником сохранена.», «На изображении вижу: ...». */
const RECEIPT_TALK = rx(`${BW}(?:заявк${TAIL}|запрос${TAIL}|обращени${TAIL}|на\\s+изображении\\s+вижу|в\\s+подтвержд[её]нных\\s+данных|в\\s+систем${TAIL}|дархост${TAIL})${EW}`);
/** Bookish and machine Tajik the owner banned (tajik-phrasebook do-not-say, owner 16.08/17.09/11.11.2026). */
const WOODEN_TG = w([`лутфан`, `безаҳмат`, `безахмат`, `мутахассис${TAIL}`, `амвол${TAIL}`, `муфассал${TAIL}`, `хоҳиш\\s+мекун${TAIL}`, `ёрӣ\\s+медиҳ${TAIL}`, `қулай${TAIL}`, `мудир${TAIL}`, `линк${TAIL}`,
  `муҳтарам\\s+мизоҷ${TAIL}`, `мизоҷи\\s+муҳтарам`].join("|"));
/** Owner rule: no dash inside phrases (tajik-phrasebook do-not-say №14); a line that starts with a dash is a list. */
const DASH = /—|–|(?:^|\s)-(?:\s|$)|(?:^|\n)\s*[-•]\s/u;
const POLITE_CAPITALS = new Set(["вы", "вас", "вам", "вами", "ваш", "ваша", "ваше", "ваши", "вашего", "вашей", "вашу", "вашим", "ваших", "шумо", "шуморо", "шумоед"].map(f));

// ── claims that only a verified template line may carry ──────────────────────────────────────────────────────────────
const CLAIM_CLASSES: readonly RegExp[] = [
  w(`продан${TAIL}|продал${TAIL}|брон${TAIL}|забронир${TAIL}|свободн${TAIL}|свободен|в\\s+наличии|фурӯхта${TAIL}|озод${TAIL}|мавҷуд${TAIL}|занят${TAIL}`),
  rx(`${BW}(?:комисси${TAIL}|процент${TAIL}|фоиз${TAIL}|ҳаққи\\s+хизмат${TAIL})${EW}`),
  w(`аренд${TAIL}|снять|сдать|кироя${TAIL}|иҷора${TAIL}`),
  w(`ипотек${TAIL}|рассрочк${TAIL}|кредит${TAIL}|насия${TAIL}|қарз${TAIL}|бо\\s+қисм${TAIL}|қисм-қисм`),
  w(`скидк${TAIL}|торг${TAIL}|уступ${TAIL}|тахфиф${TAIL}|арзон\\s+мекун${TAIL}`),
  w(`друг${TAIL}\\s+город${TAIL}|не\\s+работаем|не\\s+обслуживаем|только\\s+в|шаҳрҳои\\s+дигар|кор\\s+намекун${TAIL}|фақат\\s+дар|танҳо\\s+дар`),
  w(`юридическ${TAIL}|юридик${TAIL}|чистот${TAIL}|ҳуқуқ${TAIL}|покии|гаранти${TAIL}|кафолат${TAIL}`),
  w(`евроремонт${TAIL}|таъмир${TAIL}|коробк${TAIL}|каробка${TAIL}|чернов${TAIL}|белая\\s+отделк${TAIL}|отделк${TAIL}`),
  w(`мебл${TAIL}|ҷиҳоз${TAIL}`),
  w(`зарплат${TAIL}|оклад${TAIL}|маош${TAIL}|музд${TAIL}|оплата\\s+труда`),
  w(`адрес${TAIL}|суроға${TAIL}|офис${TAIL}|улиц${TAIL}|проспект${TAIL}|кӯча${TAIL}|хиёбон${TAIL}|дафтар${TAIL}|идора${TAIL}`),
  w(`послезавтра|вечером|утром|в\\s+течение|до\\s+конца\\s+дня|бегоҳ${TAIL}|соат${TAIL}|душанбе\\s+рӯз|ҷумъа`),
  w(`застройщик${TAIL}|сохтмонч${TAIL}|ширкати\\s+сохтмон${TAIL}`),
  w(`ноза${TAIL}|риелтор${TAIL}|директор${TAIL}|руководител${TAIL}|роп`),
];
const SERVICE_CLAIM = rx(SERVICE_CLAIM_SOURCE);

const sentencesOf = (text: string) => text.split(/(?<=[.!?…])\s+/u).map(s => s.trim()).filter(s => /\p{L}/u.test(s));

type Role = "lead" | "ask" | "close";
const LIMITS: Record<Role, { chars: number; sentences: number }> = {
  lead: { chars: ANSWER_LEAD_MAX_CHARS, sentences: 2 }, ask: { chars: ANSWER_ASK_MAX_CHARS, sentences: 1 }, close: { chars: ANSWER_CLOSE_MAX_CHARS, sentences: 1 },
};

/** The kind of an APPROVED question wording (customerAgentHumanText.ts APPROVED_ASKS), or null: no free paraphrase is a question kind. */
export function customerAgentAskKindOf(line: string): CustomerAgentAskKind | null {
  return approvedAsk(normalizeSayText(line.normalize("NFKC").replace(INVISIBLE, "")))?.kind ?? null;
}

/**
 * Why one human part may not reach a customer, or null. Fact-bearing tokens first (the reason the redesign exists), then tone.
 * `language` undefined: only the fact checks (used to admit a sent line into the dialogue memory, whatever its language).
 */
function humanPartIssue(raw: string, role: Role, opts: { kind?: CustomerAgentAskKind; language?: "ru" | "tg"; own?: string; neutralOnly?: boolean }): Reason | null {
  if (/[№#]/u.test(raw)) return "number";
  const nfkc = raw.normalize("NFKC").replace(INVISIBLE, "");
  if (NEWLINE.test(nfkc)) return "length";
  const text = normalizeSayText(nfkc);
  if (text.length < 2 || text.length > LIMITS[role].chars || sentencesOf(text).length > LIMITS[role].sentences) return "length";
  if (/\p{Nd}/u.test(text)) return "number";
  if (/[%$€₽£¥]/u.test(text)) return "currency";
  if (/\p{Script=Latin}|@/u.test(text)) return "place";
  if (!PLAIN.test(text)) return "meta";
  const folded = f(text);
  // The question slot: an APPROVED wording of the server's question kind, in the reply language, or nothing (review #211, round 2).
  if (role === "ask") {
    const approved = approvedAsk(text);
    if (!approved || approved.kind !== opts.kind || opts.language && approved.language !== opts.language) return "question";
    return null;
  }
  if (/[?]/u.test(text) || SAY_LEXICON.ASKING.test(folded)) return "question";
  // ALLOWLIST decides: every word from the vetted vocabulary (any language for the memory check, the reply language otherwise; neutral
  // words only next to a refusal). The lexicons below only NAME the reason of a refusal for the counters («модель сама писала факт»).
  const outside = opts.language ? outsideHumanVocabulary(text, opts.language, opts.neutralOnly)
    : outsideHumanVocabulary(text, "ru") && outsideHumanVocabulary(text, "tg");
  const reason = lexiconReason(text, folded);
  if (outside && reason) return reason;
  if (SAY_LEXICON.META.test(folded)) return "meta";
  if (REPEAT_RUDE.test(folded) || RECEIPT_TALK.test(folded) || WOODEN_TG.test(folded) || findBannedWords(text).length || DASH.test(text)) return "wooden";
  if (SAY_LEXICON.CLICHE.test(folded)) return "cliche";
  if (opts.language && informalAddress(text, opts.language)) return "rude";
  if (opts.language && foreignLanguageWord(text, opts.language)) return "language";
  if (outside) return "vocabulary";
  if (opts.own && sayEchoes(text, opts.own)) return "echo";
  return null;
}
/** Why a text outside the vocabulary was refused, named for the day line (a fact attempt or not); null = just an unknown word. */
function lexiconReason(text: string, checked: string): Reason | null {
  if (SAY_LEXICON.CONTACT.test(checked)) return "phone_ask";
  if (SAY_LEXICON.CALL_PROMISE.test(checked) || SAY_LEXICON.SAVE_PROMISE.test(checked) || SAY_LEXICON.ALWAYS_PROMISE.test(checked)) return "promise";
  if (SAY_LEXICON.NUMBER_WORDS.test(checked) || SAY_LEXICON.MONTHS.test(checked) || SAY_LEXICON.WEEKDAYS.test(checked) || SAY_LEXICON.RELATIVE_TIME.test(checked)) return "number";
  if (SAY_LEXICON.CURRENCY.test(checked)) return "currency";
  if (SAY_LEXICON.FACT_CLAIM.test(checked) || SERVICE_CLAIM.test(checked) || CLAIM_CLASSES.some(claim => claim.test(checked))) return "claim";
  if (SAY_LEXICON.KNOWN_PLACES.some(place => place.pattern.test(checked))) return "place";
  for (const [index, word] of sayTokens(text).entries()) {
    if (index === 0 || word.length < 3) continue;
    const first = word[0];
    if (first !== first.toLowerCase() && first === first.toUpperCase() && !POLITE_CAPITALS.has(f(word))) return "place";
  }
  return null;
}

/**
 * A line the bot sent that carries no fact (a model lead, ask or close accepted earlier): safe to keep in the dialogue memory, so the
 * model sees what it said and the repeat/greeting guards see it too (review #211, п.5). A question line counts only with ONE topic.
 */
export function customerAgentHumanLineSafe(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (/[?]/u.test(text)) return customerAgentAskKindOf(text) !== null;
  return humanPartIssue(text, "lead", {}) === null;
}

/**
 * The lines of a sent bot text that may enter the dialogue memory: the server's own lines (`allowed`) and fact-free human lines, i.e.
 * the model's accepted lead / ask / close (review #211, п.5: they matched no template, so the whole turn vanished from memory and the
 * repeat and double-greeting guards saw nothing). A line that carries any fact still never enters unless the server can re-derive it.
 */
export function customerAgentMemoryText(text: string, allowed: ReadonlySet<string>): string {
  return text.split("\n").map(line => line.trim()).filter(line => line && (allowed.has(line) || customerAgentHumanLineSafe(line))).join("\n");
}

/** The model's raw `answer` as human parts; null for any other shape (a string, an array, unknown keys, nothing to say). */
export function parseCustomerAgentAnswerParts(raw: unknown): CustomerAgentAnswerParts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>, parts: CustomerAgentAnswerParts = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== "lead" && key !== "ask" && key !== "close") return null;
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") return null;
    parts[key] = value;
  }
  return parts.lead || parts.ask || parts.close ? parts : null;
}

const isGreeting = (line: string) => SAY_LEXICON.GREETING.test(f(line));

/** All-or-nothing verdict and the composed text. The first failing rule names the reason; no part is ever repaired. */
export function validateCustomerAgentAnswer(input: CustomerAgentAnswerInput): CustomerAgentAnswerVerdict {
  const bad = (reason: Reason): CustomerAgentAnswerVerdict => ({ ok: false, reason });
  if (input.surface !== "dm") return bad("surface_disabled");
  if (!(input.enabledLanguages ?? ANSWER_ENABLED_LANGUAGES).includes(input.language)) return bad("language_disabled");
  const template = input.template;
  if (!template || !template.social.length && !template.facts.length && !template.question) return bad("not_eligible");
  if (input.attachment) return bad("template_payload");
  const parts = parseCustomerAgentAnswerParts(input.answer);
  if (!parts) return bad("length");
  const own = clientOwnWords(input.inputText ?? "");
  const kind = template.question?.kind;
  for (const [role, value] of [["lead", parts.lead], ["ask", parts.ask], ["close", parts.close]] as const) {
    if (value === undefined) continue;
    if (role === "ask" && !template.question) return bad("question");
    if (role === "close" && template.negative) return bad("vocabulary");
    const issue = humanPartIssue(value, role, { kind: role === "ask" ? kind : undefined, language: input.language, own, neutralOnly: template.negative });
    if (issue) return bad(issue);
  }
  const lead = parts.lead && normalizeSayText(parts.lead), ask = parts.ask && normalizeSayText(parts.ask), close = parts.close && normalizeSayText(parts.close);
  const human = [lead, ask, close].filter((part): part is string => !!part);

  // One language across the human words (a Tajik lead with a Russian question is still a mix).
  const verdict = detectClientLanguage(human.join(" "));
  if (input.language === "ru" ? verdict === "tg" || verdict === "mixed" : verdict === "ru" || verdict === "mixed") return bad("language");

  // Greetings: the lead may greet only where the template greets (then it replaces that line); ask and close never greet.
  const templateGreets = template.social.some(isGreeting);
  if (lead && isGreeting(lead) && !templateGreets || ask && isGreeting(ask) || close && isGreeting(close)) return bad("double_greet");

  // Never the same words twice in a conversation.
  const prior = (input.priorAssistantTurns ?? []).flatMap(turn => turn.split("\n").map(line => sayComparable(line)).filter(Boolean));
  const priorTurns = (input.priorAssistantTurns ?? []).map(sayComparable);
  // «Хорошо, понимаю вас.» after «Понимаю вас, хорошо.» is the same words: compared as a set too.
  const bag = (value: string) => [...new Set(sayComparable(value).split(" ").filter(Boolean))].sort().join(" ");
  const priorBags = (input.priorAssistantTurns ?? []).flatMap(turn => turn.split("\n").map(bag)).filter(Boolean);
  for (const part of human) {
    const key = sayComparable(part);
    if (key && (prior.includes(key) || priorBags.includes(bag(part)) || key.length >= 20 && priorTurns.some(turn => turn.includes(key)))) return bad("repeat");
  }

  // Compose: template facts verbatim, the human words around them.
  const lastFact = template.facts.at(-1) ?? "";
  if (close && (template.question || /[?]/u.test(lastFact))) return bad("question");
  const lines = [...(lead ? [...(isGreeting(lead) ? [] : template.social.filter(isGreeting)), lead] : template.social), ...template.facts,
    ...(template.question ? [ask ?? template.question.line] : []), ...(close ? [close] : [])];
  const text = lines.join("\n");
  // Invariant (defence in depth): every template fact line is in the reply, unchanged.
  const sent = new Set(lines);
  if (!template.facts.every(line => sent.has(line))) return bad("missing_fact");
  if (text.length > input.maxOutputChars) return bad("length");
  if (priorTurns.includes(sayComparable(text))) return bad("repeat");
  return { ok: true, text, asked: template.question?.kind ?? null };
}

