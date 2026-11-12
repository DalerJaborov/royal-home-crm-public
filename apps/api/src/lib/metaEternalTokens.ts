import { createHash } from "node:crypto";
import type { MetaEternalKeyRow, MetaEternalState, MetaEternalStatus } from "@royal-home/shared";
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { GRAPH_VERSION, instagramApiUrl, instagramRequest } from "../messengers/metaGraph.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";
import { isMetaAuthFailure, raiseChannelKeyAlarm } from "./channelKeyAlarm.js";

/**
 * ВЕЧНЫЕ КЛЮЧИ META — ОДНА ДВЕРЬ (12.11.2026).
 *
 * Случай: 11.11 владелец сменил пароль Instagram — личный маркер входа через
 * Instagram (IGAA…) умер с 401, и бот @royal.home.tj замолчал. Личные маркеры
 * Страницы Facebook и рекламы живут ровно до смены пароля своего человека.
 *
 * Вечный путь: маркер системного пользователя компании (Settings.metaIgManageToken,
 * срок «никогда») → маркер Страницы `GET /{page-id}?fields=access_token` → переписка
 * Instagram/Facebook через graph.facebook.com. Пароли людей в цепочке не участвуют.
 *
 * ОГРАНИЧЕНИЕ (ФАКТ, Meta DevTools 12.11): у приложения ключа компании нет
 * Advanced Access к `pages_messaging` и `instagram_manage_messages` — путь через
 * Страницу ответит только людям с ролью в приложении, клиентам нет. Поэтому путь
 * для переписки включается ТОЛЬКО когда директор отметил «App Review одобрен»
 * И включил рубильник (оба по умолчанию выключены). Самопроверка и сторож ключей
 * работают независимо от них.
 *
 * Правила:
 *  - вечный путь предпочитается, только если: рубильник + «App Review одобрен» +
 *    ключ компании задан и у него есть нужные права (/me/permissions) + у
 *    аккаунта задана Страница + Meta подтвердила, что к Странице привязан ИМЕННО
 *    этот Instagram; иначе — прежний личный маркер;
 *  - подмена — у физического вызова (meta.ts::callGraph), поэтому её получают все
 *    пути отправки разом; при чётком отказе Meta на пути Страницы (4xx с телом
 *    ошибки) callGraph повторяет ОДИН раз личным ключом (routeFailed ниже);
 *  - личный маркер остаётся удостоверением аккаунта в CRM, стирать его нельзя.
 */

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const SNAPSHOT_TTL_MS = 60_000;
/** Выдачу Страницы перечитываем часто: доступ могут отозвать, а worker — свой процесс. */
const GRANT_TTL_MS = 10 * 60_000;
/** Отказ (и откат после ошибки Страницы) не долбим на каждое сообщение. */
const FAIL_TTL_MS = 5 * 60_000;
const SCOPES_TTL_MS = 10 * 60_000;
const ADS_TTL_MS = 6 * 60 * 60_000;
/** Отметку «последняя успешная отправка» пишем не чаще — это строка в базе. */
const SENT_MARK_EVERY_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 8_000;

/** Права ключа компании для Instagram через Страницу (Messenger Platform → Instagram, Get started). */
export const IG_PAGE_SCOPES = ["instagram_basic", "instagram_manage_messages", "pages_manage_metadata"];
/** Права для Messenger Страницы (Send API). */
export const FB_PAGE_SCOPES = ["pages_messaging"];
/** Коды Meta «ключ/права не те» — тревога директору на пути Страницы. */
const PERMISSION_CODES = new Set([3, 10, 102, 190, 230, 551]);
const isPermissionCode = (code: number | undefined) => code !== undefined && (PERMISSION_CODES.has(code) || (code >= 200 && code <= 299));

export interface EternalAccountRow {
  id: string;
  channel: string;
  title: string;
  externalId: string;
  pageId: string | null;
  token: string | undefined;
  enabled: boolean;
  username: string | null;
  eternalLastSentAt: Date | null;
}

interface Snapshot {
  at: number;
  preferred: boolean;
  appReviewApproved: boolean;
  systemToken?: string;
  settingsPageId?: string;
  settingsPageToken?: string;
  settingsPageLastSentAt: Date | null;
  settingsIgToken?: string;
  settingsWaToken?: string;
  adsToken?: string;
  accounts: EternalAccountRow[];
}

let snapshot: Snapshot | null = null;

type Grant =
  | { ok: true; at: number; token: string; pageName?: string; igId?: string }
  | { ok: false; at: number; reason: string; auth: boolean };
const grants = new Map<string, Grant>();
/** Маркер Страницы → id Страницы: узнать уже подменённый маркер (повторный вход, тревога). */
const pageTokenOwner = new Map<string, string>();

/** Кэш с объединением одновременных вызовов (single-flight) и коротким сроком для отказа. */
type Memo<T> = { at: number; ok: boolean; value: Promise<T> };
function memo<T>(store: Map<string, Memo<T>>, key: string, okTtl: number, failTtl: number, run: () => Promise<{ ok: boolean; value: T }>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? okTtl : failTtl)) return hit.value;
  const entry: Memo<T> = { at: Date.now(), ok: true, value: Promise.resolve(undefined as T) };
  entry.value = run().then(
    (r) => { entry.ok = r.ok; entry.at = Date.now(); return r.value; },
    (err) => { entry.ok = false; entry.at = Date.now(); throw err; }
  );
  store.set(key, entry);
  return entry.value;
}
const scopesMemo = new Map<string, Memo<Set<string> | null>>();
const adsMemo = new Map<string, Memo<{ ok: boolean; reason?: string }>>();
const sentMarks = new Map<string, number>();

/** Сброс при любой правке аккаунтов/настроек (accounts.ts::resetAccountsCache, маршруты). */
export function resetMetaEternalCache(): void {
  snapshot = null;
  grants.clear();
  pageTokenOwner.clear();
  scopesMemo.clear();
  adsMemo.clear();
  sentMarks.clear();
}

const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 12);
const grantKey = (pageId: string, systemToken: string) => `${pageId}:${fingerprint(systemToken)}`;

async function loadSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot;
  const [s, rows] = await Promise.all([
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        metaSystemTokenPreferred: true,
        metaAppReviewApproved: true,
        metaIgManageToken: true,
        metaPageId: true,
        metaPageToken: true,
        metaPageEternalLastSentAt: true,
        metaIgToken: true,
        metaWaToken: true,
        metaAdsToken: true,
      },
    }),
    prisma.messengerAccount.findMany({
      select: { id: true, channel: true, title: true, externalId: true, pageId: true, token: true, enabled: true, username: true, eternalLastSentAt: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
  ]);
  snapshot = {
    at: Date.now(),
    preferred: s?.metaSystemTokenPreferred ?? false,
    appReviewApproved: s?.metaAppReviewApproved ?? false,
    systemToken: decryptSecretSafe(s?.metaIgManageToken ?? null) || undefined,
    settingsPageId: s?.metaPageId || process.env.META_PAGE_ID || undefined,
    settingsPageToken: decryptSecretSafe(s?.metaPageToken ?? null) || process.env.META_PAGE_TOKEN || undefined,
    settingsPageLastSentAt: s?.metaPageEternalLastSentAt ?? null,
    settingsIgToken: decryptSecretSafe(s?.metaIgToken ?? null) || process.env.META_IG_TOKEN || undefined,
    settingsWaToken: decryptSecretSafe(s?.metaWaToken ?? null) || process.env.META_WA_TOKEN || undefined,
    adsToken: decryptSecretSafe(s?.metaAdsToken ?? null) || process.env.META_ADS_TOKEN || undefined,
    accounts: rows.map((r) => ({ ...r, token: decryptSecretSafe(r.token) || undefined })),
  };
  return snapshot;
}

/** Путь переписки через ключ компании вообще разрешён? (рубильник + App Review + ключ) */
const messagingAllowed = (s: Snapshot) => s.preferred && s.appReviewApproved && Boolean(s.systemToken);

async function graphJson(url: string, token: string, init?: { method?: "GET" | "POST"; body?: URLSearchParams }) {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: init?.body,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { ok: res.ok, status: res.status, text, data: data as Record<string, unknown> | null };
}

function graphErrorText(r: { status: number; data: Record<string, unknown> | null; text: string }): string {
  const err = (r.data?.error ?? null) as { message?: string; code?: number } | null;
  return `HTTP ${r.status}${err?.code ? ` код ${err.code}` : ""}: ${err?.message ?? r.text.slice(0, 160)}`;
}

/** Выданные ключу права (/me/permissions), кэш 10 мин, отказ — 5 мин, одновременные — один запрос. */
export function grantedScopes(token: string): Promise<Set<string> | null> {
  return memo(scopesMemo, fingerprint(token), SCOPES_TTL_MS, FAIL_TTL_MS, async () => {
    try {
      const r = await graphJson(`${GRAPH}/me/permissions`, token);
      if (!r.ok) return { ok: false, value: null };
      const rows = (r.data?.data ?? []) as Array<{ permission?: string; status?: string }>;
      return { ok: true, value: new Set(rows.filter((p) => p.status === "granted" && p.permission).map((p) => p.permission as string)) };
    } catch {
      return { ok: false, value: null };
    }
  });
}

async function missingScopes(token: string, required: string[]): Promise<string[] | null> {
  const granted = await grantedScopes(token);
  if (!granted) return null;
  return required.filter((p) => !granted.has(p));
}

/**
 * Маркер Страницы от системного пользователя. Заодно Meta говорит, какой
 * Instagram к Странице привязан, — по нему сверяем, что отвечаем от того аккаунта.
 */
async function systemPageGrant(pageId: string, systemToken: string): Promise<Grant> {
  const key = grantKey(pageId, systemToken);
  const cached = grants.get(key);
  if (cached && Date.now() - cached.at < (cached.ok ? GRANT_TTL_MS : FAIL_TTL_MS)) return cached;
  let grant: Grant;
  try {
    const r = await graphJson(`${GRAPH}/${encodeURIComponent(pageId)}?fields=access_token,name,instagram_business_account`, systemToken);
    const token = typeof r.data?.access_token === "string" ? r.data.access_token : undefined;
    if (r.ok && token) {
      const ig = r.data?.instagram_business_account as { id?: string } | undefined;
      grant = { ok: true, at: Date.now(), token, pageName: typeof r.data?.name === "string" ? r.data.name : undefined, igId: ig?.id };
      pageTokenOwner.set(token, pageId);
    } else {
      const auth = isMetaAuthFailure(r.status, r.text);
      grant = {
        ok: false,
        at: Date.now(),
        auth,
        reason: r.ok ? "Meta не выдала маркер Страницы — Страница не назначена системному пользователю" : graphErrorText(r),
      };
      if (auth) {
        void raiseChannelKeyAlarm({
          key: "meta-system-user",
          label: "Вечный ключ Meta (системный пользователь)",
          detail: grant.reason,
          fix: "Business Suite → Настройки компании → Системные пользователи → выпустить ключ заново и вставить в Настройки → Каналы.",
        });
      }
    }
  } catch (err) {
    grant = { ok: false, at: Date.now(), auth: false, reason: describeError(err) };
  }
  grants.set(key, grant);
  return grant;
}

/** Выдачу Страницы забыть и 5 минут не пробовать (отказ Meta, 190 на маркере Страницы). */
function benchPage(pageId: string, reason: string, systemToken?: string): void {
  for (const [token, owner] of pageTokenOwner) if (owner === pageId) pageTokenOwner.delete(token);
  const keys = systemToken ? [grantKey(pageId, systemToken)] : [...grants.keys()].filter((k) => k.startsWith(`${pageId}:`));
  for (const key of keys) grants.set(key, { ok: false, at: Date.now(), auth: false, reason });
}

export type InstagramRoute =
  | { kind: "instagram_login"; token: string }
  | { kind: "page"; token: string; pageId: string; accountId: string | null };

/**
 * Каким путём говорить с Instagram, если в руках — маркер аккаунта. Никогда не
 * бросает: худший исход — прежний личный путь.
 */
export async function instagramRouteForToken(token: string): Promise<InstagramRoute> {
  const fallback: InstagramRoute = { kind: "instagram_login", token };
  try {
    const knownPage = pageTokenOwner.get(token);
    if (knownPage) return { kind: "page", token, pageId: knownPage, accountId: null };
    const s = await loadSnapshot();
    if (!messagingAllowed(s)) return fallback;
    const account = s.accounts.find((a) => a.channel === "INSTAGRAM" && a.token === token && a.pageId);
    if (!account?.pageId) return fallback;
    const missing = await missingScopes(s.systemToken!, IG_PAGE_SCOPES);
    if (!missing || missing.length) return fallback;
    const grant = await systemPageGrant(account.pageId, s.systemToken!);
    if (!grant.ok) return fallback;
    if (grant.igId !== account.externalId) {
      // Отвечать от Страницы с ЧУЖИМ Instagram нельзя — это ответ не тем аккаунтом.
      void logSystemError(
        "meta",
        `Вечный ключ Instagram «${account.title}» не включён: к Странице ${account.pageId} привязан ` +
          `Instagram ${grant.igId ?? "—"}, а у аккаунта ${account.externalId}. Проверьте Страницу в Настройках → Каналы.`,
        { dedupKey: `ig-page-mismatch:${account.id}`, dedupWindowMs: 24 * 60 * 60_000 }
      );
      return fallback;
    }
    return { kind: "page", token: grant.token, pageId: account.pageId, accountId: account.id };
  } catch (err) {
    console.warn("[вечные ключи] путь Instagram не выбран, остаётся личный маркер:", describeError(err));
    return fallback;
  }
}

/** Чья это Страница Facebook по личному маркеру: Настройки или аккаунт FACEBOOK. */
function facebookOwner(s: Snapshot, token: string): { pageId: string; accountId: string | null } | null {
  if (s.settingsPageToken && token === s.settingsPageToken && s.settingsPageId) return { pageId: s.settingsPageId, accountId: null };
  const account = s.accounts.find((a) => a.channel === "FACEBOOK" && a.token === token);
  return account ? { pageId: account.externalId, accountId: account.id } : null;
}

async function facebookRoute(token: string, urlPageId?: string): Promise<{ token: string; pageId: string; accountId: string | null } | null> {
  if (pageTokenOwner.has(token)) return null;
  const s = await loadSnapshot();
  if (!messagingAllowed(s)) return null;
  const owner = facebookOwner(s, token);
  if (!owner) return null;
  // Адрес обязан быть адресом ЭТОЙ Страницы (или /me её маркера) — не номером
  // WhatsApp и не чужой Страницей.
  if (urlPageId && urlPageId !== "me" && urlPageId !== owner.pageId) return null;
  const missing = await missingScopes(s.systemToken!, FB_PAGE_SCOPES);
  if (!missing || missing.length) return null;
  const grant = await systemPageGrant(owner.pageId, s.systemToken!);
  return grant.ok ? { token: grant.token, ...owner } : null;
}

/** Маркер для переписки Страницы Facebook (чтение имени собеседника и т.п.). */
export async function facebookPageTokenFor(token: string): Promise<string> {
  try {
    return (await facebookRoute(token))?.token ?? token;
  } catch (err) {
    console.warn("[вечные ключи] маркер Страницы не подменён:", describeError(err));
    return token;
  }
}

/** Адрес переписки Страницы; чья это Страница — решает facebookRoute по маркеру и id. */
const FB_MESSAGES = /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/(me|\d+)\/messages$/;

export type RoutedCall = {
  url: string;
  token: string;
  body: unknown;
  route: "instagram_page" | "facebook_page" | "unchanged";
  pageId?: string;
  accountId?: string | null;
};

/**
 * ДВЕРЬ У ФИЗИЧЕСКОГО ВЫЗОВА (meta.ts::callGraph). Только адреса переписки:
 *  - Instagram `/me/messages` → `graph.facebook.com/{page}/messages` маркером
 *    Страницы; обычному ответу — `messaging_type: RESPONSE` (Send API);
 *  - Facebook `/{page}/messages` известной Страницы (и `/me/messages` её маркера)
 *    → маркер той же Страницы от системного пользователя.
 * Комментарии, публикации и прочее не трогаем.
 */
export async function routeMetaMessagingCall(url: string, token: string, body: unknown): Promise<RoutedCall> {
  const same: RoutedCall = { url, token, body, route: "unchanged" };
  try {
    if (url === instagramApiUrl(`/${GRAPH_VERSION}/me/messages`)) {
      const route = await instagramRouteForToken(token);
      if (route.kind !== "page") return same;
      return { url: `${GRAPH}/${route.pageId}/messages`, token: route.token, body: withResponseType(body), route: "instagram_page", pageId: route.pageId, accountId: route.accountId };
    }
    const match = FB_MESSAGES.exec(url);
    if (match) {
      const fb = await facebookRoute(token, match[1]);
      if (fb) return { url, token: fb.token, body, route: "facebook_page", pageId: fb.pageId, accountId: fb.accountId };
    }
  } catch (err) {
    console.warn("[вечные ключи] путь не выбран:", describeError(err));
  }
  return same;
}

function withResponseType(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const value = body as Record<string, unknown>;
  const recipient = value.recipient as Record<string, unknown> | undefined;
  if (!value.message || value.messaging_type || value.sender_action || !recipient || !("id" in recipient)) return body;
  return { ...value, messaging_type: "RESPONSE" };
}

/**
 * Отказ Meta на пути Страницы. Возвращает true, если callGraph должен ОДИН раз
 * повторить личным ключом: только чёткий ответ-ошибка (4xx с телом error) — Meta
 * сообщение не приняла, повтор не задвоит. Таймаут и обрыв сюда не попадают.
 * Выдача Страницы скамейкой на 5 минут: следующие сообщения сразу идут личным.
 */
export function pageRouteFailed(routed: RoutedCall, status: number, text: string): boolean {
  if (routed.route === "unchanged" || !routed.pageId) return false;
  let error: { code?: number; message?: string } | undefined;
  try { error = (JSON.parse(text) as { error?: { code?: number; message?: string } }).error; } catch { error = undefined; }
  if (status < 400 || status >= 500 || !error) return false;
  benchPage(routed.pageId, `отказ Meta на пути Страницы: HTTP ${status}${error.code ? ` код ${error.code}` : ""}`);
  if (isPermissionCode(error.code) || isMetaAuthFailure(status, text)) {
    void raiseChannelKeyAlarm({
      key: `page-route:${routed.pageId}`,
      label: `${routed.route === "instagram_page" ? "Instagram" : "Facebook"} через Страницу ${routed.pageId} (ключ компании)`,
      detail: `HTTP ${status} код ${error.code ?? "—"}: ${error.message ?? ""}`,
      fix: "Ответ ушёл личным ключом. Проверьте «Вечные ключи» в Настройках → Каналы: права ключа компании и App Review.",
    });
  }
  return true;
}

/**
 * Успешная отправка через Страницу — отметка по аккаунту: экран показывает
 * «работает» только после настоящей отправки, а не по одной проверке ключа.
 */
export async function recordEternalSendSuccess(routed: RoutedCall): Promise<void> {
  if (routed.route === "unchanged" || !routed.pageId) return;
  const key = routed.accountId ?? `settings:${routed.pageId}`;
  const last = sentMarks.get(key);
  if (last && Date.now() - last < SENT_MARK_EVERY_MS) return;
  sentMarks.set(key, Date.now());
  try {
    if (routed.accountId) await prisma.messengerAccount.update({ where: { id: routed.accountId }, data: { eternalLastSentAt: new Date() } });
    else await prisma.settings.update({ where: { id: "singleton" }, data: { metaPageEternalLastSentAt: new Date() } });
  } catch (err) {
    console.warn("[вечные ключи] отметка отправки не записана:", describeError(err));
  }
}

/** 190/102 на маркере Страницы: выдачу забыть сразу, а не ждать срока кэша. */
export function forgetPageToken(token: string): void {
  const pageId = pageTokenOwner.get(token);
  if (pageId) benchPage(pageId, "маркер Страницы отвергнут Meta");
}

/**
 * Чтение по Instagram (профиль собеседника, «видит ли маркер человека»): тот же
 * выбор пути, адрес graph.facebook.com при вечном ключе.
 */
export async function instagramReadRequest(path: string, token: string): Promise<{ url: string; headers: Record<string, string> }> {
  const route = await instagramRouteForToken(token);
  if (route.kind === "page") return { url: `https://graph.facebook.com${path}`, headers: { Authorization: `Bearer ${route.token}` } };
  return instagramRequest(instagramApiUrl(path), token);
}

/** Чей это маркер — для тревоги «ключ умер». Наружу — метка и имя, не маркер. */
export async function describeMetaToken(token: string): Promise<{ key: string; label: string }> {
  const page = pageTokenOwner.get(token);
  if (page) return { key: `page-route:${page}`, label: `Ключ компании для Страницы ${page}` };
  try {
    const s = await loadSnapshot();
    const account = s.accounts.find((a) => a.token === token);
    if (account) {
      const name = account.channel === "INSTAGRAM" ? "Instagram" : account.channel === "FACEBOOK" ? "Facebook" : "WhatsApp";
      return { key: `account:${account.id}`, label: `${name} «${account.title}» (личный маркер)` };
    }
    if (token === s.settingsPageToken) return { key: "settings:metaPageToken", label: "Страница Facebook (маркер в Настройках)" };
    if (token === s.settingsIgToken) return { key: "settings:metaIgToken", label: "Instagram (запасной маркер в Настройках)" };
    if (token === s.settingsWaToken) return { key: "settings:metaWaToken", label: "WhatsApp (маркер в Настройках)" };
    if (token === s.systemToken) return { key: "meta-system-user", label: "Вечный ключ Meta (системный пользователь)" };
  } catch {
    // Имя не нашли — тревога всё равно уйдёт, по отпечатку.
  }
  return { key: `meta-token:${fingerprint(token)}`, label: "Ключ Meta" };
}

// ─────────────────────────────── реклама ───────────────────────────────

/**
 * Маркер для рекламы (чтение расходов И запись: пауза по стоп-лоссу в
 * reelsAutoBoostMeta.ts). Ключ компании — только если у него не меньше прав на
 * рекламу, чем у личного, и в КАЖДОМ кабинете у него задача ADVERTISE или MANAGE.
 * Иначе личный: правка не имеет права сломать то, что работает сейчас.
 * Апп-ревью не нужно: свои кабинеты компании (ОЦЕНКА), поэтому только рубильник.
 */
export async function eternalAdsToken(personal: string | null, adAccountIds: string[]): Promise<string | null> {
  try {
    const s = await loadSnapshot();
    if (!s.preferred || !s.systemToken || adAccountIds.length === 0) return personal;
    const check = await adsCheck(s.systemToken, personal, adAccountIds);
    return check.ok ? s.systemToken : personal;
  } catch {
    return personal;
  }
}

const ADS_SCOPES = ["ads_read", "ads_management", "business_management"];
const ADS_WRITE_TASKS = ["ADVERTISE", "MANAGE"];

/** Результат кэшируется (успех 6 ч, отказ 5 мин), одновременные вызовы — один запрос. */
export function adsCheck(systemToken: string, personal: string | null, adAccountIds: string[]): Promise<{ ok: boolean; reason?: string }> {
  const key = `${fingerprint(systemToken)}:${personal ? fingerprint(personal) : "-"}:${adAccountIds.join(",")}`;
  return memo(adsMemo, key, ADS_TTL_MS, FAIL_TTL_MS, async () => {
    const value = await adsCheckNow(systemToken, personal, adAccountIds).catch((err) => ({ ok: false, reason: describeError(err) }));
    return { ok: value.ok, value };
  });
}

async function adsCheckNow(systemToken: string, personal: string | null, adAccountIds: string[]): Promise<{ ok: boolean; reason?: string }> {
  const sys = await grantedScopes(systemToken);
  if (!sys) return { ok: false, reason: "права ключа компании не прочитаны" };
  if (!sys.has("ads_read") && !sys.has("ads_management")) return { ok: false, reason: "у ключа компании нет права ads_read" };
  if (personal) {
    const mine = await grantedScopes(personal);
    const missing = mine ? ADS_SCOPES.filter((p) => mine.has(p) && !sys.has(p)) : [];
    if (missing.length) return { ok: false, reason: `у ключа компании нет прав: ${missing.join(", ")}` };
  }
  for (const id of adAccountIds) {
    const r = await graphJson(`${GRAPH}/${encodeURIComponent(id)}?fields=id,user_tasks`, systemToken);
    if (!r.ok) return { ok: false, reason: `кабинет ${id} не выдан системному пользователю (${graphErrorText(r)})` };
    const tasks = Array.isArray(r.data?.user_tasks) ? (r.data!.user_tasks as unknown[]).map(String) : [];
    if (!tasks.some((t) => ADS_WRITE_TASKS.includes(t))) {
      return { ok: false, reason: `в кабинете ${id} у системного пользователя нет задачи «Реклама» или «Управление» (стоп-лосс не сможет ставить паузу)` };
    }
  }
  return { ok: true };
}

// ─────────────────────────────── настройки ───────────────────────────────

const SHARE_HINT = (what: string) =>
  `Business Suite → Настройки компании → Пользователи → Системные пользователи → royalhome-crm → «Назначить ресурсы» → ${what} → полный доступ.`;
const REVIEW_HINT =
  "Ждёт одобрения Meta (App Review: pages_messaging, instagram_manage_messages — расширенный доступ). Пока его нет, путь через Страницу ответит только людям с ролью в приложении, поэтому для клиентов он выключен.";
const TEST_HINT =
  "Проверка: напишите в этот аккаунт с личного профиля, у которого НЕТ роли в приложении Meta, — только так видно, что ответ дойдёт до любого клиента.";

/** Самопроверка для экрана Настроек: кому что докликать. Ничего не меняет. Работает и при выключенном рубильнике. */
export async function metaEternalStatus(): Promise<MetaEternalStatus> {
  snapshot = null; // свежие настройки; кэш маркеров Страниц живой переписке не сбрасываем
  scopesMemo.clear();
  const s = await loadSnapshot();
  const systemUser: MetaEternalStatus["systemUser"] = { configured: Boolean(s.systemToken), ok: false, missingScopes: [] };
  let appId: string | undefined;
  let granted: Set<string> | null = null;
  if (s.systemToken) {
    try {
      const me = await graphJson(`${GRAPH}/me?fields=id,name`, s.systemToken);
      systemUser.ok = me.ok;
      systemUser.name = typeof me.data?.name === "string" ? me.data.name : undefined;
      if (!me.ok) systemUser.detail = graphErrorText(me);
      const app = me.ok ? await graphJson(`${GRAPH}/app?fields=id`, s.systemToken) : null;
      appId = typeof app?.data?.id === "string" ? app.data.id : undefined;
      systemUser.appId = appId;
      granted = me.ok ? await grantedScopes(s.systemToken) : null;
      systemUser.missingScopes = granted ? [...IG_PAGE_SCOPES, ...FB_PAGE_SCOPES].filter((p) => !granted!.has(p)) : [];
    } catch (err) {
      systemUser.detail = describeError(err);
    }
  }
  const rows: MetaEternalKeyRow[] = [];
  const pageRow = async (
    base: Omit<MetaEternalKeyRow, "state" | "hint">,
    required: string[],
    lastSentAt: Date | null,
    igId?: string
  ): Promise<MetaEternalKeyRow> => {
    const row = { ...base, lastSentAt: lastSentAt?.toISOString() ?? null };
    const say = (state: MetaEternalState, hint: string): MetaEternalKeyRow => ({ ...row, state, hint });
    if (!s.systemToken || !systemUser.ok) return say("no_system", "Вставьте ключ системного пользователя royalhome-crm в «Маркер удаления Instagram» (Настройки → Каналы).");
    if (!granted) return say("error", "Не удалось прочитать права ключа компании. Нажмите «Проверить ещё раз».");
    const missing = required.filter((p) => !granted!.has(p));
    if (missing.length) return say("missing_scopes", `У ключа компании нет прав: ${missing.join(", ")}. Выпустите ключ системного пользователя заново с этими правами.`);
    if (!base.pageId) return say("no_page", "Нажмите «Найти Страницу» — CRM сама найдёт Страницу Facebook, к которой привязан этот Instagram.");
    const grant = await systemPageGrant(base.pageId, s.systemToken);
    if (!grant.ok) return say("page_not_shared", SHARE_HINT(`Страницы → ${base.pageId}`));
    const named = { ...row, pageName: grant.pageName };
    if (igId && grant.igId !== igId) return { ...named, state: "mismatch", hint: "К этой Странице привязан другой Instagram. Нажмите «Найти Страницу» ещё раз." };
    const subscribed = await pageSubscribed(base.pageId, grant.token, appId);
    const withSub = { ...named, subscribed };
    if (!s.appReviewApproved) return { ...withSub, state: "awaiting_review", hint: REVIEW_HINT };
    if (!s.preferred) return { ...withSub, state: "off", hint: "Всё готово. Включите рубильник «Ключ компании вместо личных»." };
    if (!lastSentAt) return { ...withSub, state: "pending_first_send", hint: `Ни одной отправки через Страницу ещё не было. ${TEST_HINT}` };
    return {
      ...withSub,
      state: "ready",
      hint:
        subscribed === false
          ? "«Подписать Страницу» — только если входящие перестанут приходить: при двух подписках сообщение может прийти дважды."
          : "",
    };
  };
  for (const a of s.accounts.filter((x) => x.channel === "INSTAGRAM")) {
    rows.push(await pageRow({ key: `account:${a.id}`, title: `Instagram «${a.title}»${a.username ? ` @${a.username}` : ""}`, channel: "INSTAGRAM", accountId: a.id, pageId: a.pageId }, IG_PAGE_SCOPES, a.eternalLastSentAt, a.externalId));
  }
  const fbAccounts = s.accounts.filter((x) => x.channel === "FACEBOOK");
  for (const a of fbAccounts) {
    rows.push(await pageRow({ key: `account:${a.id}`, title: `Facebook «${a.title}»`, channel: "FACEBOOK", accountId: a.id, pageId: a.externalId }, FB_PAGE_SCOPES, a.eternalLastSentAt));
  }
  if (fbAccounts.length === 0 && s.settingsPageId) {
    rows.push(await pageRow({ key: "settings:metaPageToken", title: "Страница Facebook (Messenger)", channel: "FACEBOOK", pageId: s.settingsPageId }, FB_PAGE_SCOPES, s.settingsPageLastSentAt));
  }
  const ads = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaAdsEnabled: true, metaAdAccountId: true } });
  if (ads?.metaAdsEnabled && ads.metaAdAccountId) {
    const ids = ads.metaAdAccountId.split(/[\s,]+/).filter(Boolean).map((v) => (v.startsWith("act_") ? v : `act_${v}`));
    let state: MetaEternalState;
    let hint: string;
    if (!s.systemToken || !systemUser.ok) {
      state = "no_system";
      hint = "Нет ключа системного пользователя.";
    } else {
      adsMemo.clear();
      const check = await adsCheck(s.systemToken, s.adsToken ?? null, ids);
      if (!check.ok) {
        state = "page_not_shared";
        hint = `${check.reason}. ${SHARE_HINT("Рекламные аккаунты → каждый кабинет, задача «Реклама» или «Управление»")} Если кабинета нет в списке — сначала его владелец даёт компании партнёрский доступ.`;
      } else if (!s.preferred) {
        state = "off";
        hint = "Готово. Включите рубильник, чтобы реклама шла ключом компании.";
      } else {
        state = "ready";
        hint = "";
      }
    }
    rows.push({ key: "meta-ads", title: "Отчёт по рекламе", channel: "ADS", state, hint });
  }
  return { preferred: s.preferred, appReviewApproved: s.appReviewApproved, systemUser, rows };
}

async function pageSubscribed(pageId: string, pageToken: string, appId: string | undefined): Promise<boolean | null> {
  if (!appId) return null;
  try {
    const r = await graphJson(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`, pageToken);
    if (!r.ok) return null;
    const apps = (r.data?.data ?? []) as Array<{ id?: string; subscribed_fields?: string[] }>;
    const ours = apps.find((x) => x.id === appId);
    return Boolean(ours?.subscribed_fields?.includes("messages"));
  } catch {
    return null;
  }
}

/**
 * «Найти Страницу»: среди Страниц, выданных системному пользователю, та, к
 * которой привязан Instagram аккаунта. Ничего не записывает — это делает маршрут.
 */
export async function discoverInstagramPage(externalId: string): Promise<{ ok: true; pageId: string; pageName?: string } | { ok: false; error: string }> {
  const s = await loadSnapshot();
  if (!s.systemToken) return { ok: false, error: "Нет ключа системного пользователя." };
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await graphJson(
      `${GRAPH}/me/accounts?fields=id,name,instagram_business_account&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      s.systemToken
    );
    if (!r.ok) return { ok: false, error: graphErrorText(r) };
    const rows = (r.data?.data ?? []) as Array<{ id?: string; name?: string; instagram_business_account?: { id?: string } }>;
    const hit = rows.find((p) => p.instagram_business_account?.id === externalId && p.id);
    if (hit?.id) return { ok: true, pageId: hit.id, pageName: hit.name };
    const paging = r.data?.paging as { next?: string; cursors?: { after?: string } } | undefined;
    after = paging?.next ? paging.cursors?.after : undefined;
    if (!after) break;
  }
  return { ok: false, error: `Страница с этим Instagram не выдана системному пользователю. ${SHARE_HINT("Страницы → нужная Страница")}` };
}

/** Проверка выбранной Страницы перед записью: Meta подтверждает её Instagram. */
export async function verifyInstagramPage(pageId: string, externalId: string): Promise<{ ok: true; pageName?: string } | { ok: false; error: string }> {
  const s = await loadSnapshot();
  if (!s.systemToken) return { ok: false, error: "Нет ключа системного пользователя." };
  grants.delete(grantKey(pageId, s.systemToken));
  const grant = await systemPageGrant(pageId, s.systemToken);
  if (!grant.ok) return { ok: false, error: `Страница не выдана системному пользователю: ${grant.reason}` };
  if (grant.igId !== externalId) return { ok: false, error: `К Странице привязан другой Instagram (${grant.igId ?? "никакой"}).` };
  return { ok: true, pageName: grant.pageName };
}

/** Поля, на которые подписываем Страницу. Чужие поля нашего приложения сохраняем. */
export const PAGE_MESSAGING_FIELDS = ["messages", "messaging_postbacks"];

/**
 * «Подписать Страницу»: POST /{page}/subscribed_apps маркером Страницы от
 * системного пользователя. Список полей ОБЪЕДИНЯЕТСЯ с уже подписанными у
 * нашего приложения — POST задаёт список целиком, и голый вызов снял бы, например,
 * `feed` (комментарии). Не узнали приложение или текущую подписку — отказ, без POST.
 */
export async function subscribePageMessaging(pageId: string): Promise<{ ok: true; fields: string[] } | { ok: false; error: string }> {
  const s = await loadSnapshot();
  if (!s.systemToken) return { ok: false, error: "Нет ключа системного пользователя." };
  const grant = await systemPageGrant(pageId, s.systemToken);
  if (!grant.ok) return { ok: false, error: grant.reason };
  const app = await graphJson(`${GRAPH}/app?fields=id`, s.systemToken).catch(() => null);
  const appId = app?.ok && typeof app.data?.id === "string" ? app.data.id : undefined;
  if (!appId) return { ok: false, error: "Не удалось узнать приложение ключа компании — подписка не изменена. Нажмите ещё раз позже." };
  const current = await graphJson(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`, grant.token);
  if (!current.ok) return { ok: false, error: `Текущая подписка не прочитана — не меняю: ${graphErrorText(current)}` };
  const ours = ((current.data?.data ?? []) as Array<{ id?: string; subscribed_fields?: string[] }>).find((x) => x.id === appId);
  const fields = Array.from(new Set([...(ours?.subscribed_fields ?? []), ...PAGE_MESSAGING_FIELDS]));
  const r = await graphJson(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`, grant.token, {
    method: "POST",
    body: new URLSearchParams({ subscribed_fields: fields.join(",") }),
  });
  if (!r.ok) return { ok: false, error: graphErrorText(r) };
  return { ok: true, fields };
}
