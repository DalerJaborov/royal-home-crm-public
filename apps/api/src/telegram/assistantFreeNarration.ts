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
import {
  cancelFreeNarration, claimFreeNarration, clearFreeNarrationTextWait, createFreeNarrationRequest, executeFreeNarration, freeNarrationFilePath, pendingFreeNarrationTextWait,
  setFreeNarrationLang, startFreeNarrationTextWait, type FreeNarrationClaim, type FreeNarrationRow, type FreeNarrationRunOutcome,
} from "../lib/freeNarration.js";
import { loadNarrationConfiguration } from "../lib/narrationGeneration.js";
import { narrationLastChoiceFor } from "../lib/narrationLastChoice.js";
import { findAgentByTelegramChatId } from "../lib/telegramAgentLink.js";
import { logSystemError } from "../lib/systemError.js";
import { trackBackgroundTask } from "../lib/shutdownState.js";
import { answerCallbackQuery, editMessageText, sendDocumentFile, sendMessage, sendMessageWithButtons, type TelegramCallbackQuery, type TelegramIncomingMessage, type TelegramInlineButton } from "./api.js";
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

const CANCEL_WORDS =/^(?:отмена|отменить|бекор|бекор кун)[.!]?$/iu;

const copy = {
  ru: {
    noAccess: "У вас нет доступа к озвучке текста.",
    off: "Озвучка текста сейчас выключена в настройках.",
    notConfigured: "Озвучка пока не настроена: нет голосов или ключа. Напишите руководителю.",
    tooShort: "Текст слишком короткий.",
    tooLong: (max: number, len: number) => `Текст длиннее ${max} знаков (у вас ${len}). Сократите его или пришлите частями.`,
    ask: "Хорошо. Пришлите текст одним сообщением, не голосом. Чтобы отменить, напишите «отмена».",
    voiceOnly: "Пришлите, пожалуйста, текст сообщением, а не голосом.",
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
    ask: "Хуб. Матнро бо як паём фиристед, на бо овоз. Барои бекор кардан «бекор» нависед.",
    voiceOnly: "Матнро, лутфан, бо паём фиристед, на бо овоз.",
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

/**
 * Личный чат: true — сообщение наше (просьба «озвучь» или текст после неё). false — обычное сообщение,
 * дальше работает помощник. Пересланное сообщение принимается только как текст, которого мы уже ждём.
 */
export async function handleFreeNarrationMessage(msg: TelegramIncomingMessage, agent: { id: string }, forwarded = false): Promise<boolean> {
  if (msg.chat.type !== "private") return false;
  const chatId = String(msg.chat.id);
  const text = (forwarded ? msg.text ?? msg.caption ?? "" : msg.text ?? "").trim();
  const trigger = !forwarded && text ? parseFreeNarrationTrigger(text) : null;
  const waiting = await pendingFreeNarrationTextWait(agent.id, chatId);
  const lang = await chatLang(chatId);
  const c = copy[lang];
  try {
    if (waiting && !trigger) {
      if (!text) { if (msg.voice || msg.audio) { await sendMessage(chatId, c.voiceOnly); return true; } return false; }
      if (text.startsWith("/")) { await clearFreeNarrationTextWait(chatId); return false; }
      if (CANCEL_WORDS.test(text)) { await clearFreeNarrationTextWait(chatId); await sendMessage(chatId, c.cancelled); return true; }
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

const CALLBACK = /^fnr:(p|l|x|s):([\da-f-]{36})(?::([a-z\d]{1,4}))?(?::([\da-f]{4}))?$/u;

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
