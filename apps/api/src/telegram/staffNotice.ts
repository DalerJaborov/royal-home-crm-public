import { ALWAYS_ON_KINDS, PUSH_KINDS, isMutablePushKind, type PushKind } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { describeError } from "../lib/describeError.js";
import { isKindMuted, kindLabel, mutedKindsOf, setKindMuted } from "../lib/notificationPrefs.js";
import { logSystemError } from "../lib/systemError.js";
import { findAgentByTelegramChatId, findAgentByTelegramUserId } from "../lib/telegramAgentLink.js";
import { claimCallback } from "../lib/telegramCallbackClaim.js";
import {
  answerCallbackQuery, sendHtmlMessage, type TelegramCallbackQuery, type TelegramIncomingMessage, type TelegramInlineButton,
} from "./api.js";
import { renderAssistantListHtml, type ListLang } from "./assistantList.js";
import { escapeHtml } from "./assistantReply.js";

/**
 * СООБЩЕНИЕ ПОМОЩНИЦЫ СОТРУДНИКУ ПО ЕЁ ПОЧИНУ — ОДНА ДВЕРЬ (владелец 10.11.2026).
 *
 * Всё, что Шабнам пишет сотруднику сама, а не в ответ на его просьбу, идёт
 * через sendStaffNotice. Дверь:
 *  1. требует ВИД сообщения (PushKind) — тот же, что у push CRM;
 *  2. не шлёт выключенный человеком вид (lib/notificationPrefs.ts — одна дверь
 *     с push и профилем);
 *  3. ставит под сообщением «🔕 Не присылать такое» (у неотключаемых видов —
 *     нет: безопасность выключить нельзя);
 *  4. пишет журнал StaffNotice — по нему «не присылай мне такое» ответом на
 *     сообщение или сразу после него понимает, о каком виде речь;
 *  5. dedupKey — один повод = одно сообщение, повтор тика не шлёт второй раз.
 *
 * Обход ловит сторож tests/staff-notice-one-door.test.ts: файл, который пишет
 * в telegramChatId сотрудника мимо двери, должен быть в его списке с причиной.
 */

export const MUTE_BUTTON_TEXT = "🔕 Не присылать такое";
const MUTE_PREFIX = "nm:";
const UNMUTE_PREFIX = "nu:";
/** «Нет» в вопросе «Выключить …?». */
const KEEP_DATA = "nx:";

export function muteButton(kind: PushKind): TelegramInlineButton[] {
  return [{ text: MUTE_BUTTON_TEXT, callback_data: `${MUTE_PREFIX}${kind}` }];
}

export type StaffNoticeStatus = "sent" | "muted" | "no-telegram" | "duplicate" | "failed";

export interface StaffNoticeInput {
  agentId: string;
  kind: PushKind;
  /** Готовый HTML; массив — страницы (кнопки под последней). */
  html?: string | string[];
  /**
   * Свой способ отправки (фото с подписью, обычный текст): дверь отдаёт ему
   * чат и ряды кнопок с «🔕 Не присылать такое» и ждёт отправленное сообщение.
   * Отбор по отключениям, журнал и ключ повода остаются за дверью.
   */
  deliver?: (chatId: string, rows: TelegramInlineButton[][]) => Promise<unknown>;
  buttons?: TelegramInlineButton[][];
  /** Один повод = одно сообщение. */
  dedupKey?: string;
  subject?: string;
  /** Ключи, уже занятые вызывающим (claimNoticeKeys): при успехе к ним
   *  пишется номер сообщения, при сбое — отдаются обратно. */
  attachKeys?: string[];
}

function messageIdOf(result: unknown): number | null {
  const id = (result as { message_id?: unknown } | null)?.message_id;
  return typeof id === "number" ? id : null;
}

/** Занять ключи повода. Возвращает те, что заняты ЭТИМ вызовом (остальные уже были). */
export async function claimNoticeKeys(agentId: string, kind: PushKind, keys: string[], subject?: (key: string) => string | undefined): Promise<string[]> {
  const claimed: string[] = [];
  for (const dedupKey of keys) {
    try {
      await prisma.staffNotice.create({ data: { agentId, kind, dedupKey, subject: subject?.(dedupKey) } });
      claimed.push(dedupKey);
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    }
  }
  return claimed;
}

/** Отдать ключи обратно — отправка не удалась, следующий тик попробует снова. */
export async function releaseNoticeKeys(keys: string[]): Promise<void> {
  if (keys.length) await prisma.staffNotice.deleteMany({ where: { dedupKey: { in: keys }, messageId: null } });
}

export async function sendStaffNotice(input: StaffNoticeInput): Promise<StaffNoticeStatus> {
  const agent = await prisma.agent.findUnique({
    where: { id: input.agentId },
    select: { telegramChatId: true, isActive: true, pushMuted: true },
  });
  if (!agent?.isActive || !agent.telegramChatId || isKindMuted(input.kind, agent.pushMuted)) {
    await releaseNoticeKeys(input.attachKeys ?? []);
    return agent?.isActive && agent.telegramChatId ? "muted" : "no-telegram";
  }
  const chatId = agent.telegramChatId;
  const own = input.dedupKey ? await claimNoticeKeys(input.agentId, input.kind, [input.dedupKey], () => input.subject) : [];
  if (input.dedupKey && own.length === 0) return "duplicate";
  const keys = [...own, ...(input.attachKeys ?? [])];

  const pages = (Array.isArray(input.html) ? input.html : [input.html ?? ""]).filter((p) => p.trim());
  const rows = [...(input.buttons ?? [])];
  if (isMutablePushKind(input.kind)) rows.push(muteButton(input.kind));
  try {
    let lastId: number | null = null;
    if (input.deliver) lastId = messageIdOf(await input.deliver(chatId, rows));
    else for (const [i, page] of pages.entries()) {
      const last = i === pages.length - 1;
      lastId = messageIdOf(await sendHtmlMessage(chatId, page, undefined, last && rows.length ? rows : undefined));
    }
    if (keys.length) {
      await attachNoticeMessage(keys, chatId, lastId);
    } else {
      await prisma.staffNotice.create({ data: { agentId: input.agentId, kind: input.kind, chatId, messageId: lastId ?? 0, subject: input.subject } });
    }
    return "sent";
  } catch (err) {
    await releaseNoticeKeys(keys).catch(() => undefined);
    void logSystemError("telegram", `Сообщение помощницы (${input.kind}) не доставлено: ${describeError(err)}`, {
      dedupKey: `staff-notice:${input.kind}`,
    });
    return "failed";
  }
}

/** Журнал рассылок хранится 90 дней: дальше ни «ответом на сообщение», ни ключ повода не нужны. */
export const STAFF_NOTICE_KEEP_DAYS = 90;

/** Ночная уборка журнала (cron.ts, «staff-notice-cleanup»). Несработавшие «напомнить завтра» не трогаем. */
export async function cleanupStaffNotices(now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - STAFF_NOTICE_KEEP_DAYS * 86_400_000);
  const { count } = await prisma.staffNotice.deleteMany({
    where: { createdAt: { lt: before }, OR: [{ remindOn: null }, { firedAt: { not: null } }] },
  });
  return count;
}

/** Записать в журнал уже отправленное сообщение с несколькими ключами повода. */
export async function attachNoticeMessage(keys: string[], chatId: string, messageId: number | null): Promise<void> {
  if (keys.length) await prisma.staffNotice.updateMany({ where: { dedupKey: { in: keys } }, data: { chatId, messageId: messageId ?? 0 } });
}

// ───────────────────────── слова человека ─────────────────────────
//
// ГЛАВНОЕ ПРАВИЛО (ревью 11.11.2026): рабочая команда важнее настройки.
// «не отправляй заявку Нозе», «не надо писать задачу на завтра», «верни
// обратно объект в продажу» — просьбы к помощнице, и разбор их НЕ трогает.
//  • выключить СРАЗУ — только кнопкой или ответом (reply) на само уведомление;
//  • вид назван только словами («не присылай мне оплаты») — сначала вопрос
//    кнопками «Выключить …? Да / Нет»;
//  • в фразе есть хоть одно слово не про уведомления (имя, дата, номер
//    карточки) — фраза не наша, идёт дальше к помощнице;
//  • ответ на НЕ-уведомление и фраза-указатель без ответа — не наши, молча
//    дальше (return false), без реплики бота.

const TAJIK = /[ӣӯҳқғҷ]|(?:^|\s)(?:ман|инро|нафирист|лозим|нест|хомӯш|дубора|боз)(?=\s|$|[.!?,])/iu;

const KIND_WORDS: { kind: PushKind; re: RegExp }[] = [
  { kind: "payment", re: /оплат|подписк|платеж|платёж|пардохт|обуна/iu },
  { kind: "security", re: /безопасност|бехатар|неверн\p{L}*\s+код|код\p{L}*\s+вход|изменени\p{L}*\s+прав/iu },
  { kind: "publication", re: /публикац|(?:^|\s)пост(?:ы|ов)?(?![\p{L}])|нашр/iu },
  { kind: "lead", re: /заявк|(?:^|\s)лид(?:ы|ов)?(?![\p{L}])|дархост/iu },
  { kind: "message", re: /переписк|паём\p{L}*\s+мизоҷ/iu },
  { kind: "showing", re: /показ|встреч|намоиш/iu },
  { kind: "task", re: /задач|просрочк|сводк|вазифа/iu },
  { kind: "score", re: /royal\s*score|балл|скор|рейтинг/iu },
  { kind: "oversight", re: /контрол|разбор|потерянн/iu },
  { kind: "look", re: /подбор|подходящ|мувофиқ/iu },
  { kind: "hot", re: /загорел|просмотр/iu },
  { kind: "market_buyer", re: /под\s+(?:вашего\s+)?покупател/iu },
  { kind: "market", re: /площадк|somon|сомон|paydo|пайдо/iu },
];

/** Вид по словам («не присылай мне оплаты»). null — слова не называют вид. */
export function kindFromWords(text: string): PushKind | null {
  for (const { kind, re } of KIND_WORDS) if (re.test(text)) return kind;
  return null;
}

/** Слово, которое называет вид (одно слово, без контекста). */
const KIND_TOKEN = /^(?:оплат|подписк|платеж|платёж|пардохт|обуна|публикац|пост|нашр|заявк|лид|дархост|переписк|паём|мизоҷ|показ|встреч|намоиш|задач|просрочк|сводк|вазифа|royal|score|балл|скор|рейтинг|контрол|разбор|потерянн|подбор|подходящ|мувофиқ|загорел|просмотр|площадк|somon|сомон|paydo|пайдо|безопасност|бехатар|неверн|код|вход|изменени|прав)\p{L}*$/iu;
/** Слово, которое показывает на уведомления, а не на дело. */
const FILLER_TOKEN = /^(?:мне|меня|больше|такое|такие|такого|это|эти|этого|подобное|подобные|об|о|про|по|насчёт|насчет|их|все|всё|уведомлени\p{L}*|сообщени\p{L}*|напоминани\p{L}*|ба|ман|маро|инро|инҳоро|ин|инҳо|дигар|огоҳ\p{L}*|паёмҳо|паёмҳоро)$/iu;
/** Слова из подписей видов («Объект на площадках»), допустимые рядом с названием вида. */
const LABEL_TOKEN = /^(?:объект\p{L}*|на|в|сетях|сайте)$/iu;
const NOTIF_WORD = /уведомлени|сообщени|напоминани|огоҳ|паёмҳо/iu;
const SELF_WORD = /(?:^|\s)(?:мне|ба\s+ман)(?=\s|$|[.,!?])/iu;
const THIRD_PARTY = /клиент|(?:^|\s)(?:ему|ей|им|него|неё|них)(?![\p{L}])|агент|собственник|покупател|продав|(?:ОБ|ПК|ПР)-?\d/iu;

const POLITE = String.raw`(?:(?:пожалуйста|пж|илтимос)[,\s]+)?`;
const MUTE_RE = new RegExp(
  "^" + POLITE + String.raw`(?:больше\s+|дигар\s+)?(?:` +
    String.raw`не\s+(?:присылай(?:те)?|отправляй(?:те)?|пиши(?:те)?|шли(?:те)?|надо\s+(?:присылать|отправлять|слать|писать))` +
    String.raw`|(?:хватит|перестань(?:те)?|прекрати(?:те)?)\s+(?:присылать|слать|отправлять|писать)` +
    String.raw`|не\s+беспокой(?:те)?` +
    String.raw`|(?:инро\s+|инҳоро\s+)?хомӯш\s+кун(?:ед)?` +
    String.raw`|отключи(?:те)?|выключи(?:те)?` +
    String.raw`|(?:ба\s+ман\s+)?(?:инро\s+|инҳоро\s+)?нафирист(?:ед)?` +
    String.raw`)(?<rest>[^\n]*)$`,
  "iu",
);
const NOT_NEEDED_RE = /^(?:мне\s+)?(?:это|такое|такие|эти|подобное)\s+(?:мне\s+)?не\s+нужн\p{L}*[.!]*$|^(?:ба\s+ман\s+)?(?:ин|инҳо)\s+(?:ба\s+ман\s+)?лозим\s+нест[.!]*$/iu;
/**
 * «Эти уведомления мне не нужны», «оплаты мне больше не нужны», «ин паёмҳо ба ман
 * даркор нест», «пардохтро хомӯш кун» — сказуемое В КОНЦЕ (14.11.2026). Хвост перед
 * ним обязан состоять только из слов про уведомления (onlyNoticeWords).
 */
const NOT_NEEDED_TAIL_RE = /^(?<rest>.{1,80}?)\s+(?:(?:мне\s+)?(?:больше\s+)?не\s+нужн\p{L}*|(?:ба\s+ман\s+)?(?:лозим|даркор)\s+нест)[.!]*$/iu;
const TAJIK_MUTE_TAIL_RE = /^(?<rest>.{1,80}?)\s+(?:хомӯш\s+кун(?:ед)?|нафирист(?:ед)?)[.!]*$/iu;
const LIST_RE = /^(?:что|какие\s+(?:уведомления|сообщения))\s+(?:у\s+меня\s+)?(?:сейчас\s+)?(?:выключен\p{L}*|отключен\p{L}*)\s*\??$|^что\s+я\s+(?:выключил|отключил)\p{L}*\s*\??$|^(?:чӣ|кадом\s+огоҳиҳо)\s+(?:ба\s+ман\s+)?хомӯш(?:\s+аст)?\s*\??$/iu;
const ENABLE_RE = new RegExp(
  "^" + POLITE + String.raw`(?<verb>` +
    String.raw`(?:включи(?:те)?|верни(?:те)?)(?:\s+(?:обратно|снова|опять))?` +
    String.raw`|(?:снова|опять)\s+присылай(?:те)?` +
    String.raw`|(?:боз|дубора)\s+(?:фирист(?:ед)?|фаъол\s+кун(?:ед)?)` +
    String.raw`)(?<rest>(?:\s[^\n]*)?)$`,
  "iu",
);

/**
 * Все слова хвоста — про уведомления: служебные («мне», «такое»), название
 * вида или слово из его подписи. Хоть одно чужое слово — фраза не наша.
 */
function onlyNoticeWords(rest: string): boolean {
  // «сообщения клиентов» — название вида, а не «третье лицо».
  const normalized = rest.replace(/сообщени\p{L}*\s+клиент\p{L}*/giu, "переписка");
  const tokens = normalized.toLowerCase().split(/[\s,.!?;:«»"()—–-]+/u).filter(Boolean);
  const hasKind = tokens.some((t) => KIND_TOKEN.test(t));
  return tokens.every((t) => FILLER_TOKEN.test(t) || KIND_TOKEN.test(t) || (hasKind && LABEL_TOKEN.test(t)));
}

export type NoticeIntent =
  /** explicit — человек явно сказал, что речь о его уведомлениях («мне», «уведомления»). */
  | { type: "mute"; kind: PushKind | null; explicit: boolean }
  | { type: "unmute"; kind: PushKind | null; explicit: boolean }
  | { type: "list" };

/** Разбор фразы. null — фраза не про уведомления, её обрабатывает помощница. */
export function parseNoticeIntent(raw: string): NoticeIntent | null {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text || text.length > 120) return null;
  if (LIST_RE.test(text)) return { type: "list" };
  if (NOT_NEEDED_RE.test(text)) return { type: "mute", kind: null, explicit: false };
  const tail = NOT_NEEDED_TAIL_RE.exec(text) ?? TAJIK_MUTE_TAIL_RE.exec(text);
  if (tail) {
    const rest = (tail.groups?.rest ?? "").replace(/сообщени\p{L}*\s+клиент\p{L}*/giu, "переписка");
    if (THIRD_PARTY.test(rest) || !onlyNoticeWords(rest)) return null;
    // Хвост из одних служебных слов («мне это») без вида и без слова «уведомления» — не наш.
    if (!kindFromWords(rest) && !NOTIF_WORD.test(rest) && !/(?<!\p{L})(?:эти|это|такие|такое|ин|инҳо|инро|инҳоро)(?!\p{L})/iu.test(rest)) return null;
    return { type: "mute", kind: kindFromWords(rest), explicit: SELF_WORD.test(text) || NOTIF_WORD.test(rest) };
  }
  const enable = ENABLE_RE.exec(text);
  if (enable) {
    const rest = enable.groups?.rest ?? "";
    const verb = enable.groups?.verb ?? "";
    if (!onlyNoticeWords(rest)) return null;
    const explicit = NOTIF_WORD.test(rest);
    // «Верни …» и голое «включи …» без слова «уведомления» — про дело
    // («верни обратно оплату», «включи объект»), а не про сообщения.
    if (!explicit && (/^верни/iu.test(verb) || !/обратно|снова|опять|присылай|фирист|фаъол/iu.test(verb))) return null;
    const kind = kindFromWords(rest.replace(/сообщени\p{L}*\s+клиент\p{L}*/giu, "переписка"));
    return { type: "unmute", kind, explicit };
  }
  const mute = MUTE_RE.exec(text);
  if (mute) {
    const rest = mute.groups?.rest ?? "";
    const verb = text.slice(0, text.length - rest.length);
    if (THIRD_PARTY.test(rest.replace(/сообщени\p{L}*\s+клиент\p{L}*/giu, "переписка"))) return null;
    if (!onlyNoticeWords(rest)) return null;
    // «выключи/отключи …» — только со словом «уведомления/напоминания».
    if (/(?:отключи|выключи)/iu.test(verb) && !NOTIF_WORD.test(rest)) return null;
    const kind = kindFromWords(rest.replace(/сообщени\p{L}*\s+клиент\p{L}*/giu, "переписка"));
    // «Перестань присылать», «не беспокой» — сами про сообщения мне, слово «мне» не обязательно.
    return { type: "mute", kind, explicit: SELF_WORD.test(text) || NOTIF_WORD.test(rest) || /перестан|прекрат|беспоко/iu.test(verb) };
  }
  return null;
}

const COPY = {
  ru: {
    muted: (label: string) => `🔕 Выключила: «${label}». Больше такое не присылаю.\nВключить обратно — «включи обратно ${label.toLowerCase()}» или в профиле CRM → «Что присылать мне».`,
    already: (label: string) => `🔕 «${label}» уже выключено.`,
    unmuted: (label: string) => `🔔 Снова присылаю: «${label}».`,
    notMuted: (label: string) => `🔔 «${label}» и так включено.`,
    always: (label: string, why: string) => `«${label}» выключить нельзя. ${why}`,
    which: "Не поняла, о каких сообщениях речь. Ответьте этой фразой на само сообщение или нажмите под ним «🔕 Не присылать такое».",
    askMute: (label: string) => `Выключить «${label}»? Это перестанет приходить в Telegram и на телефон.`,
    askUnmute: (label: string) => `Снова присылать «${label}»?`,
    yesMute: "🔕 Да, выключить",
    yesUnmute: "🔔 Да, присылать",
    no: "Нет",
    kept: "Хорошо, оставила как было",
    whichOn: (list: string) => `Что включить обратно? Сейчас выключено: ${list}.`,
    nothingOff: "У вас ничего не выключено — присылаю всё.",
    listTitle: "Выключено у вас",
    listTip: "включить обратно — «включи обратно уведомления о …» или в профиле CRM → «Что присылать мне».",
    always2: (label: string, why: string) => `Всегда приходит: ${label}. ${why}`,
    turnOn: "🔔 Включить обратно",
    tapMuted: "Выключила",
  },
  tg: {
    muted: (label: string) => `🔕 Хомӯш кардам: «${label}». Дигар инро намефиристам.\nБарои боз фаъол кардан — «боз фирист ${label.toLowerCase()}» ё дар профили CRM.`,
    already: (label: string) => `🔕 «${label}» аллакай хомӯш аст.`,
    unmuted: (label: string) => `🔔 Боз мефиристам: «${label}».`,
    notMuted: (label: string) => `🔔 «${label}» фаъол аст.`,
    always: (label: string, why: string) => `«${label}»-ро хомӯш кардан мумкин нест. ${why}`,
    which: "Нафаҳмидам, кадом паёмҳо. Ба худи паём ҷавоб диҳед ё тугмаи «🔕 Не присылать такое»-ро зер кунед.",
    askMute: (label: string) => `«${label}»-ро хомӯш кунам? Дигар дар Telegram ва телефон намеояд.`,
    askUnmute: (label: string) => `«${label}»-ро боз фиристам?`,
    yesMute: "🔕 Ҳа, хомӯш кун",
    yesUnmute: "🔔 Ҳа, фирист",
    no: "Не",
    kept: "Хуб, ҳамон тавр монд",
    whichOn: (list: string) => `Чиро боз фаъол кунам? Ҳоло хомӯш: ${list}.`,
    nothingOff: "Ҳеҷ чиз хомӯш нест — ҳамаро мефиристам.",
    listTitle: "Хомӯш кардаед",
    listTip: "барои фаъол кардан — «боз фирист …» ё дар профили CRM.",
    always2: (label: string, why: string) => `Ҳамеша меояд: ${label}. ${why}`,
    turnOn: "🔔 Боз фаъол кардан",
    tapMuted: "Хомӯш шуд",
  },
} as const;

/** Вид уведомления, на которое ответили. null — ответили не на уведомление. */
async function repliedNoticeKind(chatId: string, replyToId: number): Promise<PushKind | null> {
  const row = await prisma.staffNotice.findFirst({ where: { chatId, messageId: replyToId }, select: { kind: true } });
  if (!row) return null;
  return isMutablePushKind(row.kind) || ALWAYS_ON_KINDS.some((k) => k.key === row.kind) ? (row.kind as PushKind) : null;
}

async function reply(chatId: string, html: string, buttons?: TelegramInlineButton[][]): Promise<void> {
  await sendHtmlMessage(chatId, html, undefined, buttons);
}

async function applyMute(chatId: string, agentId: string, kind: PushKind, lang: ListLang): Promise<void> {
  const c = COPY[lang];
  const result = await setKindMuted(agentId, kind, true);
  if (!result.ok) {
    if (result.reason === "always-on") await reply(chatId, escapeHtml(c.always(result.label, result.why)));
    else await reply(chatId, escapeHtml(c.which));
    return;
  }
  const label = kindLabel(kind);
  await reply(chatId, escapeHtml(result.changed ? c.muted(label) : c.already(label)), [[{ text: c.turnOn, callback_data: `${UNMUTE_PREFIX}${kind}` }]]);
}

async function applyUnmute(chatId: string, agentId: string, kind: PushKind, lang: ListLang): Promise<void> {
  const c = COPY[lang];
  const result = await setKindMuted(agentId, kind, false);
  if (!result.ok) {
    await reply(chatId, escapeHtml(result.reason === "always-on" ? c.always2(result.label, result.why) : c.which));
    return;
  }
  const label = kindLabel(kind);
  await reply(chatId, escapeHtml(result.changed ? c.unmuted(label) : c.notMuted(label)));
}

/** Вопрос «Выключить …? Да / Нет» — когда вид понят только из слов. */
async function askConfirm(chatId: string, kind: PushKind, mute: boolean, lang: ListLang): Promise<void> {
  const c = COPY[lang];
  const always = ALWAYS_ON_KINDS.find((k) => k.key === kind);
  if (always) {
    await reply(chatId, escapeHtml(mute ? c.always(always.label, always.why) : c.always2(always.label, always.why)));
    return;
  }
  const label = kindLabel(kind);
  await reply(chatId, escapeHtml(mute ? c.askMute(label) : c.askUnmute(label)), [[
    { text: mute ? c.yesMute : c.yesUnmute, callback_data: `${mute ? MUTE_PREFIX : UNMUTE_PREFIX}${kind}` },
    { text: c.no, callback_data: KEEP_DATA },
  ]]);
}

/** «Что у меня выключено» — список тем же модулем, что все списки помощницы. */
export async function renderMutedList(agentId: string, lang: ListLang): Promise<string[]> {
  const c = COPY[lang];
  const muted = (await mutedKindsOf(agentId)).filter(isMutablePushKind);
  const always = ALWAYS_ON_KINDS.map((k) => c.always2(k.label, k.why)).join("\n");
  if (!muted.length) return [`🔔 ${escapeHtml(c.nothingOff)}\n\n${escapeHtml(always)}`];
  return renderAssistantListHtml({
    icon: "🔕",
    title: c.listTitle,
    lang,
    items: PUSH_KINDS.filter((k) => muted.includes(k.key)).map((k) => ({ title: k.label, main: [k.hint] })),
    note: always,
    tip: c.listTip,
  });
}

/**
 * Фраза человека в личке про его уведомления. true — обработано; false — фраза
 * не наша, её обрабатывает помощница как обычную просьбу.
 */
export async function handleNoticePreferenceText(msg: TelegramIncomingMessage, agent: { id: string }, text: string): Promise<boolean> {
  const intent = parseNoticeIntent(text);
  if (!intent) return false;
  const chatId = String(msg.chat.id);
  const lang: ListLang = TAJIK.test(text) ? "tg" : "ru";
  const c = COPY[lang];
  const replyTo = msg.reply_to_message?.message_id;
  try {
    if (intent.type === "list") {
      for (const page of await renderMutedList(agent.id, lang)) await reply(chatId, page);
      return true;
    }
    if (replyTo !== undefined) {
      // Ответ на само уведомление — действие сразу. Ответ на что-то другое — не наше.
      const noticeKind = await repliedNoticeKind(chatId, replyTo);
      if (!noticeKind) return false;
      if (intent.type === "mute") await applyMute(chatId, agent.id, noticeKind, lang);
      else await applyUnmute(chatId, agent.id, noticeKind, lang);
      return true;
    }
    if (intent.type === "mute") {
      if (!intent.kind || !intent.explicit) return false;
      await askConfirm(chatId, intent.kind, true, lang);
      return true;
    }
    if (intent.kind) {
      if (intent.explicit) await applyUnmute(chatId, agent.id, intent.kind, lang);
      else await askConfirm(chatId, intent.kind, false, lang);
      return true;
    }
    if (!intent.explicit) return false;
    const muted = (await mutedKindsOf(agent.id)).filter(isMutablePushKind);
    if (muted.length === 1) await applyUnmute(chatId, agent.id, muted[0]!, lang);
    else await reply(chatId, escapeHtml(muted.length ? c.whichOn(muted.map(kindLabel).map((l) => `«${l}»`).join(", ")) : c.nothingOff));
  } catch (err) {
    void logSystemError("telegram", `Настройка сообщений помощницы не сохранена: ${describeError(err)}`);
    await reply(chatId, "Не получилось сохранить, попробуйте ещё раз.").catch(() => undefined);
  }
  return true;
}

async function clickerOf(query: TelegramCallbackQuery): Promise<{ id: string } | null> {
  if (!query.from?.id) return null;
  const byUser = await findAgentByTelegramUserId(String(query.from.id));
  if (byUser) return byUser;
  const chatId = query.message?.chat.id;
  return chatId !== undefined && chatId === query.from.id ? findAgentByTelegramChatId(String(chatId)) : null;
}

/** «🔕 Не присылать такое» / «🔔 Включить обратно». true — нажатие наше. */
export async function handleStaffNoticeCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  if (data === KEEP_DATA) {
    const lang: ListLang = TAJIK.test(query.message?.text ?? "") ? "tg" : "ru";
    await answerCallbackQuery(query.id, COPY[lang].kept);
    return true;
  }
  const mute = data.startsWith(MUTE_PREFIX);
  if (!mute && !data.startsWith(UNMUTE_PREFIX)) return false;
  if (!(await claimCallback(query.id))) {
    await answerCallbackQuery(query.id);
    return true;
  }
  const kind = data.slice(MUTE_PREFIX.length);
  const chatId = query.message?.chat.id !== undefined ? String(query.message.chat.id) : null;
  const lang: ListLang = TAJIK.test(query.message?.text ?? query.message?.caption ?? "") ? "tg" : "ru";
  try {
    const clicker = await clickerOf(query);
    if (!clicker) {
      await answerCallbackQuery(query.id, "Привяжите аккаунт в личке с ботом");
      return true;
    }
    if (!isMutablePushKind(kind)) {
      await answerCallbackQuery(query.id, "Это выключить нельзя");
      return true;
    }
    await answerCallbackQuery(query.id, mute ? COPY[lang].tapMuted : undefined);
    if (chatId) await (mute ? applyMute : applyUnmute)(chatId, clicker.id, kind, lang);
  } catch (err) {
    void logSystemError("telegram", `Кнопка «Не присылать такое» не сработала: ${describeError(err)}`);
    await answerCallbackQuery(query.id, "Не получилось, попробуйте ещё раз").catch(() => undefined);
  }
  return true;
}
