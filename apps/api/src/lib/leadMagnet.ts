import { matchesKeyword } from "@royal-home/shared";
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { publicUploadUrl } from "./crmPublicUrl.js";
import { instagramShortcode } from "../messengers/sharedMedia.js";
import { appendConversationMessages } from "../messengers/appendMessages.js";
import { ensureConversationId } from "../messengers/conversationStore.js";
import { accountTokenById, listAccounts, resolveIncomingAccount } from "../messengers/accounts.js";
import { detectSpam } from "./incomingSpam.js";
import {
  describeError,
  fetchInstagramProfile,
  FileUnsupportedInChannelError,
  sendButtonCard,
  sendFile,
  sendMessage,
  sendPrivateReply,
  sendQuickReplies,
  type QuickReplyButton,
} from "../messengers/meta.js";

/**
 * ВОРОНКА «КОММЕНТАРИЙ → ЧЕК-ЛИСТ В ДИРЕКТ».
 *
 * Человек пишет ключевое слово под рекламным роликом — бот отвечает публично и
 * присылает файл в личные сообщения. Между «написал» и «получил» стоит проверка
 * подписки, потому что ради неё лид-магнит и делается.
 *
 * ЗДЕСЬ НЕТ НИ ОДНОГО ОБРАЩЕНИЯ К ИИ, И ЭТО РЕШЕНИЕ, А НЕ ЭКОНОМИЯ НА СПИЧКАХ.
 * Ключевое слово, проверка подписки, выдача файла — конечный автомат: думать не о
 * чем, вариантов ровно столько, сколько ступеней. Реклама приводит сотни человек
 * за вечер, и ход модели на каждого стоил бы денег ради решения, которое
 * принимается сравнением строк. Модель подключается ровно там, где начинается
 * разговор: человек получил файл и спросил про квартиры — дальше обычный бот.
 *
 * ПОЧЕМУ ВООБЩЕ ДВА ШАГА, А НЕ «ПРОВЕРИЛ И ОТПРАВИЛ». Meta разрешает по
 * комментарию отправить РОВНО ОДНО сообщение (private reply), и продолжить
 * переписку можно, только если человек ответил. Поэтому первым письмом уходит не
 * файл, а кнопка: её нажатие — это ответ, который открывает окно переписки. Заодно
 * это отсеивает случайных: за файлом тянется тот, кому он нужен.
 *
 * Побочная выгода, ради которой этот путь стоит предпочитать обычному «напишите
 * нам в директ»: разговор начинает БИЗНЕС, а не клиент. Сообщения от новых людей
 * Instagram кладёт в папку «Запросы», откуда вебхук их не приносит (проверено на
 * живом аккаунте 14.08.2026; у ManyChat ровно та же беда). Переписка, начатая
 * нашим ответом на комментарий, сразу попадает в основной ящик — и всё, что
 * человек пишет дальше, доходит нормально.
 */

/**
 * КНОПКА — НЕ ГАРАНТИЯ, И ТЕКСТ ОБЯЗАН РАБОТАТЬ БЕЗ НЕЁ (16.08.2026, живой прогон).
 *
 * Первый настоящий человек воронки получил приглашение «ба тугмаи зерин пахш
 * кунед» — и никакой кнопки под ним: ВЕБ-версия Instagram quick-reply-кнопки не
 * рисует вовсе (Meta запрос приняла, CRM честно записала «с кнопкой ушло»). На
 * телефоне кнопка обычно видна, но полагаться на «обычно» в оплаченной рекламе
 * нельзя.
 *
 * Сама логика от кнопки не зависит давно: ступень определяется состоянием записи,
 * и ЛЮБОЙ ответ человека двигает воронку дальше. Не знал об этом только человек —
 * текст говорил «нажмите кнопку», которой нет. Поэтому к каждому шагу с кнопкой
 * дописывается запасная строка: не видно кнопку — просто ответьте «+».
 *
 * Дописывается ПРИ ОТПРАВКЕ, а не в настройках: текст в Настройках принадлежит
 * владельцу, и молча переписывать его нельзя, а забыть дописать при следующей
 * кампании — легко.
 */
const NO_BUTTON_FALLBACK = 'Агар тугма нанамояд, дар ҷавоб "+" нависед.';

/** Уже сказал это владелец своими словами — не дублируем. */
function hasOwnButtonHint(text: string): boolean {
  return /["«+»"]\s*нависед|напишите\s*["«+»]/iu.test(text);
}

function withButtonFallback(text: string): string {
  if (hasOwnButtonHint(text)) return text;
  return `${text}\n\n${NO_BUTTON_FALLBACK}`;
}

/**
 * Та же подсказка, но ОТДЕЛЬНОЙ строкой карточки (см. explicitSubtitle в meta.ts).
 *
 * Зачем понадобилось (17.08.2026, разбор «половина не нажимает»): подсказку
 * завели 16.08 для тех, у кого кнопка не рисуется, но дописывали её только на
 * ЗАПАСНЫХ путях отправки. А уходило всё карточкой — 18 отправок из 18, ни
 * одного отката, — то есть подсказку не увидел ни один человек. Те, у кого
 * карточка не нарисовалась, получали пустое место и не знали, что делать.
 *
 * Приклеить её к тексту нельзя: карточка режет длинное по ближайшему пробелу, и
 * фраза разорвалась бы пополам — ровно то, на что владелец жаловался. Поэтому
 * подзаголовком, целой фразой.
 */
function buttonHintSubtitle(text: string): string | undefined {
  return hasOwnButtonHint(text) ? undefined : NO_BUTTON_FALLBACK;
}

/**
 * ТРИ ОДИНАКОВЫХ «ОБУНАРО ҲАНӮЗ НАМЕБИНАМ» ПОДРЯД — ЭТО НЕ ОТВЕТ, А ЗАЦИКЛИВАНИЕ
 * (разбор живых переписок 22.08.2026).
 *
 * Текст повторной просьбы в кампании один (`notFollowingText`), и человек получал
 * его слово в слово столько раз, сколько разрешает `maxFollowChecks`. Со стороны это
 * выглядит сломанным автоматом: он делает то же самое и ждёт другого результата, а
 * человек не понимает ни что делать, ни сколько это продлится.
 *
 * Второй строкой карточки — ровно то, чего в тексте владельца нет и быть не должно:
 * что именно надо сделать и что просить будем не бесконечно. Текст владельца при
 * этом не переписывается (то же правило, что у NO_BUTTON_FALLBACK выше).
 */
const FOLLOW_RETRY_HINT = "Аввал обуна шавед, баъд тугмаро пахш кунед.";
const FOLLOW_LAST_HINT = "Ин дафъаи охирин мепурсем.";

/**
 * ЗАПАСНОЙ ПУТЬ «+» НЕ УБИРАЕТСЯ И НА ПОВТОРАХ (уточнение 22.08.2026).
 *
 * Соблазн был: человек, дошедший до повторной просьбы, один раз уже ответил —
 * значит кнопку нашёл, и подсказку про «+» можно заменить полезной. Но нашёл он
 * её не обязательно: у кого Instagram кнопку не рисует вовсе, «+» — единственный
 * способ пройти дальше, и, убрав подсказку, мы запираем ровно тех, кому она и
 * писалась. Поэтому обе строки: чем именно этот повтор отличается от прошлого И
 * как быть, если кнопки не видно. Вторая исчезает сама, если владелец объяснил
 * кнопку в своём тексте (buttonHintSubtitle) — дублировать его мы не лезем.
 */
function followRetrySubtitle(checks: number, maxChecks: number, rawAsk: string): string {
  const base = checks >= maxChecks ? FOLLOW_LAST_HINT : FOLLOW_RETRY_HINT;
  const noButton = buttonHintSubtitle(rawAsk);
  return noButton ? `${base} ${noButton}` : base;
}

/** Метка в кнопке. Наружу не видна — по ней воронка узнаёт своё нажатие. */
const PAYLOAD_PREFIX = "lm";
const wantPayload = (campaignId: string): string => `${PAYLOAD_PREFIX}:${campaignId}:want`;
const followPayload = (campaignId: string): string => `${PAYLOAD_PREFIX}:${campaignId}:followed`;

/** Кампании читаются на каждый комментарий, а комментарии идут пачками: под
 *  рекламным роликом их сотни. Настройки за минуту не меняются. */
const CACHE_MS = 60_000;
let cache: { at: number; value: ActiveCampaign[] } | null = null;

export interface ActiveCampaign {
  id: string;
  name: string;
  enabled: boolean;
  /** Аккаунт, чьи комментарии ловит кампания. null — любой (см. pickCampaign). */
  accountId: string | null;
  postUrl: string | null;
  mediaId: string | null;
  keywords: string[];
  anyComment: boolean;
  publicReplies: string[];
  inviteText: string;
  inviteButton: string;
  requireFollow: boolean;
  followText: string;
  followButton: string;
  notFollowingText: string;
  maxFollowChecks: number;
  deliverIfUnsure: boolean;
  /** Второе «я подписался» открывает выдачу, даже если Instagram подписки не видит. */
  deliverOnSecondClaim: boolean;
  /** Требовать подписку на ВСЕ наши аккаунты Instagram, а не только на «свой». */
  requireFollowAll: boolean;
  /** Ещё публикации этой же кампании — работают наравне с одиночными postUrl/mediaId. */
  postUrls: string[];
  mediaIds: string[];
  deliveredText: string;
  filePath: string | null;
  fileName: string | null;
  link: string | null;
  handoffToBot: boolean;
}

const CAMPAIGN_FIELDS = {
  id: true,
  name: true,
  enabled: true,
  accountId: true,
  postUrl: true,
  mediaId: true,
  keywords: true,
  anyComment: true,
  publicReplies: true,
  inviteText: true,
  inviteButton: true,
  requireFollow: true,
  followText: true,
  followButton: true,
  notFollowingText: true,
  maxFollowChecks: true,
  deliverIfUnsure: true,
  deliverOnSecondClaim: true,
  requireFollowAll: true,
  postUrls: true,
  mediaIds: true,
  deliveredText: true,
  filePath: true,
  fileName: true,
  link: true,
  handoffToBot: true,
} as const;

/** Сбрасывается при любой правке кампаний (routes/leadMagnets.ts): включённая
 *  кампания обязана заработать сразу, а не через минуту. */
export function invalidateLeadMagnetCache(): void {
  cache = null;
}

/** Все кампании, включая выключенные: две ступени воронки смотрят на них по-разному
 *  (см. `leadMagnetActive` и `leadMagnetInUse`), а запрос и кэш должны быть одни. */
async function loadCampaigns(): Promise<ActiveCampaign[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const rows = await prisma.leadMagnetCampaign.findMany({
      select: CAMPAIGN_FIELDS,
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    cache = { at: Date.now(), value: rows };
    return rows;
  } catch (err) {
    void logSystemError("meta", `Кампании воронки не прочитаны: ${describeError(err)}`);
    // Пустой список, а не бросок: отказ базы не должен ронять обработку
    // комментария целиком — обычный ответ бота важнее лид-магнита.
    return [];
  }
}

/** Ловим ли мы сейчас НОВЫХ людей. Дешёвый вопрос перед дорогими шагами: без
 *  включённых кампаний ни один комментарий воронки не касается. */
export async function leadMagnetActive(): Promise<boolean> {
  return (await loadCampaigns()).some((c) => c.enabled);
}

/**
 * КЛЮЧЕВОЕ СЛОВО ВОРОНКИ — ЭТО НЕ ВОПРОС К БОТУ (замечание владельца 16.08.2026).
 *
 * Живой случай: кампанию забыли включить, человек написал под роликом «Дастур», и
 * ответил обычный бот-консультант: «Салом! Ба директ нависед». Для человека это
 * пустой ответ — он написал кодовое слово ради файла, а получил приглашение куда-то
 * писать. Хуже того, реклама уже оплачена, и такие отклики уходят впустую молча.
 *
 * Поэтому смотрим ВСЕ кампании, включая выключенные: слово из воронки принадлежит
 * воронке. Не сработала она — комментарий остаётся без ответа, а в журнал уходит
 * причина. Ответ от постороннего бота хуже молчания: он выглядит как выполненное
 * обещание и закрывает человеку повод написать ещё раз.
 */
export async function isFunnelKeyword(input: {
  text: string;
  /** Публикация, под которой оставлен комментарий, — id и адрес из вебхука. */
  mediaId?: string;
  permalink?: string;
}): Promise<{ campaignName: string; enabled: boolean; reason: "keyword" | "post" } | null> {
  const campaigns = await loadCampaigns();
  const commentCode = instagramShortcode(input.permalink);

  for (const c of campaigns) {
    if (c.keywords.length > 0 && matchesKeyword(input.text, c.keywords)) {
      return { campaignName: c.name, enabled: c.enabled, reason: "keyword" };
    }
    /**
     * ПУБЛИКАЦИЯ ВОРОНКИ — ТОЖЕ ЕЁ ТЕРРИТОРИЯ.
     *
     * Кампанию часто настраивают без ключевых слов вовсе: «ловим любой комментарий
     * под этим роликом» (anyComment) — так владелец и завёл «Чеклист дастур»
     * 16.08.2026. Проверять только слова там нечего, и обычный бот снова забрал бы
     * себе комментарии, стоит кампании выключиться. Под рекламным роликом это
     * особенно дорого: туда пишут именно за файлом.
     */
    /**
     * Одиночные postUrl/mediaId и списки postUrls/mediaIds — тот же смысл, что и в
     * pickCampaign ниже по файлу: «эта кампания про эти публикации». Забыть про
     * списки здесь означало бы, что комментарий под ВТОРЫМ роликом кампании уходит
     * обычному ИИ-боту вместо приглашения с файлом — ровно тот сбой, который эта
     * функция и существует, чтобы предотвратить (см. комментарий выше).
     */
    const wantedIds = [c.mediaId, ...(c.mediaIds ?? [])].filter((v): v is string => Boolean(v));
    const wantedCodes = [c.postUrl, ...(c.postUrls ?? [])]
      .map((u) => instagramShortcode(u ?? undefined))
      .filter((v): v is string => Boolean(v));
    const byId = Boolean(input.mediaId && wantedIds.includes(input.mediaId));
    const byCode = Boolean(commentCode && wantedCodes.includes(commentCode));
    if (byId || byCode) return { campaignName: c.name, enabled: c.enabled, reason: "post" };
  }
  return null;
}

/**
 * Есть ли в CRM хоть одна кампания — вопрос ступени в личных сообщениях.
 *
 * Здесь нарочно НЕ проверяется «включена». Кампанию выключают, когда реклама
 * закончилась, а люди, уже получившие приглашение, продолжают нажимать кнопку
 * ещё сутками. Обещание им дала CRM, и не сдержать его из-за того, что владелец
 * убрал галочку, — худший исход: человек нажал кнопку и не получил ничего.
 * Новых в воронку выключенная кампания при этом не пускает (см. `pickCampaign`).
 */
async function leadMagnetInUse(): Promise<boolean> {
  return (await loadCampaigns()).length > 0;
}

/**
 * У ЭТОГО АВТОРА УЖЕ ВИСИТ ВЫДАЧА — ЗНАЧИТ, ОТВЕЧАЕТ ТОЛЬКО ВОРОНКА.
 *
 * Личные сообщения от этого человека уже гасит `tryLeadMagnetMessage` по
 * состоянию записи (см. вызов в webhooks.ts). У КОММЕНТАРИЕВ такого щита не
 * было: `handleComment` пропускал к обычному ИИ-боту (`decideOnComment` →
 * `maybeSendPrivateReply`) любой комментарий, чей текст не совпал с ключевым
 * словом кампании — а между приглашением и подтверждением подписки человек
 * почти всегда пишет что-то СВОИМИ словами («ок», «готово», простое спасибо),
 * которое ни на одно ключевое слово не похоже. Бот отвечал за воронку сам —
 * без файла, придумывая от себя «спасибо за подписку, вот материалы» — и
 * получалось два разных «спасибо» на одного человека: одно настоящее с
 * файлом (когда воронка наконец сработает), одно выдуманное моделью раньше
 * (см. память `royalhome-funnel-double-send-echo-mid-17-08`).
 */
export async function hasPendingLeadMagnetDelivery(igUserId: string): Promise<boolean> {
  const pending = await prisma.leadMagnetDelivery.findFirst({
    where: { igUserId, state: { in: ["INVITED", "AWAITING_FOLLOW"] } },
    select: { id: true },
  });
  return Boolean(pending);
}

// ─── Ступень 1: комментарий ─────────────────────────────────────────────────

export interface LeadMagnetComment {
  commentId: string;
  mediaId: string;
  /** В какой НАШ аккаунт пришёл комментарий — им же уходит личное приглашение. */
  accountExternalId?: string;
  parentId: string | null;
  authorId: string;
  authorName: string | null;
  text: string;
  createdAt: Date;
}

export interface LeadMagnetCommentResult {
  campaignId: string;
  campaignName: string;
  /** Что опубликовать под комментарием. null — публично не отвечаем. */
  publicReply: string | null;
  /** Ушло ли личное сообщение с кнопкой. */
  dmSent: boolean;
  /** Текст личного — его показывает лента комментариев в CRM. */
  dmText: string | null;
  /** Почему ход закончился так, а не иначе, — для журнала. */
  note: string;
}

/** Личное сообщение по комментарию Meta разрешает 7 суток. Столько же и здесь:
 *  писать позже некуда, и попытка стоила бы отказа в журнале на ровном месте. */
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Комментарий под публикацией: наш ли он.
 *
 * `permalink` — адрес публикации; передаёт его вызывающий (messengers/comments.ts),
 * потому что у него этот адрес уже загружен и закэширован. Просить его отдельно
 * значило бы второй раз ходить в Graph API за тем же самым.
 *
 * null — воронка к этому комментарию отношения не имеет, и он идёт обычным путём.
 */
export async function tryLeadMagnetComment(
  row: LeadMagnetComment,
  permalink?: string
): Promise<LeadMagnetCommentResult | null> {
  // Комментарий мог прийти в любой из подключённых Instagram — личное сообщение
  // обязано уйти ТЕМ ЖЕ аккаунтом, иначе Meta отклонит отправку чужим токеном,
  // а без аккаунтов в CRM (см. messengers/accounts.ts) — прежним поведением.
  const account = await resolveIncomingAccount("INSTAGRAM", row.accountExternalId);
  // Ответ внутри ветки — не обращение к нам с ключевым словом, а разговор двух
  // подписчиков. Личное по нему Meta всё равно не примет (нужен корневой).
  if (row.parentId) return null;

  // Аккаунт получателя передаём В ОТБОР: кампания второго зеркала соавторского
  // поста не должна отвечать на комментарий первого (см. pickCampaign).
  const campaign = await pickCampaign(row, permalink, account.id);
  if (!campaign) return null;

  /**
   * ДОСЬЕ КОММЕНТАТОРА ВОРОНКИ — НЕЗАВИСИМО ОТ ТОГО, УШЛО ЛИ ПРИГЛАШЕНИЕ (находка
   * ночной проверки 24.09.2026, тот же класс, что у Б8 в messengers/comments.ts).
   *
   * Раньше recordInConversation вызывалась только при `dmSent === true` (см.
   * ниже) — то есть карточка (BotConversation + досье) заводилась ТОЛЬКО когда
   * приглашение с кнопкой получалось отправить. Окно ответа старше 7 суток
   * (note="lm_window"), человек уже в очереди без права на повтор
   * (note="lm_repeat") и сам сбой отправки (note="lm_dm_failed") — во всех этих
   * случаях комментатор терялся так же, как и в обычном боте до правки Б8.
   *
   * Место — СРАЗУ ПОСЛЕ того, как кампания найдена (pickCampaign выше уже отсеял
   * ответ внутри ветки и для anyComment-кампаний — явную грубость/спам через
   * isHostileComment; для кампаний по ключевому слову спам-фильтра здесь как не
   * было, так и нет — это отдельное решение продукта, не эта правка), и ДО любого
   * из трёх исходов ниже — так карточка не зависит от того, каким из них дело
   * закончится.
   *
   * Вызов пустой (`outgoing: []`) — сама запись реплики в хронологию переписки, как
   * и раньше, происходит только при удачной отправке (см. recordInConversation
   * ниже, при `dmSent === true`); здесь только заводится/находится карточка.
   * ensureConversationId внутри дедуплицирует по паре (channel, subscriberId) — тот
   * же приём, что и в comments.ts, повторный комментарий второй карточки не заводит.
   */
  await recordInConversation(row.authorId, row.authorName, null, [], account);

  if (Date.now() - row.createdAt.getTime() > PRIVATE_REPLY_WINDOW_MS) {
    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      publicReply: null,
      dmSent: false,
      dmText: null,
      note: "lm_window",
    };
  }

  /**
   * ЗАПИСЬ ВЫДАЧИ — ОНА ЖЕ ЗАМОК ОТ ПОВТОРА.
   *
   * Человек пишет ключевое слово трижды подряд (так делают все, кому не ответили
   * за минуту), Meta доставляет одно событие дважды, крон берёт комментарий на
   * второй заход после сбоя — во всех трёх случаях личное сообщение должно уйти
   * ОДНО. Держится это на ограничении базы (уникальная пара кампания+человек), а
   * не на проверке в коде: две проверки могут пройти одновременно, ограничение —
   * нет.
   */
  const created = await prisma.leadMagnetDelivery.createMany({
    data: [
      {
        campaignId: campaign.id,
        igUserId: row.authorId,
        username: row.authorName,
        commentId: row.commentId,
        commentText: row.text.slice(0, 500),
        state: "INVITED",
      },
    ],
    skipDuplicates: true,
  });

  let publicReply = pickPublicReply(campaign, row.commentId);
  /** Приглашение уходит ВТОРОЙ раз тому, кто застрял без файла (см. stillWaiting). */
  let reinvited = false;

  if (created.count === 0) {
    /**
     * Человек уже в воронке — второго приглашения не будет. Публичный ответ тоже:
     * одинаковые реплики под одним постом читаются как накрутка.
     *
     * ЕДИНСТВЕННОЕ ИСКЛЮЧЕНИЕ — приглашение не ушло вовсе. Meta ответила отказом
     * (сеть, 500, истёкший маркер), запись осталась в FAILED, и человек, ничего
     * не получивший, для воронки больше не существует: следующая ступень ищет
     * только INVITED и AWAITING_FOLLOW, а этот комментарий упирается в замок от
     * повтора. Один отказ сети — и оплаченный рекламой лид потерян навсегда,
     * причём молча. Поэтому здесь пробуем ещё раз: человек написал снова, значит
     * он всё ещё ждёт файл.
     */
    const stuck = await prisma.leadMagnetDelivery.findUnique({
      where: { campaignId_igUserId: { campaignId: campaign.id, igUserId: row.authorId } },
      select: { id: true, state: true, askedFollowAt: true, deliveredAt: true, updatedAt: true },
    });
    const inviteNeverReached = stuck?.state === "FAILED" && !stuck.askedFollowAt && !stuck.deliveredAt;
    /**
     * ПРИГЛАШЕНИЕ УШЛО, А ЧЕЛОВЕК ВСЁ РАВНО ПИШЕТ ПОД ПОСТОМ (прод, 22.08.2026).
     *
     * На проде 29 человек из 79 застряли в INVITED: приглашение отправлено, а
     * файла нет — и такие люди возвращаются под ролик и пишут «Гирифтани PDF» или
     * «Где мой дастур?» ещё раз. Раньше это был чистый `lm_repeat`: ни файла, ни
     * ответа, ни строки в журнале. Причина у застревания обычно одна — приглашение
     * человек не увидел: Instagram кладёт такое сообщение в «Запросы», карточку с
     * кнопкой веб-версия не рисует, уведомление теряется.
     *
     * Повторное приглашение здесь ЗАКОННО и по правилам Meta: разрешение «одно
     * личное на комментарий» считается по комментарию, а это НОВЫЙ комментарий.
     *
     * Пауза обязательна: человек, написавший кодовое слово трижды за минуту (так
     * делают все, кому не ответили сразу), не должен получить три сообщения. Час —
     * это «он ушёл и вернулся», а не «пишет подряд».
     */
    const REINVITE_COOLDOWN_MS = 60 * 60 * 1000;
    const stillWaiting =
      (stuck?.state === "INVITED" || stuck?.state === "AWAITING_FOLLOW") &&
      !stuck.deliveredAt &&
      Date.now() - stuck.updatedAt.getTime() > REINVITE_COOLDOWN_MS;
    if (!inviteNeverReached && !stillWaiting) {
      return {
        campaignId: campaign.id,
        campaignName: campaign.name,
        publicReply: null,
        dmSent: false,
        dmText: null,
        note: "lm_repeat",
      };
    }
    // Состояние НЕ откатываем у того, кто уже дошёл до ступени подписки: он там и
    // остаётся, ему просто заново уходит приглашение с кнопкой — нажатие открывает
    // окно переписки, а дальше воронка сама разберётся по состоянию записи.
    await prisma.leadMagnetDelivery.update({
      where: { id: stuck!.id },
      data: {
        ...(stuck!.state === "AWAITING_FOLLOW" ? {} : { state: "INVITED" }),
        commentId: row.commentId,
        lastError: null,
      },
    });
    if (stillWaiting) {
      // Публично второй раз не отвечаем: тот же текст под тем же постом читается
      // как накрутка, а нужное человеку — приглашение — уходит ему в личные.
      publicReply = null;
      reinvited = true;
      void logSystemError(
        "meta",
        `Воронка «${campaign.name}»: человек снова написал под публикацией, хотя приглашение ему уже уходило ` +
          `и файла он так и не получил. Отправляем приглашение повторно — обычно это значит, что первое ` +
          `сообщение он не увидел (Instagram кладёт письма от новых собеседников в «Запросы»).`
      );
    }
  }

  const button: QuickReplyButton = { title: campaign.inviteButton, payload: wantPayload(campaign.id) };
  let dmSent = false;
  let note = "lead_magnet";
  /**
   * ТРИ ПОПЫТКИ, ОТ КРАСИВОЙ К НАДЁЖНОЙ (владелец 16.08.2026: «кнопка обязательно»).
   *
   * 1. Карточка generic template — настоящая кнопка ВНУТРИ пузыря, её рисуют и
   *    приложение, и веб. Так выглядят кнопки ManyChat.
   * 2. Quick reply — прежний путь: кнопка-подсказка, видна только в приложении.
   *    К тексту дописывается запасная строка «ответьте +» — для тех, кто в вебе.
   * 3. Чистый текст — воронка работает и так: ЛЮБОЙ ответ человека двигает её
   *    дальше, ступень определяется состоянием записи, а не нажатием.
   *
   * Лестница, а не одна попытка, потому что форматы Meta меняются молча, а лид
   * с оплаченной рекламы не должен зависеть от того, что она поменяла сегодня.
   */
  /** Чем Meta назвала отправленное приглашение. Кладём в выдачу (см. inviteMid):
   *  без него «пустое сообщение» разбирается только косвенно. */
  let inviteMid: string | null = null;
  try {
    inviteMid = await sendButtonCard(
      "INSTAGRAM",
      row.commentId,
      campaign.inviteText,
      button,
      account.token,
      true,
      buttonHintSubtitle(campaign.inviteText)
    );
    dmSent = true;
  } catch {
    try {
      inviteMid = await sendPrivateReply(row.commentId, withButtonFallback(campaign.inviteText), [button], account.token);
      dmSent = true;
      note = "lm_quick_reply";
    } catch (err) {
      void logSystemError("meta", `Воронка «${campaign.name}»: приглашение с кнопкой не ушло: ${describeError(err)}`);
      try {
        inviteMid = await sendPrivateReply(row.commentId, withButtonFallback(campaign.inviteText), [], account.token);
        dmSent = true;
        note = "lm_no_button";
      } catch (plain) {
        note = "lm_dm_failed";
        await markFailed(campaign.id, row.authorId, describeError(plain));
        void logSystemError("meta", `Воронка «${campaign.name}»: личное сообщение не ушло: ${describeError(plain)}`);
      }
    }
  }

  // Пометка в журнале комментариев: повторное приглашение видно отдельно от первого,
  // иначе «почему человеку ушло два письма» разбирается только по времени.
  if (reinvited && dmSent && note === "lead_magnet") note = "lm_reinvite";

  if (dmSent)
    await recordInConversation(
      row.authorId,
      row.authorName,
      null,
      [{ text: campaign.inviteText, mid: inviteMid }],
      account
    );

  /**
   * Чем Meta назвала приглашение — в выдачу, рядом с состоянием воронки.
   *
   * updateMany, а не update: запись создана выше по паре «кампания + человек», но
   * между созданием и этой строкой прошла отправка, и запись могла исчезнуть
   * (удалили кампанию). Ронять из-за этого уже отправленное сообщение нельзя —
   * идентификатор нужен для разбора, а не для работы воронки, поэтому отказ
   * только в журнал.
   *
   * ЖДЁМ, а не пишем в фоне. Фоновая запись не успевала за возвратом из функции —
   * поймано тестом: обработчик комментария завершался раньше, чем UPDATE доходил
   * до базы, и поле оставалось пустым ровно в том случае, ради которого заведено.
   * Стоит это один UPDATE рядом с уже ожидаемым recordInConversation.
   */
  if (dmSent && inviteMid) {
    try {
      await prisma.leadMagnetDelivery.updateMany({
        where: { campaignId: campaign.id, igUserId: row.authorId },
        data: { inviteMid },
      });
    } catch (err) {
      void logSystemError("meta", `Воронка: mid приглашения не записан: ${describeError(err)}`);
    }
  }

  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    publicReply,
    dmSent,
    dmText: dmSent ? campaign.inviteText : null,
    note,
  };
}

/**
 * Какая кампания ловит этот комментарий.
 *
 * Публикация сверяется по короткому коду адреса, а не по строке целиком: у одной
 * и той же публикации адреса отличаются доменом и хвостом `?igsh=…`, и сравнение
 * строк не сошлось бы никогда (та же причина, что в messengers/sharedMedia.ts).
 *
 * Найденный `mediaId` запоминается в кампании: в вебхуке комментария есть только
 * он, и следующее совпадение обойдётся сравнением двух строк вместо разбора адреса.
 */
async function pickCampaign(
  row: LeadMagnetComment,
  permalink?: string,
  /**
   * Наш аккаунт, В ЧЕЙ вебхук пришёл этот комментарий. Кампания, привязанная к
   * другому аккаунту, его не видит.
   *
   * Ради этого поле и появилось (17.08.2026): одно видео выложили на оба аккаунта
   * СОАВТОРАМИ, Meta доставила комментарий в вебхуки обоих, и человек получил два
   * приглашения — по одному от каждого зеркала. Замок выдачи стоит по паре
   * «кампания + человек» и две разные кампании не считает повтором.
   *
   * undefined — получателя опознать не удалось: тогда ведём себя как раньше и
   * смотрим все кампании, иначе воронка молча перестала бы работать там, где
   * раньше работала.
   */
  accountId?: string | null
): Promise<ActiveCampaign | null> {
  const campaigns = (await loadCampaigns()).filter(
    (c) => c.enabled && (!c.accountId || !accountId || c.accountId === accountId)
  );
  if (campaigns.length === 0) return null;
  const commentCode = instagramShortcode(permalink);

  for (const c of campaigns) {
    /**
     * Одиночные postUrl/mediaId и списки postUrls/mediaIds — один и тот же смысл:
     * «эта кампания про эти публикации». Списки добавлены 30.08.2026, чтобы не
     * заводить копию кампании на каждый ролик; одиночные поля остались, потому что
     * ими привязаны живые кампании и переносить их молча нельзя.
     */
    const wantedIds = [c.mediaId, ...(c.mediaIds ?? [])].filter((v): v is string => Boolean(v));
    const wantedCodes = [c.postUrl, ...(c.postUrls ?? [])]
      .map((u) => instagramShortcode(u ?? undefined))
      .filter((v): v is string => Boolean(v));
    const targeted = wantedIds.length > 0 || wantedCodes.length > 0;
    if (targeted) {
      const byId = Boolean(row.mediaId && wantedIds.includes(row.mediaId));
      const wantedCode = wantedCodes[0];
      const byCode = Boolean(commentCode && wantedCodes.includes(commentCode));
      /**
       * СВЕРЯТЬ БЫЛО НЕЧЕМ — И РАНЬШЕ ЭТО ПРОХОДИЛО МОЛЧА (прод, 22.08.2026).
       *
       * Кампания «Чеклист дастур (копия)» стояла со ссылкой и без mediaId и за
       * неделю не выдала НИ ОДНОГО файла, хотя под её публикацией было 20
       * комментариев. Причина не в ссылке: единственный способ сопоставить
       * кампанию, у которой заполнен только postUrl, — короткий код из permalink
       * комментария, а permalink приходит из Graph API и не приходил вовсе (чужой
       * маркер, см. fetchMedia в messengers/comments.ts). Кампания просто
       * пропускалась в этом `continue`, и в журнале не было ни строки.
       *
       * Теперь причина названа своим именем. Дедуп записей в lib/systemError.ts
       * сверяет текст целиком, поэтому здесь нет ни кода поста, ни идентификатора
       * комментария: иначе одинаковая по смыслу запись будила бы владельца
       * утренней сводкой на каждый комментарий.
       */
      if (!byId && !byCode && wantedCode && !commentCode) {
        void logSystemError(
          "meta",
          `Воронка «${c.name}» не сопоставлена: кампания привязана ССЫЛКОЙ на публикацию, а адрес публикации ` +
            `комментария прочитать не удалось — сверять нечего, и файл никому не уйдёт. Причина обычно в ` +
            `предыдущей записи «Публикация Instagram … не получена». Лечится либо восстановлением доступа к ` +
            `публикации, либо тем, что в кампании указан её идентификатор (mediaId), а не только ссылка.`
        );
      }
      if (!byId && !byCode) continue;
      if (byCode && c.mediaId !== row.mediaId) void rememberMediaId(c.id, row.mediaId);
    }
    // Ключевое слово — согласие человека на воронку, оно главнее всего остального.
    if (matchesKeyword(row.text, c.keywords)) return c;
    // Без ключевых слов кампания ловит всё под своей публикацией — так делают,
    // когда в ролике сказано «напишите что угодно под этим видео». Но «всё» не
    // значит буквально всё: см. isHostileComment.
    if (c.anyComment && !isHostileComment(row.text)) return c;
  }
  return null;
}

/** Смайлики-грубости — та же грамматика, что у комментариев (messengers/comments.ts);
 *  своя копия, потому что импорт оттуда закольцевал бы модули. */
/** Перечислением, а не квадратными скобками: `☠️` — два символа, и модификатор
 *  начертания U+FE0F в скобках становился отдельным членом списка, из-за чего
 *  «грубым» читался любой цветной смайлик («Раҳмат ❤️») и такой человек молча
 *  выпадал из воронки. Найдено тестом 22.08.2026, та же правка в comments.ts. */
const RUDE_EMOJI = /🖕|💩|🤮|🤢|🤡|👿|😡|🤬|💀|☠️/u;

/**
 * Комментарий, на который НЕЛЬЗЯ отвечать заготовкой «чек-лист готов!».
 *
 * Кампания «на любой комментарий» до 16.08.2026 отвечала ею буквально на всё:
 * человек пишет «мошенники!» — и получает в директ бодрое приглашение за файлом.
 * Со стороны это читается как издевательство, и скрыть такой комментарий модель
 * уже не может — воронка перехватила его раньше модерации.
 *
 * Отдаём такие комментарии обычному пути (модель умеет и скрыть, и вежливо
 * ответить). Проверка нарочно узкая: спам-детектор труслив по построению, а
 * слова — только явная брань в наш адрес. Обычное возражение («дорого») остаётся
 * в воронке: человек, написавший «дорого» под рекламой чек-листа о ценах, — это
 * ровно тот, кому чек-лист и нужен.
 */
export function isHostileComment(text: string): boolean {
  if (RUDE_EMOJI.test(text)) return true;
  if (detectSpam(text)) return true;
  // Без `\b`: в JavaScript он знает только латиницу, и «развод\b» не совпадает с
  // кириллицей НИКОГДА — та самая грабля, на которой в этом репозитории молча
  // умерли уже три правила (см. INVITE_PATTERNS в messengers/comments.ts).
  // «развод» — через юникодные границы, чтобы «после развода продаём» (настоящий
  // продавец!) не считалось обвинением: у падежных форм за словом идёт буква.
  return /мошенник|кидал|обман|аферист|қаллоб|фиреб|(^|\P{L})развод(?!\p{L})/iu.test(text);
}

async function rememberMediaId(campaignId: string, mediaId: string): Promise<void> {
  if (!mediaId) return;
  try {
    await prisma.leadMagnetCampaign.update({ where: { id: campaignId }, data: { mediaId } });
    invalidateLeadMagnetCache();
  } catch (err) {
    // Не критично: в следующий раз просто снова разберём адрес публикации.
    void logSystemError("meta", `Воронка: публикация не запомнилась: ${describeError(err)}`);
  }
}

/**
 * Публичный ответ выбирается ИЗ ИДЕНТИФИКАТОРА комментария, а не случайно.
 *
 * Случайность означала бы, что повторная обработка той же записи после сбоя даёт
 * другой текст, а поведение не воспроизводится в тесте. Тот же приём, что у
 * ответов смайликом в messengers/comments.ts.
 */
export function pickPublicReply(
  campaign: Pick<ActiveCampaign, "publicReplies">,
  commentId: string
): string | null {
  const variants = campaign.publicReplies.filter((t) => t.trim());
  if (variants.length === 0) return null;
  let hash = 0;
  for (const ch of commentId) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  return variants[hash % variants.length];
}

// ─── Ступень 2: человек ответил в директ ────────────────────────────────────

export interface LeadMagnetMessage {
  channel: string;
  senderId: string;
  /** В какой НАШ аккаунт написал человек — им же уходит выдача. */
  accountExternalId?: string;
  text: string;
  /** Метка нажатой кнопки, если человек нажал, а не написал. */
  payload?: string;
}

/**
 * Ход воронки в личных сообщениях. `true` — сообщение разобрала воронка, и
 * обычному боту отвечать на него не нужно.
 *
 * Состояние берётся из записи выдачи, а не из текста сообщения: человек может
 * нажать кнопку, а может написать «дай» руками — воронке всё равно, ступень
 * определяется тем, где он уже находится.
 */
/**
 * ПОДПИСАН ЛИ ЧЕЛОВЕК НА ВСЕ НАШИ АККАУНТЫ INSTAGRAM (просьба владельца: страниц
 * две — royal.home.tj и royalhome.info, — а реклама ведёт на одну, и вторая
 * остаётся без подписчиков).
 *
 * Почему обходом, а не одним запросом: `is_user_follow_business` отвечает про ТОТ
 * аккаунт, чьим маркером спросили. «Подписан на обе» одним вызовом не выразить.
 *
 * Правила сведения ответов — те же три состояния, что и у одиночной проверки:
 *   false      — хотя бы один аккаунт ответил «не подписан». Это отказ.
 *   undefined  — «не знаю»: ни одного твёрдого «не подписан», но и не все ответили
 *                (маркер без прав, закрытый профиль, отказ Graph API). Дальше решает
 *                настройка кампании «отдавать при сомнении» — как и раньше.
 *   true       — все аккаунты ответили «подписан».
 * Порядок важен: одно твёрдое «нет» перевешивает любое число «не знаю», иначе
 * требование «на обе» обходилось бы аккаунтом, про который мы ничего не выяснили.
 */
async function followsAllAccounts(senderId: string, fallbackToken?: string): Promise<boolean | undefined> {
  const accounts = (await listAccounts("INSTAGRAM")).filter((a) => a.enabled && a.hasToken);
  // Аккаунтов в таблице нет вовсе (старая настройка одним маркером в Settings) —
  // ведём себя как одиночная проверка, иначе воронка молча перестала бы работать.
  if (accounts.length === 0) {
    const only = await fetchInstagramProfile(senderId, fallbackToken);
    return only.isUserFollowBusiness;
  }
  let unknown = false;
  for (const account of accounts) {
    const token = (await accountTokenById(account.id, "INSTAGRAM")).token;
    if (!token) {
      unknown = true;
      continue;
    }
    const profile = await fetchInstagramProfile(senderId, token);
    if (profile.isUserFollowBusiness === false) return false;
    if (profile.isUserFollowBusiness !== true) unknown = true;
  }
  return unknown ? undefined : true;
}

export async function tryLeadMagnetMessage(msg: LeadMagnetMessage): Promise<boolean> {
  // Воронка живёт в Instagram: приглашение отправляется ответом на комментарий, а
  // комментарии есть только там. В WhatsApp этого пути нет вовсе.
  if (msg.channel !== "INSTAGRAM") return false;
  if (!(await leadMagnetInUse())) return false;
  const account = await resolveIncomingAccount("INSTAGRAM", msg.accountExternalId);

  const fromPayload = campaignIdFromPayload(msg.payload);
  const candidates = await prisma.leadMagnetDelivery.findMany({
    where: {
      igUserId: msg.senderId,
      // FAILED здесь нарочно, наравне с незакрытыми. Это человек, которого воронка
      // однажды отпустила: спросили про подписку столько раз, сколько разрешено, и
      // замолчали. Если он подписался ПОТОМ и написал сам — файл он получить
      // обязан. Просить снова мы не будем (см. `gaveUp` ниже), но и держать
      // подписавшегося человека без обещанного файла нельзя: он выполнил условие.
      state: { in: ["INVITED", "AWAITING_FOLLOW", "FAILED"] },
      ...(fromPayload ? { campaignId: fromPayload } : {}),
    },
    orderBy: { invitedAt: "desc" },
    take: 5,
    include: { campaign: { select: CAMPAIGN_FIELDS } },
  });
  // Живая воронка важнее брошенной: человек мог оставить старую кампанию
  // незакрытой и прийти по новой рекламе. Сортировкой в запросе это не выразить —
  // состояния сравнивались бы как строки, и FAILED оказался бы впереди INVITED.
  const delivery = candidates.find((d) => d.state !== "FAILED") ?? candidates[0];
  // Ни одной подходящей выдачи — человек к воронке отношения не имеет либо уже
  // всё получил. Второе — не «дальше говорит обычный бот»: см. tryRedeliver.
  if (!delivery) return tryRedeliver(msg, account);

  const campaign = delivery.campaign;
  /** Воронка этого человека уже отпустила: выдать можем, просить — нет. */
  const gaveUp = delivery.state === "FAILED";
  const said: SaidMessage[] = [];
  try {
    if (!campaign.requireFollow) {
      said.push(...(await deliver(delivery.id, campaign, msg.senderId, null, account.token)));
      await recordInConversation(msg.senderId, delivery.username, msg.text, said, account);
      return true;
    }

    /**
     * ОТКАЗ ПРОФИЛЯ — ЭТО «НЕ ЗНАЮ», А НЕ КОНЕЦ ВОРОНКИ (16.08.2026, живой прогон).
     *
     * Graph отвечает «The requested user cannot be found» (2534014) на обычных
     * людей: закрытый профиль, новый аккаунт, маркер другой страницы. Брошенная
     * отсюда ошибка уводила весь ход в общий catch — человек нажал кнопку и не
     * получал НИЧЕГО, даже просьбы подписаться. Дальше по коду `undefined`
     * означает ровно «проверить не удалось», и решает настройка кампании
     * «отдавать при сомнении» — та самая ветка, ради которой она заведена.
     */
    const profile = await fetchInstagramProfile(msg.senderId, account.token).catch((err) => {
      void logSystemError(
        "meta",
        `Воронка «${campaign.name}»: подписку проверить не удалось (${describeError(err)}) — решаем по настройке «отдавать при сомнении».`
      );
      return { username: undefined, name: undefined, isUserFollowBusiness: undefined } as Awaited<
        ReturnType<typeof fetchInstagramProfile>
      >;
    });
    /**
     * «Подписан на обе страницы» — отдельным обходом по аккаунтам (см.
     * followsAllAccounts). Профиль выше всё равно нужен: из него берём @ник для
     * журнала выдач, и второй раз за ним не ходим.
     */
    const following = campaign.requireFollowAll
      ? await followsAllAccounts(msg.senderId, account.token)
      : profile.isUserFollowBusiness;
    // Имя узнаём попутно: в комментарии @ник есть не всегда, а в журнале выдач
    // «кому именно ушёл файл» — первый вопрос владельца.
    if (profile.username && profile.username !== delivery.username) {
      await prisma.leadMagnetDelivery
        .update({ where: { id: delivery.id }, data: { username: profile.username } })
        .catch(() => {});
    }

    if (following === true) {
      said.push(...(await deliver(delivery.id, campaign, msg.senderId, true, account.token)));
      await recordInConversation(msg.senderId, profile.username ?? delivery.username, msg.text, said, account);
      return true;
    }

    /**
     * ПРОВЕРКА НЕ УДАЛАСЬ — ЭТО НЕ «НЕ ПОДПИСАН».
     *
     * `is_user_follow_business` приходит пустым, когда Graph API отказал или у
     * маркера нет нужного разрешения. Отказывать человеку из-за нашего сбоя —
     * худший исход: он пришёл с оплаченной рекламы, выполнил условие и получил
     * подозрение вместо файла. По умолчанию отдаём, а владелец может переключить.
     */
    if (following === undefined && campaign.deliverIfUnsure) {
      said.push(...(await deliver(delivery.id, campaign, msg.senderId, null, account.token)));
      await recordInConversation(msg.senderId, profile.username ?? delivery.username, msg.text, said, account);
      return true;
    }

    /**
     * ЧЕЛОВЕК ВТОРОЙ РАЗ ГОВОРИТ «Я ПОДПИСАЛСЯ» — ОТДАЁМ (решение владельца 30.08.2026).
     *
     * Что было. Проверка `is_user_follow_business` отвечает не только пустотой, но и
     * твёрдым `false` — и тогда ветка «отдавать при сомнении» выше не срабатывает,
     * потому что сомнения формально нет. Живой диалог с прода: человек нажал
     * «Гирифтани PDF», подписался, нажал «Ман обуна шудам ✅», получил «Обунаро ҳанӯз
     * намебинам», нажал ещё раз — и снова то же самое, слово в слово. Так он ходит по
     * кругу до `maxFollowChecks`, после чего воронка молча ставит FAILED.
     *
     * Цифры, на которых принято решение: за всё время выдач 46, и у ВСЕХ
     * `wasFollowing = true` — то есть спасательная ветка «при сомнении» не сработала
     * ни разу. Последняя выдача 27.08, при этом приглашения шли до 29.08, и 8 человек
     * застряли ровно здесь. Реклама оплачена, человек условие выполнил — цена ошибки
     * в нашу сторону (отдали тому, кто не подписан) несопоставима с ценой ошибки в
     * другую (не отдали тому, кто подписан, и он ушёл).
     *
     * ПОЧЕМУ СО ВТОРОГО, А НЕ С ПЕРВОГО. Первый отказ — самый частый и самый честный
     * случай: человек нажал кнопку, не подписавшись, и просьба подписаться работает.
     * Второе нажатие — это уже осознанное «я сделал»: между ними он сходил и проверил.
     * Дальше настаивать бессмысленно: у Meta это поле отстаёт и требует разрешений,
     * и мы спорим с человеком о том, чего сами достоверно не знаем.
     *
     * `wasFollowing: false` записывается честно — в журнале выдач видно, что подписку
     * подтвердить не удалось и файл отдан по слову человека.
     */
    /**
     * ОТДЕЛЬНЫЙ ПЕРЕКЛЮЧАТЕЛЬ, А НЕ «отдавать при сомнении». Тот закрывает случай
     * «Graph API промолчал»; здесь Instagram отвечает твёрдое «не подписан», и это
     * прямое противоречие прежнему требованию владельца «без подписки не выдавать».
     * Переопределять его молча нельзя — поэтому своя настройка, по умолчанию
     * выключенная, и включается она осознанно на кампанию.
     *
     * `state === "AWAITING_FOLLOW"` — это «мы уже просили подписаться в ЭТОМ круге».
     * Одного счётчика мало: он копится по строке выдачи, а строка одна на человека и
     * кампанию навсегда (уникальность campaignId + igUserId). Человек, вернувшийся
     * через месяц по новому приглашению, унёс бы старый счётчик и получил бы файл с
     * первого нажатия, ни разу не увидев просьбы подписаться.
     */
    const saysFollowedAgain =
      following === false &&
      campaign.deliverOnSecondClaim &&
      delivery.state === "AWAITING_FOLLOW" &&
      // >= 2, а не >= 1: счётчик растёт уже на нажатии «хочу» (там же уходит первая
      // просьба подписаться). Порог 1 отдавал бы файл на ПЕРВОМ «я подписался», а
      // первая просьба — самая честная и работающая: человек часто жмёт кнопку, не
      // подписавшись. Два — это «мы попросили дважды, и дважды он сказал, что сделал».
      delivery.followChecks >= 2 &&
      !gaveUp;
    if (saysFollowedAgain) {
      said.push(...(await deliver(delivery.id, campaign, msg.senderId, false, account.token)));
      await recordInConversation(msg.senderId, profile.username ?? delivery.username, msg.text, said, account);
      void logSystemError(
        "meta",
        `Воронка «${campaign.name}»: ${profile.username ?? delivery.username ?? msg.senderId} второй раз подтвердил подписку, ` +
          `Instagram её не видит — файл отдан по слову человека (решение владельца 30.08.2026).`
      );
      return true;
    }

    // Подписки по-прежнему нет, а воронка этого человека уже отпустила. Второй
    // круг просьб — это и есть навязчивость, из-за которой жалуются на спам.
    // Молчим и отдаём ход обычному боту: он ответит на то, о чём человек спросил.
    if (gaveUp) return false;

    // Подписки нет. Просим — но считанное число раз: человек, которого
    // спрашивают четвёртый раз, уходит и жалуется на спам, а жалоба в Instagram
    // стоит дороже любого лид-магнита.
    const checks = delivery.followChecks + 1;
    const first = delivery.state === "INVITED";
    if (checks > campaign.maxFollowChecks) {
      await prisma.leadMagnetDelivery.update({
        where: { id: delivery.id },
        data: { state: "FAILED", followChecks: checks, lastError: "не подписался" },
      });
      // Молчим нарочно: всё, что можно было сказать, уже сказано maxFollowChecks
      // раз. Разговор переходит обычному боту — человек может спросить о чём-то
      // ещё, и это уже не воронка.
      return false;
    }

    /**
     * ЗАМОК — АТОМАРНЫЙ, ДО ОТПРАВКИ, А НЕ ПРОВЕРКОЙ СОСТОЯНИЯ ВЫШЕ (22.09.2026,
     * тот же приём, что у `deliver()`/`tryRedeliver()` ниже).
     *
     * До этой правки просьба подписаться уходила клиенту, и ТОЛЬКО ПОТОМ строка
     * `leadMagnetDelivery` обновлялась (`state`, `followChecks`, `askedFollowAt`).
     * Сбой между двумя строками (обрыв процесса, отказ базы) оставлял запись в
     * прежнем состоянии `INVITED`/`AWAITING_FOLLOW` с тем же `followChecks` — и
     * следующее сообщение того же человека (в т.ч. честный повтор доставки этого
     * же вебхука Meta) видело ту же незакрытую ступень и отправляло ТУ ЖЕ просьбу
     * подписаться ещё раз.
     *
     * Условный `updateMany` по `followChecks: delivery.followChecks` — то же
     * условие-CAS, что у `deliver()` (там — `deliveredAt: null`): проигравший
     * (или подхват после сбоя, где строка уже сдвинута) получает `count === 0`
     * и не отправляет вторую просьбу.
     */
    const claimed = await prisma.leadMagnetDelivery.updateMany({
      where: { id: delivery.id, followChecks: delivery.followChecks },
      data: { state: "AWAITING_FOLLOW", followChecks: checks, askedFollowAt: new Date() },
    });
    if (claimed.count === 0) return true;

    // Тот же порядок, что у приглашения: сначала карточка с настоящей кнопкой,
    // при отказе Meta — quick reply с запасной строкой «ответьте +».
    const followButton = { title: campaign.followButton, payload: followPayload(campaign.id) };
    const rawAsk = first ? campaign.followText : campaign.notFollowingText;
    const subtitle = first
      ? buttonHintSubtitle(rawAsk)
      : followRetrySubtitle(checks, campaign.maxFollowChecks, rawAsk);
    let ask = rawAsk;
    let askMid: string | null = null;
    try {
      try {
        // Подсказка «не видно кнопку — ответьте +» и здесь: ступень подписки та же
        // карточка, и у неё та же беда, если Instagram её не нарисует. На ПОВТОРНОЙ
        // просьбе её место занимает подсказка про саму подписку (см. followRetrySubtitle):
        // человек, дошедший сюда, уже один раз ответил, значит кнопку или замену ей
        // он нашёл, а вот одинаковый текст третий раз подряд ему уже мешает.
        askMid = await sendButtonCard(
          "INSTAGRAM",
          msg.senderId,
          rawAsk,
          followButton,
          account.token,
          false,
          subtitle
        );
      } catch {
        ask = first ? withButtonFallback(rawAsk) : `${rawAsk}\n\n${subtitle ?? ""}`.trim();
        askMid = await sendQuickReplies("INSTAGRAM", msg.senderId, ask, [followButton], account.token);
      }
    } catch (sendErr) {
      // Ни карточка, ни запасной quick reply не ушли — просьба клиента не видела
      // вовсе. Откатываем захват, чтобы следующая попытка (человек напишет ещё раз,
      // честный повтор доставки) не считала вопрос уже заданным и не молчала.
      await prisma.leadMagnetDelivery
        .updateMany({
          where: { id: delivery.id, followChecks: checks },
          data: { state: delivery.state, followChecks: delivery.followChecks, askedFollowAt: delivery.askedFollowAt },
        })
        .catch(() => {});
      throw sendErr;
    }
    await recordInConversation(
      msg.senderId,
      profile.username ?? delivery.username,
      msg.text,
      [{ text: ask, mid: askMid }],
      account
    );
    return true;
  } catch (err) {
    void logSystemError("meta", `Воронка «${campaign.name}»: ход не выполнен: ${describeError(err)}`);
    await prisma.leadMagnetDelivery
      .update({ where: { id: delivery.id }, data: { lastError: describeError(err).slice(0, 300) } })
      .catch(() => {});
    /**
     * Отдаём ход обычному боту, а не молчим. Человек написал живому, как ему
     * кажется, собеседнику; наш сбой не повод оставить его без ответа вовсе.
     */
    return false;
  }
}

/**
 * ЧЕЛОВЕК УЖЕ ПОЛУЧИЛ ФАЙЛ И ПЕРЕСПРАШИВАЕТ — ЭТО НЕ «ВОРОНКА ЗАКОНЧИЛАСЬ».
 *
 * Живые переписки прода 22.08.2026: «Гирифтани PDF», «Где мой дастур?» — и тишина
 * в ответ. Тишина, а не ответ бота: у кампании с выключенной передачей разговора
 * боту (`handoffToBot = false`) `leadMagnetSilencesBot` глушит модель сразу после
 * выдачи, и переспросивший человек не получает вообще ничего. Файл при этом у нас
 * есть, отдать его второй раз ничего не стоит, и просить за это ничего не надо.
 *
 * Узнаём просьбу тремя способами сразу, потому что человек может и нажать кнопку, и
 * написать её текст словами, и сказать своими: метка кнопки, ключевые слова
 * кампании (ими же он попал в воронку) и прямая просьба про файл/PDF/чек-лист.
 * Ошибка узнавания здесь дёшева — человек лишний раз получит обещанный файл.
 */
const FILE_REQUEST_RE =
  /\bpdf\b|дастур|чек\s*-?\s*лист|checklist|файл|китоб|куҷо(ст)?|кучо(ст)?|нафирист|наомад|не\s*пришл|не\s*получил|где\s+(мой|файл|чек)/iu;

/** Второй раз отдаём не чаще: человек, зациклившийся на кнопке, не должен получить
 *  десять писем подряд, а «ушёл и вернулся» в этот промежуток не укладывается. */
const REDELIVER_COOLDOWN_MS = 10 * 60 * 1000;

async function tryRedeliver(
  msg: LeadMagnetMessage,
  account: { id: string | null; token?: string }
): Promise<boolean> {
  const delivery = await prisma.leadMagnetDelivery.findFirst({
    where: { igUserId: msg.senderId, state: "DELIVERED" },
    orderBy: { deliveredAt: "desc" },
    include: { campaign: { select: CAMPAIGN_FIELDS } },
  });
  if (!delivery) return false;

  const campaign = delivery.campaign;
  const text = msg.text ?? "";
  const asked =
    Boolean(campaignIdFromPayload(msg.payload)) ||
    matchesKeyword(text, campaign.keywords) ||
    matchesKeyword(text, [campaign.inviteButton, campaign.followButton].filter((t) => t.trim())) ||
    FILE_REQUEST_RE.test(text);
  if (!asked) return false;

  // Только что отдали — молчим, но ход считаем своим: обычный бот не должен
  // отвечать «уточню и вернусь» поверх только что отправленного файла.
  const since = Date.now() - (delivery.deliveredAt?.getTime() ?? 0);
  if (since < REDELIVER_COOLDOWN_MS) return true;

  // Захват — атомарный, как у первичной deliver(): повтор доставки Meta приходит
  // ВТОРЫМ HTTP-запросом параллельно первому, и неатомарная проверка кулдауна выше
  // пропускала оба — клиент получал повторную выдачу дважды (26.08.2026). Арбитр —
  // условный сдвиг deliveredAt: проигравший видит count 0 и молчит, считая ход своим.
  const claimed = await prisma.leadMagnetDelivery.updateMany({
    where: {
      id: delivery.id,
      OR: [{ deliveredAt: null }, { deliveredAt: { lte: new Date(Date.now() - REDELIVER_COOLDOWN_MS) } }],
    },
    data: { deliveredAt: new Date() },
  });
  if (claimed.count === 0) return true;

  try {
    const said = await send(delivery.id, campaign, msg.senderId, delivery.wasFollowing, account.token);
    await recordInConversation(msg.senderId, delivery.username, text, said, account);
    return true;
  } catch (err) {
    void logSystemError(
      "meta",
      `Воронка «${campaign.name}»: человек переспросил про файл, а повторная выдача не ушла: ${describeError(err)}`
    );
    // Отдаём ход обычному боту: наш сбой не повод оставить человека без ответа.
    return false;
  }
}

function campaignIdFromPayload(payload?: string): string | null {
  if (!payload?.startsWith(`${PAYLOAD_PREFIX}:`)) return null;
  const id = payload.split(":")[1];
  return id || null;
}

/**
 * Выдача. Сначала текст, потом файл: подписи у вложения в Instagram нет, и файл
 * без единого слова выглядит как что-то присланное по ошибке.
 *
 * ВЫДАЧА НЕ ОБЯЗАНА БЫТЬ ФАЙЛОМ. Лид-магнит — это обещание, а чем оно выполнено,
 * решает владелец: PDF, ссылка на страницу или папку, промокод, адрес офиса,
 * просто ответ текстом. Поэтому пустые «файл» и «ссылка» — это не поломка
 * кампании, а третий её вид: человек получает текст, и на этом всё.
 *
 * Файл может не уйти по причинам, которые от нас не зависят: Meta не забрала его
 * по ссылке, формат не тот, адрес CRM не настроен. Тогда уходит ссылка — человек
 * получает обещанное, пусть и другим способом.
 */
async function deliver(
  deliveryId: string,
  campaign: ActiveCampaign,
  igUserId: string,
  wasFollowing: boolean | null,
  accountToken?: string
): Promise<SaidMessage[]> {
  /**
   * ЗАМОК ВЫДАЧИ — АТОМАРНЫЙ, А НЕ ПРОВЕРКОЙ СОСТОЯНИЯ ВЫШЕ.
   *
   * Повтор доставки от Meta приходит не следующим по очереди, а ВТОРЫМ HTTP-запросом
   * параллельно первому: повторяет она именно тогда, когда мы не успели ответить
   * 200, а не успеваем мы ровно под нагрузкой от рекламы. Выборка в
   * `tryLeadMagnetMessage` обоим обработчикам покажет одну и ту же незакрытую
   * запись, и оба пойдут отправлять — человек получит чек-лист дважды. Та же
   * причина, по которой замком от повторного ПРИГЛАШЕНИЯ служит ограничение базы,
   * а не проверка в коде (см. createMany выше).
   *
   * Арбитр — сама БД: `deliveredAt: null` в условии означает «занимаю, если ещё
   * никто не занял», и второму обработчику достанется count === 0.
   */
  const claimed = await prisma.leadMagnetDelivery.updateMany({
    where: { id: deliveryId, deliveredAt: null },
    data: { deliveredAt: new Date() },
  });
  // Выдачу уже ведёт параллельный обработчик. Молчим и отдаём ему ход: ход воронки
  // всё равно считается сделанным, и обычный бот в разговор не вмешивается.
  if (claimed.count === 0) return [];

  try {
    return await send(deliveryId, campaign, igUserId, wasFollowing, accountToken);
  } catch (err) {
    // Замок снимаем: отправка не удалась, и следующая попытка (человек нажмёт
    // кнопку ещё раз) обязана пройти, а не упереться в наш же захват.
    await prisma.leadMagnetDelivery
      .updateMany({ where: { id: deliveryId, state: { not: "DELIVERED" } }, data: { deliveredAt: null } })
      .catch(() => {});
    throw err;
  }
}

/** Собственно отправка — вынесена из `deliver`, чтобы замок стоял ровно вокруг неё. */
async function send(
  deliveryId: string,
  campaign: ActiveCampaign,
  igUserId: string,
  wasFollowing: boolean | null,
  accountToken?: string
): Promise<SaidMessage[]> {
  const said: SaidMessage[] = [];
  const deliveredMid = await sendMessage("INSTAGRAM", igUserId, campaign.deliveredText, accountToken);
  said.push({ text: campaign.deliveredText, mid: deliveredMid });

  const fileUrl = campaign.filePath ? publicUploadUrl(campaign.filePath) : null;
  let asFile = false;
  if (fileUrl) {
    try {
      const fileMid = await sendFile("INSTAGRAM", igUserId, fileUrl, accountToken);
      asFile = true;
      said.push({ text: `[файл: ${campaign.fileName ?? "чек-лист"}]`, mid: fileMid });
    } catch (err) {
      // Известное ограничение платформы (Instagram не принимает PDF вовсе) — не сбой:
      // штатно уходим на ссылку, не наполняя журнал ошибок на каждом лиде.
      if (!(err instanceof FileUnsupportedInChannelError)) {
        void logSystemError(
          "meta",
          `Воронка «${campaign.name}»: файл не ушёл, отправляем ссылку: ${describeError(err)}`
        );
      }
    }
  }

  /**
   * Обещали файл, а отдать нечем. Не «человек не получил ничего» — текст выше он
   * получил, — но и не выполненное обещание: чаще всего это незаданный
   * CRM_PUBLIC_URL, из-за которого Meta просто некуда прийти за файлом.
   * Записываем прямо в журнал выдач: иначе владелец видит бодрое «файл отдан» и
   * узнаёт правду от клиента.
   */
  let shortfall: string | null = null;

  if (!asFile) {
    // Ссылка отдельным сообщением: в Instagram она так становится кликабельной
    // и не теряется в конце длинного текста. `fileUrl` вторым запасом — файл есть,
    // но Meta его не приняла; тогда человек хотя бы скачает его сам.
    const link = campaign.link?.trim() || fileUrl;
    if (link) {
      const linkMid = await sendMessage("INSTAGRAM", igUserId, link, accountToken);
      said.push({ text: link, mid: linkMid });
    } else if (campaign.filePath) {
      shortfall = fileUrl
        ? "файл не принят Instagram, запасной ссылки нет"
        : "файл не отдан: не задан публичный адрес CRM (CRM_PUBLIC_URL)";
      void logSystemError("meta", `Воронка «${campaign.name}»: ${shortfall}`);
    }
    // Ни файла, ни ссылки и файл не приложен — это законная кампания «только
    // текстом»: обещанное могло быть промокодом, адресом или ответом на вопрос.
    // Раньше здесь стоял отказ, и такая кампания молча попадала в «не дошло»,
    // хотя человек всё получил.
  }

  await prisma.leadMagnetDelivery.update({
    where: { id: deliveryId },
    data: {
      state: "DELIVERED",
      deliveredAt: new Date(),
      wasFollowing,
      deliveredAsFile: asFile,
      lastError: shortfall,
    },
  });
  return said;
}

/** Реплика воронки вместе с идентификатором Meta — см. SaidMessage ниже. */
interface SaidMessage {
  text: string;
  mid?: string | null;
}

/**
 * Реплики воронки — в ту же переписку, что и разговор с ботом.
 *
 * Без этого в CRM видно только, как человек ни с того ни с сего пишет «спасибо» в
 * пустой диалог: всё, что было до, лежало бы в журнале выдач, куда агент не
 * смотрит. Подпись `{kind:"system"}` — это и есть автоматическая рассылка самой
 * CRM, не ИИ и не сотрудник (см. MessageSender в @royal-home/shared).
 *
 * `mid` ЗАПИСЫВАЕТСЯ ОБЯЗАТЕЛЬНО (17.08.2026, «воронка отправляет дважды»).
 * Meta присылает эхо каждого нашего исходящего сообщения тем же вебхуком, что и
 * ручной ответ сотрудника из приложения (см. handleOutgoingEcho). Отличают своё
 * от чужого только по `mid`: без него собственное сообщение воронки выглядело
 * ровно как «сотрудник ответил вручную, мимо CRM» — эхо дописывало в переписку
 * ВТОРУЮ копию того же текста и вдобавок ставило бота на паузу. Идентификатор уже
 * есть у каждого вызывающего (Meta возвращает его при отправке), оставалось
 * только сохранить его рядом с репликой.
 *
 * Отказ записи не должен ломать выдачу: человек уже получил файл, и потерянная
 * строка в истории — меньшая беда, чем исключение посреди воронки.
 */
async function recordInConversation(
  igUserId: string,
  username: string | null,
  incoming: string | null,
  outgoing: SaidMessage[],
  /** Аккаунт, узнанный по получателю; догадка «по умолчанию» (certain=false) не
   *  переписывает уже привязанный диалог (02.10.2026, upsertConversation). */
  account?: { id: string | null; certain?: boolean }
): Promise<void> {
  try {
    const conversationId = await ensureConversationId(
      "INSTAGRAM",
      igUserId,
      username ? `@${username}` : undefined,
      account?.id,
      account?.certain === false
    );
    await appendConversationMessages(conversationId, [
      ...(incoming?.trim() ? [{ role: "user" as const, content: incoming.trim() }] : []),
      ...outgoing
        .filter((o) => o.text.trim())
        .map((o) => ({
          role: "assistant" as const,
          content: o.text,
          by: { kind: "system" as const },
          ...(o.mid ? { mid: o.mid } : {}),
        })),
    ]);
  } catch (err) {
    void logSystemError("meta", `Воронка: реплики не записались в переписку: ${describeError(err)}`);
  }
}

async function markFailed(campaignId: string, igUserId: string, error: string): Promise<void> {
  await prisma.leadMagnetDelivery
    .update({
      where: { campaignId_igUserId: { campaignId, igUserId } },
      data: { state: "FAILED", lastError: error.slice(0, 300) },
    })
    .catch(() => {});
}

// ─── Репетиция ──────────────────────────────────────────────────────────────

/** Одна реплика репетиции — то, что увидит человек, в порядке появления. */
export interface RehearsalStep {
  /** who: client — «написал человек», us — «ответила CRM», note — пояснение владельцу. */
  who: "client" | "us" | "note";
  /** Где реплика живёт: под постом или в директе. У note не заполняется. */
  place?: "comment" | "dm";
  text: string;
  /** Кнопка под сообщением, если есть. */
  button?: string;
  /** Вложение-файл, если уходит. */
  file?: string;
}

export interface RehearsalInput {
  /** Комментарий «клиента» — как его напишет живой человек. */
  comment: string;
  /** Сценарий подписки: подписан / не подписан / Instagram не ответил на вопрос. */
  following: "yes" | "no" | "unknown";
}

/**
 * Прогон кампании без Instagram: тот же путь, что пройдёт настоящий человек, —
 * совпадение, публичный ответ, приглашение, проверка подписки, выдача — но без
 * единого внешнего вызова и без единой записи в базе.
 *
 * Зачем: первый настоящий прогон иначе случается на оплаченном трафике, и цена
 * ошибки в текстах или в ключевом слове — живые лиды. Репетиция отвечает на два
 * вопроса владельца до запуска рекламы: «поймает ли моё слово живую фразу» и «что
 * именно увидит человек в каждой ветке».
 *
 * ЧЕСТНОСТЬ РЕПЕТИЦИИ ДЕРЖИТСЯ НА ОБЩЕМ КОДЕ: совпадение считает тот же
 * matchesKeyword, вариант ответа выбирает тот же pickPublicReply, враждебность —
 * тот же isHostileComment, что и боевой путь. Своя копия логики здесь через месяц
 * репетировала бы другую воронку.
 */
export function rehearseCampaign(campaign: ActiveCampaign, input: RehearsalInput): RehearsalStep[] {
  const steps: RehearsalStep[] = [];
  const text = input.comment.trim();
  steps.push({ who: "client", place: "comment", text: text || "(пустой комментарий)" });

  // Совпадение — ровно как в pickCampaign.
  const byKeyword = matchesKeyword(text, campaign.keywords);
  const byAny = campaign.anyComment && !isHostileComment(text);
  if (!text || (!byKeyword && !byAny)) {
    steps.push({
      who: "note",
      text:
        campaign.anyComment && isHostileComment(text)
          ? "Воронка промолчит: комментарий похож на грубость или рассылку. Им займётся обычный бот — он умеет и вежливо ответить, и скрыть."
          : `Воронка промолчит: в комментарии нет ключевого слова (${campaign.keywords.join(", ") || "—"}). Человек получит обычный ответ бота, без чек-листа.`,
    });
    return steps;
  }
  steps.push({
    who: "note",
    text: byKeyword
      ? `Сработало ключевое слово — совпадение по вхождению, регистр и дефисы не важны.`
      : "Сработал режим «на любой комментарий».",
  });

  // Публичный ответ — детерминированный выбор из того же кода; в репетиции
  // показываем вариант по тексту комментария, чтобы разные фразы давали разные.
  const publicReply = pickPublicReply(campaign, text || "rehearsal");
  if (publicReply) steps.push({ who: "us", place: "comment", text: publicReply });
  else steps.push({ who: "note", text: "Публичного ответа под постом не будет — список вариантов пуст." });

  steps.push({ who: "us", place: "dm", text: campaign.inviteText, button: campaign.inviteButton });
  steps.push({ who: "client", place: "dm", text: `(нажимает «${campaign.inviteButton}»)` });

  const deliver = () => {
    steps.push({
      who: "us",
      place: "dm",
      text: campaign.deliveredText,
      ...(campaign.fileName ? { file: campaign.fileName } : {}),
    });
    if (!campaign.fileName && campaign.link) steps.push({ who: "us", place: "dm", text: campaign.link });
    if (!campaign.fileName && !campaign.link) {
      steps.push({ who: "note", text: "Файла и ссылки нет — выдача только текстом. Если так и задумано, всё в порядке." });
    }
  };

  if (!campaign.requireFollow) {
    steps.push({ who: "note", text: "Подписка не требуется — выдаём сразу." });
    deliver();
    return steps;
  }

  if (input.following === "yes") {
    steps.push({ who: "note", text: "Instagram подтвердил подписку." });
    deliver();
    return steps;
  }

  if (input.following === "unknown") {
    if (campaign.deliverIfUnsure) {
      steps.push({
        who: "note",
        text: "Instagram не ответил, подписан ли человек. По настройке кампании сомнение решается в пользу клиента — выдаём.",
      });
      deliver();
    } else {
      steps.push({
        who: "note",
        text: "Instagram не ответил, подписан ли человек. По настройке кампании без подтверждения не выдаём — человек получит просьбу подписаться, даже если он давно подписан.",
      });
      steps.push({ who: "us", place: "dm", text: campaign.followText, button: campaign.followButton });
    }
    return steps;
  }

  // Не подписан: первая просьба, повторные проверки, предел.
  steps.push({ who: "us", place: "dm", text: campaign.followText, button: campaign.followButton });
  steps.push({ who: "client", place: "dm", text: `(подписывается и нажимает «${campaign.followButton}»)` });
  steps.push({ who: "note", text: "Instagram подтвердил подписку при повторной проверке." });
  deliver();
  steps.push({
    who: "note",
    text:
      `Если человек нажмёт кнопку, НЕ подписавшись, — придёт текст «${campaign.notFollowingText.slice(0, 80)}…». ` +
      `Так не больше ${campaign.maxFollowChecks} раз, потом воронка замолчит и разговор продолжит обычный бот. Без подписки файл не уходит.`,
  });
  return steps;
}

/**
 * Продолжает ли обычный бот разговор с этим человеком. Зовётся вебхуком уже
 * ПОСЛЕ того, как воронка отработала: если владелец выключил передачу боту,
 * сообщения после выдачи файла копятся в переписке, но модель не вызывается.
 */
export async function leadMagnetSilencesBot(channel: string, senderId: string): Promise<boolean> {
  if (channel !== "INSTAGRAM") return false;
  try {
    const delivery = await prisma.leadMagnetDelivery.findFirst({
      where: { igUserId: senderId, state: "DELIVERED" },
      orderBy: { deliveredAt: "desc" },
      select: { campaign: { select: { handoffToBot: true } } },
    });
    return delivery ? !delivery.campaign.handoffToBot : false;
  } catch {
    // Молчать по ошибке нельзя: сомнение решается в пользу ответа клиенту.
    return false;
  }
}
