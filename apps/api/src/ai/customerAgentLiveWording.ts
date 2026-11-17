/**
 * ЖИВЫЕ СЛОВА НОВОГО ЯДРА — РАЗБОР 16.11.2026 (аудит переписок 10–16.11: 189 чатов, 481 ответ бота).
 *
 * Чистые правила без базы: рендер (ai/customerAgentRenderer.ts) зовёт их и при ответе, и при запечатывании,
 * поэтому одинаковый вход всегда даёт одинаковый текст. Здесь только то, ЧТО и КОГДА сказать; факты (цены,
 * вакансии, часы) по-прежнему приходят из проверенных чтений.
 *
 * Классы, которые закрывает этот файл (живые случаи, время Душанбе):
 *  - кнопка рекламы «Привет! Можно узнать об этом подробнее?» → «Какой объект вы имеете в виду?» (65 чатов, 39 из них
 *    оказались соискателями, 21 ушёл молча) — теперь один живой вопрос «купить, продать или работа у нас?»;
 *  - «Салом!» на «Ассалому алейкум» и повторное приветствие в одном чате (17 ответов в 15 чатах);
 *  - соискатель: строка про Нозу второй раз, свой номер кандидата пропал, «звонила — никто не берёт» → «Извините за
 *    неудобство.» (19 ответов в 18 чатах);
 *  - «Не могу гарантировать юридическую чистоту» на «Хочу продать квартиру» (5 чатов), аренда не к месту;
 *  - «Понял./Фаҳмидам.» единственным ответом на сообщение с цифрами, адресом или вопросом (20 ответов);
 *  - зона работы: «только Душанбе» — неверно, владелец: Душанбе и район Рудаки.
 *
 * ТАДЖИКСКИЙ — по скиллу tajik-phrasebook. Фразы без пометки взяты из live-agent-phrases.md как есть. Фразы,
 * собранные по образцу (их нет в разговорнике дословно), перечислены в описании PR для проверки владельцем.
 */
import { RETIRED_SERVICE_AREA_LINES } from "../lib/serviceArea.js";
import { clientSaidNothingSubstantive, isAdTemplateOpener } from "./adTemplatePhrase.js";
import { clientOwnWords } from "./untrustedContent.js";
import { extractAllPhones } from "../lib/shared/phoneText.js";
import { RECRUITMENT_CONTACT } from "@royal-home/shared";
import type { CustomerAgentVerifiedContext } from "@royal-home/shared";

type Lang = "ru" | "tg";
type Pair = { ru: string; tg: string };
const own = (text: string | undefined) => clientOwnWords(text ?? "").normalize("NFKC").toLowerCase().replace(/ё/gu, "е");

/** The ad button / a bare greeting, and nothing of the customer's own yet: one live question instead of "which object?".
 *  Tajik: «Чӣ хизмат кунам?» (live-agent-phrases, приветствие оператора). */
export const AD_OPEN_QUESTION: Pair = {
  ru: "Подскажите, что вас интересует: купить, продать недвижимость или работа у нас?",
  tg: "Чӣ хизмат кунам?",
};
/** The customer has not said a single word of their own in this conversation: only the ad button text and greetings.
 *  Text only (a photo or a reel is the customer's material), and either the ad button is there or the bot has not spoken yet
 *  (a «?» after the bot's own question is a repair, not an opening). */
export function customerAdOpening(input: { inputText?: string; verifiedContext?: CustomerAgentVerifiedContext;
  attachmentInput?: unknown; mediaPerception?: unknown }): boolean {
  if (input.verifiedContext?.surface !== "dm" || input.verifiedContext.publicState.topic === "job") return false;
  if (input.attachmentInput || input.mediaPerception || !clientOwnWords(input.inputText ?? "").trim()) return false;
  const users = input.verifiedContext.turns.filter(turn => turn.role === "user").map(turn => turn.text);
  const words = [...users, input.inputText ?? ""];
  if (!words.every(text => clientSaidNothingSubstantive(text))) return false;
  // After the bot has shown objects or vacancies, «можно поподробнее» is about them, never the opening (review #206 С4).
  if (input.verifiedContext.turns.some(turn => turn.role === "assistant" && SHOWN_SOMETHING.test(turn.text))) return false;
  return words.some(text => isAdTemplateOpener(text)) || !input.verifiedContext.turns.some(turn => turn.role === "assistant");
}

const SHOWN_SOMETHING = /Объект\s*№|^\s*\d+\.\s|ваканси|Ҷой(?:ҳо)?и\s+кори|Нархаш|Цена\s+объекта|https?:\/\//imu;
/** Every greeting line the bot can send (current and earlier wording): the memory of "already greeted". */
export const GREETING_REPLY_LINES: readonly string[] = ["Здравствуйте!", "Добрый день!", "Здравствуйте, рад вас слышать!",
  "Салом!", "Ассалому алайкум!", "Ассалому алейкум!", "Ваалайкум ассалом!", "Салом, хуш омадед!"];
const SALAAM = /(?:^|[\s,.!])(?:ас+алому?|ас+алом|салом|салам|assalomu|salom)?\s*(?:а?лей?к[уӯ]м|алайк[уӯ]м|алек[уӯ]м|алекум\p{L}*|алеккум|aleykum|alaykum|alaikum)/iu;
/** «Ассалому алейкум» is answered «Ваалайкум ассалом!» (phrasebook rule 2), never «Салом!». */
export function customerGreetingLine(language: Lang, inputText: string | undefined, greet: Pair): string {
  return language === "tg" && SALAAM.test(own(inputText)) ? "Ваалайкум ассалом!" : greet[language];
}
/** The bot already greeted in this conversation (its recent lines or the remembered turns): no second greeting. */
export function customerAlreadyGreeted(said: (line: string) => boolean): boolean {
  return GREETING_REPLY_LINES.some(said);
}

/** The customer asks about documents/legal purity: only then the "cannot guarantee" line is an answer. */
const LEGAL_WORDS = /юрид|чистот|документ|ҳуҷҷат|хуччат|хучат|хуҷҷат|ҳуқуқ|хукук|кафолат|гарант|нотариус|техпаспорт|кадастр|санад|покии|проверя|провер(?:ка|ить)|бмти|мбти|обременен|арест|залог/u;
export function customerLegalAsked(text: string | undefined): boolean { return LEGAL_WORDS.test(own(text)); }
/** The customer speaks about renting: only then "we do not do rentals" is an answer. */
const RENT_WORDS = /аренд|снять|сдать|сдаю|сдаете|сдаёте|сниму|иҷора|ичора|ижора|ичорa|кира|квартирант|моҳона|мохона|в\s+месяц|помесяч|посуточ|суточ/u;
export function customerRentalAsked(text: string | undefined): boolean { return RENT_WORDS.test(own(text)); }

/** A link or a bare object number in the customer's message: never "which object?" back (audit 16.11.2026, class 7). */
export function customerInputHasLink(text: string | undefined): boolean {
  return /https?:\/\/|www\.|instagram\.com|instagr\.am|fb\.watch|facebook\.com|wa\.me|royalhome\.tj/iu.test(text ?? "");
}
/** The message carries something: digits (a price, a floor, an area, a phone) or a question. */
export function customerSubstantiveInput(text: string | undefined, asksNow: boolean): boolean {
  return asksNow || /\d{2,}/u.test(own(text));
}


// ---- Recruitment (phone-only by the owner's decision 10–11.11.2026; Noza's number said ONCE per chat) ----
/** The candidate gave their own number: it is passed on (the turn signals a person), Noza calls them herself. */
const RECRUITMENT_PHONE_TAKEN: Pair = {
  ru: `Спасибо, передал ваш номер ${RECRUITMENT_CONTACT.name === "Ноза" ? "Нозе" : RECRUITMENT_CONTACT.name}, она сама вам позвонит.`,
  tg: `Ташаккур, рақамро ба ${RECRUITMENT_CONTACT.name} додем, худаш ба шумо занг мезанад.`,
};
/** "I called, nobody answers" / "came to the interview, nobody knew": a person must answer, never "Извините за неудобство.". */
const RECRUITMENT_COMPLAINT: Pair = {
  ru: `Извините, что не получилось связаться. Передал ${RECRUITMENT_CONTACT.name === "Ноза" ? "Нозе" : RECRUITMENT_CONTACT.name}, она сама вам позвонит.`,
  tg: `Бубахшед. Ба ${RECRUITMENT_CONTACT.name} хабар додем, худаш ба шумо занг мезанад.`,
};
/** A question about the job after Noza's number was already given: one short line, the number is not repeated. */
const RECRUITMENT_ASK_NOZA: Pair = {
  ru: `Это подробно расскажет ${RECRUITMENT_CONTACT.name} по телефону.`,
  tg: `Инро аниқ ${RECRUITMENT_CONTACT.name} мегӯяд.`,
};
/** The candidate wrote about themselves after Noza's number was given: thanks, and she tells the rest (no number again). */
const RECRUITMENT_THANKS_NOZA: Pair = {
  ru: `Спасибо! Все подробности расскажет ${RECRUITMENT_CONTACT.name} по телефону.`,
  tg: `Ташаккур! Ҳамаи тафсилотро ${RECRUITMENT_CONTACT.name} мегӯяд.`,
};
/** A receipt already said in this chat, and nothing else to say: the same fact in other words (never silence). */
export const RECEIPT_AGAIN: Pair = { ru: "Хорошо, записал.", tg: "Хуб, қайд кардам." };
/** Lines after which a person must be told (one door: lib/customerDmAgentTurn.ts::signalStaffFollowUp). */
export const RECRUITMENT_FOLLOW_UP_LINES: readonly string[] = [RECRUITMENT_PHONE_TAKEN, RECRUITMENT_COMPLAINT].flatMap(pair => [pair.ru, pair.tg]);
export function recruitmentFollowUpFixedLines(): string[] {
  return [RECRUITMENT_PHONE_TAKEN, RECRUITMENT_COMPLAINT, RECRUITMENT_ASK_NOZA, RECRUITMENT_THANKS_NOZA, RECEIPT_AGAIN].flatMap(pair => [pair.ru, pair.tg]);
}
/** "I called and nobody answers" in ONE sentence (review #206 В1): a call word AND a no-answer word. «Когда собеседование?»,
 *  «Мне Ноза звонила, всё хорошо», «Хорошо, никто не против» are not complaints. */
const CALL_WORD = /звон|дозвон|занг|трубк|телефон/u;
const NO_ANSWER = /не\s+(?:берут|бер[её]т|отвечает|отвечают|поднимает|поднимают|могу\s+дозвон)|никто\s+не\s+(?:берет|берёт|отвечает|поднимает|взял)|не\s+дозвон|намегир|ҷавоб\s+намедиҳ|чавоб\s+намедих|ҷавоб\s+на(?:дод|гирифт)|чавоб\s+на(?:дод|гирифт)|хомуш/u;
function complaint(text: string | undefined): boolean {
  return own(text).split(/[.!?？\n]+/u).some(part => CALL_WORD.test(part) && NO_ANSWER.test(part));
}
const NOZA_TAIL = RECRUITMENT_CONTACT.phone.replace(/\D/gu, "").slice(-9);
/** The candidate's own phone numbers in their words, parsed by the project's strict phone parser (review #206 В2: never a
 *  date «20.11.2026», a salary «3000-5000» or years «2019 2024»); Noza's own number quoted back is not theirs. */
export function candidatePhones(text: string | undefined): string[] {
  const words = clientOwnWords(text ?? "");
  const phones = extractAllPhones(words).filter(phone => phone.replace(/\D/gu, "").slice(-9) !== NOZA_TAIL);
  // A bare nine-digit run with no phone word around it («ИНН 123456789») is not a phone (re-review #206 Н3).
  if (PHONE_CONTEXT.test(words.toLowerCase())) return phones;
  return phones.filter(phone => !new RegExp(`(?<!\\d)${phone.replace(/\D/gu, "").slice(-9)}(?!\\d)`, "u").test(words.replace(/\+?992/gu, " ")));
}
const PHONE_CONTEXT = /номер|телефон|тел\.|тел\s|whatsapp|ватсап|вотсап|вацап|телеграм|telegram|рақам|раками|ракам|занг|звон|позвон|\+992|для\s+связи/u;
export function candidatePhoneGiven(text: string | undefined): boolean { return candidatePhones(text).length > 0; }
export type RecruitmentFollowUp = "phone_given" | "complaint" | "ask" | null;
/** What a candidate's message is, once Noza's number is known to them. */
export function customerRecruitmentFollowUp(text: string | undefined, asksNow: boolean): RecruitmentFollowUp {
  if (candidatePhoneGiven(text)) return "phone_given";
  if (complaint(text)) return "complaint";
  return asksNow ? "ask" : null;
}
export function recruitmentFollowUpLine(kind: Exclude<RecruitmentFollowUp, null> | "thanks", language: Lang): string {
  return (kind === "phone_given" ? RECRUITMENT_PHONE_TAKEN : kind === "complaint" ? RECRUITMENT_COMPLAINT
    : kind === "thanks" ? RECRUITMENT_THANKS_NOZA : RECRUITMENT_ASK_NOZA)[language];
}
/** Noza's number was already said in this chat (current or retired wording). */
export function recruitmentPhoneLineSaid(said: (line: string) => boolean, lines: readonly string[]): boolean {
  return lines.some(said);
}

/**
 * RETIRED wording (16.11.2026). Never rendered again; kept so the conversation memory of older chats still recognises
 * what the bot asked or said before the change (lib/customerAgentVerifiedContext.ts keeps only fixed server lines).
 */
export const RETIRED_TEMPLATE_LINES: readonly string[] = [
  "Бигӯед, лутфан, ба шумо чӣ лозим аст?", "Шумо чӣ қадар буҷет дар назар доред?", "Кадом ноҳия ба шумо мувофиқ аст?",
  "Ба шумо чанд ҳуҷра лозим аст?", "Ба шумо чӣ тавр муроҷиат кунам?", "Барои тамос кадом рақами телефонро мегузоред?",
  "Шумо амвол харидан мехоҳед ё фурӯхтан?", "Чиро муфассалтар шарҳ диҳам?", "Дар бораи амволе, ки фурӯхтан мехоҳед, нависед.",
  "Я уточнял, о каком объекте речь. Пришлёте номер объекта или ссылку?",
  "Ман муайян кардан мехостам, ки сухан дар бораи кадом объект меравад. Рақами объект ё пайвандашро мефиристед?",
  "Извините за неудобство.", "Барои нороҳатӣ узр мехоҳам.",
  "Сведения добавлены к отклику на вакансию.", "Маълумот ба дархости кор илова шуд.", "Контактные данные сохранены.", "Маълумоти тамос сабт шуд.",
  "Запрос на звонок создан.", "Дархост барои занг сабт шуд.", "Обращение зарегистрировано.", "Муроҷиат сабт шуд.",
  "Обращение к сотруднику создано.", "Муроҷиат ба корманд сабт шуд.",
  "Ҳоло бо иҷора кор намекунем: на ба иҷора медиҳем ва на меҷӯем.",
  "Барои хариду фурӯши амвол дар Душанбе кӯмак мекунем.", "Помогаем с покупкой и продажей недвижимости в городе Душанбе.",
  "Барои хариду фурӯши амвол дар Душанбе кӯмак мекунем. Дар шаҳрҳои дигар кор намекунем.",
  "Помогаем с покупкой и продажей недвижимости в городе Душанбе. Другие города не обслуживаем.",
  ...RETIRED_SERVICE_AREA_LINES,
  "Это наша публикация, но объект к ней не привязан. Напишите район и число комнат — подберу.",
  "Ин нашрияи мост, вале объект ба он пайваст нест. Минтақа ва шумораи ҳуҷраҳоро нависед — интихоб мекунам.",
  "Пришлите, пожалуйста, обычным фото — так агент его сохранит.",
  "Лутфан, ҳамчун акси оддӣ фиристед — агент онро нигоҳ медорад.",
  "Расскажите о вашем опыте. Если его пока нет, так и напишите — это не означает отказ.",
  "Дар бораи таҷрибаатон нависед. Агар таҷриба надошта бошед, ҳамин тавр нависед — ин маънои рад шуданро надорад.",
];
