import { createHash } from "node:crypto";
import type { MetaEternalKeyRow, MetaEternalState, MetaEternalStatus } from "@royal-home/shared";
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { GRAPH_VERSION, instagramApiUrl, instagramRequest, isFacebookLoginToken } from "../messengers/metaGraph.js";
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
 *
 * INSTAGRAM С 21.11.2026 (владелец: «Да, переводи»): для Instagram отметка «App Review
 * одобрен» и общий рубильник больше не нужны — путь решает рубильник реестра
 * «Автоматика» `Settings.instagramCompanyKeyEnabled` (ВКЛ) плюс проверка аккаунта
 * (ключ компании, права, Страница с этим же Instagram). Довод: Messenger той же Страницы
 * Royal.home.tj в том же приложении без App Review отвечает клиентам (72 диалога за 30
 * дней, прод 21.11), IGSID путей совпадают (48 из 50 собеседников). Документация при
 * стандартном доступе обещает ответ только людям с ролью — если Meta откажет, срабатывает
 * откат на личный ключ ниже и тревога руководству. Facebook-путь — по-прежнему за обоими
 * флагами (Arvan 15.11: людям без роли не доходило).
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
  accessLostAt: Date | null;
  accessLostReason: string | null;
}

interface Snapshot {
  at: number;
  preferred: boolean;
  appReviewApproved: boolean;
  /** Рубильник «Instagram через постоянный ключ Meta» (реестр «Автоматика», ВКЛ по умолчанию). */
  igCompanyKey: boolean;
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
        instagramCompanyKeyEnabled: true,
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
      select: {
        id: true, channel: true, title: true, externalId: true, pageId: true, token: true, enabled: true, username: true,
        eternalLastSentAt: true, accessLostAt: true, accessLostReason: true,
      },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
  ]);
  snapshot = {
    at: Date.now(),
    preferred: s?.metaSystemTokenPreferred ?? false,
    appReviewApproved: s?.metaAppReviewApproved ?? false,
    igCompanyKey: s?.instagramCompanyKeyEnabled ?? true,
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

/** Путь переписки Facebook через ключ компании разрешён? (рубильник + App Review + ключ) */
const messagingAllowed = (s: Snapshot) => s.preferred && s.appReviewApproved && Boolean(s.systemToken);
/** Instagram через Страницу (21.11.2026): рубильник реестра «Автоматика» + ключ компании. */
const instagramAllowed = (s: Snapshot) => s.igCompanyKey && Boolean(s.systemToken);

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
        reason: r.ok ? "Meta не выдала ключ Страницы — Страница не назначена системному пользователю" : graphErrorText(r),
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
  /** pageOnly — аккаунт подключён входом через Facebook и держит маркер САМОЙ
   *  Страницы: другого пути у него нет, откатываться некуда. */
  | { kind: "page"; token: string; pageId: string; accountId: string | null; pageOnly?: boolean; igId?: string };

/**
 * Аккаунт Instagram с маркером Страницы (EAA…, «Войти через Facebook»,
 * 13.11.2026): говорит ТОЛЬКО через свою Страницу — graph.instagram.com такой
 * маркер не примет. Поэтому без рубильников и App Review: это не подмена
 * личного ключа ключом компании, а единственная дорога этого аккаунта.
 */
function pageOnlyRoute(s: Snapshot, token: string): InstagramRoute | null {
  if (!isFacebookLoginToken(token)) return null;
  const account = s.accounts.find((a) => a.channel === "INSTAGRAM" && a.token === token && a.pageId);
  return account?.pageId ? { kind: "page", token, pageId: account.pageId, accountId: account.id, pageOnly: true, igId: account.externalId } : null;
}

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
    const pageOnly = pageOnlyRoute(s, token);
    if (pageOnly) return pageOnly;
    if (!instagramAllowed(s)) return fallback;
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
    return { kind: "page", token: grant.token, pageId: account.pageId, accountId: account.id, igId: account.externalId };
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
  /** Личного ключа у аккаунта нет — повтор «личным» бессмыслен (см. pageOnlyRoute). */
  pageOnly?: boolean;
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
      return {
        url: `${GRAPH}/${route.pageId}/messages`,
        token: route.token,
        body: withResponseType(body),
        route: "instagram_page",
        pageId: route.pageId,
        accountId: route.accountId,
        ...(route.pageOnly ? { pageOnly: true } : {}),
      };
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
  // Маркер Страницы — единственный ключ аккаунта: откатываться некуда, отказ
  // идёт обычным путём ошибки (тревога «ключ не принят» — в callGraph).
  if (routed.pageOnly) return false;
  let error: { code?: number; error_subcode?: number; message?: string } | undefined;
  try { error = (JSON.parse(text) as { error?: { code?: number; error_subcode?: number; message?: string } }).error; } catch { error = undefined; }
  if (status < 400 || status >= 500 || !error) return false;
  /**
   * ОТКАЗ ПРО ОДНОГО СОБЕСЕДНИКА — НЕ ОТКАЗ ПУТИ (21.11.2026). «Человек недоступен», «вне окна
   * 24 часов», лимит частоты: Страница исправна, личный путь ответит тем же. Не скамейка, не
   * тревога «ключ перестал работать»; ошибка идёт обычным путём (окно, недоступен — как раньше).
   * «Нет такого собеседника» — один повтор личным ключом (вдруг id не тот на этом пути), без тревоги.
   */
  const recipient = recipientLevelError(error.code, error.error_subcode);
  if (recipient === "user_not_found") {
    void logSystemError("meta", `Путь Страницы ${routed.pageId}: Meta не нашла собеседника (код ${error.code}/${error.error_subcode ?? "-"}), ответ ушёл личным ключом аккаунта.`,
      { dedupKey: `page-route-no-user:${routed.pageId}`, dedupWindowMs: 24 * 60 * 60_000, silent: true });
    return true;
  }
  if (recipient) return false;
  benchPage(routed.pageId, `отказ Meta на пути Страницы: HTTP ${status}${error.code ? ` код ${error.code}` : ""}`);
  if (isPermissionCode(error.code) || isMetaAuthFailure(status, text)) {
    const instagram = routed.route === "instagram_page";
    void raiseChannelKeyAlarm({
      key: `page-route:${routed.pageId}`,
      label: `${instagram ? "Instagram" : "Facebook"} через Страницу ${routed.pageId} (ключ компании)`,
      detail: `HTTP ${status} код ${error.code ?? "—"}: ${error.message ?? ""}`,
      fix: instagram
        ? "Ответ ушёл личным ключом аккаунта. Проверьте «Вечные ключи» в Настройках → Каналы: доступ ключа компании к Странице и права."
        : "Ответ ушёл личным ключом. Проверьте «Вечные ключи» в Настройках → Каналы: права ключа компании и App Review.",
      ...(instagram ? { audience: "management" as const } : {}),
    });
  }
  return true;
}

/**
 * Коды Send API «про этого собеседника», а не про путь (первоисточник: Messenger Platform →
 * Error codes, developers.facebook.com/docs/messenger-platform/error-codes, сверено 21.11.2026):
 *  551 (любой подкод), 200/1545041 — «This person isn't available right now»;
 *  10/2018278, 10/2534022, 10/2018065 — «sent outside of allowed window»;
 *  10/2018108 — «They can't receive your messages right now»; 10/1893015 — человек отписался от темы;
 *  10/2018300, 100/2534037 — переписку ведёт другое приложение; 613 — лимиты частоты;
 *  100/2018001, 100/2534014 — «No matching (Instagram) user».
 * НЕ здесь (это отказ пути): 200 без подкода и 200/2018028 — «Cannot message users who are not
 * admins, developers or testers» (нет App Review), 100/2534013 — Страница не связана с Instagram,
 * 10/2534077 — связь Страницы и Instagram, 200/2534041 — владелец закрыл доступ к Direct, 190 — ключ.
 */
export function recipientLevelError(code: number | null | undefined, subcode: number | null | undefined): "user_not_found" | "recipient" | null {
  if (code === 100 && (subcode === 2018001 || subcode === 2534014)) return "user_not_found";
  if (code === 551 || code === 613) return "recipient";
  if (code === 200 && subcode === 1545041) return "recipient";
  if (code === 10 && subcode != null && [2018278, 2534022, 2018065, 2018108, 1893015, 2018300].includes(subcode)) return "recipient";
  if (code === 100 && subcode === 2534037) return "recipient";
  return null;
}

/**
 * Запрет Meta по правилам на пути Страницы (21.11.2026): аккаунт целиком не метим, а один раз
 * пробуем личным ключом — запрет мог касаться только ключа компании. Страница на скамейке 5 минут.
 * true — callGraph повторяет личным; метку «Meta не пропускает отправку» поставит отказ личного пути.
 */
export function pageRoutePolicyRefused(routed: RoutedCall, status: number, graph: { code: number | null; subcode: number | null }): boolean {
  if (routed.route === "unchanged" || !routed.pageId || routed.pageOnly) return false;
  const what = `HTTP ${status} код ${graph.code ?? "—"}/${graph.subcode ?? "-"}`;
  benchPage(routed.pageId, `запрет Meta на пути Страницы: ${what}`);
  void logSystemError("meta", `Путь Страницы ${routed.pageId}: Meta отказала по правилам (${what}), ответ пробуем личным ключом аккаунта.`,
    { dedupKey: `page-route-policy:${routed.pageId}`, dedupWindowMs: 6 * 60 * 60_000 });
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

/**
 * ЛЕНТА АККАУНТА (сайт, узнавание своих роликов) тем же путём, что и переписка
 * (21.11.2026). Через Страницу: `graph.facebook.com/{ig-id}/media` маркером Страницы
 * (проверено на проде 21.11 GET-запросом: 200, те же поля); иначе — прежний
 * `graph.instagram.com/me/media` личным маркером. `next` — готовая ссылка следующей
 * страницы из ответа: её хост решает, каким маркером идти.
 */
export async function instagramMediaRequest(
  token: string,
  query: string,
  next?: string
): Promise<{ url: string; headers: Record<string, string> } | null> {
  const route = await instagramRouteForToken(token);
  if (next) {
    // Ключ — по хосту ссылки, а не по нынешнему пути: путь мог смениться между страницами
    // (Страница на скамейке, рубильник). Ссылку Страницы личный ключ не откроет — null, дочитать нельзя.
    let host = "";
    try { host = new URL(next).host; } catch { return null; }
    if (host === "graph.facebook.com") {
      return route.kind === "page" ? { url: next, headers: { Authorization: `Bearer ${route.token}` } } : null;
    }
    return instagramRequest(next, token);
  }
  if (route.kind === "page" && route.igId) {
    return { url: `${GRAPH}/${encodeURIComponent(route.igId)}/media?${query}`, headers: { Authorization: `Bearer ${route.token}` } };
  }
  return instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/me/media?${query}`), token);
}

/**
 * Чей аккаунт отправляет (lib/metaSendBlock.ts: метка «Meta не пропускает отправку»
 * ставится аккаунту, а не каналу). По id строки или по личному маркеру — из того же
 * снимка на минуту, что и выбор пути выше, без отдельного запроса. Маркер из
 * Настроек — `settings:<канал>`. Наружу маркер не уходит.
 */
export async function metaSendAccountFor(input: { accountId?: string | null; token?: string }): Promise<
  { key: string; accountId: string | null; channel: string; title: string } | null
> {
  const s = await loadSnapshot();
  const row = input.accountId
    ? s.accounts.find((a) => a.id === input.accountId)
    : input.token ? s.accounts.find((a) => a.token === input.token) : undefined;
  if (row) return { key: `account:${row.id}`, accountId: row.id, channel: row.channel, title: row.title };
  if (input.accountId || !input.token) return null;
  if (input.token === s.settingsPageToken) return { key: "settings:FACEBOOK", accountId: null, channel: "FACEBOOK", title: "Страница Facebook" };
  if (input.token === s.settingsIgToken) return { key: "settings:INSTAGRAM", accountId: null, channel: "INSTAGRAM", title: "Instagram" };
  if (input.token === s.settingsWaToken) return { key: "settings:WHATSAPP", accountId: null, channel: "WHATSAPP", title: "WhatsApp" };
  return null;
}

/** Чей это маркер — для тревоги «ключ умер». Наружу — метка и имя, не маркер. */
export interface MetaTokenOwner {
  key: string;
  label: string;
  /** Аккаунт Instagram — тревога руководству «к сведению», раз в сутки (channelKeyAlarm.ts). */
  audience?: "management";
  /** Аккаунт Instagram, чей это маркер (для отметки «Meta закрыла доступ»). */
  instagramAccountId?: string;
  /** Отметка «Meta закрыла доступ» уже стоит — тревога об этом уже ушла. */
  accessLost?: boolean;
}

export async function describeMetaToken(token: string): Promise<MetaTokenOwner> {
  const page = pageTokenOwner.get(token);
  if (page) return { key: `page-route:${page}`, label: `Ключ компании для Страницы ${page}` };
  try {
    const s = await loadSnapshot();
    const account = s.accounts.find((a) => a.token === token);
    if (account) {
      const name = account.channel === "INSTAGRAM" ? "Instagram" : account.channel === "FACEBOOK" ? "Facebook" : "WhatsApp";
      const kind = account.channel === "INSTAGRAM" && isFacebookLoginToken(token) ? "ключ Страницы" : "личный ключ";
      const who: MetaTokenOwner = { key: `account:${account.id}`, label: `${name} «${account.title}» (${kind})` };
      if (account.channel === "INSTAGRAM") {
        return { ...who, audience: "management", instagramAccountId: account.id, accessLost: Boolean(account.accessLostAt) };
      }
      return who;
    }
    if (token === s.settingsPageToken) return { key: "settings:metaPageToken", label: "Страница Facebook (ключ в Настройках)" };
    if (token === s.settingsIgToken) return { key: "settings:metaIgToken", label: "Instagram (запасной ключ в Настройках)" };
    if (token === s.settingsWaToken) return { key: "settings:metaWaToken", label: "WhatsApp (ключ в Настройках)" };
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
const IG_SWITCH_OFF_HINT =
  "Всё готово, но выключен рубильник «Instagram через постоянный ключ Meta» (Настройки → Автоматика → Бот клиентов). Аккаунт отвечает личным ключом.";
const IG_NO_PAGE_HINT =
  "CRM не нашла Страницу Facebook с этим Instagram среди Страниц ключа компании и отвечает личным ключом. Что сделать: " +
  "1) привязать Instagram к Странице Facebook (Meta Business Suite → Настройки → Аккаунты Instagram → «Подключить»); " +
  "2) выдать эту Страницу ключу компании: Business Suite → Настройки компании → Системные пользователи → royalhome-crm → «Назначить ресурсы» → Страницы → полный доступ. " +
  "Дальше CRM найдёт Страницу сама в течение трёх часов или сразу по кнопке «Найти Страницу».";
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
    if (!base.pageId) return say("no_page", base.channel === "INSTAGRAM" ? IG_NO_PAGE_HINT : "Нажмите «Найти Страницу» — CRM сама найдёт Страницу Facebook, к которой привязан этот Instagram.");
    const grant = await systemPageGrant(base.pageId, s.systemToken);
    if (!grant.ok) return say("page_not_shared", SHARE_HINT(`Страницы → ${base.pageId}`));
    const named = { ...row, pageName: grant.pageName };
    if (igId && grant.igId !== igId) return { ...named, state: "mismatch", hint: "К этой Странице привязан другой Instagram. Нажмите «Найти Страницу» ещё раз." };
    const subscribed = await pageSubscribed(base.pageId, grant.token, appId);
    const withSub = { ...named, subscribed };
    if (base.channel === "INSTAGRAM") {
      // 21.11.2026: Instagram решает свой рубильник реестра «Автоматика», App Review не ждём.
      if (!s.igCompanyKey) return { ...withSub, state: "off", hint: IG_SWITCH_OFF_HINT };
    } else {
      if (!s.appReviewApproved) return { ...withSub, state: "awaiting_review", hint: REVIEW_HINT };
      if (!s.preferred) return { ...withSub, state: "off", hint: "Всё готово. Включите рубильник «Ключ компании вместо личных»." };
    }
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
    if (a.pageId && isFacebookLoginToken(a.token)) {
      // Подключён «Войти через Facebook» (13.11.2026): у аккаунта маркер своей
      // Страницы, ключ компании и рубильник ему не нужны — не пугаем «нет ключа».
      rows.push({
        key: `account:${a.id}`,
        title: `Instagram «${a.title}»${a.username ? ` @${a.username}` : ""}`,
        channel: "INSTAGRAM",
        accountId: a.id,
        pageId: a.pageId,
        lastSentAt: a.eternalLastSentAt?.toISOString() ?? null,
        state: a.eternalLastSentAt ? "ready" : "pending_first_send",
        hint: "Подключён входом через Facebook: отвечает ключом своей Страницы, ключ компании не нужен.",
        route: "page",
      });
      continue;
    }
    const base = { key: `account:${a.id}`, title: `Instagram «${a.title}»${a.username ? ` @${a.username}` : ""}`, channel: "INSTAGRAM" as const, accountId: a.id, pageId: a.pageId };
    const liveRoute = a.token ? (await instagramRouteForToken(a.token)).kind : "instagram_login";
    // Аккаунт с рабочим путём через Страницу «закрытым» не показываем (ревью #344): бот отвечает,
    // умер лишь запасной личный ключ; отметку снимет суточная проверка (integrationHealth.ts).
    if (a.accessLostAt && liveRoute !== "page") {
      // Meta закрыла сам аккаунт (lib/instagramAccountAccess.ts): ни один путь не поможет,
      // пока владелец не пройдёт проверку в Instagram. Страницу и права не дёргаем.
      rows.push({
        ...base,
        lastSentAt: a.eternalLastSentAt?.toISOString() ?? null,
        state: "locked",
        hint: `Meta закрыла доступ к аккаунту${a.accessLostReason ? ` (${a.accessLostReason.slice(0, 120)})` : ""}. Войдите в этот аккаунт в Instagram и пройдите проверку, затем нажмите «Заменить маркер». Проверки здоровья этот аккаунт не трогают, пока доступ не вернётся.`,
        route: "personal",
        accessLostAt: a.accessLostAt.toISOString(),
      });
      continue;
    }
    const row = await pageRow(base, IG_PAGE_SCOPES, a.eternalLastSentAt, a.externalId);
    rows.push({ ...row, route: liveRoute === "page" ? "page" : "personal", accessLostAt: null });
  }
  const fbAccounts = s.accounts.filter((x) => x.channel === "FACEBOOK");
  for (const a of fbAccounts) {
    rows.push(await pageRow({ key: `account:${a.id}`, title: `Facebook «${a.title}»`, channel: "FACEBOOK", accountId: a.id, pageId: a.externalId }, FB_PAGE_SCOPES, a.eternalLastSentAt));
  }
  // Основная Страница из Настроек показывается, пока её не завели отдельным
  // аккаунтом: вторая подключённая Страница (Arvan) её не заменяет.
  if (s.settingsPageId && !fbAccounts.some((a) => a.externalId === s.settingsPageId)) {
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

/**
 * САМ НАЙТИ СТРАНИЦУ (21.11.2026): аккаунтам Instagram без `pageId` CRM ищет Страницу
 * среди Страниц ключа компании, сверяет, что Meta привязала к ней ИМЕННО этот
 * Instagram, и записывает только своё поле `pageId` — тем же путём, что кнопка «Найти
 * Страницу». Путь ответа от этого меняется, только если включён рубильник
 * «Instagram через постоянный ключ Meta». Не нашла — ничего не пишет: экран говорит,
 * что сделать. Аккаунты, к которым Meta закрыла доступ, и выключенные не трогает.
 * Тик — сторож подписки Instagram (раз в три часа).
 */
export async function autoLinkInstagramPages(): Promise<{ linked: string[]; notFound: string[] }> {
  const out = { linked: [] as string[], notFound: [] as string[] };
  snapshot = null;
  const s = await loadSnapshot();
  if (!s.systemToken) return out;
  const candidates = s.accounts.filter(
    (a) => a.channel === "INSTAGRAM" && a.enabled && !a.pageId && !a.accessLostAt && !(a.token && isFacebookLoginToken(a.token))
  );
  for (const a of candidates) {
    try {
      const found = await discoverInstagramPage(a.externalId);
      if (!found.ok) {
        out.notFound.push(a.id);
        continue;
      }
      const verified = await verifyInstagramPage(found.pageId, a.externalId);
      if (!verified.ok) {
        out.notFound.push(a.id);
        continue;
      }
      const updated = await prisma.messengerAccount.updateMany({ where: { id: a.id, pageId: null }, data: { pageId: found.pageId } });
      if (updated.count === 0) continue;
      out.linked.push(a.id);
      await logSystemError(
        "meta",
        `Instagram «${a.title}»: CRM сама нашла Страницу ${found.pageId}${verified.pageName ? ` («${verified.pageName}»)` : ""} с этим Instagram — ` +
          `ответы пойдут через неё постоянным ключом, если рубильник «Instagram через постоянный ключ Meta» включён.`,
        { dedupKey: `ig-page-autolinked:${a.id}`, silent: true }
      );
    } catch (err) {
      console.warn("[вечные ключи] Страница для Instagram не найдена:", describeError(err));
    }
  }
  if (out.linked.length) resetMetaEternalCache();
  return out;
}

/**
 * Поля, на которые подписываем Страницу. Чужие поля нашего приложения сохраняем.
 * `message_echoes` и `messaging_referrals` (20.11.2026, первоисточник developers.facebook.com/docs/messenger-platform/webhooks):
 * эхо исходящих в Messenger приходит ТОЛЬКО по `message_echoes` (у Instagram — внутри `messages`), поэтому ответы
 * сотрудников из Meta Business Suite до CRM не доходили (0 за 60 дней против 292 в Instagram) и бот не знал, что человек
 * уже ответил; `messaging_referrals` — клик по рекламе и m.me-ссылке в уже начатом разговоре (55 диалогов Messenger без
 * метки рекламы). Применяется только кнопкой «Подписать Страницу» в Настройках — сам выкат подписку не меняет.
 */
export const PAGE_MESSAGING_FIELDS = ["messages", "messaging_postbacks", "message_echoes", "messaging_referrals"];

/**
 * «Подписать Страницу»: POST /{page}/subscribed_apps маркером Страницы от
 * системного пользователя. Список полей ОБЪЕДИНЯЕТСЯ с уже подписанными у
 * нашего приложения — POST задаёт список целиком, и голый вызов снял бы, например,
 * `feed` (комментарии). Не узнали приложение или текущую подписку — отказ, без POST.
 */
export type PageSubscribeResult = { ok: true; fields: string[] } | { ok: false; error: string };

export async function subscribePageMessaging(pageId: string): Promise<PageSubscribeResult> {
  const s = await loadSnapshot();
  if (!s.systemToken) return { ok: false, error: "Нет ключа системного пользователя." };
  const grant = await systemPageGrant(pageId, s.systemToken);
  if (!grant.ok) return { ok: false, error: grant.reason };
  const appId = await companyKeyAppId();
  if (!appId) return { ok: false, error: "Не удалось узнать приложение ключа компании — подписка не изменена. Нажмите ещё раз позже." };
  return subscribePageWithToken(pageId, grant.token, appId);
}

/** Приложение ключа компании (системного пользователя) — его поля подписки сверяем. */
export async function companyKeyAppId(): Promise<string | undefined> {
  const s = await loadSnapshot();
  if (!s.systemToken) return undefined;
  const app = await graphJson(`${GRAPH}/app?fields=id`, s.systemToken).catch(() => null);
  return app?.ok && typeof app.data?.id === "string" ? app.data.id : undefined;
}

/**
 * ПОДПИСКА СТРАНИЦЫ МАРКЕРОМ САМОЙ СТРАНИЦЫ — одна дверь для ключа компании и
 * для входа через Facebook (13.11.2026). `appId` — приложение, выдавшее маркер
 * Страницы: POST подписывает именно его, а поля сверяем по его же строке.
 * Поля ОБЪЕДИНЯЮТСЯ с уже подписанными (feed не снимается); не узнали приложение
 * или текущую подписку — отказ без POST.
 */
export async function subscribePageWithToken(pageId: string, pageToken: string, appId: string | undefined): Promise<PageSubscribeResult> {
  if (!appId) return { ok: false, error: "Не удалось узнать приложение Meta — подписка не изменена. Нажмите ещё раз позже." };
  try {
    const current = await graphJson(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`, pageToken);
    if (!current.ok) return { ok: false, error: `Текущая подписка не прочитана — не меняю: ${graphErrorText(current)}` };
    const ours = ((current.data?.data ?? []) as Array<{ id?: string; subscribed_fields?: string[] }>).find((x) => x.id === appId);
    const fields = Array.from(new Set([...(ours?.subscribed_fields ?? []), ...PAGE_MESSAGING_FIELDS]));
    const r = await graphJson(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`, pageToken, {
      method: "POST",
      body: new URLSearchParams({ subscribed_fields: fields.join(",") }),
    });
    if (!r.ok) return { ok: false, error: graphErrorText(r) };
    return { ok: true, fields };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * ЗАПРОС К GRAPH ОТ ИМЕНИ ВХОДА — для lib/metaLoginAssets.ts: тот же срок
 * ожидания (8 с) и тот же разбор ошибки, что у вызовов ключа компании.
 */
export async function metaGraphGet(path: string, token: string): Promise<{ ok: true; data: Record<string, unknown> | null } | { ok: false; error: string; auth: boolean }> {
  try {
    const r = await graphJson(`${GRAPH}${path}`, token);
    if (r.ok) return { ok: true, data: r.data };
    return { ok: false, error: graphErrorText(r), auth: isMetaAuthFailure(r.status, r.text) };
  } catch (err) {
    return { ok: false, error: describeError(err), auth: false };
  }
}

// ──────────────────── Страницы Facebook ключом компании ────────────────────

/**
 * MESSENGER ВТОРОЙ И СЛЕДУЮЩИХ СТРАНИЦ (13.11.2026, Arvan estate).
 *
 * Страница другой компании, выданная партнёру Royal Home и системному
 * пользователю royalhome-crm, подключается кнопкой: маркер Страницы берётся у
 * ключа компании (не истекает, смену пароля не замечает) и кладётся в
 * MessengerAccount канала FACEBOOK. Вставлять маркер руками человеку не нужно —
 * и нельзя: маркер Страницы в браузере не показывается никому.
 */
const MESSAGING_TASKS = ["MESSAGING", "MANAGE"];

export interface CompanyPage {
  id: string;
  name: string;
  /** Задачи системного пользователя на Странице позволяют переписку. */
  canMessage: boolean;
  /** Instagram, привязанный к Странице (для «той же компании» — имя бренда). */
  igId: string | null;
}

/** Страницы, выданные ключу компании (/me/accounts). Ничего не меняет. */
export async function listCompanyPages(): Promise<{ ok: true; pages: CompanyPage[] } | { ok: false; error: string }> {
  const s = await loadSnapshot();
  if (!s.systemToken) return { ok: false, error: "Нет ключа системного пользователя." };
  const pages: CompanyPage[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await graphJson(
      `${GRAPH}/me/accounts?fields=id,name,tasks,instagram_business_account&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      s.systemToken
    );
    if (!r.ok) return { ok: false, error: graphErrorText(r) };
    const rows = (r.data?.data ?? []) as Array<{ id?: string; name?: string; tasks?: unknown; instagram_business_account?: { id?: string } }>;
    for (const p of rows) {
      if (!p.id) continue;
      const tasks = Array.isArray(p.tasks) ? p.tasks.map(String) : [];
      pages.push({
        id: p.id,
        name: p.name ?? p.id,
        canMessage: tasks.some((t) => MESSAGING_TASKS.includes(t)),
        igId: p.instagram_business_account?.id ?? null,
      });
    }
    const paging = r.data?.paging as { next?: string; cursors?: { after?: string } } | undefined;
    after = paging?.next ? paging.cursors?.after : undefined;
    if (!after) break;
  }
  return { ok: true, pages };
}

/**
 * Маркер Страницы для записи в MessengerAccount: только Страница из списка
 * ключа компании, с задачей «Сообщения», и не та, что уже работает через
 * основные настройки (Settings.metaPageId) — иначе одна Страница отвечала бы
 * двумя путями.
 */
export async function facebookPageForConnect(
  pageId: string
): Promise<{ ok: true; token: string; pageName: string; igId: string | null } | { ok: false; status: 404 | 409; error: string }> {
  const s = await loadSnapshot();
  if (!s.systemToken) return { ok: false, status: 409, error: "Нет ключа системного пользователя." };
  if (s.settingsPageId === pageId) {
    return { ok: false, status: 409, error: "Эта Страница уже отвечает через основные настройки Facebook." };
  }
  const listed = await listCompanyPages();
  if (!listed.ok) return { ok: false, status: 409, error: listed.error };
  const page = listed.pages.find((p) => p.id === pageId);
  if (!page) return { ok: false, status: 404, error: `Страница не выдана системному пользователю. ${SHARE_HINT(`Страницы → ${pageId}`)}` };
  if (!page.canMessage) {
    return { ok: false, status: 409, error: `У системного пользователя на Странице нет задачи «Сообщения». ${SHARE_HINT(`Страницы → ${page.name}`)}` };
  }
  grants.delete(grantKey(pageId, s.systemToken));
  const grant = await systemPageGrant(pageId, s.systemToken);
  if (!grant.ok) return { ok: false, status: 409, error: grant.reason };
  return { ok: true, token: grant.token, pageName: grant.pageName ?? page.name, igId: grant.igId ?? page.igId };
}

/** Подписано ли наше приложение на сообщения Страницы (null — не удалось проверить). */
export async function pageMessagingSubscribed(pageId: string): Promise<boolean | null> {
  try {
    const s = await loadSnapshot();
    if (!s.systemToken) return null;
    const grant = await systemPageGrant(pageId, s.systemToken);
    if (!grant.ok) return null;
    const app = await graphJson(`${GRAPH}/app?fields=id`, s.systemToken);
    const appId = app.ok && typeof app.data?.id === "string" ? app.data.id : undefined;
    return await pageSubscribed(pageId, grant.token, appId);
  } catch {
    return null;
  }
}
