import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  SOCIAL_PHOTO_POST_CHANNELS,
  SOCIAL_PHOTO_POST_MAX_BYTES,
  SOCIAL_PHOTO_POST_MAX_IMAGES,
  SOCIAL_VIDEO_CHANNELS,
  SOCIAL_VIDEO_CHANNEL_LABELS,
  evaluatePhotoPostForChannel,
  evaluateVideoForChannel,
  isReadOnlyRole,
  type SocialVideoCaptionLanguage,
  type SocialVideoChannel,
  type SocialVideoItem,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { loadAgentAccess } from "../auth/middleware.js";
import { hasMarketingRole } from "../lib/marketingRole.js";
import { automationSwitchOn } from "../lib/automationSwitches.js";
import { claimAgentAiAction } from "../lib/agentAiActionCap.js";
import { logAgentAudit } from "../lib/audit.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { trackBackgroundTask } from "../lib/shutdownState.js";
import { loadChannelInfos } from "../lib/socialVideoChannels.js";
import { containsForbiddenWord, effectiveCaptionLimit, generateSocialVideoCaptions, SocialVideoAiError } from "../lib/socialVideoAi.js";
import { stripDashes } from "../ai/seoGenerator.js";
import {
  SocialVideoError,
  createSocialPhotoPostFromUpload,
  createSocialVideoFromUpload,
  deleteSocialVideo,
  getSocialVideo,
  publishSocialVideo,
  updateSocialVideo,
} from "../lib/socialVideoPosts.js";
import { isInsideTelegramFilesDir } from "../messengers/attachments.js";
import { videoHandoffDir } from "../upload.js";
import { dropDraftIfStillDraft } from "../lib/staffSocialPostSweep.js";
import { dushanbeDateString, dushanbeTimeString } from "../lib/dushanbeTime.js";
import { assistantLanguage } from "../ai/assistant/languageRouting.js";
import { downloadAssistantMedia } from "./assistantMedia.js";
import {
  answerCallbackQuery, editMessageText, resolveTelegramFileMaterialization, sendChatAction, sendMessage, sendMessageWithButtons,
  TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES,
  type TelegramCallbackQuery, type TelegramIncomingMessage, type TelegramInlineButton,
} from "./api.js";

/**
 * ПОСТ БЕЗ ОБЪЕКТА ОТ ШАБНАМ (21.11.2026, владелец на вопрос «Учить Шабнам публиковать ролики
 * без объекта и карусели?»: «да…»).
 *
 * Сотрудник с правом маркетинга (`marketing.access`: маркетинг, директор, админ, РОП с галочкой)
 * присылает Шабнам в личку ролик или 1–10 фото (альбом Telegram — один пост, а не десять).
 * Шабнам делает ровно то же, что экран «Ролики» CRM, теми же функциями:
 *  - файл → черновик (lib/socialVideoPosts.ts::createSocialVideoFromUpload / createSocialPhotoPostFromUpload);
 *  - подпись → lib/socialVideoAi.ts::generateSocialVideoCaptions (там же проверка фактов: цифры и ссылки
 *    только из слов сотрудника, контакты компании дописывает код, а не модель);
 *  - публикация → publishSocialVideo (проверки площадок, захват статуса, фон).
 * Перед публикацией — превью: что, куда, подпись, когда; кнопки «Опубликовать», «Изменить подпись»,
 * «Другая подпись», «Выбрать сети», «Отмена». В СЕТИ УХОДИТ ТОЛЬКО ПО КНОПКЕ «Опубликовать» ТОГО ЖЕ
 * СОТРУДНИКА и только с ПОСЛЕДНЕГО превью: в кнопке номер превью, а при показе запоминается отпечаток
 * подписи и сетей — уходит ровно то, что человек видел. Все смены статуса условные (updateMany из
 * ожидаемого): пока пишется новая подпись или выбираются сети (PREPARING / PICKING), «Опубликовать»
 * не срабатывает; после захвата PUBLISHING никто подпись уже не перепишет. Двойное нажатие и повтор
 * апдейта Telegram второй публикации не дают (и сам publishSocialVideo второй раз из DRAFT не запустит).
 * Долгое (скачивание, ИИ, публикация) идёт в очереди этого чата (DeferWork), кнопка отвечает сразу.
 * Брошенное убирает lib/staffSocialPostSweep.ts (cron, раз в 15 минут).
 *
 * Приватность: только личка привязанного сотрудника, не пересланное (чужой файл, в том числе от
 * клиента, сюда не попадает). Рубильник «Шабнам публикует ролики и фото без объекта» — реестр
 * «Автоматика ИИ и напоминания» (packages/shared/src/automationSwitches.ts), по умолчанию ВКЛ.
 */

export const STAFF_SOCIAL_POST_TTL_MS = 24 * 3_600_000;
const EDIT_CAPTION_WINDOW_MS = 10 * 60_000;
const CAPTION_DAILY_LIMIT = 40;
export const STAFF_SOCIAL_ALBUM_QUIET_MS = 2_500;

type Lang = "ru" | "tg";
type Actor = { id: string; fullName: string };
type PostRow = Prisma.StaffSocialPostGetPayload<object>;

/** Как запустить долгую часть нажатия: бот передаёт очередь чата (assistantBot.ts), тесты — сразу. */
export type DeferWork = (work: () => Promise<void>) => Promise<void>;
export const runInline: DeferWork = (work) => work();

/** Статусы, из которых можно показать превью заново. */
const SHOWABLE = ["PREPARING", "PREVIEW", "EDIT_CAPTION", "PICKING"];
/** Статусы, в которых превью живое и кнопки работают. */
const LIVE = ["PREVIEW", "EDIT_CAPTION"];

// ───────────────────────────── тексты ─────────────────────────────

const T = {
  ru: {
    off: "Публиковать посты без объекта через меня сейчас выключено в Настройках. Сделайте пост в разделе «Ролики» CRM.",
    rights: "Публиковать в соцсети компании может сотрудник с доступом к маркетингу. Попросите маркетолога или руководителя.",
    preparing: "Готовлю пост, это займёт до минуты…",
    title: "📣 Пост готов. Проверьте перед публикацией",
    what: "Что",
    where: "Куда",
    when: "Когда",
    whenNow: "сразу после кнопки «Опубликовать»",
    caption: "Подпись",
    noChannels: "ни одной сети не выбрано",
    video: (dur: string) => `ролик${dur}`,
    photos: (n: number) => (n === 1 ? "фото" : `альбом, ${n} фото`),
    duplicate: (title: string, where: string) => `⚠️ Этот файл уже загружали: «${title}»${where ? `, вышел в ${where}` : ""}.`,
    notReady: (list: string) => `Не подключены или не подходят: ${list}.`,
    publish: "✅ Опубликовать",
    edit: "✏️ Изменить подпись",
    regen: "🔄 Другая подпись",
    networks: "📡 Выбрать сети",
    cancel: "Отмена",
    done: "Готово",
    askCaption: "Пришлите новый текст подписи одним сообщением. Опубликую его как есть, ничего не меняя. «Отмена» оставит прежнюю подпись.",
    captionTooLong: (n: number) => `Подпись длиннее ${n} знаков для выбранных сетей. Сократите и пришлите ещё раз.`,
    captionKept: "Оставила прежнюю подпись.",
    pickNetworks: "Отметьте сети и нажмите «Готово».",
    needOne: "Нужна хотя бы одна сеть",
    queued: (where: string) => `Отправила в публикацию: ${where}. Как выйдет, напишу сюда со ссылками.`,
    cancelled: "Отменила. В соцсети ничего не ушло.",
    stale: "Кнопка устарела",
    expired: "Прошли сутки, пост не опубликован. Пришлите файлы ещё раз или опубликуйте черновик в разделе «Ролики».",
    already: "Уже публикую",
    failed: "Не получилось подготовить пост. Попробуйте ещё раз или сделайте его в разделе «Ролики» CRM.",
    publishFailed: "Не получилось отправить в публикацию, попробуйте ещё раз через минуту.",
    refused: (why: string) => `Публикация не началась:\n${why}`,
    download: "Не получилось скачать файл из Telegram. Пришлите его ещё раз.",
    captionAi: "Подпись сама не написалась, поставила короткую. Можно нажать «Другая подпись» или «Изменить подпись».",
    captionLimit: "На сегодня подписей от ИИ хватит. Напишите подпись сами кнопкой «Изменить подпись».",
    sentState: "✅ Отправлено в публикацию",
    cancelState: "Отменено",
    updatedBelow: "Превью обновлено, смотрите ниже ↓",
    oldPreview: "Это старое превью, смотрите последнее ниже",
    changed: "Подпись или сети изменились, показываю заново",
    busy: "Подождите, готовлю подпись",
    regenerating: "Пишу другую подпись…",
    preparingShort: "Готовлю…",
    captionAbove: (n: number) => `в сообщении выше ↑ (${n} знаков, уйдёт целиком)`,
  },
  tg: {
    off: "Нашри постҳо бе объект тавассути ман ҳоло дар Танзимот хомӯш аст. Постро дар бахши «Роликҳо»-и CRM созед.",
    rights: "Дар шабакаҳои ширкат танҳо корманди дорои дастрасӣ ба маркетинг нашр карда метавонад. Аз маркетолог ё роҳбар хоҳиш кунед.",
    preparing: "Постро омода мекунам, то як дақиқа вақт мегирад…",
    title: "📣 Пост тайёр аст. Пеш аз нашр тафтиш кунед",
    what: "Чӣ",
    where: "Куҷо",
    when: "Кай",
    whenNow: "фавран баъди тугмаи «Нашр кардан»",
    caption: "Матн",
    noChannels: "ягон шабака интихоб нашудааст",
    video: (dur: string) => `ролик${dur}`,
    photos: (n: number) => (n === 1 ? "акс" : `албом, ${n} акс`),
    duplicate: (title: string, where: string) => `⚠️ Ин файл аллакай бор шуда буд: «${title}»${where ? `, дар ${where} баромадааст` : ""}.`,
    notReady: (list: string) => `Пайваст нестанд ё мувофиқ нестанд: ${list}.`,
    publish: "✅ Нашр кардан",
    edit: "✏️ Матнро иваз кардан",
    regen: "🔄 Матни дигар",
    networks: "📡 Шабакаҳо",
    cancel: "Бекор кардан",
    done: "Тайёр",
    askCaption: "Матни навро бо як паём фиристед. Ҳамонтавр нашр мекунам, бе тағйир. «Бекор» матни пештараро нигоҳ медорад.",
    captionTooLong: (n: number) => `Матн барои шабакаҳои интихобшуда аз ${n} аломат дароз аст. Кӯтоҳ карда боз фиристед.`,
    captionKept: "Матни пештара монд.",
    pickNetworks: "Шабакаҳоро қайд кунед ва «Тайёр»-ро пахш кунед.",
    needOne: "Ақаллан як шабака лозим аст",
    queued: (where: string) => `Ба нашр фиристодам: ${where}. Вақте ки баромад, ҳамин ҷо бо пайвандҳо менависам.`,
    cancelled: "Бекор кардам. Ба шабакаҳо чизе нарафт.",
    stale: "Тугма кӯҳна шуд",
    expired: "Як шабонарӯз гузашт, пост нашр нашуд. Файлҳоро боз фиристед ё лоиҳаро дар бахши «Роликҳо» нашр кунед.",
    already: "Аллакай нашр мекунам",
    failed: "Постро омода карда натавонистам. Боз кӯшиш кунед ё онро дар бахши «Роликҳо»-и CRM созед.",
    publishFailed: "Ба нашр фиристода натавонистам, баъди як дақиқа боз кӯшиш кунед.",
    refused: (why: string) => `Нашр сар нашуд:\n${why}`,
    download: "Файлро аз Telegram гирифта натавонистам. Онро боз фиристед.",
    captionAi: "Матн худ ба худ навишта нашуд, кӯтоҳашро гузоштам. «Матни дигар» ё «Матнро иваз кардан»-ро пахш кардан мумкин аст.",
    captionLimit: "Барои имрӯз матнҳо аз ИИ бас аст. Матнро худатон бо тугмаи «Матнро иваз кардан» нависед.",
    sentState: "✅ Ба нашр фиристода шуд",
    cancelState: "Бекор шуд",
    updatedBelow: "Пешнамоиш нав шуд, дар поён нигоҳ кунед ↓",
    oldPreview: "Ин пешнамоиши кӯҳна аст, охиринашро дар поён нигоҳ кунед",
    changed: "Матн ё шабакаҳо иваз шуданд, аз нав нишон медиҳам",
    busy: "Каме сабр кунед, матнро омода мекунам",
    regenerating: "Матни дигар менависам…",
    preparingShort: "Омода мекунам…",
    captionAbove: (n: number) => `дар паёми боло ↑ (${n} аломат, пурра меравад)`,
  },
} as const;

const textOf = (lang: string | null | undefined) => T[lang === "tg" ? "tg" : "ru"];

// ───────────────────────────── кто может ─────────────────────────────

export type SocialPublishGate = { ok: true } | { ok: false; reason: "off" | "rights" };

/** Одна проверка «можно ли этому сотруднику публиковать через Шабнам»: рубильник, учётка, право маркетинга. */
export async function socialPublishGate(agentId: string): Promise<SocialPublishGate> {
  if (!(await automationSwitchOn("shabnamSocialPublishEnabled"))) return { ok: false, reason: "off" };
  const access = await loadAgentAccess(agentId);
  if (!access?.isActive || isReadOnlyRole(access.role) || !hasMarketingRole(access)) return { ok: false, reason: "rights" };
  return { ok: true };
}

// ───────────────────────────── разбор слов сотрудника ─────────────────────────────

/** «опубликуй», «выложи в инстаграм», «запости», тадж. «нашр кун». */
const PUBLISH_INTENT = /(?:^|[^\p{L}])(?:опубликуй|опубликовать|опубликуйте|публикуй|выложи|выложить|выложите|запости|постни|в\s+(?:инст|инсту|инстаграм|фейсбук|фб|тикток|ютуб|телеграм)|нашр\s*(?:кун|кунед|намо)|ба\s+(?:инстаграм|шабака))/iu;
export function hasPublishIntent(text: string | null | undefined): boolean {
  return !!text && PUBLISH_INTENT.test(text);
}
/** «без объекта», тадж. «бе объект». */
export function wantsNoProperty(text: string | null | undefined): boolean {
  return !!text && /(?:^|[^\p{L}])(?:без\s+объекта|не\s+к\s+объекту|бе\s+объект)/iu.test(text);
}

const CHANNEL_WORDS: Array<[RegExp, SocialVideoChannel]> = [
  [/инст|insta|ig(?![\p{L}])/iu, "INSTAGRAM"],
  [/фейсбук|фб(?![\p{L}])|facebook|fb(?![\p{L}])/iu, "FACEBOOK"],
  [/ютуб|youtube|шортс/iu, "YOUTUBE"],
  [/тикток|tiktok|тик\s*ток/iu, "TIKTOK"],
  [/телеграм|telegram|тг(?![\p{L}])|канал/iu, "TELEGRAM"],
  [/threads|тредс/iu, "THREADS"],
];
export function requestedChannels(text: string | null | undefined): SocialVideoChannel[] {
  if (!text) return [];
  return CHANNEL_WORDS.filter(([re]) => re.test(text)).map(([, c]) => c);
}

/** Язык подписи: сказано словами («на таджикском», «на двух языках») — так; иначе язык самих слов. */
export function captionLanguageOf(text: string | null | undefined): SocialVideoCaptionLanguage {
  const t = text ?? "";
  if (/двух\s+языках|два\s+языка|ду\s+забон|рус\p{L}*\s+и\s+тадж|тадж\p{L}*\s+и\s+рус/iu.test(t)) return "RU_TG";
  if (/(?:на|по)[\s-]+таджикск|тоҷикӣ|тоҷики|точики/iu.test(t)) return "TG";
  if (/(?:на|по)[\s-]+русск|русӣ/iu.test(t)) return "RU";
  if (!t.trim()) return "RU";
  const lang = assistantLanguage([{ role: "user", content: t }]);
  return lang === "tg" ? "TG" : "RU";
}

function replyLanguage(text: string | null | undefined): Lang {
  if (!text?.trim()) return "ru";
  const lang = assistantLanguage([{ role: "user", content: text }]);
  return lang === "tg" || lang === "mixed" ? "tg" : "ru";
}

/** Слова сотрудника без команды: «опубликуй в инстаграм, новый ЖК в Сино» → «новый ЖК в Сино». */
export function briefOf(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/(?:^|[^\p{L}])(?:пожалуйста|шабнам|опубликуй(?:те)?|опубликовать|публикуй|выложи(?:те)?|выложить|запости|постни|без\s+объекта|нашр\s*(?:кун|кунед|намо)|на\s+(?:двух\s+языках|таджикском|русском)(?:\s+языке)?)(?=[^\p{L}]|$)/giu, " ")
    .replace(/(?:^|[^\p{L}])(?:в|и|ба)\s+(?:инстаграм\p{L}*|инсту|инст|фейсбук\p{L}*|фб|тикток|ютуб|телеграм\p{L}*|threads)(?=[^\p{L}]|$)/giu, " ")
    .replace(/[\s,.;:!]+/gu, " ")
    .trim();
}

/**
 * Не имена, а слова служебных учёток («Royal Home Офис», «Бот», «Маркетолог»): запрет на них
 * выбрасывал бы из подписи название самого агентства и обычные слова.
 */
const NOT_A_NAME = new Set(["royal", "home", "роял", "хоум", "офис", "office", "admin", "админ", "администратор", "бот", "bot",
  "робот", "robot", "агентство", "агент", "менеджер", "маркетинг", "маркетолог", "директор", "сотрудник", "отдел", "продаж",
  "тест", "test", "душанбе", "оператор", "монтажёр", "монтажер", "смм", "smm"]);

/** Слова из имён действующих сотрудников (3+ буквы): их не должно быть в публичной подписи. */
export async function staffNameWords(): Promise<string[]> {
  const rows = await prisma.agent.findMany({ where: { isActive: true }, select: { fullName: true }, take: 2000 });
  return [...new Set(rows.flatMap((r) => r.fullName.split(/[^\p{L}]+/u)))]
    .filter((w) => w.length >= 3 && !NOT_A_NAME.has(w.toLowerCase().replace(/ё/gu, "е")));
}

// ───────────────────────────── сети по умолчанию ─────────────────────────────

const kindChannels = (kind: string): readonly SocialVideoChannel[] => (kind === "PHOTO" ? SOCIAL_PHOTO_POST_CHANNELS : SOCIAL_VIDEO_CHANNELS);

/** Готовые (подключённые) сети этого вида поста; названные сотрудником — только они. */
async function readyChannels(kind: string): Promise<{ ready: SocialVideoChannel[]; problems: Map<SocialVideoChannel, string> }> {
  const infos = await loadChannelInfos();
  const problems = new Map<SocialVideoChannel, string>();
  const ready: SocialVideoChannel[] = [];
  for (const channel of kindChannels(kind)) {
    const info = infos.find((i) => i.channel === channel);
    if (info?.ready) ready.push(channel);
    else problems.set(channel, info?.problem ?? "не подключён");
  }
  return { ready, problems };
}

function blockedFor(item: SocialVideoItem, channel: SocialVideoChannel): string | null {
  const verdict = item.mediaKind === "PHOTO"
    ? evaluatePhotoPostForChannel(channel, item.caption)
    : evaluateVideoForChannel(channel, item, item.caption);
  return verdict.blockers[0] ?? null;
}

const jsonChannels = (v: Prisma.JsonValue | null | undefined): SocialVideoChannel[] =>
  Array.isArray(v) ? v.filter((x): x is SocialVideoChannel => typeof x === "string" && (SOCIAL_VIDEO_CHANNELS as readonly string[]).includes(x)) : [];

/** Отпечаток того, что уйдёт: подпись и сети. Совпал с показанным — публикуем, нет — показываем заново. */
export function previewHash(item: Pick<SocialVideoItem, "caption" | "channels">): string {
  return createHash("sha256").update(`${item.caption}\n${[...item.channels].sort().join(",")}`).digest("hex").slice(0, 32);
}

// ───────────────────────────── подпись ─────────────────────────────

const FALLBACK_BRIEF = { VIDEO: "Ролик агентства недвижимости Royal Home в Душанбе", PHOTO: "Фото от агентства недвижимости Royal Home в Душанбе" } as const;
const NEUTRAL_CAPTION = { RU: "Royal Home, агентство недвижимости в Душанбе", TG: "Royal Home, агентии амволи ғайриманқул дар Душанбе" } as const;

/**
 * Подпись тем же ИИ, что у экрана «Ролики». Служебного названия с именем сотрудника модель не видит,
 * имена действующих сотрудников вычищаются проверкой фактов (lib/socialVideoAi.ts).
 */
async function writeCaption(agentId: string, brief: string, language: SocialVideoCaptionLanguage, channels: SocialVideoChannel[], avoid: string[] = []): Promise<{ caption: string } | { error: "limit" | "ai" }> {
  const cap = await claimAgentAiAction(agentId, "assistant-social-caption", CAPTION_DAILY_LIMIT);
  if (!cap.allowed) return { error: "limit" };
  try {
    const variants = await generateSocialVideoCaptions({ brief, tone: "SELLING", language, channels, avoid: avoid.slice(0, 9) }, { forbiddenWords: await staffNameWords() });
    return variants[0] ? { caption: variants[0] } : { error: "ai" };
  } catch (err) {
    if (!(err instanceof SocialVideoAiError)) void logSystemError("ai", `Шабнам: подпись поста без объекта — ${describeError(err)}`, { dedupKey: "staff-social-caption" });
    return { error: "ai" };
  }
}

/** Запасная подпись: только слова самого сотрудника (без тире и имён сотрудников), иначе нейтральная строка. */
async function fallbackCaption(ownWords: string, language: string): Promise<string> {
  const own = stripDashes(ownWords).trim();
  if (own.length >= 3 && !containsForbiddenWord(own, await staffNameWords())) return own;
  return language === "TG" ? NEUTRAL_CAPTION.TG : NEUTRAL_CAPTION.RU;
}

// ───────────────────────────── превью ─────────────────────────────

const ACTIONS = { publish: "p", edit: "e", regen: "g", networks: "n", toggle: "t", back: "b", cancel: "x" } as const;
const cb = (action: string, id: string, arg?: number) => `spub:${action}:${id}${arg !== undefined ? `:${arg}` : ""}`;
/** Предел текста сообщения Telegram (4096) с запасом. */
const MESSAGE_ROOM = 3900;

function durationText(sec: number | null): string {
  if (!sec || sec <= 0) return "";
  const s = Math.round(sec);
  return ` ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Текст превью. Подпись показывается ЦЕЛИКОМ: не влезает в одно сообщение вместе с остальным —
 * уходит отдельным сообщением выше (sendMessage делит длинное сам), а в превью — ссылка на него.
 * Непоказанной части подписи не бывает.
 */
export function socialPostPreviewParts(item: SocialVideoItem, lang: Lang, notes: string[]): { captionAlone: string | null; text: string } {
  const t = textOf(lang);
  const what = item.mediaKind === "PHOTO" ? t.photos(item.imagePaths.length || 1) : t.video(durationText(item.durationSec));
  const where = item.channels.map((c) => SOCIAL_VIDEO_CHANNEL_LABELS[c]).join(", ") || t.noChannels;
  const head = [t.title, "", `${t.what}: ${what}`, `${t.where}: ${where}`, `${t.when}: ${t.whenNow}`, ""];
  const tail = notes.length ? ["", ...notes] : [];
  const inline = [...head, `${t.caption}:`, item.caption, ...tail].join("\n");
  if (inline.length <= MESSAGE_ROOM) return { captionAlone: null, text: inline };
  return { captionAlone: item.caption, text: [...head, `${t.caption}: ${t.captionAbove(item.caption.length)}`, ...tail].join("\n").slice(0, MESSAGE_ROOM) };
}

function previewButtons(id: string, version: number, lang: Lang): TelegramInlineButton[][] {
  const t = textOf(lang);
  return [
    [{ text: t.publish, callback_data: cb(ACTIONS.publish, id, version) }],
    [{ text: t.edit, callback_data: cb(ACTIONS.edit, id) }, { text: t.regen, callback_data: cb(ACTIONS.regen, id) }],
    [{ text: t.networks, callback_data: cb(ACTIONS.networks, id) }, { text: t.cancel, callback_data: cb(ACTIONS.cancel, id) }],
  ];
}

async function previewNotes(post: PostRow, item: SocialVideoItem, lang: Lang): Promise<string[]> {
  const t = textOf(lang);
  const notes: string[] = [];
  const { ready, problems } = await readyChannels(post.kind);
  const missing = jsonChannels(post.channels).filter((c) => !ready.includes(c));
  const off = [...new Set([...requestedChannels(post.request).filter((c) => !ready.includes(c)), ...missing])];
  const blocked = ready.filter((c) => !item.channels.includes(c) && blockedFor(item, c));
  const list = [
    ...off.filter((c) => kindChannels(post.kind).includes(c)).map((c) => `${SOCIAL_VIDEO_CHANNEL_LABELS[c]} (${problems.get(c) ?? "не подключён"})`),
    ...blocked.map((c) => `${SOCIAL_VIDEO_CHANNEL_LABELS[c]} (${blockedFor(item, c)})`),
  ];
  if (list.length) notes.push(t.notReady(list.join("; ")));
  const dup = item.duplicateOf;
  if (dup) notes.push(t.duplicate(dup.title, dup.publishedTo.join(", ")));
  return notes;
}

/**
 * Показать (или обновить) превью. Только пока пост не опубликован и не отменён: сначала условно берётся
 * новый номер превью, в конце условно ставится PREVIEW с этим номером, сообщением и отпечатком подписи.
 * Опоздавший показ (пост уже публикуют или есть превью новее) свои кнопки снимает. false — не показано.
 */
async function showPreview(postId: string, extraNotes: string[] = []): Promise<boolean> {
  const bumped = await prisma.staffSocialPost.updateMany({ where: { id: postId, status: { in: SHOWABLE } }, data: { previewVersion: { increment: 1 } } });
  if (!bumped.count) return false;
  const post = await prisma.staffSocialPost.findUnique({ where: { id: postId } });
  if (!post?.socialVideoPostId) return false;
  const item = await getSocialVideo(post.socialVideoPostId);
  const lang = replyLanguage(post.request);
  const t = textOf(lang);
  const { captionAlone, text } = socialPostPreviewParts(item, lang, [...extraNotes, ...(await previewNotes(post, item, lang))]);
  if (post.previewMessageId) await editMessageText(post.chatId, post.previewMessageId, t.updatedBelow, null).catch(() => {});
  if (captionAlone) await sendMessage(post.chatId, captionAlone);
  const sent = await sendMessageWithButtons(post.chatId, text, previewButtons(post.id, post.previewVersion, lang));
  const moved = await prisma.staffSocialPost.updateMany({
    where: { id: post.id, status: { in: SHOWABLE }, previewVersion: post.previewVersion },
    data: { status: "PREVIEW", previewMessageId: sent?.message_id ?? null, previewCaptionHash: previewHash(item) },
  });
  if (!moved.count) {
    if (sent?.message_id) await editMessageText(post.chatId, sent.message_id, t.oldPreview, null).catch(() => {});
    return false;
  }
  return true;
}

// ───────────────────────────── создание поста ─────────────────────────────

/** Служебное название в «Роликах» CRM. Без имени сотрудника (автор и так виден в CRM), в ИИ не уходит. */
function postTitle(kind: string): string {
  const now = new Date();
  return `${kind === "PHOTO" ? "Фото" : "Ролик"} из Telegram · ${dushanbeDateString(now).slice(5).split("-").reverse().join(".")} ${dushanbeTimeString(now)}`.slice(0, 120);
}

/**
 * Черновик + подпись + превью. `makeDraft` создаёт SocialVideoPost той же функцией, что экран CRM.
 * Подпись пишется под выбранные сети (длина и хештеги), затем сети, которым файл не подходит, снимаются.
 * Строку за это время убрала уборка — черновик удаляется, превью не показывается.
 */
async function preparePost(post: PostRow, actor: Actor, transcript: string | null, makeDraft: (channels: SocialVideoChannel[], title: string, brief: string) => Promise<SocialVideoItem>): Promise<void> {
  const lang = replyLanguage(post.request);
  const t = textOf(lang);
  const { ready } = await readyChannels(post.kind);
  const asked = requestedChannels(post.request).filter((c) => ready.includes(c));
  const channels = asked.length ? asked : ready;
  const ownWords = briefOf(post.request);
  const brief = (ownWords.length >= 3 ? ownWords : transcript && transcript.length >= 3 ? transcript : FALLBACK_BRIEF[post.kind === "PHOTO" ? "PHOTO" : "VIDEO"]).slice(0, 2000);
  const item = await makeDraft(channels, postTitle(post.kind), brief);
  const linked = await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: "PREPARING" }, data: { socialVideoPostId: item.id } });
  if (!linked.count) { await deleteSocialVideo(item.id).catch(() => {}); return; }
  logAgentAudit(actor.id, "SOCIAL_VIDEO_CREATED", "SocialVideoPost", item.id, { source: "telegram-shabnam", kind: post.kind, staffSocialPostId: post.id });
  const notes: string[] = [];
  const written = await writeCaption(actor.id, brief, post.language as SocialVideoCaptionLanguage, channels);
  let caption: string;
  if ("caption" in written) caption = written.caption;
  else {
    caption = await fallbackCaption(ownWords, post.language);
    notes.push(written.error === "limit" ? t.captionLimit : t.captionAi);
  }
  const fitting = channels.filter((c) => !blockedFor({ ...item, caption }, c));
  await updateSocialVideo(item.id, { caption, channels: fitting });
  await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: "PREPARING" }, data: { channels: fitting } });
  await showPreview(post.id, notes);
}

/** Сообщение «не можете» по исходу проверки. */
export function gateRefusal(gate: Exclude<SocialPublishGate, { ok: true }>, request: string | null): string {
  return textOf(replyLanguage(request))[gate.reason];
}

/**
 * Ролик из «к какому объекту» (telegram/staffClip.ts) → пост без объекта. Один пост на ролик
 * (staffClipIntakeId уникален): повторное нажатие показывает то же превью, а не второй черновик.
 */
export async function startVideoPostFromClip(input: {
  intakeId: string; chatId: string; actor: Actor; fileId: string; filename: string; caption: string | null; transcript: string | null;
}): Promise<string | null> {
  const gate = await socialPublishGate(input.actor.id);
  if (!gate.ok) return gateRefusal(gate, input.caption);
  const existing = await prisma.staffSocialPost.findUnique({ where: { staffClipIntakeId: input.intakeId } });
  if (existing) {
    if (LIVE.includes(existing.status) || existing.status === "PICKING") { await showPreview(existing.id); return null; }
    if (existing.status === "PREPARING") return null; // первое нажатие ещё готовит пост
    return existing.status === "CANCELLED" ? "Пост по этому ролику отменён. Пришлите ролик ещё раз." : "Этот ролик уже отправлен в публикацию.";
  }
  const lang = replyLanguage(input.caption);
  const post = await prisma.staffSocialPost.create({ data: {
    chatId: input.chatId, agentId: input.actor.id, kind: "VIDEO", staffClipIntakeId: input.intakeId, request: input.caption,
    language: captionLanguageOf(input.caption), expiresAt: new Date(Date.now() + STAFF_SOCIAL_POST_TTL_MS), status: "PREPARING",
  } }).catch(() => null);
  if (!post) return null; // второй заход того же нажатия — первый уже готовит пост
  await sendMessage(input.chatId, textOf(lang).preparing).catch(() => {});
  void sendChatAction(input.chatId).catch(() => {});
  const tmpPath = await videoToTemp(input.fileId);
  if (!tmpPath) {
    // Строку убираем: повторное нажатие должно попробовать снова (staffClipIntakeId уникален).
    await prisma.staffSocialPost.deleteMany({ where: { id: post.id, status: "PREPARING" } }).catch(() => {});
    return textOf(lang).download;
  }
  try {
    await preparePost(post, input.actor, input.transcript, (channels, title, brief) => createSocialVideoFromUpload({
      tmpPath, originalName: safeName(input.filename, ".mp4"), title, caption: "", brief, channels, createdById: input.actor.id,
    }));
    await prisma.staffClipIntake.updateMany({ where: { id: input.intakeId }, data: { status: "FREE", decidedAt: new Date() } });
    return null;
  } catch (err) {
    return failPreparation(post, err, lang);
  } finally {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
  }
}

/** Подготовка не удалась: черновик и строка убираются (в сети ничего не ушло), повтор возможен. */
async function failPreparation(post: PostRow, err: unknown, lang: Lang): Promise<string> {
  const fresh = await prisma.staffSocialPost.findUnique({ where: { id: post.id }, select: { socialVideoPostId: true, status: true } });
  if (fresh?.status === "PREPARING") {
    if (fresh.socialVideoPostId) await deleteSocialVideo(fresh.socialVideoPostId).catch(() => {});
    await prisma.staffSocialPost.deleteMany({ where: { id: post.id, status: "PREPARING" } }).catch(() => {});
  }
  if (err instanceof SocialVideoError) return err.message;
  void logSystemError("telegram", `Шабнам: пост без объекта не подготовлен — ${describeError(err)}`, { dedupKey: "staff-social-prepare" });
  return textOf(lang).failed;
}

const safeName = (name: string, ext: string) => {
  const base = path.basename(name || `file${ext}`).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120);
  return path.extname(base) ? base : `${base}${ext}`;
};

async function videoToTemp(fileId: string): Promise<string | null> {
  const material = await resolveTelegramFileMaterialization(fileId, TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES).catch(() => null);
  if (!material) return null;
  const tmpPath = path.join(videoHandoffDir, `staff-social-${randomUUID()}${material.kind === "path" ? path.extname(material.path) || ".mp4" : ".mp4"}`);
  try {
    await fs.promises.mkdir(videoHandoffDir, { recursive: true });
    if (material.kind === "path") await pipeline(fs.createReadStream(material.path), fs.createWriteStream(tmpPath));
    else await fs.promises.writeFile(tmpPath, material.buffer);
  } catch {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    return null;
  }
  if (material.kind === "path" && isInsideTelegramFilesDir(material.path)) await fs.promises.rm(material.path, { force: true }).catch(() => {});
  return tmpPath;
}

// ───────────────────────────── фото и альбомы ─────────────────────────────

interface PendingAlbum {
  chatId: string; actor: Actor; groupKey: string; request: string; files: Array<{ messageId: number; fileId: string; name: string }>;
  timer?: ReturnType<typeof setTimeout>; done?: Promise<void>; finish?: () => void;
}
const albums = new Map<string, PendingAlbum>();
let albumQuietMs = STAFF_SOCIAL_ALBUM_QUIET_MS;
/** Для тестов: короткое ожидание альбома и «дождаться всех». */
export function setStaffSocialAlbumQuietForTests(ms: number | null) { albumQuietMs = ms ?? STAFF_SOCIAL_ALBUM_QUIET_MS; }
export async function flushStaffSocialAlbumsForTests(): Promise<void> { await Promise.all([...albums.values()].map((a) => a.done)); }

function incomingPhoto(msg: TelegramIncomingMessage): { fileId: string; name: string } | null {
  const photo = msg.photo?.at(-1);
  if (photo) return { fileId: photo.file_id, name: `photo-${msg.message_id}.jpg` };
  const doc = msg.document;
  if (doc && (doc.mime_type?.startsWith("image/") || /\.(?:jpe?g|png|webp|heic|heif)$/iu.test(doc.file_name ?? ""))) {
    return { fileId: doc.file_id, name: doc.file_name ?? `photo-${msg.message_id}.jpg` };
  }
  return null;
}

/**
 * Фото в личке Шабнам с подписью «опубликуй…» (или продолжение уже начатого альбома) → один пост.
 * Без слов о публикации фото сюда не попадают: ими живут расходы и мастер объекта. Мастер объекта
 * стоит в assistantBot.ts РАНЬШЕ: сотрудник в мастере, фото с «выложи» — это фото объекта.
 * true — сообщение разобрано здесь.
 */
export async function handleStaffSocialPhoto(msg: TelegramIncomingMessage, agent: Actor): Promise<boolean> {
  if (msg.chat.type !== "private" || msg.forward_origin || msg.forward_from_message_id) return false;
  const photo = incomingPhoto(msg);
  if (!photo) return false;
  const chatId = String(msg.chat.id);
  const caption = (msg.caption ?? "").trim();
  const groupKey = msg.media_group_id ? `${chatId}:${msg.media_group_id}` : null;
  const open = groupKey ? albums.get(groupKey) : undefined;
  if (!open && !hasPublishIntent(caption)) return false;
  if (!open) {
    // Выключено или нет права маркетинга — не перехватываем: фото идёт своим обычным путём
    // (мастер объекта, обычный ответ Шабнам), где «выложи» может значить совсем другое.
    if (!(await socialPublishGate(agent.id)).ok) return false;
  }
  const key = groupKey ?? `${chatId}:single:${msg.message_id}`;
  let album = albums.get(key);
  if (!album) {
    album = { chatId, actor: agent, groupKey: key, request: caption, files: [] };
    const created = album;
    created.done = trackBackgroundTask(new Promise<void>((resolve) => { created.finish = resolve; }));
    albums.set(key, album);
  }
  if (caption && !album.request) album.request = caption;
  if (album.files.length < SOCIAL_PHOTO_POST_MAX_IMAGES) album.files.push({ messageId: msg.message_id ?? 0, ...photo });
  if (album.timer) clearTimeout(album.timer);
  const current = album;
  current.timer = setTimeout(() => {
    albums.delete(key);
    void createPhotoPost(current).catch(async (err: unknown) => {
      await logSystemError("telegram", `Шабнам: фото-пост без объекта — ${describeError(err)}`, { dedupKey: "staff-social-album" });
    }).finally(() => current.finish?.());
  }, groupKey ? albumQuietMs : 0);
  return true;
}

async function createPhotoPost(album: PendingAlbum): Promise<void> {
  const lang = replyLanguage(album.request);
  const t = textOf(lang);
  const gate = await socialPublishGate(album.actor.id);
  if (!gate.ok) { if (gate.reason === "rights") await sendMessage(album.chatId, gateRefusal(gate, album.request)); return; }
  const files = [...album.files].sort((a, b) => a.messageId - b.messageId);
  const post = await prisma.staffSocialPost.create({ data: {
    chatId: album.chatId, agentId: album.actor.id, kind: "PHOTO", mediaGroupKey: album.groupKey, request: album.request || null,
    language: captionLanguageOf(album.request), expiresAt: new Date(Date.now() + STAFF_SOCIAL_POST_TTL_MS), status: "PREPARING",
  } }).catch(() => null);
  if (!post) return; // этот альбом уже разобран (повтор доставки)
  await sendMessage(album.chatId, t.preparing, files[0]?.messageId).catch(() => {});
  const buffers: Array<{ buffer: Buffer; originalName: string }> = [];
  for (const f of files) {
    try {
      buffers.push({ buffer: await downloadAssistantMedia(f.fileId, SOCIAL_PHOTO_POST_MAX_BYTES), originalName: safeName(f.name, ".jpg") });
    } catch {
      // Не скачалось одно фото — остальные идут; если не скачалось ни одно, ниже честный отказ.
    }
  }
  if (!buffers.length) {
    await prisma.staffSocialPost.deleteMany({ where: { id: post.id, status: "PREPARING" } }).catch(() => {});
    await sendMessage(album.chatId, t.download);
    return;
  }
  try {
    await preparePost(post, album.actor, null, (channels, title, brief) => createSocialPhotoPostFromUpload({
      files: buffers, title, caption: "", brief, channels, createdById: album.actor.id,
    }));
  } catch (err) {
    await sendMessage(album.chatId, await failPreparation(post, err, lang));
  }
}

// ───────────────────────────── новая подпись словами ─────────────────────────────

/** Ответ на «Изменить подпись» (10 минут): следующий текст — подпись как есть (без длинных тире). true — наш ответ. */
export async function handleStaffSocialText(msg: TelegramIncomingMessage, agent: Actor): Promise<boolean> {
  const raw = (msg.text ?? "").trim();
  if (msg.chat.type !== "private" || !raw || raw.startsWith("/") || msg.forward_origin || msg.forward_from_message_id) return false;
  const chatId = String(msg.chat.id);
  const post = await prisma.staffSocialPost.findFirst({
    where: { chatId, agentId: agent.id, status: "EDIT_CAPTION", updatedAt: { gte: new Date(Date.now() - EDIT_CAPTION_WINDOW_MS) } },
    orderBy: { updatedAt: "desc" },
  });
  if (!post?.socialVideoPostId) return false;
  const t = textOf(replyLanguage(post.request));
  if (/^(?:отмена|отменить|бекор|бекор кардан)$/iu.test(raw)) {
    await sendMessage(chatId, t.captionKept);
    await showPreview(post.id);
    return true;
  }
  const text = stripDashes(raw).trim();
  const limit = effectiveCaptionLimit(jsonChannels(post.channels));
  if (text.length > limit) { await sendMessage(chatId, t.captionTooLong(limit)); return true; }
  // Захват на время записи: «Опубликовать» на старом превью в эту секунду не сработает.
  const claimed = await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: "EDIT_CAPTION" }, data: { status: "PREPARING" } });
  if (!claimed.count) return true;
  try {
    await updateSocialVideo(post.socialVideoPostId, { caption: text });
  } finally {
    await showPreview(post.id);
  }
  return true;
}

// ───────────────────────────── кнопки ─────────────────────────────

const CALLBACK = /^spub:([pegntbx]):([\da-f-]{36})(?::(\d{1,6}))?$/u;

/**
 * `spub:<действие>:<id>[:<номер превью или сети>]`. true — наша кнопка.
 * Проверки и захваты статуса — сразу, и кнопка сразу получает ответ; долгое (ИИ, публикация,
 * новое превью) — через `defer`, в очереди этого чата.
 */
export async function handleStaffSocialCallback(query: TelegramCallbackQuery, defer: DeferWork = runInline): Promise<boolean> {
  const match = CALLBACK.exec(query.data ?? "");
  if (!match) return false;
  const answer = (text?: string) => answerCallbackQuery(query.id, text).catch(() => {});
  const chat = query.message?.chat;
  if (chat?.type !== "private" || query.from?.id !== chat.id) { await answer(); return true; }
  const chatId = String(chat.id);
  const messageId = query.message?.message_id ?? null;
  const post = await prisma.staffSocialPost.findUnique({ where: { id: match[2]! } });
  const agent = post ? await prisma.agent.findUnique({ where: { id: post.agentId }, select: { id: true, fullName: true, telegramChatId: true } }) : null;
  // Нажать может только тот, кто прислал файл, из своей же лички.
  if (!post || !agent || post.chatId !== chatId || agent.telegramChatId !== chatId) { await answer(T.ru.stale); return true; }
  const lang = replyLanguage(post.request);
  const t = textOf(lang);
  const action = match[1]!;
  const draftId = post.socialVideoPostId;
  const failed = async (err: unknown) => {
    void logSystemError("telegram", `Шабнам: кнопка поста без объекта — ${describeError(err)}`, { dedupKey: "staff-social-callback" });
    await sendMessage(chatId, t.publishFailed).catch(() => {});
  };
  try {
    if (post.status === "PREPARING") { await answer(t.busy); return true; }
    if (!SHOWABLE.includes(post.status) || !draftId) {
      await answer(post.status === "PUBLISHING" || post.status === "PUBLISHED" ? t.already : t.stale);
      return true;
    }
    if (post.expiresAt < new Date()) { await answer(t.stale); await sendMessage(chatId, t.expired); return true; }
    const gate = await socialPublishGate(agent.id);
    if (!gate.ok) { await answer(); await sendMessage(chatId, gateRefusal(gate, post.request)); return true; }

    if (action === ACTIONS.cancel) {
      const claimed = await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: { in: [...LIVE, "PICKING"] } }, data: { status: "CANCELLED" } });
      if (!claimed.count) { await answer(t.stale); return true; }
      await answer();
      await dropDraftIfStillDraft(draftId);
      logAgentAudit(agent.id, "SOCIAL_VIDEO_DELETED", "SocialVideoPost", draftId, { source: "telegram-shabnam", staffSocialPostId: post.id });
      if (post.previewMessageId) await editMessageText(chatId, post.previewMessageId, t.cancelState, null).catch(() => {});
      await sendMessage(chatId, t.cancelled);
      return true;
    }
    if (action === ACTIONS.edit) {
      const claimed = await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: { in: LIVE } }, data: { status: "EDIT_CAPTION" } });
      await answer(claimed.count ? undefined : t.stale);
      if (claimed.count) await sendMessage(chatId, t.askCaption);
      return true;
    }
    if (action === ACTIONS.regen) {
      // Захват PREPARING: пока пишется новая подпись, «Опубликовать» не сработает, и после ответа ИИ
      // подпись пишется, только если пост всё ещё наш (не опубликован и не отменён).
      const claimed = await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: { in: LIVE } }, data: { status: "PREPARING" } });
      if (!claimed.count) { await answer(t.stale); return true; }
      await answer(t.regenerating);
      await defer(async () => {
        try {
          const item = await getSocialVideo(draftId);
          const ownWords = briefOf(post.request);
          const brief = (item.brief ?? (ownWords.length >= 3 ? ownWords : FALLBACK_BRIEF[post.kind === "PHOTO" ? "PHOTO" : "VIDEO"])).slice(0, 2000);
          const written = await writeCaption(agent.id, brief, post.language as SocialVideoCaptionLanguage, item.channels, [item.caption]);
          const still = await prisma.staffSocialPost.findUnique({ where: { id: post.id }, select: { status: true } });
          if (still?.status !== "PREPARING") return;
          if ("caption" in written) await updateSocialVideo(item.id, { caption: written.caption });
          await showPreview(post.id, "caption" in written ? [] : [written.error === "limit" ? t.captionLimit : t.captionAi]);
        } catch (err) {
          await failed(err);
          await showPreview(post.id).catch(() => false);
        }
      });
      return true;
    }
    if (action === ACTIONS.networks || action === ACTIONS.toggle) {
      if (action === ACTIONS.networks) {
        const claimed = await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: { in: LIVE } }, data: { status: "PICKING" } });
        if (!claimed.count) { await answer(t.stale); return true; }
      } else if (post.status !== "PICKING") { await answer(t.stale); return true; }
      const { ready } = await readyChannels(post.kind);
      const item = await getSocialVideo(draftId);
      let selected = item.channels;
      if (action === ACTIONS.toggle) {
        const channel = kindChannels(post.kind)[Number(match[3])];
        if (!channel || !ready.includes(channel) || blockedFor(item, channel)) { await answer(t.stale); return true; }
        const next = selected.includes(channel) ? selected.filter((c) => c !== channel) : [...selected, channel];
        if (!next.length) { await answer(t.needOne); return true; }
        await updateSocialVideo(item.id, { channels: next });
        await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: "PICKING" }, data: { channels: next } });
        selected = next;
      }
      await answer();
      const rows: TelegramInlineButton[][] = kindChannels(post.kind)
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => ready.includes(c) && !blockedFor(item, c))
        .map(({ c, i }) => [{ text: `${selected.includes(c) ? "✅" : "▫️"} ${SOCIAL_VIDEO_CHANNEL_LABELS[c]}`, callback_data: cb(ACTIONS.toggle, post.id, i) }]);
      rows.push([{ text: t.done, callback_data: cb(ACTIONS.back, post.id) }]);
      if (messageId) await editMessageText(chatId, messageId, t.pickNetworks, rows).catch(() => {});
      else await sendMessageWithButtons(chatId, t.pickNetworks, rows);
      return true;
    }
    if (action === ACTIONS.back) {
      if (post.status !== "PICKING") { await answer(t.stale); return true; }
      await answer();
      await defer(async () => { await showPreview(post.id).catch(failed); });
      return true;
    }

    // «Опубликовать» — только с последнего превью и только то, что в нём показано.
    const version = match[3] === undefined ? null : Number(match[3]);
    if (version === null || version !== post.previewVersion || messageId === null || messageId !== post.previewMessageId) {
      await answer(t.oldPreview);
      return true;
    }
    const claimed = await prisma.staffSocialPost.updateMany({
      where: { id: post.id, status: { in: LIVE }, previewVersion: version, previewMessageId: messageId },
      data: { status: "PUBLISHING" },
    });
    if (!claimed.count) { await answer(t.already); return true; }
    // После захвата подпись никто не перепишет; сверяем, что она та же, что в показанном превью
    // (её могли поменять и в «Роликах» CRM).
    const shown = await getSocialVideo(draftId);
    if (previewHash(shown) !== post.previewCaptionHash) {
      await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: "PUBLISHING" }, data: { status: "PREVIEW" } });
      await answer(t.changed);
      await defer(async () => { await showPreview(post.id).catch(failed); });
      return true;
    }
    await answer(t.sentState);
    await defer(async () => {
      try {
        const item = await publishSocialVideo(draftId, { mode: "NOW" });
        await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: "PUBLISHING" }, data: { status: "PUBLISHED", publishedAt: new Date() } });
        const where = item.channels.map((c) => SOCIAL_VIDEO_CHANNEL_LABELS[c]).join(", ");
        logAgentAudit(agent.id, "SOCIAL_VIDEO_PUBLISH", "SocialVideoPost", item.id, { source: "telegram-shabnam", mode: "NOW", channels: item.channels, staffSocialPostId: post.id });
        await editMessageText(chatId, messageId, `${t.sentState}: ${where}`, null).catch(() => {});
        await sendMessage(chatId, t.queued(where));
      } catch (err) {
        // Публикация не началась (черновик всё ещё черновик) — превью снова живое; началась — отмечаем PUBLISHED.
        const still = await getSocialVideo(draftId).catch(() => null);
        const started = still !== null && still.status !== "DRAFT";
        await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: "PUBLISHING" }, data: started ? { status: "PUBLISHED", publishedAt: new Date() } : { status: "PREVIEW" } });
        if (err instanceof SocialVideoError) { await sendMessage(chatId, t.refused(err.message)); return; }
        if (!started) await failed(err);
        else void logSystemError("telegram", `Шабнам: после запуска публикации — ${describeError(err)}`, { dedupKey: "staff-social-callback" });
      }
    });
    return true;
  } catch (err) {
    await answer();
    await failed(err);
    return true;
  }
}
