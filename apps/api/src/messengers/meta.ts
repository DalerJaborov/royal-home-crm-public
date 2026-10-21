import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { isMessagingWindowClosedError } from "../lib/messagingWindow.js";
import { decryptSecretSafe } from "../crypto.js";
import { describeError } from "../lib/describeError.js";
import { GEMINI_RETRY_DELAYS_MS, sleep } from "../ai/geminiTransport.js";
import { rememberOutgoingMid } from "./outgoingMids.js";
import { admitOutbound, OutboundBlockedError, type OutboundOrigin } from "../lib/outboundShield.js";
import type { AttachmentSource } from "./attachments.js";
import type { BotIngressShape } from "@royal-home/shared";
import { traceObserveSend, traceProviderAccepted, traceKnownSecrets } from "../lib/botTurnTrace.js";
import { projectBotIngressShape } from "../lib/botTurnTraceIngress.js";
import { customerPropertyContextEnabled } from "../lib/customerPropertyContextFlag.js";
import { beforeCustomerPropertyPost, customerPropertyProviderAccepted } from "../lib/customerPropertyTransport.js";
import { currentCustomerDeliveryTransport } from "../lib/customerDeliveryTransport.js";
import { bindCustomerMetaSendCredentials, resolveLegacyMetaSendTransport } from "../lib/customerMetaTransport.js";
import type { CustomerTransportReference } from "../lib/customerConversationScope.js";
import type { MetaCredentials, MetaChannel } from "./metaTypes.js";
import type { CustomerPrincipal } from "../lib/customerPrincipal.js";
import { assertCustomerReplyPost, CustomerReplyHeldError } from "../lib/customerReplyFence.js";
export type { MetaCredentials, MetaChannel } from "./metaTypes.js";
export { verifyAndRegisterMetaCustomerIssuer as verifyCustomerAccountSignature } from "../lib/customerIngressAuthority.js";
export { verifyAndRegisterPublicMetaCustomerIssuer as verifyPublicCustomerAccountSignature } from "../lib/customerIngressAuthority.js";

/**
 * Отмечает только что отправленное сообщение как НАШЕ и отдаёт его id дальше —
 * обёртка вокруг каждого `return message_id` в этом файле.
 *
 * Стоит именно здесь, в транспорте: эхо Meta прилетает через доли секунды после
 * отправки, а переписка с mid'ами пишется вызывающим позже и пачкой. Без отметки
 * в этот момент собственное сообщение воронки успевало сойти за ручной ответ
 * сотрудника — см. messengers/outgoingMids.ts.
 */
async function rememberedMid(mid: string | null): Promise<string | null> {
  // Отметка ДОЖИДАЕТСЯ: без этого эхо Meta успевало обогнать запись и наш же
  // ответ сходил за ручной ответ сотрудника — разбор в outgoingMids.ts.
  await rememberOutgoingMid(mid);
  return mid;
}

/**
 * Прямая интеграция с Meta без сторонней бот-платформы: WhatsApp Business
 * Platform и Instagram Direct.
 *
 * Оба канала живут в одном приложении Meta и шлют вебхуки на один и тот же
 * адрес — различаются полем `object` в теле. Поэтому здесь один разбор, одна
 * проверка подписи и одна отправка с ветвлением по каналу: два почти
 * одинаковых эндпоинта разъезжались бы при первой же правке.
 *
 * Каналы в CRM остаются прежними ("WHATSAPP", "INSTAGRAM"), поэтому переписка
 * ложится в те же диалоги, что и прежде.
 *
 * Ключи задаются в Настройках CRM (в базе, зашифрованы), а переменные окружения
 * META_* остаются запасным вариантом для тех, кому удобнее держать их на сервере.
 */

/**
 * Ключи берутся из Настроек CRM (зашифрованы в базе), а окружение сервера —
 * запасной вариант. Так владельцу не нужно лезть на сервер по SSH, чтобы
 * подключить канал: он вставляет ключи в интерфейс, как ключи Claude и Gemini.
 */

/**
 * ОДИН ИСТОЧНИК ТОКЕНА INSTAGRAM (ОБ-000113, решение владельца 21.09.2026).
 *
 * ДО ЭТОЙ ПРАВКИ маркер жил в ДВУХ местах: `Settings.metaIgToken` (читала
 * публикация, см. lib/socialPublish.ts::publishApprovedPost — именно этот путь)
 * и `MessengerAccount.token` аккаунта по умолчанию (channel='INSTAGRAM',
 * isDefault=true — читали лента и переписка). На проде они разъехались: живой
 * ролик ушёл в YouTube/Facebook/TikTok/Telegram, а в Instagram — нет, потому что
 * `instagramTokenIdentity` не смог опознать аккаунт по устаревшему токену из
 * Settings, пока лента и переписка тем временем прекрасно работали ВТОРЫМ,
 * актуальным токеном из MessengerAccount. Объект простоял в таком виде всю ночь.
 *
 * ПОЧЕМУ ПОБЕЖДАЕТ MESSENGERACCOUNT, А НЕ SETTINGS. Аккаунтов Instagram у нас
 * может быть несколько («Royal Home» и «Royal Home Info»), у каждого свой
 * маркер и свой промт (messengers/accounts.ts) — MessengerAccount и есть
 * действующий реестр подключённых аккаунтов, который владелец правит в
 * Настройки → Каналы. `Settings.metaIgToken` по своей природе один на весь
 * проект и не может отличить два аккаунта: он остаётся ЗАПАСНЫМ путём для
 * инсталляций, где ни один аккаунт ещё не заведён в таблице (тот же принцип
 * совместимости, что уже описан у legacyToken в accounts.ts).
 *
 * ВАЖНО: берём СТРОГО `isDefault: true` — второй аккаунт («Royal Home Info»,
 * isDefault=false) никогда не должен подменить основной здесь. Публикация — это
 * основной аккаунт агентства; если понадобится публиковать вторым, это отдельная
 * задача с явным выбором аккаунта, не эта правка.
 *
 * Единственный вызывающий, кому нужен именно маркер аккаунта по умолчанию
 * (лента/переписка/публикация) — идёт через это поле; не размазываем выбор по
 * вызывающим коду, читающим loadCredentials().
 */
async function loadDefaultInstagramAccountToken(): Promise<string | undefined> {
  try {
    const row = await prisma.messengerAccount.findFirst({
      where: { channel: "INSTAGRAM", isDefault: true, enabled: true },
    });
    return decryptSecretSafe(row?.token ?? null) || undefined;
  } catch {
    // Отказ базы — не повод падать здесь: вызывающий откатится на Settings/env,
    // как и раньше.
    return undefined;
  }
}

export async function loadCredentials(): Promise<MetaCredentials> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      metaAppSecret: true,
      metaVerifyToken: true,
      metaWaToken: true,
      metaWaPhoneId: true,
      metaIgToken: true,
      metaIgAppSecret: true,
      metaPageToken: true,
      metaPageId: true,
    },
  });
  const defaultAccountToken = await loadDefaultInstagramAccountToken();
  return {
    appSecret: decryptSecretSafe(s?.metaAppSecret ?? null) || process.env.META_APP_SECRET || undefined,
    verifyToken: decryptSecretSafe(s?.metaVerifyToken ?? null) || process.env.META_VERIFY_TOKEN || undefined,
    waToken: decryptSecretSafe(s?.metaWaToken ?? null) || process.env.META_WA_TOKEN || undefined,
    // Идентификатор номера не секрет — хранится как есть.
    waPhoneId: s?.metaWaPhoneId || process.env.META_WA_PHONE_ID || undefined,
    // MessengerAccount (аккаунт по умолчанию) — источник правды; Settings/env —
    // запасной путь для инсталляций без заведённых аккаунтов (см. докстринг выше).
    igToken: defaultAccountToken || decryptSecretSafe(s?.metaIgToken ?? null) || process.env.META_IG_TOKEN || undefined,
    igAppSecret: decryptSecretSafe(s?.metaIgAppSecret ?? null) || process.env.META_IG_APP_SECRET || undefined,
    pageToken: decryptSecretSafe(s?.metaPageToken ?? null) || process.env.META_PAGE_TOKEN || undefined,
    // Идентификатор Страницы не секрет — хранится как есть.
    pageId: s?.metaPageId || process.env.META_PAGE_ID || undefined,
  };
}

/**
 * КЛЮЧИ ПОДКЛЮЧЁННЫХ АККАУНТОВ (таблица MessengerAccount) — второй источник правды.
 *
 * ЗАЧЕМ. До 30.08.2026 весь транспорт Meta знал ровно один набор ключей — одиночные
 * поля Settings. Из этого следовали три невидимые поломки сразу:
 *   1) второй номер WhatsApp отбрасывался ВСЕГДА: получатель сверялся с единственным
 *      `metaWaPhoneId`, и сколько бы номеров ни завели в Настройках → Каналы, ни один
 *      кроме одного не проходил разбор;
 *   2) второе приложение Meta было невозможно: подпись вебхука сверялась с двумя
 *      секретами Settings, и аккаунт, живущий под другим App ID, получал 403 ДО
 *      разбора тела — ни сообщения, ни записи об ошибке;
 *   3) канал считался ненастроенным, если маркеры перенесли в новую таблицу и
 *      очистили старые поля: модерация комментариев и весь вебхук выключались
 *      бесшумно (см. isChannelConfigured).
 *
 * ПОЧЕМУ ЗАПРОС ЗДЕСЬ, А НЕ ЧЕРЕЗ accounts.ts. `accounts.ts` сам импортирует этот
 * файл; обратный импорт замкнул бы модули в кольцо. Выборка дешёвая и кэшируется.
 *
 * ПОЧЕМУ `findMany()` БЕЗ `select`. Поле `appSecret` появляется в схеме отдельной
 * миграцией, и явная выборка по имени не собралась бы до неё. Без `select` Prisma
 * отдаёт все скалярные колонки: пока колонки нет — тут `undefined` и прежнее
 * поведение, как только появится — секрет читается сам, без правки этого места.
 */
export interface MetaAccountCredentials {
  channel: string;
  /** Идентификатор у Meta: entry[].id (IG/FB) либо phone_number_id (WA). */
  externalId: string;
  /** Второй идентификатор того же аккаунта Instagram (личные сообщения). */
  messagingId: string | null;
  enabled: boolean;
  /** Маркер задан и расшифровался. Сам маркер здесь не нужен — только факт. */
  hasToken: boolean;
  /** Секрет приложения ЭТОГО аккаунта. Пусто — сверяем общими из Настроек. */
  appSecret?: string;
}

/** Кэш на минуту: зовётся на каждый вебхук, состав аккаунтов меняется раз в месяц. */
const ACCOUNT_CREDS_CACHE_MS = 60_000;
let accountCredsCache: { at: number; rows: MetaAccountCredentials[] } | null = null;

/** Сбрасывается при любой правке аккаунтов — см. accounts.ts, resetAccountsCache. */
export function resetMetaAccountCredsCache(): void {
  accountCredsCache = null;
}

export async function loadAccountCredentials(): Promise<MetaAccountCredentials[]> {
  if (accountCredsCache && Date.now() - accountCredsCache.at < ACCOUNT_CREDS_CACHE_MS) {
    return accountCredsCache.rows;
  }
  try {
    const rows = await prisma.messengerAccount.findMany();
    const mapped: MetaAccountCredentials[] = rows.map((r) => ({
      channel: r.channel,
      externalId: r.externalId,
      messagingId: r.messagingId,
      enabled: r.enabled,
      hasToken: Boolean(decryptSecretSafe(r.token)),
      appSecret: decryptSecretSafe((r as { appSecret?: string | null }).appSecret ?? null) || undefined,
    }));
    accountCredsCache = { at: Date.now(), rows: mapped };
    return mapped;
  } catch (err) {
    /**
     * Отказ базы не должен превращаться в 403 на вебхуке: подпись тогда сверится
     * только общими секретами (прежнее поведение), а не отвергнется целиком.
     * Отдаём прошлый кэш, если он был, — он вернее пустого списка.
     */
    console.error("[meta] не удалось прочитать ключи аккаунтов:", describeError(err));
    return accountCredsCache?.rows ?? [];
  }
}

import { GRAPH_VERSION, instagramApiUrl, instagramRequest } from "./metaGraph.js";
export { GRAPH_VERSION, instagramApiUrl, instagramRequest } from "./metaGraph.js";

const CALL_TIMEOUT_MS = 15_000;

/**
 * Повтор `fetch` при СЕТЕВОМ отказе (DNS/обрыв соединения) — не при ответе Meta.
 *
 * Добавлено 18.08.2026: `EAI_AGAIN` на адресе Cloudflare Worker (тот же прокси, что
 * держит Gemini и Instagram) периодически ронял единственную попытку без единого
 * повтора — сообщение воронки или карточка терялись из-за секундного DNS-сбоя.
 * Та же пауза, что уже испытана на Gemini (geminiTransport.ts): 1с → 2с → 4с.
 *
 * HTTP-ответ Meta (даже с ошибкой) сюда не попадает — `fetch` бросает исключение
 * только на сетевом уровне, до получения `Response`. Повторять 4xx/5xx от самой
 * Meta нельзя: это осмысленный ответ, а не сбой сети, и повтор ничего не изменит.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number = CALL_TIMEOUT_MS,
  beforePost?: () => Promise<void>
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt++) {
    await beforeCustomerPropertyPost(init.method);
    if (["POST", "DELETE"].includes(init.method?.toUpperCase() ?? "")) await beforePost?.();
    const durable = init.method?.toUpperCase() === "POST" ? currentCustomerDeliveryTransport() : undefined;
    if (durable) await durable.beforePost();
    try {
      // Свежий AbortSignal на КАЖДУЮ попытку. Раньше вызывающие передавали один
      // signal: AbortSignal.timeout(...), созданный один раз ДО цикла ретраев —
      // его собственный отсчёт не останавливался ни на паузах между попытками
      // (1с/2с/4с), ни на времени самой первой попытки, и к третьему повтору
      // сигнал почти всегда был уже истёк: retry проваливался мгновенно тем же
      // "aborted due to timeout", даже не дойдя до сети. Найдено 20.08.2026 по
      // «Лента аккаунта Instagram не дочитана: The operation was aborted due to
      // timeout» — сама сеть была ни при чём, ретраи были фикцией.
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (durable) { await durable.networkFailure(err); throw err; }
      lastErr = err;
      // ОТПРАВКУ ПОСЛЕ ТАЙМАУТА НЕ ПОВТОРЯЕМ (02.10.2026, ревизия бота). Таймаут или
      // обрыв ответа не значит, что запрос не дошёл: Meta могла уже принять
      // сообщение, комментарий или платный шаблон WhatsApp, и повтор давал клиенту
      // дубль, а нам — второй счёт за шаблон (в Instagram эхо дубля ещё и
      // принималось за ручной ответ сотрудника). Повторяем только то, что
      // повторять безопасно: чтение, удаление и отказ в соединении, когда запрос
      // точно не ушёл.
      if (!isRetrySafe(init.method, err)) throw err;
      if (attempt < GEMINI_RETRY_DELAYS_MS.length) await sleep(GEMINI_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

/** Коды, при которых соединение не установилось и запрос до площадки не дошёл. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

export function isRetrySafe(method: string | undefined, err: unknown): boolean {
  const verb = (method ?? "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "DELETE") return true;
  const code =
    (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code ?? "";
  return NOT_SENT_CODES.has(code);
}


export const META_CHANNELS: MetaChannel[] = ["WHATSAPP", "INSTAGRAM", "FACEBOOK"];

/**
 * Настроен ли конкретный канал. Общие секреты нужны всем, свои — каждому.
 *
 * МАРКЕР ИЗ ТАБЛИЦЫ АККАУНТОВ СЧИТАЕТСЯ НАРАВНЕ С НАСТРОЙКАМИ (30.08.2026).
 * Раньше смотрели ТОЛЬКО одиночные поля Settings, и стоило владельцу перевести
 * аккаунты на Настройки → Каналы и очистить старые поля, как канал объявлялся
 * ненастроенным: вебхук отвечал 503, комментарии ложились в базу со статусом
 * SKIPPED и пометкой "bot_off", и ни одной записи об ошибке при этом не
 * появлялось. Со стороны — «бот молчит, а всё включено».
 *
 * @param accounts аккаунты канала из MessengerAccount; пусто — прежнее поведение.
 */
export function isChannelConfigured(
  c: MetaCredentials,
  channel: MetaChannel,
  accounts: MetaAccountCredentials[] = []
): boolean {
  if (!c.verifyToken) return false;
  const own = accounts.filter((a) => a.channel === channel);
  // Выключенный аккаунт не считается: «настроен» здесь значит «готов работать».
  const accountToken = own.some((a) => a.enabled && a.hasToken);
  // Секрет приложения может лежать и у аккаунта — второе приложение Meta.
  const accountSecret = own.some((a) => !!a.appSecret);
  if (channel === "WHATSAPP") {
    return (
      (!!c.appSecret || accountSecret) &&
      ((!!c.waToken && !!c.waPhoneId) || own.some((a) => a.enabled && a.hasToken && !!a.externalId))
    );
  }
  if (channel === "FACEBOOK") {
    return (!!c.appSecret || accountSecret) && ((!!c.pageToken && !!c.pageId) || accountToken);
  }
  // Instagram подписывает вебхуки своим секретом, но приложение может быть заведено
  // и через Facebook — годится любой из двух.
  return (!!c.appSecret || !!c.igAppSecret || accountSecret) && (!!c.igToken || accountToken);
}

/** Хоть один канал настроен — этого достаточно, чтобы вебхук имел смысл. */
export async function isMetaConfigured(): Promise<boolean> {
  const c = await loadCredentials();
  const accounts = await loadAccountCredentials();
  return META_CHANNELS.some((channel) => isChannelConfigured(c, channel, accounts));
}

/**
 * Канал реально работает: и ключи на месте, и рубильник в Настройках включён.
 * Асинхронна, потому что рубильник живёт в базе — выключение должно срабатывать
 * сразу, а не после перезапуска процесса.
 */
export async function isMetaEnabled(): Promise<boolean> {
  if (!(await isMetaConfigured())) return false;
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaEnabled: true },
  });
  return settings?.metaEnabled ?? false;
}

/**
 * Готов ли КОНКРЕТНЫЙ канал принять исходящее: свои ключи на месте и рубильник
 * включён. `isMetaEnabled` для этого не годится — она отвечает «хоть один канал
 * настроен», и ответ оператора в Instagram уходил бы в отправку только потому,
 * что настроен WhatsApp, а падал бы уже на Graph API.
 */
export async function isMetaChannelEnabled(channel: MetaChannel): Promise<boolean> {
  const c = await loadCredentials();
  if (!isChannelConfigured(c, channel, await loadAccountCredentials())) return false;
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaEnabled: true },
  });
  return settings?.metaEnabled ?? false;
}

/**
 * ГОТОВНОСТЬ КАНАЛОВ META ДЛЯ ЭКРАНОВ — один ответ на всех (28.09.2026).
 *
 * До этой правки Настройки, «Центр управления» и «Маркетинг» решали «подключён ли
 * Instagram» каждый сам по одиночному полю `Settings.metaIgToken`, а бот и
 * публикация — через `loadCredentials()` (сначала маркер основного аккаунта из
 * списка «Аккаунты Instagram»). Стоило завести аккаунт списком и не заполнять
 * запасное поле — и экраны говорили «ключи не заполнены», выключали рубильник
 * бота в Instagram и кнопку проверки статистики, хотя бот и публикация работали.
 * Теперь экраны спрашивают то же, по чему работает сам код.
 *
 * - `channelsConfigured` — те же правила, что у вебхука (`isMetaChannelEnabled`):
 *   общие ключи плюс маркеры таблицы аккаунтов;
 * - `igTokenAvailable` — есть ли маркер, которым пойдут публикация/лента/проверка
 *   статистики (`loadCredentials().igToken`: аккаунт → поле → окружение);
 * - `igTokenFromAccount` — маркер берётся у основного аккаунта списка, а поле
 *   «Маркер Instagram» сейчас запасное.
 */
export interface MetaReadiness {
  channelsConfigured: MetaChannel[];
  igTokenAvailable: boolean;
  igTokenFromAccount: boolean;
}

export async function loadMetaReadiness(): Promise<MetaReadiness> {
  const [c, accounts, accountToken] = await Promise.all([
    loadCredentials(),
    loadAccountCredentials(),
    loadDefaultInstagramAccountToken(),
  ]);
  return {
    channelsConfigured: META_CHANNELS.filter((channel) => isChannelConfigured(c, channel, accounts)),
    igTokenAvailable: !!c.igToken,
    igTokenFromAccount: !!accountToken,
  };
}

/** Канал из строки диалога — тот, что мы умеем отправлять сами. */
export function asMetaChannel(channel: string): MetaChannel | null {
  return (META_CHANNELS as readonly string[]).includes(channel) ? (channel as MetaChannel) : null;
}

/**
 * Чужие номера, на которые пришли РЕАЛЬНЫЕ сообщения и которые отсеял фильтр
 * песочницы. Нужна, чтобы отбрасывание перестало быть бесшумным.
 *
 * Молчаливый отсев — плохая идея, и это выяснилось на живом примере: стоит
 * ошибиться идентификатором номера в Настройках, и все входящие исчезают без
 * следа. Meta при этом получает честные 200, ошибок доставки не показывает, в
 * журнале CRM тоже пусто — искать причину не по чему.
 *
 * Смотрим только те `change`, где действительно были `messages`: статусы
 * доставки приходят пачками, и на них журнал захлёбывался бы впустую.
 */
export function foreignWhatsAppPhoneIds(body: unknown, expectedWaPhoneId: string | string[]): string[] {
  const parsed = body as { object?: string; entry?: { changes?: { value?: WhatsAppValue }[] }[] } | null;
  if (parsed?.object !== "whatsapp_business_account") return [];
  const ours = asPhoneIdSet(expectedWaPhoneId);
  const found = new Set<string>();
  for (const entry of parsed.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages?.length) continue;
      const to = value.metadata?.phone_number_id;
      if (to && !ours.has(to)) found.add(to);
    }
  }
  return [...found];
}

/** Один идентификатор или список — к одному виду. Пустой список = «не фильтруем». */
function asPhoneIdSet(expected: string | string[] | undefined): Set<string> {
  if (!expected) return new Set();
  return new Set((Array.isArray(expected) ? expected : [expected]).filter(Boolean));
}

/**
 * Идентификаторы НАШИХ номеров WhatsApp — для отсева чужих вебхуков в
 * `parseIncoming`. Отдельный геттер, чтобы разбор тела остался чистой функцией:
 * иначе его не проверить тестом без базы.
 *
 * СПИСОК, А НЕ ОДНО ЗНАЧЕНИЕ (30.08.2026). Сверка шла с единственным полем
 * Настроек `metaWaPhoneId`, а таблица подключённых аккаунтов не участвовала
 * вовсе: второй номер WhatsApp отбрасывался на входе ВСЕГДА — «мимо своего
 * номера» — сколько бы аккаунтов владелец ни завёл в Настройках → Каналы.
 *
 * Выключенный аккаунт СЧИТАЕТСЯ своим и здесь: молчаливо терять входящие хуже,
 * чем принять их и не ответить. Ответ по выключенному аккаунту всё равно не
 * уйдёт — это решает resolveIncomingAccount (accounts.ts).
 *
 * @returns undefined — своих номеров не знаем; тогда фильтровать не по чему.
 */
export async function getWaPhoneId(): Promise<string[] | undefined> {
  const fromSettings = (await loadCredentials()).waPhoneId;
  const fromAccounts = (await loadAccountCredentials())
    .filter((a) => a.channel === "WHATSAPP")
    .map((a) => a.externalId);
  const ids = [...new Set([fromSettings, ...fromAccounts].filter((v): v is string => !!v))];
  return ids.length > 0 ? ids : undefined;
}

/**
 * Проверка рукопожатия при подключении вебхука в панели Meta.
 * Meta дёргает GET с hub.mode/hub.verify_token/hub.challenge и ждёт обратно
 * ровно challenge — иначе кнопка «Подтвердить и сохранить» не сработает.
 */
export async function verifyHandshake(query: Record<string, unknown>): Promise<string | null> {
  const { verifyToken } = await loadCredentials();
  if (!verifyToken) return null;
  const mode = String(query["hub.mode"] ?? "");
  const token = String(query["hub.verify_token"] ?? "");
  const challenge = String(query["hub.challenge"] ?? "");
  if (mode !== "subscribe" || !challenge) return null;
  // Сравнение постоянного времени: обычное === выдаёт длину общего префикса по
  // времени ответа, а токен подбирается неограниченным числом попыток.
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return challenge;
}

/**
 * Подпись тела запроса. Без неё вебхук — открытая дверь: адрес несекретный,
 * и кто угодно мог бы слать в CRM «сообщения от клиентов».
 *
 * Считается по СЫРОМУ телу: пересобранный из объекта JSON отличается пробелами
 * и порядком ключей, и подпись перестаёт сходиться (см. app.ts, express.json
 * сохраняет буфер в req.rawBody).
 */
export async function verifySignature(rawBody: Buffer | undefined, header: string | undefined): Promise<boolean> {
  const { appSecret, igAppSecret } = await loadCredentials();
  /**
   * СЕКРЕТЫ АККАУНТОВ — наравне с общими (30.08.2026).
   *
   * Пока секрет был только глобальный, второе приложение Meta подключить было
   * нельзя в принципе: вебхук аккаунта, живущего под другим App ID, отбивался
   * 403 в middleware — ДО разбора тела. В CRM не оставалось ни сообщения, ни
   * записи об ошибке, и со стороны это выглядит как «аккаунт замолчал сам».
   * Ровно так «Royal Home Info» молчал с 21.08.2026.
   *
   * Перебор проверку не ослабляет: все секреты в списке наши, подделать всё
   * равно нужно один из них.
   */
  const accountSecrets = (await loadAccountCredentials()).map((a) => a.appSecret);
  return signatureMatches(rawBody, header, [appSecret, igAppSecret, ...accountSecrets]);
}

/**
 * Сходится ли подпись хотя бы с одним из наших секретов.
 *
 * Секретов два: у входа через Instagram отдельное приложение со своим секретом, и
 * вебхуки Instagram подписаны им, а не секретом приложения Facebook. Перебор не
 * ослабляет проверку — оба секрета наши, подделать нужно всё равно один из них.
 */
export function signatureMatches(
  rawBody: Buffer | undefined,
  header: string | undefined,
  secrets: (string | undefined)[]
): boolean {
  if (!rawBody || !header?.startsWith("sha256=")) return false;
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  if (received.length === 0) return false;
  return secrets.some((secret) => {
    if (!secret) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    return expected.length === received.length && timingSafeEqual(expected, received);
  });
}

/** Одно входящее сообщение, приведённое к виду, понятному CRM. */
export interface MetaIncoming {
  /** Server normalization/binding provenance; never accepted from the body. */
  propertyReferralOrigin?: "postback_referral" | "remembered_referral";
  traceIngressShape?: BotIngressShape;
  channel: MetaChannel;
  /**
   * В КАКОЙ НАШ аккаунт пришло сообщение: entry[].id для Instagram и Messenger,
   * phone_number_id для WhatsApp. По нему выбирается маркер для ответа, когда
   * подключено несколько аккаунтов (см. messengers/accounts.ts).
   */
  accountExternalId?: string;
  /** Кому отвечать: номер клиента в WhatsApp или его ID в Instagram. */
  senderId: string;
  text: string;
  /** Имя из профиля — WhatsApp его присылает, Instagram нет. */
  name?: string;
  /** Тип вложения, если сообщение не текстовое (image/audio/...). */
  attachmentType?: string;
  /** Ссылка на само вложение (CDN или permalink) — по ней узнаём свой пост/рилс. */
  attachmentUrl?: string;
  /**
   * ПЕРЕСЛАННЫЙ ПОСТ ИЛИ РИЛС: ПОДПИСЬ И НОМЕР ПУБЛИКАЦИИ (02.10.2026).
   *
   * У пересланной публикации Meta кладёт рядом с адресом ещё два поля:
   * `payload.title` — подпись под постом, и `reel_video_id` / `ig_post_media_id` —
   * номер самой публикации в Instagram. Адрес при этом всё чаще — ссылка на CDN
   * (`lookaside.fbsbx.com/ig_messaging_cdn/…`), из которой код поста не достать.
   * Мы эти два поля выбрасывали, и наш же пост, опубликованный из CRM, бот не
   * узнавал: жалоба владельца 02.10 — клиент переслал «7 хонага, 1 221 000 TJS»,
   * а бот ответил «видео не открылось». Номер публикации — тот же, что автопубликация
   * пишет в Property.publishedPostIds.INSTAGRAM, по нему объект находится напрямую.
   */
  attachmentTitle?: string;
  attachmentMediaId?: string;
  /** Остальные вложения ТОГО ЖЕ сообщения (Instagram/Messenger позволяют пачку
   *  фото одним сообщением). До 26.08.2026 бралось только первое, остальные
   *  терялись молча — клиент присылал три фото квартиры, бот видел одно. */
  extraAttachments?: { type?: string; url?: string; attachmentMediaId?: string }[];
  /**
   * Человек пришёл по НАШЕЙ рекламе: Meta присылает referral с source=ADS и ad_id.
   *
   * Живой случай 17.08.2026: клиент нажал «Написать» под нашим рекламным роликом
   * и спросил «можно узнать об этом подробнее?» — а бот ответил «вложение не
   * открылось». Для человека это выглядит как отказ от собственной рекламы, за
   * показ которой мы только что заплатили.
   */
  fromAd?: boolean;
  adId?: string;
  /** ctwa_clid из referral WhatsApp — идентификатор клика по рекламе (хранится первым касанием). */
  adClickId?: string;
  /** Свободная метка объявления (referral.ref) — рекламодатель задаёт её в Ads
   *  Manager на кнопке перехода. По ней отличаем рекламу вакансии от рекламы
   *  объекта. Обычный «буст поста» из приложения такую метку не даёт вовсе —
   *  см. adHint в webhooks.ts, там на этот случай отдельная нейтральная подсказка. */
  adRef?: string;
  /** Номер публикации объявления и его подпись (referral.ads_context_data). */
  adPostId?: string;
  adTitle?: string;
  /**
   * Событие — ТОЛЬКО метка перехода с рекламы, без сообщения (02.10.2026). Слова
   * или пересланное придут следующим событием уже без метки; вебхук запоминает
   * её для них (messengers/metaPeerMemory.ts) и сам ход не запускает.
   */
  referralOnly?: boolean;
  /** Клиент ответил на нашу историю: тут её адрес. Без этого признака ответ на
   *  историю выглядел пустым сообщением, и бот молчал. */
  replyToStoryUrl?: string;
  /** Идентификатор медиа у WhatsApp: адрес файла добывается по нему отдельно. */
  mediaId?: string;
  /** Идентификатор сообщения у Meta — им помечаем «прочитано» в WhatsApp, и по нему
   *  же клиент ссылается, когда отвечает на конкретную реплику. */
  messageId?: string;
  /** Человек ответил НА КОНКРЕТНОЕ сообщение: тут его идентификатор. Почти всегда
   *  это наша же реплика — по ней в переписке CRM рисуется цитата. */
  replyToMessageId?: string;
  /**
   * Человек нажал НАШУ кнопку, а не написал текст. Здесь лежит `payload` —
   * скрытая метка, которую мы сами положили в кнопку при отправке.
   *
   * Отличать нажатие от слов обязательно: в тексте кнопки написано «Хочу
   * чек-лист», и по одному тексту нажатие неотличимо от человека, который эти
   * слова напечатал сам. Воронке нужно знать наверняка, на какой она ступени, а
   * догадка по строке — это и есть тихая потеря лида.
   */
  payload?: string;
  /**
   * ЭТО НАШЕ ИСХОДЯЩЕЕ, ВЕРНУВШЕЕСЯ ЭХОМ (is_echo у Meta).
   *
   * До 17.08.2026 эхо отбрасывалось целиком — и вместе с ним терялся самый
   * важный его случай: сотрудник ответил клиенту РУКАМИ из приложения
   * Instagram/Messenger, минуя CRM. Бот об этом не узнавал и продолжал вести
   * диалог параллельно с живым человеком, а в переписке CRM ответа сотрудника
   * не было вовсе — агент потом не понимал, что клиенту уже отвечали.
   *
   * Эхо приходит и на реплики САМОГО БОТА, поэтому различать обязательно:
   * у своих отправленных сообщений мы храним mid (см. stampOutgoingMid), и
   * незнакомый mid как раз и означает «писал человек руками».
   *
   * ⚠️ У эха отправитель и получатель ПЕРЕВЁРНУТЫ: sender — наш аккаунт,
   * recipient — клиент. Поэтому senderId ниже заполняется из recipient.
   */
  isEcho?: boolean;
}

interface WhatsAppValue {
  /** Чей это номер. Нужен, чтобы отличить свой трафик от песочницы Meta. */
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: {
    id?: string;
    from?: string;
    type?: string;
    text?: { body?: string };
    /** Нажатие кнопки под нашим одобренным текстом (24.09.2026, первое сообщение
     *  клиенту — lib/whatsappFirstContact.ts): приходит типом "button", не "text". */
    button?: { text?: string; payload?: string };
    /** У медиа WhatsApp отдаёт не адрес, а идентификатор: файл забирается отдельным
     *  запросом с маркером. Ключ совпадает с типом сообщения (image/audio/voice/...). */
    image?: { id?: string; caption?: string };
    audio?: { id?: string };
    voice?: { id?: string };
    video?: { id?: string; caption?: string };
    document?: { id?: string; caption?: string };
    sticker?: { id?: string };
    /** Геометка клиента (18.08.2026) — раньше не читалась вовсе, хотя Instagram/
     *  Messenger такой же случай уже понимали через общую подсказку ATTACHMENT_HINTS. */
    location?: { latitude?: number; longitude?: number; name?: string; address?: string };
    /** Визитка/контакт, присланный клиентом — имя другое, чем у value.contacts
     *  (там профиль ОТПРАВИТЕЛЯ, здесь — тот, кем он поделился). */
    contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];
    /** Ответ на конкретное сообщение: WhatsApp кладёт сюда идентификатор того,
     *  на что человек ответил. */
    context?: { id?: string };
    /** Человек пришёл по click-to-WhatsApp рекламе — Meta кладёт сюда creative
     *  объявления (17.09.2026, до этого поле не читалось вовсе: у Instagram та же
     *  реклама уже различалась по referral.ref — см. adRef выше, — а у WhatsApp
     *  референс не парсился, и распознавание держалось только на тексте ИИ). У
     *  WhatsApp нет свободной метки вроде referral.ref — вместо неё headline/body
     *  самого объявления, тот же текст, что видел человек перед переходом. */
    referral?: { source_id?: string; source_type?: string; headline?: string; body?: string; ctwa_clid?: string };
    /**
     * ПОЧЕМУ САМА META НЕ СМОГЛА ДОСТАВИТЬ СООБЩЕНИЕ (22.09.2026). При
     * `type: "unsupported"` никакого файла нет вовсе — Meta не смогла передать
     * его сама (опрос, «просмотр один раз», отредактированное сообщение) и
     * пишет причину сюда. Поле не читалось, и в CRM оставалось только слово
     * «unsupported»: понять, что именно прислал человек, было нельзя ни из
     * переписки, ни из журнала ошибок.
     */
    errors?: { code?: number; title?: string; message?: string }[];
  }[];
  /** Статусы доставки наших же сообщений — не входящие сообщения, но не мусор:
   *  см. parseStatusUpdates ниже. */
  statuses?: WhatsAppStatus[];
}

interface WhatsAppStatus {
  /** wamid НАШЕГО отправленного сообщения — то же значение, что sendMessage/
   *  sendImage/... вернули и что легло в ConversationMessage.mid. */
  id?: string;
  status?: "sent" | "delivered" | "read" | "failed";
  recipient_id?: string;
  /** Причина отказа — приходит только со `status: "failed"`. Читается с 22.09.2026:
   *  без неё «не доставлено» нечем объяснить, а причины у WhatsApp разные и
   *  чинятся по-разному (закрытое окно 24 часов, номер вне WhatsApp, шаблон не
   *  одобрен, лимит). */
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

/** Статус доставки ОДНОГО нашего сообщения — для галочек в переписке CRM. */
export interface DeliveryStatusUpdate {
  accountExternalId?: string;
  mid: string;
  status: "sent" | "delivered" | "read" | "failed";
  recipientId: string;
  /** Человеческая причина отказа, только у `failed`. Пусто, если Meta её не дала. */
  error?: string;
  /** Код первой ошибки Meta (131026 и т.п.) — по нему причина переводится в слова. */
  errorCode?: number;
}

/**
 * Статусы доставки WhatsApp (18.08.2026) — Meta присылает их тем же вебхуком,
 * что и входящие сообщения (`value.statuses`), но раньше это поле было типа
 * `unknown[]` и нигде не читалось: событие приходило и терялось. В переписке
 * CRM не было видно даже банального «доставлено»/«прочитано» — приходилось
 * верить транспорту на слово.
 *
 * Только WhatsApp: Instagram/Messenger такие статусы через Graph API не шлют
 * вовсе (там нет открытого способа узнать «прочитано» для чужого разговора).
 */
export function parseStatusUpdates(body: unknown): DeliveryStatusUpdate[] {
  const payload = body as {
    object?: string;
    entry?: { changes?: { value?: WhatsAppValue }[] }[];
  };
  if (payload?.object !== "whatsapp_business_account") return [];
  const out: DeliveryStatusUpdate[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        if (!s.id || !s.status || !s.recipient_id) continue;
        const reason = (s.errors ?? [])
          .map((e) => [e.title, e.message, e.error_data?.details].filter(Boolean).join(" — "))
          .filter(Boolean)
          .join("; ");
        const errorCode = s.errors?.find((e) => typeof e.code === "number")?.code;
        out.push({
          mid: s.id,
          // Routing identity is independent of optional diagnostic tracing.
          accountExternalId: change.value?.metadata?.phone_number_id,
          status: s.status,
          recipientId: s.recipient_id,
          ...(reason ? { error: reason } : {}),
          ...(errorCode !== undefined ? { errorCode } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Метка перехода по рекламе. Meta шлёт её тремя разными путями — отдельным
 * событием, внутри сообщения и внутри postback, — поэтому тип общий.
 */
interface MetaReferral {
  ref?: string;
  source?: string;
  type?: string;
  ad_id?: string;
  /** Что за объявление (02.10.2026): `post_id` — номер публикации, которой
   *  крутится реклама, `ad_title` — её подпись. По ним объект находится, даже
   *  когда в нашей таблице Ad объявления ещё нет. */
  ads_context_data?: { ad_title?: string; post_id?: string | number; photo_url?: string; video_url?: string };
}

/** Номер публикации и подпись объявления из метки рекламы. */
function adContextFields(referral: MetaReferral | undefined): { adPostId?: string; adTitle?: string } {
  const ctx = referral?.ads_context_data;
  if (!ctx) return {};
  const postId = ctx.post_id != null && /^[\d_]{5,}$/.test(String(ctx.post_id)) ? String(ctx.post_id) : undefined;
  const title = typeof ctx.ad_title === "string" && ctx.ad_title.trim() ? ctx.ad_title.trim() : undefined;
  return { ...(postId ? { adPostId: postId } : {}), ...(title ? { adTitle: title } : {}) };
}

/** Формат события у Instagram Direct и Messenger общий — различает их только `object`. */
interface MessagingEvent {
  sender?: { id?: string };
  /**
   * КОМУ адресовано — наш аккаунт в контексте именно этой переписки.
   *
   * Точнее, чем `entry.id`: у двух связанных аккаунтов Instagram он бывает ОБЩИМ,
   * и тогда переписка второго аккаунта достаётся первому (разбор 17.08.2026).
   */
  recipient?: { id?: string };
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    /** «Сообщение недоступно» в Instagram: Meta не может показать, что прислано. */
    is_unsupported?: boolean;
    /** У вложения есть не только тип, но и адрес: у пересланного поста/рилса это
     *  ссылка, по которой мы узнаём собственный объект. */
    attachments?: { type?: string; payload?: { url?: string } & Record<string, unknown> }[];
    /** Ответ на нашу историю приходит здесь, а не во вложениях. */
    reply_to?: { story?: { url?: string; id?: string }; mid?: string };
    /** Ниже — общий тип метки рекламы, см. MetaReferral. */
    /** Нажатие быстрой кнопки: текст кнопки приходит как обычный `text`, а вот
     *  эта метка — единственный признак, что человек нажал, а не напечатал. */
    quick_reply?: { payload?: string };
    /** Разговор начался с клика по нашей рекламе. */
    referral?: MetaReferral;
  };
  /** Кнопка шаблона. Приходит отдельным событием, БЕЗ `message` вовсе. */
  postback?: { mid?: string; title?: string; payload?: string; referral?: MetaReferral };
  /** Клик по рекламе отдельным событием — так Meta шлёт самый первый переход. */
  referral?: MetaReferral;
}

/**
 * Какой канал стоит за телом вебхука. Все продукты Meta шлют на один адрес и
 * различаются только полем `object`, а Instagram и Messenger вдобавок имеют
 * одинаковую структуру entry[].messaging[] — то есть по форме тела их не
 * отличить. Раньше сюда попадал только Instagram, и переписка Страницы легла бы
 * в диалоги Instagram под чужими идентификаторами.
 */
const CHANNEL_BY_OBJECT: Record<string, MetaChannel> = {
  whatsapp_business_account: "WHATSAPP",
  instagram: "INSTAGRAM",
  page: "FACEBOOK",
};

/**
 * НАША ЛИ ЭТО КАРТОЧКА С КНОПКОЙ (25.09.2026).
 *
 * Карточку `sendButtonCard` (ниже) CRM шлёт только воронкой лид-магнита
 * (lib/leadMagnet.ts): generic template, у каждой кнопки тип postback и метка
 * вида `lm:<кампания>:…`. Всё прочее — не наше. До этой правки любая карточка
 * считалась нашей, и когда клиент прислал в Instagram СВОЮ карточку с номером
 * телефона, номер выбрасывался, а бот слышал «клиент ничего не присылал».
 *
 * Карточка без кнопок или с кнопкой без метки — не наша: ошибиться в эту
 * сторону дешевле (в переписке окажется наш же заголовок), чем потерять номер.
 */
export function isOwnButtonCardPayload(payload: unknown): boolean {
  const p = payload as { template_type?: unknown; elements?: unknown } | undefined;
  if (!p || p.template_type !== "generic" || !Array.isArray(p.elements) || p.elements.length === 0) return false;
  return p.elements.every((el) => {
    const buttons = (el as { buttons?: unknown } | null)?.buttons;
    return (
      Array.isArray(buttons) &&
      buttons.length > 0 &&
      buttons.every((b) => {
        const btn = b as { type?: unknown; payload?: unknown } | null;
        return btn?.type === "postback" && typeof btn.payload === "string" && btn.payload.startsWith("lm:");
      })
    );
  });
}

/** Поля карточки, в которых живут слова человека. Адреса картинок (`image_url`),
 *  `template_type` и прочая разметка в текст не идут — там нет ни слова клиента. */
const TEMPLATE_TEXT_KEYS = new Set([
  "title",
  "subtitle",
  "text",
  "payload",
  "phone_number",
  "name",
  "formatted_name",
  "phone",
]);

/**
 * ТЕКСТ КАРТОЧКИ КЛИЕНТА — В ТЕКСТ СООБЩЕНИЯ (25.09.2026), тот же приём, что у
 * визитки WhatsApp (contactsText ниже): весь разбор телефонов идёт от текста хода
 * (`extractPhoneOccurrences`, ai/leadQualifier.ts), и номер из карточки, не попав в
 * текст, не доходил ни до модели, ни до карточки заявки — бот переспрашивал номер,
 * который клиент уже прислал.
 *
 * Обход рекурсивный и мягкий: формат шаблонов у Meta разный (generic, button,
 * media), и падать на незнакомом нельзя. Повторы убираются — у кнопки «позвонить»
 * номер часто стоит и в подписи, и в метке.
 */
export function templateAttachmentText(payload: unknown): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 5 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === "string") {
        const clean = value.trim();
        // Номер берём из ЛЮБОГО поля (03.10.2026, карточка «Номер телефона» Бону):
        // имя поля у Meta меняется от шаблона к шаблону, а телефон без адреса
        // и разметки ни с чем не спутать.
        const phoneLike = /^\+?[\d\s().-]{9,20}$/.test(clean) && (clean.match(/\d/g)?.length ?? 0) >= 9;
        if (
          (TEMPLATE_TEXT_KEYS.has(key) || phoneLike) &&
          clean &&
          !/^https?:\/\//i.test(clean) &&
          !seen.has(clean)
        ) {
          seen.add(clean);
          parts.push(clean);
        }
      } else {
        walk(value, depth + 1);
      }
    }
  };
  walk(payload, 0);
  return parts.join(" ").slice(0, 1000);
}

/**
 * Разбирает тело вебхука в список сообщений — все три канала сразу.
 *
 * Канал определяется полем `object`, а не формой тела: Instagram и Messenger
 * присылают структурно одинаковые события, и различить их иначе невозможно.
 *
 * Структура разбирается мягко: формат меняется от версии к версии, и падать на
 * незнакомом поле нельзя — пропущенное сообщение хуже, чем сообщение без
 * вложения. Отбрасываем то, что не является входящим сообщением: статусы
 * доставки в WhatsApp и эхо наших ответов (иначе бот отвечает сам себе по кругу).
 *
 * `expectedWaPhoneId` — идентификаторы НАШИХ номеров (одно значение или список).
 * Вместе с боевым номером приложение Meta всегда держит тестовый номер в своей
 * песочнице, и её вебхуки подписаны тем же app secret — подпись на них сходится,
 * `object` совпадает, и без этой проверки сообщение из песочницы доходит до
 * диалогов как настоящее, а CRM пытается ответить на него с боевого номера.
 *
 * СПИСОК, А НЕ ОДНО ЗНАЧЕНИЕ (30.08.2026): номеров у агентства может быть
 * несколько, и раньше все, кроме указанного в Настройках, отбрасывались молча.
 */
export function parseIncoming(body: unknown, expectedWaPhoneId?: string | string[], includeTraceShape = /^(1|true)$/.test(process.env.BOT_TURN_TRACE_ENABLED ?? ""),
  options: { captureCustomerReferences?: true } = {}): MetaIncoming[] {
  // Capturing original public references grants no property read or execution
  // authority. CORE normalization must not lose them to a legacy rollout flag;
  // ordinary legacy callers retain the existing feature-controlled behavior.
  const captureReferences = options.captureCustomerReferences === true || customerPropertyContextEnabled();
  const ourWaPhoneIds = asPhoneIdSet(expectedWaPhoneId);
  const payload = body as {
    object?: string;
    entry?: {
      /** Идентификатор НАШЕГО аккаунта-получателя (Instagram/Messenger). */
      id?: string;
      changes?: { field?: string; value?: WhatsAppValue & MessagingEvent }[];
      messaging?: MessagingEvent[];
    }[];
  };
  const out: MetaIncoming[] = [];

  // Незнакомый продукт молча пропускаем: угадывать канал по форме тела нельзя,
  // а разложить переписку не в тот диалог хуже, чем не разложить вовсе.
  const channel = CHANNEL_BY_OBJECT[payload?.object ?? ""];
  if (!channel) return out;

  for (const entry of payload?.entry ?? []) {
    // WhatsApp: entry[].changes[].value.messages[]
    if (channel === "WHATSAPP") {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages) continue;
        // Чужой номер — молча мимо. Своих идентификаторов может не быть только
        // если канал ещё не настроен; тогда фильтровать не по чему и незачем.
        const to = value.metadata?.phone_number_id;
        if (ourWaPhoneIds.size > 0 && to && !ourWaPhoneIds.has(to)) continue;
        const nameByWaId = new Map(
          (value.contacts ?? []).map((c) => [c.wa_id ?? "", c.profile?.name ?? ""])
        );
        for (const msg of value.messages) {
          const from = msg.from;
          if (!from) continue;
          // Реакция («сердечко» на наше сообщение) — не обращение и ответа не ждёт.
          // Живой человек на неё не отвечает вовсе. У нас же она доходила пустым
          // текстом с пометкой «[вложение: reaction]», и бот честно извинялся, что
          // не разглядел присланное: 01.08 клиент дважды поставил сердечко и дважды
          // получил «Расмро надидам, бубахшед». Со стороны это выглядит так, будто
          // на том конце неисправный автомат.
          if (msg.type === "reaction") continue;
          // Кнопка под одобренным текстом — это ответ словами («Да, присылайте»), а
          // не вложение: без этого в переписке лёг бы пустой пузырь «[вложение: button]».
          const isText = (msg.type ?? "text") === "text" || msg.type === "button";
          const media = msg.image ?? msg.audio ?? msg.voice ?? msg.video ?? msg.document ?? msg.sticker;
          // Подпись к фото — это слова клиента («вот такую ищу»), а не служебное поле:
          // без неё до модели доходило только само изображение, без вопроса к нему.
          const caption = msg.image?.caption ?? msg.video?.caption ?? msg.document?.caption;
          /**
           * Геометка/визитка (18.08.2026) — раньше `msg.location`/`msg.contacts` не
           * читались вовсе, хотя у Instagram/Messenger тот же случай уже понимает
           * общая подсказка ATTACHMENT_HINTS (sharedMedia.ts). Собственного текста
           * у этих типов нет — синтезируем короткую подпись, чтобы в переписке CRM
           * не было пустого пузыря без единого слова.
           */
          const locationText = msg.location
            ? `📍 ${[msg.location.name, msg.location.address].filter(Boolean).join(", ") || `${msg.location.latitude}, ${msg.location.longitude}`}`
            : undefined;
          /**
           * НОМЕР ИЗ ВИЗИТКИ — В ТЕКСТ СООБЩЕНИЯ (20.09.2026). Раньше отсюда бралось
           * только имя, а `phones[]` терялись: человек делился карточкой контакта
           * вместо того, чтобы набрать номер руками, и бот спрашивал телефон
           * снова и снова — номер у нас был, но до модели не доходил ни одной
           * цифрой. Владелец описал это так: «отправляется как карточка, а он
           * пишет, что не может видеть вложение», и «спрашивает по 35 раз».
           *
           * Цифры кладутся в САМ текст, а не в отдельное поле, потому что весь
           * разбор телефонов в проекте идёт от текста хода
           * (`extractPhoneOccurrences`, ai/leadQualifier.ts): попав в текст, номер
           * подхватывается и карточкой заявки, и проверками — без второй копии
           * логики.
           */
          const contactsText = msg.contacts?.length
            ? `👤 ${msg.contacts
                .map((c) =>
                  [c.name?.formatted_name, ...(c.phones ?? []).map((ph) => ph.phone)]
                    .filter(Boolean)
                    .join(" ")
                )
                .filter(Boolean)
                .join(", ")}`
            : undefined;
          const text = msg.text?.body ?? msg.button?.text ?? caption ?? locationText ?? contactsText ?? "";
          // ATTACHMENT_HINTS (sharedMedia.ts) знает "location"/"contact" в единственном
          // числе; WhatsApp шлёt тип "contacts" во множественном — приводим к общему ключу.
          const attachmentType = isText ? undefined : msg.type === "contacts" ? "contact" : msg.type;
          /**
           * «unsupported» — это отказ САМОЙ META, а не наша неудача с файлом
           * (22.09.2026, живой случай продавца дачи: бот ответил «ин
           * вложенияро кушода наметавонам», хотя открывать было нечего).
           * Причину Meta пишет в errors[] — кладём её в журнал, иначе в CRM
           * остаётся одно слово «unsupported» и разобраться нельзя.
           */
          if (msg.type === "unsupported") {
            const reason = msg.errors?.[0];
            void logSystemError(
              "meta",
              `WhatsApp не доставил сообщение клиента ${from}: ${reason?.title ?? "тип не поддерживается"}` +
                `${reason?.code ? ` (код ${reason.code})` : ""}${reason?.message ? `. ${reason.message}` : ""}`
            );
          }
          out.push({
            channel: "WHATSAPP",
            ...(includeTraceShape ? { traceIngressShape: projectBotIngressShape(null, msg, !!msg.referral) } : {}),
            accountExternalId: to,
            senderId: from,
            text,
            name: nameByWaId.get(from) || undefined,
            attachmentType,
            mediaId: isText ? undefined : media?.id,
            messageId: msg.id,
            replyToMessageId: msg.context?.id,
            fromAd: Boolean(msg.referral),
            adId: msg.referral?.source_id,
            // ctwa_clid клика (04.10.2026): только для будущей отдачи событий в Meta, пока лишь хранится.
            adClickId: msg.referral?.ctwa_clid || undefined,
            adRef: [msg.referral?.headline, msg.referral?.body].filter(Boolean).join(" ") || undefined,
          });
        }
      }
      continue;
    }

    // Instagram Direct и Messenger: обычно entry[].messaging[], но то же событие
    // приходит и как entry[].changes[] с field "messages" — в такой форме шлёт
    // кнопка «Тестировать» в панели Meta, и на ней проверка вебхука выглядела
    // проваленной при полностью исправной настройке.
    /**
     * КОМУ АДРЕСОВАНО: по этому идентификатору выбирается аккаунт для ответа.
     *
     * Раньше брали только `entry.id`, и 17.08.2026 это стоило нам воронки: у двух
     * наших связанных аккаунтов Instagram он оказался ОДИНАКОВЫМ. Переписка
     * Royal Home Info доставалась аккаунту Royal Home, и его маркером Meta
     * отвечала «The requested user cannot be found» на каждый вызов — ни файла,
     * ни проверки подписки, ни ответа. У самого события получатель указан точно
     * (`recipient.id`), поэтому спрашиваем сначала его.
     */
    const entryId = entry.id;

    const messagingEvents = [
      ...(entry.messaging ?? []),
      ...(entry.changes ?? [])
        .filter((change) => change.field === "messages" && change.value?.message)
        .map((change) => change.value as MessagingEvent),
    ];
    for (const event of messagingEvents) {
      const senderId = event.sender?.id;
      if (!senderId) continue;

      /**
       * НАЖАТИЕ КНОПКИ ШАБЛОНА приходит БЕЗ поля `message` вовсе — только
       * `postback`. Прежняя проверка «нет message → пропустить» выбрасывала
       * такое событие целиком, и человек, нажавший нашу же кнопку, оставался
       * без ответа. Обрабатываем до неё.
       *
       * accountExternalId ЗДЕСЬ ОБЯЗАТЕЛЕН (найдено 17.08.2026 живым прогоном):
       * без него нажатие кнопки ВСЕГДА уходило аккаунту по умолчанию, даже когда
       * человек переписывался со вторым — Graph отвечал «The requested user
       * cannot be found» на каждую попытку, и воронка молчала именно на кнопке,
       * хотя обычные сообщения к тому моменту уже шли верным аккаунтом
       * (см. recipient.id в ветке ниже, разбор того же вечера).
       */
      if (!event.message && event.postback?.payload) {
        const postbackReferral = captureReferences ? event.postback.referral ?? event.referral : undefined;
        out.push({
          ...(includeTraceShape ? { traceIngressShape: projectBotIngressShape(event, null, !!postbackReferral) } : {}),
          channel,
          accountExternalId: event.recipient?.id || entryId,
          senderId,
          text: event.postback.title ?? "",
          payload: event.postback.payload,
          messageId: event.postback.mid,
          ...(postbackReferral ? { fromAd: Boolean(postbackReferral.ad_id || postbackReferral.source === "ADS"),
            adId: postbackReferral.ad_id, adRef: postbackReferral.ref, propertyReferralOrigin: "postback_referral" as const, ...adContextFields(postbackReferral) } : {}),
        });
        continue;
      }

      /**
       * ПЕРЕХОД С РЕКЛАМЫ ОТДЕЛЬНЫМ СОБЫТИЕМ (02.10.2026) — раньше выбрасывался
       * строкой ниже вместе с меткой, и следующее сообщение человека приходило
       * «ниоткуда»: бот не узнавал нашу же рекламу. См. MetaIncoming.referralOnly.
       */
      if (!event.message && event.referral) {
        const referral = event.referral;
        out.push({
          ...(includeTraceShape ? { traceIngressShape: projectBotIngressShape(event, null, true) } : {}),
          channel,
          accountExternalId: event.recipient?.id || entryId,
          senderId,
          text: "",
          referralOnly: true,
          fromAd: Boolean(referral.ad_id || referral.source === "ADS"),
          adId: referral.ad_id,
          adRef: referral.ref,
          ...adContextFields(referral),
        });
        continue;
      }

      if (!event.message) continue;
      /**
       * ЭХО НАШЕГО ЖЕ ИСХОДЯЩЕГО — НЕ МУСОР (17.08.2026, см. isEcho в MetaIncoming).
       *
       * Отдаём его наверх отдельным признаком вместо прежнего `continue`: там
       * решается, наша это реплика (знакомый mid — молча пропустить) или
       * сотрудник ответил руками из приложения, минуя CRM (тогда записать в
       * переписку и остановить бота). Здесь, в разборе, этого не решить — нужен
       * доступ к истории диалога.
       *
       * Отправитель и получатель у эха перевёрнуты: собеседник — в recipient.
       */
      if (event.message.is_echo) {
        const clientId = event.recipient?.id;
        if (!clientId) continue;
        out.push({
          ...(includeTraceShape ? { traceIngressShape: projectBotIngressShape(event, event.message, false) } : {}),
          channel,
          // У эха наш аккаунт — это ОТПРАВИТЕЛЬ (senderId выше), а не получатель.
          accountExternalId: senderId || entryId,
          senderId: clientId,
          text: event.message.text ?? "",
          attachmentType: event.message.attachments?.[0]?.type,
          messageId: event.message.mid,
          isEcho: true,
        });
        continue;
      }
      const firstAttachment = event.message.attachments?.[0];
      /**
       * ССЫЛКА В MESSENGER — НЕ ВЛОЖЕНИЕ (02.10.2026). Страница Facebook, получив
       * сообщение с адресом, прикладывает к нему превью типа `fallback`. Мы
       * принимали его за «вложение, которое не умеем читать», и бот просил
       * написать словами человека, приславшего ссылку. Адрес переносим в текст —
       * дальше он читается тем же путём, что и любая ссылка в сообщении.
       */
      const fallbackUrl = firstAttachment?.type === "fallback" ? firstAttachment.payload?.url : undefined;
      const attachment = firstAttachment?.type === "fallback" ? undefined : firstAttachment;
      // «Сообщение недоступно» (02.10.2026, переписки Dan с рекламы): вложения нет,
      // есть только флаг. Раньше такое событие выбрасывалось как пустое — вместе с
      // меткой рекламы, и следующее сообщение человека приходило «ниоткуда».
      const attachmentType = attachment?.type ?? (event.message.is_unsupported ? "unsupported" : undefined);
      /**
       * КАРТОЧКА ОТ КЛИЕНТА (25.09.2026, см. templateAttachmentText): её слова и
       * номер — в текст хода. Нашу же карточку, пришедшую без флага эха, не
       * трогаем: вебхук узнаёт её по пустому тексту (isBareTemplateEcho в
       * routes/webhooks.ts) и не записывает как реплику клиента.
       */
      const templateText =
        attachmentType === "template" && !isOwnButtonCardPayload(attachment?.payload)
          ? templateAttachmentText(attachment?.payload)
          : "";
      const typedText = event.message.text ?? "";
      const ownText =
        fallbackUrl && !typedText.includes(fallbackUrl) ? [typedText, fallbackUrl].filter(Boolean).join(" ") : typedText;
      const text = templateText ? [ownText, `📋 ${templateText}`].filter(Boolean).join("\n") : ownText;
      // Пачка фото одним сообщением: хвост (со второго) едет отдельным полем.
      const extraAttachments = (event.message.attachments ?? [])
        .slice(1)
        .map((a) => ({ type: a?.type, url: a?.payload?.url,
          ...(captureReferences ? sharedPostFields(a?.payload) : {}) }))
        .filter((a) => a.url || ("attachmentMediaId" in a && a.attachmentMediaId));
      const replyToStoryUrl = event.message.reply_to?.story?.url;
      // Ответ на обычное сообщение (не на историю): раньше это поле выбрасывалось,
      // и в CRM было не понять, к чему относится короткое «да» или «подходит».
      const replyToMessageId = event.message.reply_to?.mid;
      const payload = event.message.quick_reply?.payload;
      // Ответ на историю приходит БЕЗ вложения и часто без текста («🔥», «свободна?»).
      // Раньше такое сообщение отсеивалось как пустое, и клиент оставался без ответа.
      // Клик по нашей рекламе Meta присылает то внутри сообщения, то отдельным
      // полем события — берём любое из двух (см. MetaReferral).
      const referral = event.message.referral ?? event.referral;
      if (!text && !attachmentType && !replyToStoryUrl && !payload && !referral) continue;
      out.push({
        channel,
        accountExternalId: event.recipient?.id || entryId,
        ...(includeTraceShape ? { traceIngressShape: projectBotIngressShape(event, event.message, !!referral) } : {}),
        senderId,
        text,
        attachmentType,
        attachmentUrl: attachment?.payload?.url,
        ...sharedPostFields(attachment?.payload),
        ...(extraAttachments.length > 0 ? { extraAttachments } : {}),
        fromAd: Boolean(referral?.ad_id || referral?.source === "ADS"),
        adId: referral?.ad_id,
        adRef: referral?.ref,
        ...adContextFields(referral),
        replyToStoryUrl,
        replyToMessageId,
        messageId: event.message.mid,
        payload,
      });
    }
  }
  return out;
}

/** Подпись и номер пересланной публикации — см. MetaIncoming.attachmentTitle.
 *  Номер Meta отдаёт то строкой, то числом; пустое не возвращаем вовсе. */
function sharedPostFields(
  payload: ({ url?: string } & Record<string, unknown>) | undefined
): { attachmentTitle?: string; attachmentMediaId?: string } {
  if (!payload) return {};
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : undefined;
  const rawId = payload.reel_video_id ?? payload.ig_post_media_id ?? payload.media_id;
  const mediaId =
    (typeof rawId === "string" || typeof rawId === "number") && /^\d{5,}$/.test(String(rawId)) ? String(rawId) : undefined;
  return { ...(title ? { attachmentTitle: title } : {}), ...(mediaId ? { attachmentMediaId: mediaId } : {}) };
}

/**
 * Куда и с каким телом стучаться, чтобы ответить в конкретный канал.
 * Вынесено отдельно: три канала с разными адресами и форматами тела внутри
 * одного `if` превращались в нечитаемую цепочку тернарников.
 */
function buildSendRequest(
  c: MetaCredentials,
  channel: MetaChannel,
  recipientId: string,
  text: string
): { token?: string; url: string; body: unknown } {
  if (channel === "WHATSAPP") {
    if (!c.waPhoneId) throw new Error("Идентификатор номера WhatsApp не задан в Настройках");
    return {
      token: c.waToken,
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.waPhoneId}/messages`,
      body: { messaging_product: "whatsapp", to: recipientId, type: "text", text: { body: text } },
    };
  }
  if (channel === "FACEBOOK") {
    if (!c.pageId) throw new Error("Идентификатор Страницы Facebook не задан в Настройках");
    return {
      token: c.pageToken,
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.pageId}/messages`,
      // messaging_type: RESPONSE — ответ на сообщение клиента. Без него Meta
      // считает письмо инициативным и режет его вне 24-часового окна.
      body: { recipient: { id: recipientId }, message: { text }, messaging_type: "RESPONSE" },
    };
  }
  return {
    token: c.igToken,
    url: instagramApiUrl(`/${GRAPH_VERSION}/me/messages`),
    body: { recipient: { id: recipientId }, message: { text } },
  };
}

/**
 * То же самое для КАРТИНКИ. Формат тела у каналов разный настолько, что «добавить
 * поле» в buildSendRequest не выходит:
 *  - WhatsApp: сообщение типа `image`, адрес лежит в `image.link`;
 *  - Instagram и Messenger: обычное сообщение с `attachment` типа `image`, адрес — в
 *    `payload.url`, и это единственный способ (загрузка файла телом там не принимается).
 *
 * Ссылку Meta забирает СВОИМИ серверами, поэтому она обязана быть публичной и
 * абсолютной (см. lib/crmPublicUrl.ts): наши `/uploads` открыты без авторизации, и это
 * ровно тот случай, ради которого так сделано.
 *
 * `is_reusable` только у Страницы: Meta возвращает идентификатор загруженного вложения,
 * и повторная отправка того же фото не требует повторной выкачки с нашей стороны.
 * У Instagram этого поля нет — оно вызывает ошибку.
 *
 * Экспортируется ради теста: различие форматов между каналами — то самое, что молча
 * ломается при правке, а поймать это по сетевому вызову нельзя.
 */
export function buildImageRequest(
  c: MetaCredentials,
  channel: MetaChannel,
  recipientId: string,
  imageUrl: string
): { token?: string; url: string; body: unknown } {
  if (channel === "WHATSAPP") {
    if (!c.waPhoneId) throw new Error("Идентификатор номера WhatsApp не задан в Настройках");
    return {
      token: c.waToken,
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.waPhoneId}/messages`,
      body: { messaging_product: "whatsapp", to: recipientId, type: "image", image: { link: imageUrl } },
    };
  }
  if (channel === "FACEBOOK") {
    if (!c.pageId) throw new Error("Идентификатор Страницы Facebook не задан в Настройках");
    return {
      token: c.pageToken,
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.pageId}/messages`,
      body: {
        recipient: { id: recipientId },
        message: { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } },
        messaging_type: "RESPONSE",
      },
    };
  }
  return {
    token: c.igToken,
    // Через instagramApiUrl, а не прямым адресом: с нашего VPS graph.instagram.com
    // недоступен на сетевом уровне, ходим через прокси-Worker (см. выше).
    url: instagramApiUrl(`/${GRAPH_VERSION}/me/messages`),
    body: { recipient: { id: recipientId }, message: { attachment: { type: "image", payload: { url: imageUrl } } } },
  };
}

/**
 * Тело запроса на отправку ВИДЕО — форма ровно как у buildImageRequest, только
 * type/attachment "video" (18.08.2026, оператор шлёт клиенту видео объекта из
 * инбокса — до этого руками можно было отправить только текст и голосовое).
 */
export function buildVideoRequest(
  c: MetaCredentials,
  channel: MetaChannel,
  recipientId: string,
  videoUrl: string
): { token?: string; url: string; body: unknown } {
  if (channel === "WHATSAPP") {
    if (!c.waPhoneId) throw new Error("Идентификатор номера WhatsApp не задан в Настройках");
    return {
      token: c.waToken,
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.waPhoneId}/messages`,
      body: { messaging_product: "whatsapp", to: recipientId, type: "video", video: { link: videoUrl } },
    };
  }
  if (channel === "FACEBOOK") {
    if (!c.pageId) throw new Error("Идентификатор Страницы Facebook не задан в Настройках");
    return {
      token: c.pageToken,
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.pageId}/messages`,
      body: {
        recipient: { id: recipientId },
        message: { attachment: { type: "video", payload: { url: videoUrl, is_reusable: true } } },
        messaging_type: "RESPONSE",
      },
    };
  }
  return {
    token: c.igToken,
    url: instagramApiUrl(`/${GRAPH_VERSION}/me/messages`),
    body: { recipient: { id: recipientId }, message: { attachment: { type: "video", payload: { url: videoUrl } } } },
  };
}

/**
 * Отправляет клиенту ВИДЕО по публичному адресу — тот же приём, что sendImage,
 * скопированный ради видео объекта/приветствия от оператора.
 * @returns `message_id` от Meta — как у sendImage/sendAudio.
 */
export function sendVideo(...args: Parameters<typeof sendVideoImpl>): ReturnType<typeof sendVideoImpl> {
  return traceObserveSend("video", "", undefined, () => sendVideoImpl(...args), { channel: args[0], peer: args[1] });
}
async function sendVideoImpl(
  channel: MetaChannel,
  recipientId: string,
  videoUrl: string,
  tokenOverride?: string,
  transport?: CustomerTransportReference
): Promise<string | null> {
  const loaded = await loadCredentials();
  const captured = transport ?? await resolveLegacyMetaSendTransport(loaded, channel, recipientId, tokenOverride);
  const bound = await bindCustomerMetaSendCredentials(loaded, channel, recipientId, tokenOverride, captured);
  const c = bound?.credentials ?? loaded;
  const { token: fallbackToken, url, body } = buildVideoRequest(c, channel, recipientId, videoUrl);
  const token = bound?.token || tokenOverride || fallbackToken;
  if (!token) throw new Error(`Маркер доступа для ${channel} не задан в Настройках`);

  try {
    const res = await callGraph<{ message_id?: string; messages?: { id?: string }[] }>(url, token, body);
    return await rememberedMid(res?.message_id ?? res?.messages?.[0]?.id ?? null);
  } catch (err) {
    logMetaSendError(`Видео в ${channel} не отправлено`, err);
    throw err;
  }
}

/** Что Instagram знает о написавшем: вебхук приносит только его идентификатор. */
export interface InstagramProfile {
  /** @ник — то, по чему человека узнают; в CRM идёт как имя клиента. */
  username?: string;
  /** Имя из профиля, если заполнено. */
  name?: string;
  profilePic?: string;
  followerCount?: number;
  /** Подписан ли на нас — видно, насколько человек «тёплый». */
  isUserFollowBusiness?: boolean;
}

/**
 * ЧЕЙ ЭТО МАРКЕР: идентификатор и @ник аккаунта, которому он выдан.
 *
 * Нужно, чтобы НЕ СПРАШИВАТЬ идентификатор у человека. У аккаунта Instagram их
 * ДВА, и `GET /me` возвращает оба разными полями:
 *
 *   `id`      — идентификатор в области приложения (например 36982440624733970);
 *               именно его показывает панель Meta и им же адресуются вызовы Graph;
 *   `user_id` — IG User ID (например 17841477393005072); ИМЕННО ОН приходит
 *               в `entry[].id` каждого вебхука.
 *
 * Аккаунт для ответа ищется по получателю из вебхука (accounts.ts), поэтому сюда
 * обязан попасть `user_id`. До 15.08.2026 здесь запрашивалось `fields=id,username`
 * и возвращался `id` — то есть проверка, поставленная ровно против этой ловушки,
 * сама в неё и попадала: оба аккаунта агентства записались с идентификатором из
 * области приложения, ни один не совпадал ни с одним входящим, и вся переписка
 * Royal Home Info отвечалась маркером и промтом основного аккаунта.
 *
 * `id` оставляем запасным: у маркеров Страницы Facebook поля `user_id` нет вовсе,
 * и там верный ответ — как раз `id`.
 */
export async function instagramTokenIdentity(
  token: string,
  /**
   * Свой срок ожидания. По умолчанию общий (15 с) — столько не жалко, когда
   * человек подключает аккаунт и смотрит на форму. Сверка же идентификаторов
   * идёт внутри обработки вебхука, где Meta ждёт от нас 200 и на задержке шлёт
   * сообщение заново, — там срок задаётся короче (messengers/accounts.ts).
   */
  timeoutMs: number = CALL_TIMEOUT_MS
): Promise<{ ok: true; id: string; messagingId?: string; username?: string } | { ok: false; error: string }> {
  try {
    const req = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/me?fields=id,user_id,username`), token);
    const res = await fetchWithRetry(req.url, { headers: req.headers }, timeoutMs);
    const body = await res.text();
    if (!res.ok) return { ok: false, error: `Meta ответила ${res.status}: ${body.slice(0, 200)}` };
    const data = JSON.parse(body) as { id?: string; user_id?: string; username?: string };
    const webhookId = data.user_id || data.id;
    if (!webhookId) return { ok: false, error: "Meta не вернула идентификатор аккаунта" };
    /**
     * У АККАУНТА INSTAGRAM ДВА ИДЕНТИФИКАТОРА, И META ШЛЁТ РАЗНЫЕ В РАЗНЫХ
     * СОБЫТИЯХ (разобрано на живой воронке 17.08.2026).
     *
     * В комментариях приходит `user_id` (17841…), в личных сообщениях — `id`
     * (369…, 374…). CRM знала только первый, поэтому сообщения второго аккаунта
     * не находили своего получателя и обслуживались маркером аккаунта по
     * умолчанию. Со стороны это выглядело как «файл не приходит, сколько ни
     * подписывайся»: Meta отвечала «The requested user cannot be found» на КАЖДЫЙ
     * вызов, потому что идентификатор собеседника выдан другим аккаунтом.
     */
    return { ok: true, id: webhookId, messagingId: data.id, username: data.username };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Видит ли маркер этого собеседника (02.10.2026, см. learnRecipientBySender в
 * messengers/accounts.ts).
 *
 * Идентификатор собеседника в Instagram выдан ПАРЕ «человек + наш аккаунт»:
 * профиль по нему читается только маркером того аккаунта, которому человек
 * писал, остальные получают «Object does not exist / cannot be found». Поэтому
 * по ответу можно точно узнать, в какой наш аккаунт пришло письмо, когда
 * получатель в вебхуке незнаком.
 *
 * Нарочно НЕ через fetchInstagramProfile: та на отказе помечает профиль
 * недоступным на сутки для всех маркеров сразу, а здесь отказ чужого маркера —
 * ожидаемый ответ, а не беда профиля.
 *
 * @returns true — видит; false — Meta отказала (4xx); null — не узнали (сеть, 5xx).
 */
export async function instagramTokenSeesUser(token: string, userId: string, timeoutMs: number): Promise<boolean | null> {
  try {
    const req = instagramRequest(
      instagramApiUrl(`/${GRAPH_VERSION}/${encodeURIComponent(userId)}?fields=username`),
      token
    );
    // Без повторов fetchWithRetry: проба идёт внутри вебхука, где Meta ждёт 200,
    // а неудача пробы лишь оставляет прежнее поведение (ответ основным аккаунтом).
    const res = await fetch(req.url, { headers: req.headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return true;
    return res.status >= 400 && res.status < 500 ? false : null;
  } catch {
    return null;
  }
}

/**
 * Кэш профилей Instagram по senderId.
 *
 * ЗАЧЕМ. До 03.09.2026 `fetchInstagramProfile` делала запрос к Graph API на КАЖДЫЙ
 * вызов — и когда профиль удалён/недоступен (subcode 33 «Object does not exist»),
 * CRM спамила Meta одинаковыми ошибками каждые N минут (×8 за ночь на одном ID).
 * Теперь «профиль недоступен» кэшируется на 24 часа: первый отказ логируется
 * через logSystemError (попадает в утренний отчёт директора), а повторные
 * запросы молча возвращают пустой объект до истечения TTL.
 *
 * УСПЕШНЫЕ ответы НЕ кэшируются нарочно (03.09.2026, упали 7 тестов воронки
 * лид-магнита): поле is_user_follow_business — живой признак «подписан на наш
 * аккаунт», по нему lib/leadMagnet.ts и lib/buyerGuide.ts решают, отдавать ли
 * файл. Клиент подписывается между двумя сообщениями — ответ обязан быть свежим.
 * К тому же признак зависит от того, ЧЬИМ токеном спрашивали (несколько
 * Instagram-аккаунтов), а ключ кэша — только senderId.
 *
 * Сбрасывается только перезапуском процесса — это нормально.
 */
const IG_PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const igProfileUnavailableUntil = new Map<string, number>();

/** Только для тестов: забыть, какие профили помечены недоступными. Модуль живёт
 *  весь процесс, и без сброса тесты из разных файлов делят один Map — тот же
 *  приём, что resetDialplanContextCache в lib/telephony/dialplanContext.ts. */
export function resetInstagramProfileCache(): void {
  igProfileUnavailableUntil.clear();
}

/**
 * Профиль автора входящего сообщения в Instagram.
 *
 * В вебхуке Instagram имени нет вообще (в отличие от WhatsApp с его
 * `value.contacts`), поэтому диалоги висели как «Без имени» — агент не понимал,
 * с кем говорит. Данные берём отдельным запросом по идентификатору отправителя.
 *
 * Отказ не должен ронять обработку сообщения: имя — приятное дополнение, а
 * ответить клиенту важнее. Поэтому здесь всегда возвращается объект, а ошибка
 * уходит в журнал.
 *
 * При HTTP 400 с error_subcode 33 («Object does not exist») профиль помечается
 * как недоступный и больше не запрашивается 24 часа — см. igProfileUnavailableUntil выше.
 */
export async function fetchInstagramProfile(senderId: string, tokenOverride?: string): Promise<InstagramProfile> {
  const unavailableUntil = igProfileUnavailableUntil.get(senderId);
  if (unavailableUntil !== undefined) {
    if (Date.now() < unavailableUntil) return {};
    igProfileUnavailableUntil.delete(senderId);
  }

  const { igToken: fallbackToken } = await loadCredentials();
  const igToken = tokenOverride || fallbackToken;
  if (!igToken) return {};
  const fields = "username,name,profile_pic,follower_count,is_user_follow_business";
  try {
    const req = instagramRequest(
      instagramApiUrl(`/${GRAPH_VERSION}/${encodeURIComponent(senderId)}?fields=${fields}`),
      igToken
    );
    const res = await fetchWithRetry(req.url, { headers: req.headers });
    if (!res.ok) {
      const body = await res.text();
      // Subcode 33 = «Object does not exist»: профиль удалён или заблокирован.
      // Кэшируем пустой ответ на 24ч и логируем ОДИН раз, чтобы не спамить API.
      if (res.status === 400) {
        try {
          const parsed = JSON.parse(body) as { error?: { error_subcode?: number } };
          if (parsed.error?.error_subcode === 33) {
            igProfileUnavailableUntil.set(senderId, Date.now() + IG_PROFILE_CACHE_TTL_MS);
            void logSystemError(
              "meta",
              `Профиль Instagram ${senderId} недоступен (subcode 33, Object does not exist) — запросы приостановлены на 24ч`
            );
            return {};
          }
        } catch {
          // Тело не JSON — обрабатываем как обычную ошибку ниже.
        }
      }
      throw new Error(`Graph API HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      username?: string;
      name?: string;
      profile_pic?: string;
      follower_count?: number;
      is_user_follow_business?: boolean;
    };
    return {
      username: data.username,
      name: data.name,
      profilePic: data.profile_pic,
      followerCount: data.follower_count,
      isUserFollowBusiness: data.is_user_follow_business,
    };
  } catch (err) {
    void logSystemError("meta", `Профиль Instagram ${senderId} не получен: ${describeError(err)}`);
    return {};
  }
}

/**
 * Имя собеседника в Messenger (Facebook) по PSID — маркером Страницы.
 *
 * До 26.08.2026 имя резолвилось только для Instagram: диалоги Messenger висели
 * «Без имени», а защита от собственных аккаунтов по имени (isOwnAccountSender)
 * для этого канала не работала вовсе. Отказ — undefined, обработку не ронять:
 * имя — украшение, ответить клиенту важнее.
 */
export async function fetchMessengerName(psid: string, tokenOverride?: string): Promise<string | undefined> {
  const { pageToken: fallbackToken } = await loadCredentials();
  const token = tokenOverride || fallbackToken;
  if (!token) return undefined;
  try {
    const res = await fetchWithRetry(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(psid)}?fields=first_name,last_name&access_token=${encodeURIComponent(token)}`,
      {}
    );
    if (!res.ok) throw new Error(`Graph API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { first_name?: string; last_name?: string };
    const name = [data.first_name, data.last_name].filter(Boolean).join(" ").trim();
    return name || undefined;
  } catch (err) {
    void logSystemError("meta", `Профиль Messenger ${psid} не получен: ${describeError(err)}`);
    return undefined;
  }
}

/**
 * Адрес файла WhatsApp по идентификатору медиа.
 *
 * WhatsApp, в отличие от Instagram и Messenger, не кладёт в вебхук ссылку на файл —
 * только идентификатор. Забирается он в два шага: сперва Graph отдаёт временный
 * адрес, потом по этому адресу качается сам файл, и ОБА запроса требуют маркер.
 * Поэтому возвращаем не голую ссылку, а источник вместе с заголовком — скачает его
 * общий загрузчик вложений (messengers/attachments.ts).
 *
 * Ссылка живёт минуты, так что кэшировать её нельзя.
 */
export async function whatsAppMediaSource(mediaId: string): Promise<AttachmentSource | null> {
  try {
    // Чтение ключей — тоже внутри `try` (правка 22.09.2026, тот же класс, что у
    // showReadAndTyping ниже): функция обещает `null` на любом отказе, а отказ
    // базы на Настройках улетал наружу и ронял разбор входящего целиком.
    const c = await loadCredentials();
    if (!c.waToken) return null;
    const res = await fetchWithRetry(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${c.waToken}` },
    });
    if (!res.ok) {
      void logSystemError("meta", `Файл WhatsApp ${mediaId} не получен: Meta ответила ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { url?: string };
    if (!data.url) return null;
    return { url: data.url, headers: { Authorization: `Bearer ${c.waToken}` } };
  } catch (err) {
    void logSystemError("meta", `Файл WhatsApp ${mediaId} не получен: ${describeError(err)}`);
    return null;
  }
}

/**
 * Человекочитаемая причина отказа fetch.
 *
 * У сетевых сбоев `message` — это всегда «fetch failed», а настоящая причина
 * (ENOTFOUND, ECONNREFUSED, истёкший сертификат) лежит в `cause`. Без неё запись
 * в журнале не отличала недоступный домен от отказа Meta.
 */
export { describeError } from "../lib/describeError.js";

/**
 * «Живое» присутствие в чате: пометить сообщение прочитанным и показать
 * «печатает…». Ответ без этого выглядит роботом — текст прилетает из ниоткуда
 * при непрочитанном сообщении.
 *
 * У каналов это делается по-разному:
 *  - WhatsApp — одним запросом: статус read по идентификатору сообщения плюс
 *    typing_indicator (Meta сама гасит его при ответе или через ~25 секунд);
 *  - Instagram и Messenger — два sender_action: mark_seen и typing_on.
 *
 * Косметика не должна мешать сути: отказ наружу не бросается — ответ клиенту
 * важнее галочек. И в ЖУРНАЛ ОШИБОК он тоже не пишется (12.08.2026): галочка
 * «прочитано» и «печатает…» ничего не доставляют и ничего не теряют — входящее
 * сообщение уже принято вебхуком и обрабатывается независимо (routes/webhooks.ts:
 * вызов идёт через `void` до разбора и отдельным шагом перед отправкой ответа).
 * Их провал по таймауту graph.facebook.com шёл в журнал наравне с настоящими
 * отказами доставки и забивал утреннюю сводку директору сотнями записей, ради
 * которых человеку делать нечего. Остаётся в консоли контейнера — там видно
 * при разборе сетевых проблем, но никого не будит. Повтора здесь сознательно
 * нет: украшение не стоит второго запроса, таймаут задан явно (CALL_TIMEOUT_MS).
 */
export async function showReadAndTyping(
  channel: MetaChannel,
  senderId: string,
  messageId?: string,
  /**
   * Показывать ли «печатает…». Разделено 01.08.2026: индикатор ставился сразу по
   * приходу сообщения, а ответ уходил через минуту (окно ожидания, пока клиент
   * дописывает, плюс раздумья модели). Meta гасит индикатор сама через ~25 секунд,
   * и человек видел странное: «печатает» долго, потом тишина, потом вдруг ответ.
   * Прочитанным сообщение помечаем сразу, как живой человек, а «печатает…»
   * показываем непосредственно перед отправкой — тогда оно означает ровно то, что
   * означает.
   */
  withTyping = true,
  /** Маркер конкретного аккаунта — когда их несколько (messengers/accounts.ts). */
  tokenOverride?: string,
  transport?: CustomerTransportReference
): Promise<void> {
  /**
   * ЗАГРУЗКА КЛЮЧЕЙ — ВНУТРИ `try` (правка 22.09.2026).
   *
   * Стояла снаружи, и отказ БАЗЫ на чтении Настроек улетал наружу из функции,
   * которая двумя абзацами выше обещает «отказ наружу не бросается». Звали её
   * прямо перед отправкой уже готового ответа модели — то есть сбой на
   * УКРАШЕНИИ уводил в catch вызывающего целый оплаченный ход, и клиент не
   * получал ничего. Ровно тот случай, ради которого весь этот try и написан.
   */
  try {
    const loaded = await loadCredentials();
    const captured = transport ?? await resolveLegacyMetaSendTransport(loaded, channel, senderId, tokenOverride);
    const bound = await bindCustomerMetaSendCredentials(loaded, channel, senderId, tokenOverride, captured);
    const c = bound.credentials;
    if (channel === "WHATSAPP") {
      const waToken = bound.token;
      if (!c.waPhoneId || !waToken || !messageId) return;
      await callGraph(`https://graph.facebook.com/${GRAPH_VERSION}/${c.waPhoneId}/messages`, waToken, {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        ...(withTyping ? { typing_indicator: { type: "text" } } : {}),
      });
      return;
    }
    const url =
      channel === "INSTAGRAM"
        ? instagramApiUrl(`/${GRAPH_VERSION}/me/messages`)
        : `https://graph.facebook.com/${GRAPH_VERSION}/${c.pageId}/messages`;
    const token = bound.token;
    if (!token || (channel === "FACEBOOK" && !c.pageId)) return;
    await callGraph(url, token, { recipient: { id: senderId }, sender_action: "mark_seen" });
    if (withTyping) await callGraph(url, token, { recipient: { id: senderId }, sender_action: "typing_on" });
  } catch (err) {
    console.warn(
      `[meta] «Прочитано/печатает» в ${channel} не показано (косметика, на переписку не влияет):`,
      describeError(err)
    );
  }
}

/**
 * POST в Graph API с таймаутом — общий кусок отправки текста и sender_action.
 *
 * Возвращает разобранный ответ Meta: ответу на комментарий (messengers/comments.ts)
 * нужен идентификатор созданной реплики, иначе собственные комментарии агентства не
 * отличить от чужих и бот отвечает сам себе. Отправке сообщений возвращаемое значение
 * не нужно — она его просто игнорирует.
 */
/**
 * ОКНО ОТВЕТА ЗАКРЫТО (решение владельца 22.08.2026: «пусть в чате будет
 * предупреждение, а не тихая ошибка»). WhatsApp и Instagram запрещают компании
 * писать клиенту свободным текстом, если клиент не писал последние 24 часа —
 * до этой правки такой отказ Graph API тонул в общем «Не удалось отправить
 * сообщение» (см. lib/conversationDelivery.ts::deliverToConversation).
 *
 * Проверка эвристическая: код 131047 документирован Meta именно для этого случая
 * в WhatsApp Cloud API, для Instagram сверено с живым отказом прода (code 10,
 * error_subcode 2534022, «This message is sent outside of allowed window»).
 *
 * 07.09.2026 сама функция переехала в lib/messagingWindow.ts — чистая, а импорт
 * этого модуля поднимает весь транспорт Meta, из-за чего тест доставки держал у
 * себя её копию и настоящую версию не проверял никто. Здесь остаётся реэкспорт:
 * место вызова (lib/conversationDelivery.ts) и все прежние импорты не меняются.
 */
// Реэкспорта нет намеренно: внутрь meta.ts функция приходит обычным импортом
// (см. шапку файла), а вызывающая сторона берёт её прямо из lib/messagingWindow.js.

/**
 * `error_subcode` Meta для "Upload failed" — Graph API не смог забрать файл/фото
 * по нашей ссылке. Отдельно от общего правила "4xx/5xx не повторяем" (см.
 * fetchWithRetry выше): это не осмысленный отказ запроса (не 403 «нет доступа»,
 * не 400 «плохой параметр»), а сбой ИМЕННО скачивания по URL — по своей природе
 * такой же транзиентный, как сетевой обрыв, просто обёрнутый Meta в HTTP 400
 * вместо сетевого исключения. Подтверждено по журналу 24.08.2026: тот же код
 * ловился и на фото, и на PDF-файле вперемешку с успешными отправками того же
 * файла минутами раньше/позже — то есть не постоянный отказ конкретного URL.
 */
const UPLOAD_FAILED_SUBCODE = 2018007;
const UPLOAD_FAILED_RETRY_DELAYS_MS = [800, 2000];

function graphErrorSubcode(text: string): number | undefined {
  try {
    return (JSON.parse(text) as { error?: { error_subcode?: number } }).error?.error_subcode;
  } catch {
    return undefined;
  }
}

/**
 * Журналирует отказ отправки клиенту — КРОМЕ закрытого 24-часового окна.
 *
 * Это штатное ограничение платформы (WhatsApp/Instagram не дают писать первыми
 * после суток тишины), не поломка CRM, и Graph API кладёт в текст ошибки
 * уникальный fbtrace_id — 10-минутная дедупликация journal.ts по тексту его не
 * ловит, и КАЖДЫЙ отказ по этой причине будил директора как «новый вид ошибки»
 * (найдено 25.08.2026: 4 записи с этим кодом за несколько минут). Вызывающий
 * (conversationDelivery.ts) уже показывает агенту понятный текст — журналу
 * системных ошибок здесь сказать нечего.
 */
function logMetaSendError(label: string, err: unknown): void {
  if (err instanceof Error && isMessagingWindowClosedError(err.message)) return;
  void logSystemError("meta", `${label}: ${describeError(err)}`);
}

/**
 * Тело ответа Graph API без экранирования \uXXXX: русский текст ошибки Meta
 * (маркер с русским языком владельца) иначе раздувается вшестеро, а обрезка до
 * 300 символов съедает и сам смысл, и error_subcode (прод 28.09.2026).
 */
function readableGraphBody(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

const durableMetaMid = z.string().min(1).max(512).refine(value => !/\s/.test(value));
const durableMetaMidSchema = z.object({ message_id: durableMetaMid.optional(),
  messages: z.array(z.object({ id: durableMetaMid }).passthrough()).length(1).optional() }).passthrough()
  .refine(value => !value.message_id || !value.messages || value.message_id === value.messages[0].id);
export async function callGraph<T = unknown>(
  url: string,
  token: string,
  body: unknown,
  method: "POST" | "DELETE" = "POST",
  beforePost?: () => Promise<void>
): Promise<T | null> {
  traceKnownSecrets([token]);
  const req = instagramRequest(url, token);
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithRetry(req.url, {
      method,
      headers: { "Content-Type": "application/json", ...req.headers },
      body: method === "DELETE" && body === undefined ? undefined : JSON.stringify(body),
    }, CALL_TIMEOUT_MS, beforePost);
    const text = await res.text();
    if (!res.ok) {
      const durable = currentCustomerDeliveryTransport();
      if (durable && method === "POST") {
        await durable.rejected(res.status);
        throw new Error(`Graph API HTTP ${res.status}: managed delivery rejected`);
      }
      if (graphErrorSubcode(text) === UPLOAD_FAILED_SUBCODE && attempt < UPLOAD_FAILED_RETRY_DELAYS_MS.length) {
        await sleep(UPLOAD_FAILED_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new Error(`Graph API HTTP ${res.status}: ${readableGraphBody(text).slice(0, 300)}`);
    }
    // Тело успешного ответа Meta не гарантировано (у sender_action оно пустое) —
    // отсутствие JSON здесь не ошибка.
    let parsed: T | null;
    try { parsed = JSON.parse(text) as T; } catch { parsed = null; }
    // Durable acceptance must commit before rememberedMid/UI projection. Keep
    // it OUTSIDE JSON parsing's catch: a DB failure is not an empty HTTP body.
    if (method === "POST") {
      const response = durableMetaMidSchema.safeParse(parsed);
      const candidate = response.success ? response.data.message_id ?? response.data.messages?.[0]?.id ?? null : null;
      await currentCustomerDeliveryTransport()?.accepted(candidate);
    }
    if (parsed !== null) {
      const response = parsed as { message_id?: unknown; messages?: { id?: unknown }[] } | null;
      const mid = response?.message_id ?? response?.messages?.[0]?.id;
      customerPropertyProviderAccepted(typeof mid === "string" ? mid : null);
      traceProviderAccepted(typeof mid === "string" ? mid : null);
      return parsed;
    } else {
      customerPropertyProviderAccepted(null);
      traceProviderAccepted(null);
      return null;
    }
  }
}

/**
 * Отправка сообщения.
 *
 * @param tokenOverride маркер КОНКРЕТНОГО аккаунта, когда их подключено несколько
 *   (messengers/accounts.ts). Передаёт вызывающий, а не берём отсюда сами:
 *   иначе meta.ts и accounts.ts импортировали бы друг друга по кругу.
 *   Без него — маркер из Settings, то есть прежнее поведение.
 *
 * @returns идентификатор отправленного сообщения у Meta (`message_id`) или null,
 * если ответ пришёл без него. Нужен для цитирования: отвечая на конкретную
 * реплику, человек присылает `reply_to.mid` — и это почти всегда mid НАШЕГО
 * сообщения. Не сохранив его при отправке, связать ответ будет не с чем, и в
 * переписке останется «да, подходит» без единого намёка, к чему это «да».
 */
export function sendMessage(...args: Parameters<typeof sendMessageImpl>): ReturnType<typeof sendMessageImpl> {
  if (args[3]) traceKnownSecrets([args[3]]);
  return traceObserveSend("text", args[2], args[4]?.origin, () => sendMessageImpl(...args), { channel: args[0], peer: args[1] });
}
async function sendMessageImpl(
  channel: MetaChannel,
  recipientId: string,
  text: string,
  tokenOverride?: string,
  /**
   * ЩИТ ИСХОДЯЩИХ (17.09.2026). Единственная точка, через которую уходит ЛЮБОЙ
   * текст бота в Instagram/WhatsApp/Messenger, — значит, и предохранитель стоит
   * здесь, а не в сценариях: сценарии ломаются по-разному, а наружу выходит одно
   * и то же (см. lib/outboundShield.ts).
   *
   * Умолчание — «бот»: путь, забывший про этот параметр, обязан считаться ботом,
   * а не рукой сотрудника. Рука (`origin: "staff"`) не ограничивается ничем.
   */
  outbound?: { origin?: OutboundOrigin; recipientName?: string | null; transport?: CustomerTransportReference;
    customerReplyPrincipal?: CustomerPrincipal }
): Promise<string | null> {
  const loaded = await loadCredentials();
  const captured = outbound?.transport ?? await resolveLegacyMetaSendTransport(loaded, channel, recipientId, tokenOverride);
  const bound = await bindCustomerMetaSendCredentials(loaded, channel, recipientId, tokenOverride, captured);
  const verdict = await admitOutbound({
    channel,
    subscriberId: recipientId,
    text,
    origin: outbound?.origin,
    recipientName: outbound?.recipientName,
    transport: captured,
  });
  if (!verdict.allowed) {
    console.warn(`[щит] ${channel} → ${recipientId}: ${verdict.reasonText}`);
    throw new OutboundBlockedError(verdict);
  }

  const c = bound?.credentials ?? loaded;
  const { token: fallbackToken, url, body } = buildSendRequest(c, channel, recipientId, text);
  const token = bound?.token || tokenOverride || fallbackToken;
  if (!token) throw new Error(`Маркер доступа для ${channel} не задан в Настройках`);

  const principal = outbound?.customerReplyPrincipal;
  try {
    // Таймаут внутри callGraph: без него зависшее соединение вешает ответ
    // клиенту навсегда — те же грабли, что были у Telegram.
    const res = await callGraph<{ message_id?: string; messages?: { id?: string }[] }>(url, token, body, "POST",
      principal ? () => assertCustomerReplyPost(principal, channel, recipientId, captured) : undefined);
    // Messenger/Instagram отдают `message_id`, WhatsApp Cloud — массив `messages`.
    // Формы разные, поле нужно одно; отсутствие не ошибка — сообщение уже ушло.
    return await rememberedMid(res?.message_id ?? res?.messages?.[0]?.id ?? null);
  } catch (err) {
    // Отказ отправки = клиент не получил ответ. Это обязано быть видно на
    // экране здоровья, а не только в логе контейнера.
    if (!(err instanceof CustomerReplyHeldError)) logMetaSendError(`Сообщение в ${channel} не отправлено`, err);
    throw err;
  }
}

/**
 * Отправляет клиенту КАРТИНКУ по публичному адресу — так бот показывает фотографии
 * объекта прямо в переписке, а не одной ссылкой.
 *
 * Бросает исключение так же, как sendMessage: решение «фото не ушло, но текст всё
 * равно нужен» принимает вызывающий (messengers/propertyShowcase.ts), а не транспорт.
 *
 * @returns `message_id` от Meta — тем же приёмом, что и у sendMessage/sendFile
 * (17.08.2026, «воронка отправляет дважды»): без него эхо этой же отправки
 * (is_echo) неотличимо от ручного ответа сотрудника, и handleOutgoingEcho
 * дописывает в переписку вторую копию показа и ставит бота на паузу.
 */
export function sendImage(...args: Parameters<typeof sendImageImpl>): ReturnType<typeof sendImageImpl> {
  return traceObserveSend("image", "", undefined, () => sendImageImpl(...args), { channel: args[0], peer: args[1] });
}
async function sendImageImpl(
  channel: MetaChannel,
  recipientId: string,
  imageUrl: string,
  /** Маркер конкретного аккаунта (messengers/accounts.ts). */
  tokenOverride?: string,
  transport?: CustomerTransportReference
): Promise<string | null> {
  const loaded = await loadCredentials();
  const captured = transport ?? await resolveLegacyMetaSendTransport(loaded, channel, recipientId, tokenOverride);
  const bound = await bindCustomerMetaSendCredentials(loaded, channel, recipientId, tokenOverride, captured);
  const c = bound?.credentials ?? loaded;
  const { token: fallbackToken, url, body } = buildImageRequest(c, channel, recipientId, imageUrl);
  const token = bound?.token || tokenOverride || fallbackToken;
  if (!token) throw new Error(`Маркер доступа для ${channel} не задан в Настройках`);

  try {
    // WhatsApp отдаёт массив `messages`, Instagram/Messenger — `message_id` —
    // та же развилка форм, что и в sendMessage/sendAudio (buildImageRequest
    // поддерживает WhatsApp, в отличие от buildFileRequest).
    const res = await callGraph<{ message_id?: string; messages?: { id?: string }[] }>(url, token, body);
    return await rememberedMid(res?.message_id ?? res?.messages?.[0]?.id ?? null);
  } catch (err) {
    // Отказ обязан быть виден на экране здоровья: чаще всего он значит, что Meta не
    // смогла забрать картинку по нашей ссылке, а это чинится настройкой, а не кодом.
    logMetaSendError(`Фото в ${channel} не отправлено`, err);
    throw err;
  }
}

/**
 * Быстрая кнопка под сообщением: что на ней написано и что мы узнаем при нажатии.
 *
 * `payload` наружу не виден — это наша метка, по которой воронка понимает, на
 * какой ступени человек. Текст кнопки для этого не годится: «Хочу чек-лист»
 * человек может и напечатать руками, и тогда нажатие от слов не отличить.
 */
export interface QuickReplyButton {
  /** До 20 знаков — предел Meta, дальше запрос отвергается целиком. */
  title: string;
  /** До 1000 знаков. */
  payload: string;
}

/**
 * Кнопки поддерживают Instagram и Messenger, WhatsApp — своим, совсем другим
 * форматом. Пока кнопки нужны только воронке из комментариев Instagram, и
 * поддельная поддержка WhatsApp была бы кодом, который никто никогда не выполнял:
 * лучше честный отказ на границе, чем тихо отправленное сообщение без кнопок,
 * из-за которого человек застревает в воронке навсегда.
 */
export function buildQuickReplyRequest(
  c: MetaCredentials,
  channel: MetaChannel,
  recipientId: string,
  text: string,
  buttons: QuickReplyButton[]
): { token?: string; url: string; body: unknown } {
  if (channel === "WHATSAPP") throw new Error("Кнопки в WhatsApp этим способом не отправляются");
  const quick_replies = buttons.map((b) => ({
    content_type: "text",
    // Обрезаем здесь, а не полагаемся на форму: текст мог прийти из старой
    // кампании, заведённой до появления ограничения, и весь запрос ушёл бы в
    // отказ из-за одной лишней буквы.
    title: b.title.slice(0, 20),
    payload: b.payload.slice(0, 1000),
  }));
  if (channel === "FACEBOOK") {
    if (!c.pageId) throw new Error("Идентификатор Страницы Facebook не задан в Настройках");
    return {
      token: c.pageToken,
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.pageId}/messages`,
      body: { recipient: { id: recipientId }, message: { text, quick_replies }, messaging_type: "RESPONSE" },
    };
  }
  return {
    token: c.igToken,
    url: instagramApiUrl(`/${GRAPH_VERSION}/me/messages`),
    body: { recipient: { id: recipientId }, message: { text, quick_replies } },
  };
}

/**
 * КАРТОЧКА С НАСТОЯЩЕЙ КНОПКОЙ — generic template (владелец 16.08.2026: «кнопка
 * обязательно, красиво, как в ManyChat»).
 *
 * Quick reply — не кнопка, а подсказка НАД полем ввода, и веб-версия Instagram её
 * не рисует вовсе: первый живой человек воронки получил «нажмите кнопку» без
 * кнопки. Generic template — другой механизм: кнопка живёт ВНУТРИ пузыря
 * сообщения, и рисуют её и приложение, и веб. Ровно так выглядят «красивые
 * кнопки» ManyChat.
 *
 * Пределы Meta: заголовок карточки 80 знаков, подзаголовок 80, кнопка 20. Текст
 * длиннее — режем на заголовок и подзаголовок; хвост длинного текста теряется,
 * поэтому вызывающий держит тексты короткими (см. leadMagnet.ts).
 *
 * Нажатие приходит вебхуком как postback с тем же payload, что у quick reply, —
 * разбор входящих не меняется.
 */
export function sendButtonCard(...args: Parameters<typeof sendButtonCardImpl>): ReturnType<typeof sendButtonCardImpl> {
  return traceObserveSend("buttons", "", undefined, () => sendButtonCardImpl(...args), { channel: args[0], peer: args[1] });
}
async function sendButtonCardImpl(
  channel: MetaChannel,
  recipientId: string,
  text: string,
  button: QuickReplyButton,
  tokenOverride?: string,
  /** Отправить как private reply на комментарий: recipient = comment_id. */
  asCommentReply = false,
  /**
   * Вторая строка карточки — задаётся явно, когда она не продолжение текста, а
   * самостоятельная подсказка (см. воронку: «не видно кнопку — ответьте +»).
   * Не передан — прежнее поведение: подзаголовком становится хвост длинного текста.
   */
  explicitSubtitle?: string
  /**
   * Идентификатор сообщения у Meta (`message_id`) — или null, если она его не
   * вернула (тело успешного ответа не гарантировано, см. callGraph).
   *
   * Возвращается ради разбора жалоб «пришло пустое сообщение» (17.08.2026): при
   * успехе код не логировал ничего, и проверить, что именно Meta приняла, было
   * нечем — оставалось верить на слово обеим сторонам. С этим идентификатором
   * отправку можно предъявить и сверить.
   */
): Promise<string | null> {
  const c = await loadCredentials();
  const { token: fallbackToken } = buildQuickReplyRequest(c, channel, recipientId, text, [button]);
  const token = tokenOverride || fallbackToken;
  if (!token) throw new Error(`Маркер доступа для ${channel} не задан в Настройках`);

  /**
   * РЕЖЕМ ПО СЛОВАМ, А НЕ ПО СИМВОЛАМ (16.08.2026, первый живой человек).
   *
   * Meta даёт 80 знаков заголовку и 80 подзаголовку. Слепая нарезка разорвала
   * слово пополам: «...ба тугмаи зерин па» / «хш кунед» — и человек написал, что
   * ничего не понял. Ищем ближайший пробел или перевод строки слева от границы;
   * если слово длиннее лимита целиком (такого в наших текстах нет, но бывает
   * ссылка), режем как есть — обрубок лучше пропажи.
   */
  const cut = (value: string, limit: number): [string, string] => {
    if (value.length <= limit) return [value, ""];
    const window = value.slice(0, limit + 1);
    const space = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
    const at = space > limit / 2 ? space : limit;
    return [value.slice(0, at).trimEnd(), value.slice(at).trimStart()];
  };
  /**
   * ПОДЗАГОЛОВОК ЗАДАЁТСЯ ЯВНО — И ТОГДА ТЕКСТ НЕ РЕЖЕТСЯ ВОВСЕ.
   *
   * Нарезка ниже нужна для длинных текстов, но у неё есть цена: она рвёт фразу
   * по ближайшему пробелу, и вторая половина повисает серой строкой над кнопкой.
   * Владелец это уже видел и просил так не делать (17.08.2026, отсюда предел в
   * 80 знаков у inviteText).
   *
   * Поэтому запасная подсказка «не видно кнопку — ответьте +» приезжает сюда
   * ОТДЕЛЬНЫМ полем, а не приклеенной к тексту: заголовком остаётся ровно текст
   * кампании, подзаголовком — ровно подсказка, и ни одна из фраз не разрывается.
   */
  const [title, rest] = explicitSubtitle ? [text.trim(), ""] : cut(text.trim(), 80);
  const [subtitleRaw] = cut(explicitSubtitle ?? rest, 80);
  const subtitle = subtitleRaw || undefined;
  const body = {
    recipient: asCommentReply ? { comment_id: recipientId } : { id: recipientId },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [
            {
              title,
              ...(subtitle ? { subtitle } : {}),
              buttons: [{ type: "postback", title: button.title.slice(0, 20), payload: button.payload.slice(0, 1000) }],
            },
          ],
        },
      },
    },
  };
  const url =
    channel === "INSTAGRAM"
      ? instagramApiUrl(`/${GRAPH_VERSION}/me/messages`)
      : `https://graph.facebook.com/${GRAPH_VERSION}/me/messages`;
  try {
    const sent = await callGraph<{ message_id?: string }>(url, token, body);
    return await rememberedMid(sent?.message_id ?? null);
  } catch (err) {
    logMetaSendError(`Карточка с кнопкой в ${channel} не отправлена`, err);
    throw err;
  }
}

/** Текст с кнопками под ним. Бросает так же, как sendMessage.
 *  @param tokenOverride маркер конкретного аккаунта (messengers/accounts.ts). */
export function sendQuickReplies(...args: Parameters<typeof sendQuickRepliesImpl>): ReturnType<typeof sendQuickRepliesImpl> {
  return traceObserveSend("buttons", "", undefined, () => sendQuickRepliesImpl(...args), { channel: args[0], peer: args[1] });
}
async function sendQuickRepliesImpl(
  channel: MetaChannel,
  recipientId: string,
  text: string,
  buttons: QuickReplyButton[],
  tokenOverride?: string
): Promise<string | null> {
  const c = await loadCredentials();
  const { token: fallbackToken, url, body } = buildQuickReplyRequest(c, channel, recipientId, text, buttons);
  const token = tokenOverride || fallbackToken;
  if (!token) throw new Error(`Маркер доступа для ${channel} не задан в Настройках`);
  try {
    const res = await callGraph<{ message_id?: string }>(url, token, body);
    return await rememberedMid(res?.message_id ?? null);
  } catch (err) {
    logMetaSendError(`Сообщение с кнопками в ${channel} не отправлено`, err);
    throw err;
  }
}

/**
 * Канал физически не умеет такой тип сообщения. Отдельный класс, чтобы вызывающий
 * код отличал «известное ограничение платформы» (штатно уйти запасным путём, без
 * записи в журнал) от настоящего сбоя отправки.
 */
export class FileUnsupportedInChannelError extends Error {}

/**
 * ФАЙЛ (PDF) в личное сообщение. Messenger принимает до 25 МБ.
 *
 * Ссылку Meta забирает СВОИМИ серверами, поэтому она обязана быть публичной и
 * абсолютной — ровно как у фотографий (см. buildImageRequest и lib/crmPublicUrl.ts).
 * Файл лид-магнита поэтому и лежит в открытой папке `/uploads`: закрытое хранилище
 * переписки Meta не откроет, и вместо чек-листа человек получил бы тишину.
 *
 * WHATSAPP (25.08.2026) — раньше здесь стоял безусловный throw «этим способом не
 * отправляется»: `lib/buyerGuide.ts` числит WhatsApp в FILE_CHANNELS и honestly
 * пытается отдать файл-гид покупателя, но каждый раз ловил этот throw — ни файла,
 * ни объяснения клиенту, только запись в журнал ошибок. WhatsApp Cloud API
 * документы умеет — тот же приём, что уже работает для голосовых
 * (см. buildAudioRequest выше, `waPhoneId`/`waToken`), просто `type: "document"`.
 *
 * INSTAGRAM (26.08.2026) — attachment type "file" в Instagram Send API НЕ существует:
 * бизнес может отправить только image/video/audio, generic-документ (PDF) — нет.
 * До этого дня запрос честно уходил в Graph и стабильно бился о 400 code 100
 * subcode 2018007 «Upload failed» — на КАЖДОЙ выдаче чек-листа воронки, с двумя
 * бесполезными ретраями (subcode помечен временным, а причина постоянная) и
 * записью в журнал ошибок. Теперь отказ мгновенный и типизированный: вызывающий
 * код (leadMagnet, buyerGuide) отдаёт ссылку — этот запасной путь у них уже был.
 */
export function buildFileRequest(
  c: MetaCredentials,
  channel: MetaChannel,
  recipientId: string,
  fileUrl: string,
  fileName?: string
): { token?: string; url: string; body: unknown } {
  if (channel === "WHATSAPP") {
    if (!c.waPhoneId) throw new Error("Идентификатор номера WhatsApp не задан в Настройках");
    return {
      token: c.waToken,
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.waPhoneId}/messages`,
      body: {
        messaging_product: "whatsapp",
        to: recipientId,
        type: "document",
        document: { link: fileUrl, filename: fileName },
      },
    };
  }
  if (channel === "FACEBOOK") {
    if (!c.pageId) throw new Error("Идентификатор Страницы Facebook не задан в Настройках");
    return {
      token: c.pageToken,
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.pageId}/messages`,
      body: {
        recipient: { id: recipientId },
        message: { attachment: { type: "file", payload: { url: fileUrl, is_reusable: true } } },
        messaging_type: "RESPONSE",
      },
    };
  }
  throw new FileUnsupportedInChannelError(
    "Instagram Direct не принимает файлы (PDF) от бизнеса — только фото/видео/аудио; отправьте ссылку"
  );
}

/**
 * ГОЛОСОВОЕ СООБЩЕНИЕ АГЕНТА клиенту (16.08.2026).
 *
 * Формат тела — ровно как у buildImageRequest: WhatsApp кладёт ссылку в `audio.link`,
 * Instagram и Messenger — во вложение `attachment.payload.url`. Ссылка обязана быть
 * публичной и абсолютной по той же причине: Meta забирает файл своими серверами
 * (см. lib/outgoingVoice.ts — публичная копия, в отличие от закрытого хранилища
 * голосовых КЛИЕНТА).
 *
 * Файл на входе — строго `audio/ogg; codecs=opus` (lib/audioTranscode.ts
 * перекодирует запись браузера перед вызовом): другой контейнер WhatsApp отклоняет
 * уже на приёме.
 */
export function buildAudioRequest(
  c: MetaCredentials,
  channel: MetaChannel,
  recipientId: string,
  audioUrl: string
): { token?: string; url: string; body: unknown } {
  if (channel === "WHATSAPP") {
    if (!c.waPhoneId) throw new Error("Идентификатор номера WhatsApp не задан в Настройках");
    return {
      token: c.waToken,
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.waPhoneId}/messages`,
      body: { messaging_product: "whatsapp", to: recipientId, type: "audio", audio: { link: audioUrl } },
    };
  }
  if (channel === "FACEBOOK") {
    if (!c.pageId) throw new Error("Идентификатор Страницы Facebook не задан в Настройках");
    return {
      token: c.pageToken,
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.pageId}/messages`,
      body: {
        recipient: { id: recipientId },
        message: { attachment: { type: "audio", payload: { url: audioUrl, is_reusable: true } } },
        messaging_type: "RESPONSE",
      },
    };
  }
  return {
    token: c.igToken,
    url: instagramApiUrl(`/${GRAPH_VERSION}/me/messages`),
    body: { recipient: { id: recipientId }, message: { attachment: { type: "audio", payload: { url: audioUrl } } } },
  };
}

/**
 * ЛИЧНОЕ СООБЩЕНИЕ АВТОРУ КОММЕНТАРИЯ (private reply) — единственный способ
 * написать в Instagram человеку, который нам ещё не писал.
 *
 * Адресат задаётся идентификатором КОММЕНТАРИЯ, а не человека, и окно всего семь
 * суток. Отправить так можно РОВНО ОДНО сообщение: продолжить разговор получится
 * только если человек ответит. Отсюда и устройство воронки — первым письмом уходит
 * не файл, а кнопка: её нажатие и есть ответ, открывающий переписку.
 *
 * Живёт здесь, а не в comments.ts, потому что этим путём ходят двое: обычный ответ
 * бота на комментарий и воронка лид-магнита. Две копии транспорта разъехались бы
 * первой же правкой.
 */
export async function sendPrivateReply(
  commentId: string,
  text: string,
  buttons: QuickReplyButton[] = [],
  /** Маркер аккаунта, под чьим постом оставлен комментарий (messengers/accounts.ts). */
  tokenOverride?: string,
  /**
   * Канал комментария (16.08.2026, комментарии Facebook).
   *
   * Private reply устроен одинаково, а вот дом разный: Instagram отвечает через
   * graph.instagram.com (с нашего VPS — через прокси), страница Facebook — через
   * graph.facebook.com и маркером страницы. Ответ уходит в Messenger, то есть
   * ровно туда, куда просил владелец.
   */
  channel: MetaChannel = "INSTAGRAM",
  /** Managed public-source gate, rechecked immediately before physical POST. */
  beforePost?: () => Promise<void>,
  observeAcceptedRecipient?: (value: { messageId: string; recipientId: string | null }) => void
  /** `message_id` от Meta — тем же приёмом и ради того же, что у sendButtonCard. */
): Promise<string | null> {
  const credentials = await loadCredentials();
  const fallbackToken = channel === "FACEBOOK" ? credentials.pageToken : credentials.igToken;
  const igToken = tokenOverride || fallbackToken;
  if (!igToken) throw new Error("Маркер Instagram не задан в Настройках");
  const message: Record<string, unknown> = { text };
  if (buttons.length > 0) {
    message.quick_replies = buttons.map((b) => ({
      content_type: "text",
      title: b.title.slice(0, 20),
      payload: b.payload.slice(0, 1000),
    }));
  }
  /**
   * ДОМ ТОЖЕ ЗАВИСИТ ОТ КАНАЛА (22.08.2026). Канал сюда передавали с 16.08.2026, но
   * им выбирался только маркер: адрес оставался инстаграмным всегда. То есть личное
   * по комментарию со страницы Facebook уходило маркером страницы на
   * graph.instagram.com — заведомо в никуда, ровно та же путаница домов, что и у
   * получения публикации в messengers/comments.ts.
   */
  const url =
    channel === "FACEBOOK"
      ? `https://graph.facebook.com/${GRAPH_VERSION}/me/messages`
      : instagramApiUrl(`/${GRAPH_VERSION}/me/messages`);
  const sent = await callGraph<{ message_id?: string }>(url, igToken, {
    recipient: { comment_id: commentId },
    message,
  }, "POST", beforePost);
  if (beforePost && sent && (Object.hasOwn(sent, "error") || Object.hasOwn(sent, "error_code") ||
      (sent as Record<string, unknown>).success === false || (sent as Record<string, unknown>).ok === false)) {
    throw new Error("Contradictory managed private reply response");
  }
  if (beforePost && !durableMetaMid.safeParse(sent?.message_id).success) throw new Error("Managed private reply has no valid provider ID");
  if (observeAcceptedRecipient && durableMetaMid.safeParse(sent?.message_id).success) {
    const recipient = durableMetaMid.safeParse((sent as Record<string, unknown>).recipient_id);
    observeAcceptedRecipient({ messageId: sent!.message_id!, recipientId: recipient.success ? recipient.data : null });
  }
  return await rememberedMid(sent?.message_id ?? null);
}

/** Голосовое по публичному адресу — возвращает mid отправленного (как sendMessage),
 *  он же уходит в цитаты переписки. Бросает при отказе: решение «не ушло» принимает
 *  вызывающий (lib/conversationDelivery.ts).
 *  @param tokenOverride маркер конкретного аккаунта (messengers/accounts.ts). */
export function sendAudio(...args: Parameters<typeof sendAudioImpl>): ReturnType<typeof sendAudioImpl> {
  return traceObserveSend("audio", "", undefined, () => sendAudioImpl(...args), { channel: args[0], peer: args[1] });
}
async function sendAudioImpl(
  channel: MetaChannel,
  recipientId: string,
  audioUrl: string,
  tokenOverride?: string,
  transport?: CustomerTransportReference
): Promise<string | null> {
  const loaded = await loadCredentials();
  const captured = transport ?? await resolveLegacyMetaSendTransport(loaded, channel, recipientId, tokenOverride);
  const bound = await bindCustomerMetaSendCredentials(loaded, channel, recipientId, tokenOverride, captured);
  const c = bound?.credentials ?? loaded;
  const { token: fallbackToken, url, body } = buildAudioRequest(c, channel, recipientId, audioUrl);
  const token = bound?.token || tokenOverride || fallbackToken;
  if (!token) throw new Error(`Маркер доступа для ${channel} не задан в Настройках`);
  try {
    const res = await callGraph<{ message_id?: string; messages?: { id?: string }[] }>(url, token, body);
    return await rememberedMid(res?.message_id ?? res?.messages?.[0]?.id ?? null);
  } catch (err) {
    logMetaSendError(`Голосовое в ${channel} не отправлено`, err);
    throw err;
  }
}

/** Файл по публичному адресу. Бросает: решение «файл не ушёл — отправить ссылку»
 *  принимает воронка (lib/leadMagnet.ts), а не транспорт.
 *  @param tokenOverride маркер конкретного аккаунта (messengers/accounts.ts).
 *  @param fileName имя файла — WhatsApp показывает его в пузыре документа
 *  (Instagram/Facebook его не используют, необязателен для них). Добавлен последним
 *  параметром, а не перед tokenOverride, — чтобы не переставлять местами аргументы
 *  в уже существующих вызовах (см. lib/leadMagnet.ts). */
export function sendFile(...args: Parameters<typeof sendFileImpl>): ReturnType<typeof sendFileImpl> {
  return traceObserveSend("file", "", undefined, () => sendFileImpl(...args), { channel: args[0], peer: args[1] });
}
async function sendFileImpl(
  channel: MetaChannel,
  recipientId: string,
  fileUrl: string,
  tokenOverride?: string,
  fileName?: string,
  transport?: CustomerTransportReference
): Promise<string | null> {
  const loaded = await loadCredentials();
  const captured = transport ?? await resolveLegacyMetaSendTransport(loaded, channel, recipientId, tokenOverride);
  const bound = await bindCustomerMetaSendCredentials(loaded, channel, recipientId, tokenOverride, captured);
  const c = bound?.credentials ?? loaded;
  const { token: fallbackToken, url, body } = buildFileRequest(c, channel, recipientId, fileUrl, fileName);
  const token = bound?.token || tokenOverride || fallbackToken;
  if (!token) throw new Error(`Маркер доступа для ${channel} не задан в Настройках`);
  try {
    const res = await callGraph<{ message_id?: string }>(url, token, body);
    return await rememberedMid(res?.message_id ?? null);
  } catch (err) {
    logMetaSendError(`Файл в ${channel} не отправлен`, err);
    throw err;
  }
}

/**
 * ГЕОМЕТКА ОБЪЕКТА (19.08.2026) — карта прямо в переписке вместо адреса текстом.
 * Только WhatsApp Cloud API документирует отправку `type: "location"`;
 * у Instagram/Messenger Send API такого типа сообщения нет (только приём от
 * пользователя, не отправка от бизнеса) — вызывать эту функцию для них незачем,
 * вызывающий код должен сам проверить канал ДО вызова.
 */
export function buildLocationRequest(
  c: MetaCredentials,
  recipientId: string,
  lat: number,
  lng: number,
  name?: string,
  address?: string
): { token?: string; url: string; body: unknown } {
  if (!c.waPhoneId) throw new Error("Идентификатор номера WhatsApp не задан в Настройках");
  return {
    token: c.waToken,
    url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.waPhoneId}/messages`,
    body: {
      messaging_product: "whatsapp",
      to: recipientId,
      type: "location",
      location: { latitude: lat, longitude: lng, ...(name ? { name } : {}), ...(address ? { address } : {}) },
    },
  };
}

export function sendLocation(...args: Parameters<typeof sendLocationImpl>): ReturnType<typeof sendLocationImpl> {
  return traceObserveSend("location", "", undefined, () => sendLocationImpl(...args), { channel: "WHATSAPP", peer: args[0] });
}
async function sendLocationImpl(
  recipientId: string,
  lat: number,
  lng: number,
  name?: string,
  address?: string,
  tokenOverride?: string,
  transport?: CustomerTransportReference
): Promise<string | null> {
  const loaded = await loadCredentials();
  const captured = transport ?? await resolveLegacyMetaSendTransport(loaded, "WHATSAPP", recipientId, tokenOverride);
  const bound = await bindCustomerMetaSendCredentials(loaded, "WHATSAPP", recipientId, tokenOverride, captured);
  const c = bound?.credentials ?? loaded;
  const { token: fallbackToken, url, body } = buildLocationRequest(c, recipientId, lat, lng, name, address);
  const token = bound?.token || tokenOverride || fallbackToken;
  if (!token) throw new Error("Маркер доступа для WhatsApp не задан в Настройках");
  try {
    const res = await callGraph<{ messages?: { id?: string }[] }>(url, token, body);
    return await rememberedMid(res?.messages?.[0]?.id ?? null);
  } catch (err) {
    logMetaSendError("Геометка в WhatsApp не отправлена", err);
    throw err;
  }
}

/**
 * НАСТОЯЩАЯ РЕАКЦИЯ (тап эмодзи на сообщение), а не отдельным сообщением.
 *
 * Только WhatsApp Cloud API: `type: "reaction"` документирован и стабилен.
 * Instagram/Messenger Send API такого типа не предоставляет (нет эндпоинта
 * «поставить реакцию от имени страницы/бизнеса») — вызывающий должен сам
 * решить, что делать на этих каналах (см. `emojiThanksReply` в webhooks.ts —
 * там ставится текстовым сообщением-смайликом, это НЕ обходной путь этой
 * функции, а единственный доступный способ на IG/Messenger).
 *
 * @param messageId `wamid` сообщения клиента, на которое реагируем — то же
 *   поле, что `msg.messageId` из parseIncoming.
 * @param emoji Пустая строка снимает ранее поставленную реакцию (правило Meta).
 */
export function buildReactionRequest(
  c: MetaCredentials,
  recipientId: string,
  messageId: string,
  emoji: string
): { token?: string; url: string; body: unknown } {
  if (!c.waPhoneId) throw new Error("Идентификатор номера WhatsApp не задан в Настройках");
  return {
    token: c.waToken,
    url: `https://graph.facebook.com/${GRAPH_VERSION}/${c.waPhoneId}/messages`,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientId,
      type: "reaction",
      reaction: { message_id: messageId, emoji },
    },
  };
}

export function sendReaction(...args: Parameters<typeof sendReactionImpl>): ReturnType<typeof sendReactionImpl> {
  return traceObserveSend("reaction", "", undefined, () => sendReactionImpl(...args), { channel: "WHATSAPP", peer: args[0] });
}
async function sendReactionImpl(
  recipientId: string,
  messageId: string,
  emoji: string,
  tokenOverride?: string,
  transport?: CustomerTransportReference
): Promise<void> {
  const loaded = await loadCredentials();
  const captured = transport ?? await resolveLegacyMetaSendTransport(loaded, "WHATSAPP", recipientId, tokenOverride);
  const bound = await bindCustomerMetaSendCredentials(loaded, "WHATSAPP", recipientId, tokenOverride, captured);
  const c = bound?.credentials ?? loaded;
  const { token: fallbackToken, url, body } = buildReactionRequest(c, recipientId, messageId, emoji);
  const token = bound?.token || tokenOverride || fallbackToken;
  if (!token) throw new Error("Маркер доступа для WhatsApp не задан в Настройках");
  try {
    await callGraph(url, token, body);
  } catch (err) {
    // Реакция — украшение поверх уже случившегося разговора: её провал не должен
    // рушить основной ответ клиенту (тот же принцип, что у showReadAndTyping).
    logMetaSendError("Реакция в WhatsApp не поставлена", err);
  }
}
