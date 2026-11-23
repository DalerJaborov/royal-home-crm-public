/**
 * «ОЗВУЧЬ ТЕКСТ» В ШАБНАМ (16.11.2026, решение владельца). Сотрудник присылает свой текст,
 * выбирает голос из утверждённых для озвучки роликов и получает mp3 документом. Текст читается
 * слово в слово: модель помощника его не видит. Вся логика, права, потолки и деньги — в
 * lib/freeNarration.ts (одна дверь, её зовёт и REST); здесь только распознавание просьбы, кнопки
 * и выдача файла.
 *
 * Распознавание намеренно узкое: «озвучь сроки по ОБ-12» — вопрос помощнику, а не текст для озвучки.
 * Текст берётся, если после просьбы стоит двоеточие или перенос строки, либо в просьбе есть
 * «текст»/«дословно»/«слово в слово» (таджикский: «матн»/«айнан»/«калима ба калима»). Голая
 * просьба «озвучь» работает только ответом на сообщение сотрудника с текстом. До выбора голоса
 * денег не тратится: ложное срабатывание стоит одного сообщения, а не кредитов.
 */
import { createHash } from "node:crypto";
import { pickNarrationVoice, type NarrationConfig } from "@royal-home/shared";
import { prisma } from "../db.js";
import { claimCallback } from "../lib/telegramCallbackClaim.js";
import { freeNarrationAdTextEnabled, freeNarrationLimits, freeNarrationOfferEnabled } from "@royal-home/shared";
import { isAiAssistantEnabled } from "../ai/assistant.js";
import { adFactsUsable, generateAdScript, parseAdTextRequest, type AdScriptResult } from "../ai/assistant/adScript.js";
import { createAssistantMoneyWallet, type AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import {
  cancelFreeNarration, claimFreeNarration, clearFreeNarrationTextWait, confirmFreeNarrationDraft, createFreeNarrationDraft, createFreeNarrationRequest, dropFreeNarrationDraft, executeFreeNarration,
  freeNarrationFilePath, loadFreeNarrationDraft, pendingFreeNarrationTextWaitMode, lockAdRewrite, finishAdRewrite, setFreeNarrationLang, startFreeNarrationTextWait, canUseFreeNarration,
  FREE_NARRATION_AD_REWRITES_MAX, type FreeNarrationClaim, type FreeNarrationDraftKind, type FreeNarrationRow, type FreeNarrationRunOutcome,
} from "../lib/freeNarration.js";
import { loadNarrationConfiguration } from "../lib/narrationGeneration.js";
import { narrationLastChoiceFor } from "../lib/narrationLastChoice.js";
import { findAgentByTelegramChatId } from "../lib/telegramAgentLink.js";
import { logSystemError } from "../lib/systemError.js";
import { trackBackgroundTask } from "../lib/shutdownState.js";
import { answerCallbackQuery, editMessageText, sendChatAction, sendDocumentFile, sendMessage, sendMessageWithButtons, type TelegramCallbackQuery, type TelegramIncomingMessage, type TelegramInlineButton } from "./api.js";
import { chatLang, sendVoiceSamples } from "./assistantNarration.js";

type Lang = "ru" | "tg";
const MAX_VOICE_BUTTONS = 8;

export type FreeNarrationTrigger = { kind: "text"; text: string } | { kind: "ask" } | { kind: "bare" };

const VERB = "(?:озвуч(?:ь|ьте)(?:\\s+это)?|(?<noun>(?:ин\\s+)?матнро\\s+)?(?:овоз(?:онӣ)?\\s+(?:кун(?:ед)?|деҳ|дех|диҳед|дихед)|хонда\\s+(?:деҳ|дех|диҳед|дихед)))";
const MODIFIER = "(?<mod>(?:\\s+(?:этот\\s+)?текст|\\s+дословно|\\s+слово\\s+в\\s+слово|\\s+матн(?:ро)?|\\s+айнан|\\s+калима\\s+ба\\s+калима)+)?";
const PLEASE = "(?:\\s*,?\\s*(?:пожалуйста|лутфан))?";
const TRIGGER = new RegExp(`^\\s*(?:(?:шабнам|shabnam)\\s*[,:!-]?\\s*)?${VERB}${MODIFIER}${PLEASE}(?![\\p{L}\\p{N}])(?<rest>[\\s\\S]*)$`, "iu");

/**
 * Просьба «озвучь» в начале сообщения. null — это не просьба (обычный вопрос помощнику).
 * text — текст нашёлся в самом сообщении; ask — просьба ясная, текста нет (спросим); bare —
 * только слово «озвучь» (годится лишь как ответ на сообщение с текстом).
 */
export function parseFreeNarrationTrigger(raw: string): FreeNarrationTrigger | null {
  const m = TRIGGER.exec(raw);
  if (!m?.groups) return null;
  const rest = m.groups.rest ?? "";
  // «матнро овоз кун» несёт слово «текст» так же, как «озвучь текст»: спрашиваем текст, а не молчим.
  const modifier = !!m.groups.mod || !!m.groups.noun;
  const colon = /^[ \t]*:[ \t]*([\s\S]*)$/u.exec(rest);
  if (colon) return colon[1].trim() ? { kind: "text", text: colon[1].trim() } : { kind: "ask" };
  const lineBreak = /^[ \t]*\r?\n([\s\S]*)$/u.exec(rest);
  if (lineBreak) return lineBreak[1].trim() ? { kind: "text", text: lineBreak[1].trim() } : modifier ? { kind: "ask" } : { kind: "bare" };
  if (!rest.trim() || /^[\s.!?]*$/u.test(rest)) return modifier ? { kind: "ask" } : { kind: "bare" };
  if (modifier && /^[ \t]/u.test(rest)) {
    const text = rest.replace(/^[ \t]*[,—–-]?[ \t]*/u, "").trim();
    if (!text) return { kind: "ask" };
    // «озвучь дословно последний ответ», «озвучь текст объявления ОБ-12»: короткий хвост про ответ или объект это вопрос помощнику.
    if (text.split(/\s+/u).length < 5 && /ответ|ОБ-?\s?\d|объявлени/iu.test(text)) return null;
    return { kind: "text", text };
  }
  return null;
}

/**
 * ДЛИННЫЙ ТЕКСТ «ДЛЯ ОЗВУЧКИ», КОТОРЫЙ НЕ ПОПАЛ В УЗКИЙ РАЗБОР ВЫШЕ (17.11.2026).
 * Журнал прода: длинная диктовка текста для озвучки ушла помощнице, модель 23 секунды ходила по
 * инструментам с адресами и ценами из текста и упала на пределе попыток (attempt_limit).
 * Голосом текст для озвучки не принимается намеренно (читается слово в слово, а расшифровка
 * ошибается), а набранный без «Озвучь текст:» угадывать опасно (в озвучку уйдёт и сама просьба).
 * Поэтому такой текст модели не отдаётся: человек получает подсказку, как прислать, без трат.
 * Признак: слово про озвучку в начале (первые 80 знаков) и дальше длинный текст (от 15 слов).
 */
// Только просьба («озвучь», «озвучить», «для озвучки»), а не слово «озвучка» в жалобе.
const DICTATION_CUE = /(?<![\p{L}\p{N}])(?:озвучь(?:те)?|озвучить|(?:для|на)\s+озвучк\p{L}*|овоз(?:онӣ|они)?\s+(?:кун(?:ед)?|диҳед|деҳ)|матнро\s+овоз\p{L}*|барои\s+овоз\p{L}*|ovoz\s+kun\p{L}*)(?![\p{L}\p{N}])/iu;

export function looksLikeNarrationDictation(text: string): boolean {
  const cue = DICTATION_CUE.exec(text);
  if (!cue || cue.index > 80) return false;
  const rest = text.slice(cue.index + cue[0].length).trim();
  return rest.split(/\s+/u).filter(Boolean).length >= 15;
}

/** Подсказка вместо хода модели. fromVoice — текст пришёл голосом: его возвращаем, чтобы поправить и прислать. */
export function narrationDictationReply(lang: Lang, fromVoice: boolean): string {
  if (lang === "tg") {
    return fromVoice
      ? "Матни овозониро бо паём фиристед, на бо овоз: он калима ба калима хонда мешавад, аммо овозро хато навишта метавонам. Аввал «Матнро овоз кун:» нависед, баъд худи матн. Он чи ман шунидам, дар паёми поён аст — нусха гиред ва ислоҳ кунед."
      : "Барои овозонӣ аввал «Матнро овоз кун:» нависед ва баъди ду нуқта худи матнро. Ҳамон тавр, калима ба калима мехонам.";
  }
  return fromVoice
    ? "Текст для озвучки пришлите сообщением, не голосом: он читается слово в слово, а расшифровка ошибается. Начните со слов «Озвучь текст:» и дальше сам текст. Что я расслышала — ниже, можно скопировать и поправить."
    : "Чтобы озвучить, начните сообщение со слов «Озвучь текст:» и после двоеточия вставьте сам текст. Прочитаю слово в слово выбранным голосом.";
}

/**
 * КОРОТКАЯ ПРОСЬБА «ОЗВУЧЬ» БЕЗ ТЕКСТА — обычно голосом (23.11.2026, жалоба владельца: «ИИ в Шабнам не
 * озвучивает любой мой текст»). Он сказал «озвучь…» голосом и следом вставил рекламный текст без
 * слов-пароля; просьба ушла модели, а та ответила «пришлите данные по объекту». Теперь такая просьба
 * открывает ожидание текста (как «Озвучь текст» без текста), и следующий набранный текст читается слово
 * в слово. Узко: про объект, ответ, шаблон, статус и жалобы («озвучка не работает») — это вопрос
 * помощнице, а не просьба озвучить свой текст; длинное — уже разбор диктовки выше.
 */
const SHORT_ASK = /(?<![\p{L}\p{N}])(?:озвуч(?:ь|ьте|и|ить|ите)|(?:нужн[аоы]|сделай(?:те)?|хочу|надо|можешь\s+сделать|можете\s+сделать)\s+(?:мне\s+)?(?:рекламн\p{L}*\s+)?озвучк\p{L}*|овоз(?:онӣ|они)?\s+(?:кун(?:ед)?|деҳ|дех|диҳед|дихед)|овоз(?:онӣ|они)?\s+(?:лозим|даркор)|мехоҳам\s+овоз\p{L}*)(?![\p{L}\p{N}])/iu;
const NOT_A_BARE_ASK = /ОБ-?\s?\d|\d{3,}|объект|объявлени|ответ|шаблон|образц|статус|не\s+(?:работает|делает|могу|получается)|почему|ошибк|сбой|мушкил|чаро/iu;

// «озвучь это», «озвучь, пожалуйста» — нечего озвучивать, кроме прошлого ответа помощницы.
const CUE_ONLY = /^(?:шабнам[\s,:!-]*)?озвуч\p{L}*(?:[\s,.!?]+(?:это|его|её|ее|пожалуйста|лутфан))*[\s.!?]*$/iu;

export function isBareNarrationAsk(text: string): boolean {
  const t = text.trim();
  if (CUE_ONLY.test(t)) return false;
  const words = t.split(/\s+/u).filter(Boolean).length;
  // Одно слово («озвучь») — «озвучь последний ответ» помощницы, а не просьба про свой текст.
  if (!t || t.length > 200 || words < 2 || words >= 15) return false;
  return SHORT_ASK.test(t) && !NOT_A_BARE_ASK.test(t);
}

/** Открывает ожидание текста и отдаёт ответ человеку: «пришлите текст» либо честная причина отказа (права, рубильник, настройка). */
export async function startFreeNarrationFromAsk(agentId: string, chatId: string, lang: Lang): Promise<string> {
  const started = await startFreeNarrationTextWait(agentId, chatId);
  const c = copy[lang];
  return started === "OK" ? c.ask : started === "OFF" ? c.off : started === "NOT_CONFIGURED" ? c.notConfigured : c.noAccess;
}

const CANCEL_WORDS =/^(?:отмена|отменить|бекор|бекор кун)[.!]?$/iu;

const copy = {
  ru: {
    noAccess: "У вас нет доступа к озвучке текста.",
    off: "Озвучка текста сейчас выключена в настройках.",
    notConfigured: "Озвучка пока не настроена: нет голосов или ключа. Напишите руководителю.",
    tooShort: "Текст слишком короткий.",
    tooLong: (max: number, len: number) => `Текст длиннее ${max} знаков (у вас ${len}). Сократите его или пришлите частями.`,
    ask: "Хорошо. Пришлите текст одним сообщением (можно и голосом: я покажу, что расслышала, и вы поправите). Чтобы отменить, напишите «отмена».",
    voiceOnly: "Пришлите, пожалуйста, текст сообщением, а не голосом.",
    adAsk: "Хорошо, напишу. Пришлите факты одним сообщением: название, район, цена, главные плюсы, контакты, если нужны. Я возьму только их, ничего не добавлю от себя. Чтобы отменить, напишите «отмена».",
    adShort: "Фактов маловато для текста. Пришлите название, район, цену и главные плюсы одним сообщением.",
    adWorking: "⏳ Пишу текст из ваших фактов…",
    adHead: (chars: number) => `Вот текст (${chars} знаков), только из ваших фактов. Проверьте цифры и названия. Если всё верно, нажмите «Озвучить».`,
    adUnsafe: "Не получилось написать текст так, чтобы в нём были только ваши факты. Пришлите факты чуть подробнее или готовый текст через «Озвучь текст:».",
    adBusy: "Сейчас не получается написать текст: у помощницы дневной предел. Попробуйте позже или пришлите готовый текст через «Озвучь текст:».",
    adRewriteLimit: "Текст уже переписывали несколько раз. Нажмите «Править» и пришлите свой вариант.",
    voiceDraftHead: (chars: number) => `Я расслышала так (${chars} знаков). Озвучка читает слово в слово, поэтому проверьте текст. Если всё верно, нажмите «Озвучить как есть».`,
    editAsk: "Хорошо. Пришлите исправленный текст одним сообщением, набранным. Чтобы отменить, напишите «отмена».",
    offerHead: (chars: number) => `Могу озвучить этот текст слово в слово (${chars} знаков).`,
    textHead: (chars: number) => `Принят текст (${chars} знаков), просьбу «озвучь» я убрала. Читается слово в слово. Если всё верно, нажмите «Озвучить как есть».`,
    heardNothing: "Не удалось расслышать текст. Пришлите его сообщением.",
    b2: { ok: "🎙 Озвучить", asIs: "🎙 Озвучить как есть", offer: "🎙 Озвучить этот текст", edit: "✏️ Править", fix: "✏️ Исправить (пришлю текстом)", rewrite: "🔄 Переписать" },
    cancelled: "Отменено.",
    head: (chars: number, lang: string) => `Текст принят: ${chars} знаков, язык: ${lang}. Выберите голос, он прочитает слово в слово.`,
    langName: { ru: "русский", tg: "таджикский", none: "не определён, читаю как есть" },
    samples: "Образцы голосов: одна и та же фраза. Послушайте и выберите ниже.",
    b: { resend: "📎 Прислать файл", samples: "🎧 Послушать образцы", cancel: "✖️ Отмена", def: "по умолчанию", last: "последний раз выбран", male: "муж.", female: "жен." },
    preparing: "⏳ Готовлю озвучку…",
    caption: (voice: string, chars: number) => `Озвучка для монтажа, голос ${voice}, ${chars} знаков`,
    limitPerson: (limit: number) => `Сегодня вы уже сделали ${limit} озвучек. Остальное завтра.`,
    budget: "Общий дневной предел озвучки исчерпан. Попробуйте завтра.",
    running: "Эта озвучка уже готовится, подождите минуту.",
    failed: "Не получилось. Пришлите текст ещё раз чуть позже.",
    quota: "Кредиты ElevenLabs закончились. Сообщите руководителю.",
    stale: "Этот запрос устарел. Пришлите текст заново.",
    voiceChanged: "Список голосов обновился. Пришлите текст заново.",
    fileLost: "Озвучка готова, но файл не отправился. Нажмите «Прислать файл», повторно платить не придётся.",
  },
  tg: {
    noAccess: "Шумо ба овозонии матн дастрасӣ надоред.",
    off: "Овозонии матн ҳоло дар танзимот хомӯш аст.",
    notConfigured: "Овозонӣ ҳоло танзим нашудааст: овоз ё калид нест. Ба роҳбар нависед.",
    tooShort: "Матн хеле кӯтоҳ аст.",
    tooLong: (max: number, len: number) => `Матн аз ${max} аломат дарозтар аст, шумо ${len} аломат навиштед. Онро кӯтоҳ кунед ё қисм-қисм фиристед.`,
    ask: "Хуб. Матнро бо як паём фиристед (бо овоз ҳам мешавад: ман он чи шунидамро нишон медиҳам, шумо ислоҳ мекунед). Барои бекор кардан «бекор» нависед.",
    voiceOnly: "Матнро, лутфан, бо паём фиристед, на бо овоз.",
    adAsk: "Хуб, менависам. Далелҳоро бо як паём фиристед: ном, маҳалла, нарх, афзалиятҳои асосӣ ва, агар лозим бошад, тамос. Ман танҳо ҳамонҳоро мегирам, аз худам чизе илова намекунам. Барои бекор кардан «бекор» нависед.",
    adShort: "Барои матн далелҳо кам аст. Ном, маҳалла, нарх ва афзалиятҳои асосиро бо як паём фиристед.",
    adWorking: "⏳ Аз далелҳои шумо матн менависам…",
    adHead: (chars: number) => `Ин матн (${chars} аломат), танҳо аз далелҳои шумо. Рақамҳо ва номҳоро санҷед. Агар ҳама дуруст бошад, «Овоз додан»-ро пахш кунед.`,
    adUnsafe: "Матнро чунин навишта натавонистам, ки танҳо далелҳои шумо дар он бошанд. Далелҳоро муфассалтар фиристед ё матни тайёрро бо «Матнро овоз кун:» диҳед.",
    adBusy: "Ҳоло навиштани матн намешавад: ҳадди рӯзонаи ёрдамчӣ тамом шуд. Баъдтар кӯшиш кунед ё матни тайёрро бо «Матнро овоз кун:» фиристед.",
    adRewriteLimit: "Матн якчанд бор аз нав навишта шуд. «Ислоҳ»-ро пахш кунед ва варианти худро фиристед.",
    voiceDraftHead: (chars: number) => `Ман чунин шунидам (${chars} аломат). Овозонӣ калима ба калима мехонад, барои ҳамин матнро санҷед. Агар ҳама дуруст бошад, «Айнан овоз диҳед»-ро пахш кунед.`,
    editAsk: "Хуб. Матни ислоҳшударо бо як паём, навишта фиристед. Барои бекор кардан «бекор» нависед.",
    offerHead: (chars: number) => `Ин матнро калима ба калима овоз дода метавонам (${chars} аломат).`,
    textHead: (chars: number) => `Матн қабул шуд (${chars} аломат), хоҳиши «овоз кун»-ро хориҷ кардам. Калима ба калима хонда мешавад. Агар ҳама дуруст бошад, «Айнан овоз диҳед»-ро пахш кунед.`,
    heardNothing: "Матнро шунида натавонистам. Онро бо паём фиристед.",
    b2: { ok: "🎙 Овоз додан", asIs: "🎙 Айнан овоз диҳед", offer: "🎙 Ин матнро овоз диҳед", edit: "✏️ Ислоҳ", fix: "✏️ Ислоҳ (бо матн мефиристам)", rewrite: "🔄 Аз нав навиштан" },
    cancelled: "Бекор шуд.",
    head: (chars: number, lang: string) => `Матн қабул шуд: ${chars} аломат, забон: ${lang}. Овозро интихоб кунед, он айнан мехонад.`,
    langName: { ru: "русӣ", tg: "тоҷикӣ", none: "муайян нашуд, ҳамон тавр мехонам" },
    samples: "Намунаи овозҳо: ҳамон як ҷумла. Гӯш кунед ва дар поён интихоб кунед.",
    b: { resend: "📎 Файлро фиристед", samples: "🎧 Намунаҳоро гӯш кунед", cancel: "✖️ Бекор", def: "асосӣ", last: "бори охир интихоб шуд", male: "мард", female: "зан" },
    preparing: "⏳ Овоз тайёр мешавад…",
    caption: (voice: string, chars: number) => `Овоз барои монтаж, овози ${voice}, ${chars} аломат`,
    limitPerson: (limit: number) => `Имрӯз шумо аллакай ${limit} бор овозонӣ кардед. Боқӣ фардо.`,
    budget: "Лимити умумии овозонии имрӯз тамом шуд. Фардо боз кӯшиш кунед.",
    running: "Ин овоз аллакай тайёр мешавад, як дақиқа интизор шавед.",
    failed: "Нашуд. Матнро баъдтар боз фиристед.",
    quota: "Кредитҳои ElevenLabs тамом шуданд. Ба роҳбар хабар диҳед.",
    stale: "Ин дархост кӯҳна шуд. Матнро аз нав фиристед.",
    voiceChanged: "Рӯйхати овозҳо навсозӣ шуд. Матнро аз нав фиристед.",
    fileLost: "Овоз тайёр аст, аммо файл нарафт. «Файлро фиристед»-ро пахш кунед, бори дуюм пул намеравад.",
  },
} as const;

const voiceHash = (voiceId: string) => createHash("sha1").update(voiceId).digest("hex").slice(0, 4);
const langLabel = (lang: Lang, value: string | null) => copy[lang].langName[value === "tg" ? "tg" : value === "ru" ? "ru" : "none"];

/** Голос по умолчанию первым (настройка владельца), «последний раз выбран» — отметкой. Индекс — в config.voices. */
function voiceButtons(row: FreeNarrationRow, config: NarrationConfig, lang: Lang, lastVoiceId: string | undefined): TelegramInlineButton[][] {
  const c = copy[lang];
  const defaultId = pickNarrationVoice(config);
  const ordered = config.voices.map((v, index) => ({ v, index })).sort((a, b) => Number(b.v.id === defaultId) - Number(a.v.id === defaultId));
  const rows: TelegramInlineButton[][] = ordered.slice(0, MAX_VOICE_BUTTONS).map(({ v, index }) => {
    const marks = [v.gender ? c.b[v.gender] : "", v.id === defaultId ? c.b.def : "", v.id === lastVoiceId ? c.b.last : ""].filter(Boolean);
    return [{ text: marks.length ? `${v.name} · ${marks.join(" · ")}` : v.name, callback_data: `fnr:p:${row.id}:${index}:${voiceHash(v.id)}` }];
  });
  rows.push([
    { text: `${row.lang === "ru" ? "✓ " : ""}Русский`, callback_data: `fnr:l:${row.id}:ru` },
    { text: `${row.lang === "tg" ? "✓ " : ""}Тоҷикӣ`, callback_data: `fnr:l:${row.id}:tg` },
  ]);
  rows.push([{ text: c.b.samples, callback_data: `fnr:s:${row.id}` }, { text: c.b.cancel, callback_data: `fnr:x:${row.id}` }]);
  return rows;
}

async function showChoices(chatId: string, row: FreeNarrationRow, lang: Lang, edit?: { messageId: number }): Promise<void> {
  const { config } = await loadNarrationConfiguration();
  const last = await narrationLastChoiceFor(row.agentId, config);
  const text = copy[lang].head(row.script.length, langLabel(lang, row.lang));
  const buttons = voiceButtons(row, config, lang, last.voiceId);
  if (edit) await editMessageText(chatId, edit.messageId, text, buttons);
  else await sendMessageWithButtons(chatId, text, buttons);
}

function failureText(outcome: FreeNarrationRunOutcome, lang: Lang): string | null {
  const c = copy[lang];
  switch (outcome.status) {
    case "NO_ACCESS": return c.noAccess;
    case "OFF": return c.off;
    case "NOT_CONFIGURED": return c.notConfigured;
    case "BUDGET": return c.budget;
    case "LIMIT_PERSON": return c.limitPerson(outcome.limit);
    case "ALREADY_RUNNING": return c.running;
    case "GONE": case "VOICE_UNKNOWN": case "ALREADY_FAILED": return c.stale;
    case "FAILED": return outcome.quota ? c.quota : c.failed;
    default: return null;
  }
}

async function createAndShow(chatId: string, agentId: string, text: string, lang: Lang): Promise<void> {
  const c = copy[lang];
  const outcome = await createFreeNarrationRequest({ agentId, source: "TELEGRAM", chatId, text });
  if (outcome.status === "CREATED" || outcome.status === "EXISTS") { await showChoices(chatId, outcome.row, lang); return; }
  await sendMessage(chatId, outcome.status === "NO_ACCESS" ? c.noAccess : outcome.status === "OFF" ? c.off : outcome.status === "NOT_CONFIGURED" ? c.notConfigured
    : outcome.status === "TOO_SHORT" ? c.tooShort : outcome.status === "TOO_LONG" ? c.tooLong(outcome.max, outcome.length) : c.failed);
}

const DRAFT_PREVIEW_MAX = 3500;

function draftButtons(rowId: string, kind: FreeNarrationDraftKind, lang: Lang): TelegramInlineButton[][] {
  const c = copy[lang];
  if (kind === "OFFER") return [[{ text: c.b2.offer, callback_data: `fnr:o:${rowId}` }, { text: c.b.cancel, callback_data: `fnr:x:${rowId}` }]];
  if (kind === "AD") {
    return [
      [{ text: c.b2.ok, callback_data: `fnr:o:${rowId}` }, { text: c.b2.edit, callback_data: `fnr:e:${rowId}` }],
      [{ text: c.b2.rewrite, callback_data: `fnr:r:${rowId}` }, { text: c.b.cancel, callback_data: `fnr:x:${rowId}` }],
    ];
  }
  return [[{ text: c.b2.asIs, callback_data: `fnr:o:${rowId}` }], [{ text: c.b2.fix, callback_data: `fnr:e:${rowId}` }, { text: c.b.cancel, callback_data: `fnr:x:${rowId}` }]];
}

function draftText(row: FreeNarrationRow, kind: FreeNarrationDraftKind, lang: Lang): string {
  const c = copy[lang];
  if (kind === "OFFER") return c.offerHead(row.script.length);
  return `${kind === "AD" ? c.adHead(row.script.length) : kind === "TEXT" ? c.textHead(row.script.length) : c.voiceDraftHead(row.script.length)}\n\n${row.script}`;
}

/** Черновик целиком (текст длиннее лимита Telegram идёт частями, кнопки под последней: человек подтверждает всё, что видел). */
async function sendDraft(chatId: string, row: FreeNarrationRow, kind: FreeNarrationDraftKind, lang: Lang): Promise<void> {
  const buttons = draftButtons(row.id, kind, lang);
  const text = draftText(row, kind, lang);
  if (text.length <= DRAFT_PREVIEW_MAX) { await sendMessageWithButtons(chatId, text, buttons); return; }
  const parts = text.match(/[\s\S]{1,3500}/gu) ?? [text];
  for (const part of parts.slice(0, -1)) await sendMessage(chatId, part);
  await sendMessageWithButtons(chatId, parts[parts.length - 1], buttons);
}

/** Черновик текста со своим набором кнопок. Деньги ElevenLabs до «Озвучить» не тратятся. */
async function createDraftAndShow(chatId: string, agentId: string, text: string, kind: FreeNarrationDraftKind, lang: Lang, facts?: string): Promise<boolean> {
  const c = copy[lang];
  const outcome = await createFreeNarrationDraft({ agentId, chatId, text, kind, facts });
  if (outcome.status === "CREATED") { await sendDraft(chatId, outcome.row, kind, lang); return true; }
  if (kind === "OFFER") return false;
  await sendMessage(chatId, outcome.status === "NO_ACCESS" ? c.noAccess : outcome.status === "OFF" ? c.off : outcome.status === "NOT_CONFIGURED" ? c.notConfigured
    : outcome.status === "TOO_SHORT" ? c.tooShort : outcome.status === "TOO_LONG" ? c.tooLong(outcome.max, outcome.length) : c.failed);
  return false;
}

/** Расшифровка голосового как текст озвучки: показать и спросить, деньги не тратятся (23.11.2026). */
export async function showVoiceNarrationDraft(chatId: string, agentId: string, heardText: string, lang: Lang, kind: "VOICE" | "TEXT" = "VOICE"): Promise<void> {
  await createDraftAndShow(chatId, agentId, heardText, kind, lang);
}

/** Текст после слова-просьбы в расшифровке длинной диктовки («озвучь, …текст…»); без просьбы в начале — как есть. */
export function narrationBodyAfterCue(text: string): string {
  const cue = DICTATION_CUE.exec(text);
  if (!cue || cue.index > 80) return text.trim();
  // «озвучь вот это: …», «озвучь этот текст …»: слова-указатели тоже часть просьбы.
  return text.slice(cue.index + cue[0].length).replace(/^[\s,:;.!?—–-]+/u, "").replace(/^(?:(?:вот\s+это|вот\s+так|вот|это|этот\s+текст|текст)(?![\p{L}\p{N}])[\s,:;.!?—–-]*)+/iu, "").trim();
}

function adFailureText(result: Exclude<AdScriptResult, { status: "OK" }>, lang: Lang): string {
  return result.status === "UNAVAILABLE" ? copy[lang].adBusy : copy[lang].adUnsafe;
}

/** Модель пишет сценарий из фактов. Денежный предел или обрыв — понятный отказ, а не молчание. */
async function writeAd(facts: string, wallet: AssistantMoneyWallet, maxChars: number, extra?: { variant: number; avoid: string }): Promise<AdScriptResult> {
  try {
    return await generateAdScript({ facts, wallet, maxChars, variant: extra?.variant, avoid: extra?.avoid });
  } catch (err) {
    void logSystemError("telegram", `Рекламный текст для озвучки не написан: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "free-narration-ad-script" });
    return { status: "UNAVAILABLE" };
  }
}

async function adAllowed(agentId: string): Promise<"OK" | "NO_ACCESS" | "OFF" | "NOT_CONFIGURED"> {
  if (!await canUseFreeNarration(agentId)) return "NO_ACCESS";
  // Выключенная помощница не зовёт Gemini и для рекламного текста.
  if (!await isAiAssistantEnabled()) return "OFF";
  const { config, key } = await loadNarrationConfiguration();
  if (!freeNarrationAdTextEnabled(config)) return "OFF";
  return key ? "OK" : "NOT_CONFIGURED";
}

/** Факты у нас: пишем текст и показываем черновик (деньги ElevenLabs не тратятся). */
async function writeAdAndShow(chatId: string, agentId: string, facts: string, lang: Lang, wallet: AssistantMoneyWallet): Promise<void> {
  const c = copy[lang];
  if (!adFactsUsable(facts)) { await sendMessage(chatId, c.adShort); return; }
  // Права, рубильники и ключ проверяются ДО Gemini (ожидание фактов могло пережить смену настроек).
  const allowed = await adAllowed(agentId);
  if (allowed !== "OK") { await sendMessage(chatId, allowed === "NO_ACCESS" ? c.noAccess : allowed === "OFF" ? c.off : c.notConfigured); return; }
  await sendMessage(chatId, c.adWorking);
  void sendChatAction(chatId).catch(() => {});
  const { config } = await loadNarrationConfiguration();
  const result = await writeAd(facts, wallet, freeNarrationLimits(config).maxChars);
  if (result.status !== "OK") { await sendMessage(chatId, adFailureText(result, lang)); return; }
  await createDraftAndShow(chatId, agentId, result.script, "AD", lang, facts);
}

/**
 * «Сделай рекламный текст и озвучь» (23.11.2026): true — сообщение наше. Факты в самой просьбе: пишем сразу;
 * без фактов: ждём их следующим сообщением (метка AD). Рубильник «рекламный текст» выключен: false, и просьба идёт дальше как раньше.
 */
export async function handleAdTextRequest(chatId: string, agentId: string, text: string, lang: Lang, wallet: AssistantMoneyWallet = createAssistantMoneyWallet()): Promise<boolean> {
  const request = parseAdTextRequest(text);
  if (!request) return false;
  const allowed = await adAllowed(agentId);
  const c = copy[lang];
  if (allowed === "OFF") return false;
  if (allowed !== "OK") { await sendMessage(chatId, allowed === "NO_ACCESS" ? c.noAccess : c.notConfigured); return true; }
  try {
    if (!request.facts) {
      const started = await startFreeNarrationTextWait(agentId, chatId, "AD");
      await sendMessage(chatId, started === "OK" ? c.adAsk : started === "OFF" ? c.off : started === "NOT_CONFIGURED" ? c.notConfigured : c.noAccess);
      return true;
    }
    await writeAdAndShow(chatId, agentId, request.facts, lang, wallet);
  } catch (err) {
    void logSystemError("telegram", `Рекламный текст в Шабнам: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "free-narration-ad-message" });
    await sendMessage(chatId, c.failed).catch(() => {});
  }
  return true;
}

/**
 * КНОПКА «ОЗВУЧИТЬ ЭТОТ ТЕКСТ» ПОД ДЛИННЫМ СООБЩЕНИЕМ БЕЗ «озвучь» (23.11.2026). Вызывается после ответа помощницы
 * на набранное (не голос, не пересланное, не файл) сообщение, не взятое другими обработчиками. Показываем только на
 * сообщение, похожее на готовый текст: от 30 слов, без вопроса, не начинается с команды помощнице; не чаще раза в пять минут.
 * Сам текст не пересылается: кнопка держит черновик (OFFER) в базе, нажатие ведёт к обычному выбору голоса.
 */
export const OFFER_MIN_WORDS = 30;
const COMMAND_START = /^\s*(?:шабнам[\s,:!-]*)?(?:пожалуйста[\s,]*)?(?:найди|покажи|внеси|добавь|создай|запиши|измени|поменяй|удали|поставь|сделай|напиши|отправь|скажи|ответь|проверь|подскажи|помоги|посчитай|объясни|расскажи|сколько|как|что|где|когда|почему|зачем|можно|можешь|а\s|и\s|нишон\s+деҳ|навис|ҷавоб\s+деҳ|санҷ|кумак\s+кун|бигӯ|чанд|чӣ|чӣ\s+хел|кай|куҷо|чаро)(?![\p{L}\p{N}])/iu;
export function looksLikeOfferableText(text: string): boolean {
  const t = text.trim();
  if (t.startsWith("/") || /[?？]/u.test(t) || COMMAND_START.test(t)) return false;
  return t.split(/\s+/u).filter(Boolean).length >= OFFER_MIN_WORDS;
}

export async function offerNarrationButton(chatId: string, agentId: string, text: string, lang: Lang): Promise<boolean> {
  if (!looksLikeOfferableText(text)) return false;
  if (!await canUseFreeNarration(agentId)) return false;
  const { config, key } = await loadNarrationConfiguration();
  if (!freeNarrationOfferEnabled(config) || !key || text.trim().length > freeNarrationLimits(config).maxChars) return false;
  // Не чаще раза в 15 минут и никогда поверх чужого открытого черновика или ожидания текста.
  const busy = await prisma.freeNarration.findFirst({ where: { chatId, status: { in: ["DRAFT", "AWAITING_TEXT"] }, createdAt: { gte: new Date(Date.now() - 15 * 60_000) } }, select: { id: true } });
  if (busy) return false;
  return createDraftAndShow(chatId, agentId, text.trim(), "OFFER", lang);
}

export type FreeNarrationTranscriber = (msg: TelegramIncomingMessage) => Promise<{ text: string } | { error: string }>;

/**
 * Личный чат: true — сообщение наше (просьба «озвучь» или текст после неё). false — обычное сообщение,
 * дальше работает помощник. Пересланное сообщение принимается только как текст, которого мы уже ждём.
 * Голос в ожидании текста (23.11.2026) расшифровывается и показывается черновиком: озвучка читает слово в слово,
 * а расшифровка ошибается, поэтому деньги не тратятся, пока человек не подтвердил текст.
 */
export async function handleFreeNarrationMessage(msg: TelegramIncomingMessage, agent: { id: string }, forwarded = false, transcribe?: FreeNarrationTranscriber, wallet?: AssistantMoneyWallet): Promise<boolean> {
  if (msg.chat.type !== "private") return false;
  const chatId = String(msg.chat.id);
  const text = (forwarded ? msg.text ?? msg.caption ?? "" : msg.text ?? "").trim();
  const trigger = !forwarded && text ? parseFreeNarrationTrigger(text) : null;
  const waitMode = await pendingFreeNarrationTextWaitMode(agent.id, chatId);
  const waiting = waitMode !== null;
  const lang = await chatLang(chatId);
  const c = copy[lang];
  try {
    if (waiting && !trigger) {
      if (!text) {
        if (!(msg.voice || msg.audio)) return false;
        if (!transcribe) { await sendMessage(chatId, c.voiceOnly); return true; }
        const heard = await transcribe(msg).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
        const heardText = "text" in heard ? heard.text.trim() : "";
        if (!heardText) { await sendMessage(chatId, ("error" in heard && heard.error) || c.heardNothing); return true; }
        if (CANCEL_WORDS.test(heardText)) { await clearFreeNarrationTextWait(chatId); await sendMessage(chatId, c.cancelled); return true; }
        if (waitMode === "AD") await writeAdAndShow(chatId, agent.id, heardText, lang, wallet ?? createAssistantMoneyWallet());
        else await showVoiceNarrationDraft(chatId, agent.id, heardText, lang);
        return true;
      }
      if (text.startsWith("/")) { await clearFreeNarrationTextWait(chatId); return false; }
      if (CANCEL_WORDS.test(text)) { await clearFreeNarrationTextWait(chatId); await sendMessage(chatId, c.cancelled); return true; }
      // Ожидание фактов не забирает обычные вопросы и команды помощнице: они идут дальше как всегда.
      if (waitMode === "AD" && (COMMAND_START.test(text) || /[?？]\s*$/u.test(text))) { await clearFreeNarrationTextWait(chatId); return false; }
      if (waitMode === "AD") { await writeAdAndShow(chatId, agent.id, text, lang, wallet ?? createAssistantMoneyWallet()); return true; }
      await createAndShow(chatId, agent.id, text, lang);
      return true;
    }
    if (!trigger) return false;
    if (trigger.kind === "text") { await createAndShow(chatId, agent.id, trigger.text, lang); return true; }
    // «озвучь» ответом на текст самого сотрудника (ответ на сообщение бота остаётся «озвучь ответ» помощника).
    const replied = msg.reply_to_message;
    const repliedText = replied && replied.from?.is_bot !== true ? (replied.text ?? replied.caption ?? "").trim() : "";
    if (repliedText) { await createAndShow(chatId, agent.id, repliedText, lang); return true; }
    if (trigger.kind === "bare") return false;
    // Права и рубильник проверяются до просьбы прислать текст.
    const started = await startFreeNarrationTextWait(agent.id, chatId);
    await sendMessage(chatId, started === "OK" ? c.ask : started === "OFF" ? c.off : started === "NOT_CONFIGURED" ? c.notConfigured : c.noAccess);
    return true;
  } catch (err) {
    void logSystemError("telegram", `Озвучка текста в Шабнам: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "free-narration-message" });
    await sendMessage(chatId, c.failed).catch(() => {});
    return true;
  }
}

const CALLBACK = /^fnr:(p|l|x|s|o|e|r):([\da-f-]{36})(?::([a-z\d]{1,4}))?(?::([\da-f]{4}))?$/u;

/** `fnr:p|l|x|s:<запрос>…`. true — это наша кнопка. */
export async function handleFreeNarrationCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const match = CALLBACK.exec(query.data ?? "");
  if (!match) return false;
  const answer = (text?: string) => answerCallbackQuery(query.id, text).catch(() => {});
  const chat = query.message?.chat;
  if (chat?.type !== "private" || query.from?.id !== chat.id) { await answer(); return true; }
  // Повторная доставка того же нажатия не исполняется заново.
  if (!await claimCallback(query.id)) { await answer(); return true; }
  const chatId = String(chat.id);
  const lang = await chatLang(chatId);
  const c = copy[lang];
  const messageId = query.message?.message_id;
  const [, action, id, arg, hash] = match;
  try {
    const agent = await findAgentByTelegramChatId(chatId);
    const row = await prisma.freeNarration.findUnique({ where: { id } });
    if (!agent || !row || row.agentId !== agent.id) { await answer(c.stale); return true; }
    if (action === "o" || action === "e" || action === "r") { await handleDraftAction(action, id, agent.id, chatId, messageId, query.message?.text ?? "", lang, answer); return true; }
    if (action === "x") {
      await cancelFreeNarration(id, agent.id);
      await answer(c.cancelled);
      if (messageId) await editMessageText(chatId, messageId, c.cancelled, null).catch(() => {});
      return true;
    }
    if (action === "l") {
      if (arg !== "ru" && arg !== "tg") { await answer(c.stale); return true; }
      if (!await setFreeNarrationLang(id, agent.id, arg)) { await answer(c.stale); return true; }
      await answer();
      const fresh = await prisma.freeNarration.findUnique({ where: { id } });
      if (fresh && messageId) await showChoices(chatId, fresh, lang, { messageId }).catch(() => {});
      return true;
    }
    if (action === "s") {
      await answer();
      const { config } = await loadNarrationConfiguration();
      await sendVoiceSamples(chatId, config, row.lang === "tg" ? "tg" : "ru", c.samples);
      return true;
    }
    // action === "p": выбор голоса — платный шаг.
    const { config } = await loadNarrationConfiguration();
    const voice = config.voices[Number(arg)];
    if (!voice || voiceHash(voice.id) !== hash) { await answer(c.voiceChanged); return true; }
    const retryData = query.data ?? "";
    if (row.status === "READY") { await answer(); await deliver(chatId, row, voice.name, lang, undefined, retryData); return true; }
    await answer(c.preparing);
    // Занять запись быстро, а вызов ElevenLabs и отправку файла (до двух минут) вынести из обработчика:
    // очередь входящих у бота одна на все чаты, долгий обработчик остановил бы их всех.
    const claimed = await claimFreeNarration({ id, agentId: agent.id, voiceId: voice.id });
    if (claimed.status === "ALREADY_READY") { await deliver(chatId, claimed.row, voice.name, lang, undefined, retryData); return true; }
    if (claimed.status !== "CLAIMED") {
      const text = failureText(claimed, lang) ?? c.failed;
      if (messageId && (claimed.status === "LIMIT_PERSON" || claimed.status === "BUDGET")) await editMessageText(chatId, messageId, text, null).catch(() => {});
      else await sendMessage(chatId, text);
      return true;
    }
    if (messageId) await editMessageText(chatId, messageId, `${query.message?.text ?? ""}\n\n${c.preparing}`, null).catch(() => {});
    void trackBackgroundTask(finishFreeNarration(chatId, claimed.claim, lang, messageId, retryData));
    return true;
  } catch (err) {
    void logSystemError("telegram", `Озвучка текста, кнопка Шабнам: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "free-narration-callback" });
    await answer(c.failed);
  }
  return true;
}

/**
 * Кнопки черновика: o — «Озвучить» (черновик становится заявкой, дальше выбор голоса), e — «Править / Исправить»
 * (ждём исправленный текст набранным), r — «Переписать» (только рекламный текст; Gemini в фоне, чтобы не держать общую очередь).
 */
async function handleDraftAction(action: "o" | "e" | "r", id: string, agentId: string, chatId: string, messageId: number | undefined, shownText: string, lang: Lang, answer: (text?: string) => Promise<unknown>): Promise<void> {
  const c = copy[lang];
  const draft = await loadFreeNarrationDraft(id, agentId);
  if (!draft) { await answer(c.stale); return; }
  if (action === "o") {
    if (draft.busy) { await answer(c.adWorking); return; }
    const row = await confirmFreeNarrationDraft(id, agentId);
    if (!row) { await answer(c.stale); return; }
    await answer();
    // Текст черновика остаётся в чате (он нужен для проверки), с него только снимаются кнопки.
    if (messageId && shownText) await editMessageText(chatId, messageId, `${shownText}\n\n✓`, null).catch(() => {});
    await showChoices(chatId, row, lang);
    return;
  }
  if (action === "e") {
    await dropFreeNarrationDraft(id, agentId);
    const started = await startFreeNarrationTextWait(agentId, chatId);
    await answer();
    if (messageId && shownText) await editMessageText(chatId, messageId, shownText, null).catch(() => {});
    await sendMessage(chatId, started === "OK" ? c.editAsk : started === "OFF" ? c.off : started === "NOT_CONFIGURED" ? c.notConfigured : c.noAccess);
    return;
  }
  // r: «Переписать».
  if (draft.kind !== "AD" || !draft.facts) { await answer(c.stale); return; }
  if (draft.busy) { await answer(c.adWorking); return; }
  if (draft.row.chars >= FREE_NARRATION_AD_REWRITES_MAX) { await answer(c.adRewriteLimit); return; }
  // Занять черновик: два нажатия подряд дают одну генерацию, «Озвучить» ждёт нового текста.
  if (!await lockAdRewrite(id, agentId)) { await answer(c.adWorking); return; }
  await answer(c.adWorking);
  void trackBackgroundTask(rewriteAd(id, agentId, chatId, messageId, draft.row.script, draft.facts, draft.row.chars + 1, lang));
}

async function rewriteAd(id: string, agentId: string, chatId: string, messageId: number | undefined, previous: string, facts: string, variant: number, lang: Lang): Promise<void> {
  const c = copy[lang];
  // Черновик занят (lockAdRewrite): любой исход обязан его освободить, иначе «Озвучить» не пройдёт до уборки.
  let finished = false;
  try {
    const { config } = await loadNarrationConfiguration();
    const result = await writeAd(facts, createAssistantMoneyWallet(), freeNarrationLimits(config).maxChars, { variant, avoid: previous });
    if (result.status !== "OK") { await finishAdRewrite(id, agentId); finished = true; await sendMessage(chatId, adFailureText(result, lang)); return; }
    if (!await finishAdRewrite(id, agentId, result.script)) { finished = true; await sendMessage(chatId, c.stale); return; }
    finished = true;
    const fresh = await loadFreeNarrationDraft(id, agentId);
    if (!fresh) { await sendMessage(chatId, c.stale); return; }
    const text = draftText(fresh.row, "AD", lang);
    // Новый текст показывается целиком, кнопки под ним; старое сообщение теряет кнопки, чтобы не подтвердили не то.
    if (messageId) await editMessageText(chatId, messageId, `${previous.slice(0, 3000)}

↻`, null).catch(() => {});
    if (text.length <= DRAFT_PREVIEW_MAX && messageId) await sendMessageWithButtons(chatId, text, draftButtons(id, "AD", lang));
    else await sendDraft(chatId, fresh.row, "AD", lang);
  } catch (err) {
    if (!finished) await finishAdRewrite(id, agentId).catch(() => false);
    void logSystemError("telegram", `Рекламный текст, «Переписать» в Шабнам: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "free-narration-ad-rewrite" });
    await sendMessage(chatId, c.failed).catch(() => {});
  }
}

/** Фон: вызов ElevenLabs, отправка файла, итог в сообщении. Ошибки не уходят наружу: запись уже занята, итог должен дойти до человека. */
async function finishFreeNarration(chatId: string, claim: FreeNarrationClaim, lang: Lang, messageId: number | undefined, retryData: string): Promise<void> {
  const c = copy[lang];
  try {
    const outcome = await executeFreeNarration(claim);
    if (outcome.status === "READY") {
      await deliver(chatId, outcome.row, outcome.voiceName ?? claim.voiceName ?? "", lang, outcome.audio, retryData);
      if (messageId) await editMessageText(chatId, messageId, `✅ ${c.caption(outcome.voiceName ?? claim.voiceName ?? "", outcome.row.chars)}`, null).catch(() => {});
      return;
    }
    await sendMessage(chatId, failureText(outcome, lang) ?? c.failed);
  } catch (err) {
    void logSystemError("telegram", `Озвучка текста в Шабнам, фон: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "free-narration-background" });
    await sendMessage(chatId, c.failed).catch(() => {});
  }
}

/** Файл документом: из хранилища, а если сохранить не удалось, то прямо из памяти. Не вышло: кнопка «Прислать файл» (без новой оплаты). */
async function deliver(chatId: string, row: FreeNarrationRow, voiceName: string, lang: Lang, audio?: Buffer, retryData?: string): Promise<void> {
  const c = copy[lang];
  const lost = async () => {
    if (retryData) await sendMessageWithButtons(chatId, c.fileLost, [[{ text: c.b.resend, callback_data: retryData }]]);
    else await sendMessage(chatId, c.fileLost);
  };
  const path = await freeNarrationFilePath(row.id, row.agentId);
  const file = path ? { path } : audio;
  if (!file) { await lost(); return; }
  try {
    await sendDocumentFile(chatId, file, `ozvuchka-${row.id.slice(0, 8)}.mp3`, c.caption(voiceName, row.chars), 60_000, true);
  } catch (err) {
    void logSystemError("telegram", `Озвучка текста: файл не ушёл в Шабнам: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "free-narration-send" });
    await lost();
  }
}
