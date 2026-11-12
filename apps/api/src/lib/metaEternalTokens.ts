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
 * срок «никогда») → маркер Страницы `GET /{page-id}?fields=access_token` (от
 * системного пользователя он тоже не истекает) → переписка Instagram/Facebook
 * через graph.facebook.com. Пароли людей в этой цепочке не участвуют.
 *
 * Правила:
 *  - вечный путь ПРЕДПОЧИТАЕТСЯ, если включён рубильник
 *    (Settings.metaSystemTokenPreferred), задан системный маркер, у аккаунта
 *    задана Страница и Meta подтвердила, что к этой Странице привязан ИМЕННО этот
 *    Instagram; иначе — прежний личный маркер (запасной путь);
 *  - подмена делается в самом низу, у физического вызова (meta.ts::callGraph,
 *    чтение профиля), поэтому её получают ВСЕ пути отправки разом — ответ бота,
 *    кнопки, файлы, «печатает…», ответ на комментарий в личку, ручной ответ;
 *  - личный маркер остаётся ключом-удостоверением аккаунта в CRM (по нему
 *    узнаётся аккаунт), поэтому стирать его из аккаунта не нужно.
 */

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const SNAPSHOT_TTL_MS = 60_000;
/** Маркер Страницы от системного пользователя не истекает; перечитываем ради отзыва доступа. */
const GRANT_TTL_MS = 6 * 60 * 60_000;
/** Отказ не долбим на каждое сообщение. */
const GRANT_FAIL_TTL_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 8_000;

export interface EternalAccountRow {
  id: string;
  channel: string;
  title: string;
  externalId: string;
  pageId: string | null;
  token: string | undefined;
  enabled: boolean;
  username: string | null;
}

interface Snapshot {
  at: number;
  preferred: boolean;
  systemToken?: string;
  settingsPageId?: string;
  settingsPageToken?: string;
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
/** Маркер Страницы → id Страницы: узнать уже подменённый маркер (повторный вход). */
const pageTokenOwner = new Map<string, string>();
let adsChoice: { at: number; key: string; system: boolean } | null = null;

/** Сброс при любой правке аккаунтов/настроек (accounts.ts::resetAccountsCache, settings). */
export function resetMetaEternalCache(): void {
  snapshot = null;
  grants.clear();
  pageTokenOwner.clear();
  adsChoice = null;
}

const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 12);

async function loadSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot;
  const [s, rows] = await Promise.all([
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        metaSystemTokenPreferred: true,
        metaIgManageToken: true,
        metaPageId: true,
        metaPageToken: true,
        metaIgToken: true,
        metaWaToken: true,
        metaAdsToken: true,
      },
    }),
    prisma.messengerAccount.findMany({
      select: { id: true, channel: true, title: true, externalId: true, pageId: true, token: true, enabled: true, username: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
  ]);
  snapshot = {
    at: Date.now(),
    preferred: s?.metaSystemTokenPreferred ?? true,
    systemToken: decryptSecretSafe(s?.metaIgManageToken ?? null) || undefined,
    settingsPageId: s?.metaPageId || process.env.META_PAGE_ID || undefined,
    settingsPageToken: decryptSecretSafe(s?.metaPageToken ?? null) || process.env.META_PAGE_TOKEN || undefined,
    settingsIgToken: decryptSecretSafe(s?.metaIgToken ?? null) || process.env.META_IG_TOKEN || undefined,
    settingsWaToken: decryptSecretSafe(s?.metaWaToken ?? null) || process.env.META_WA_TOKEN || undefined,
    adsToken: decryptSecretSafe(s?.metaAdsToken ?? null) || process.env.META_ADS_TOKEN || undefined,
    accounts: rows.map((r) => ({ ...r, token: decryptSecretSafe(r.token) || undefined })),
  };
  return snapshot;
}

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

/**
 * Маркер Страницы от системного пользователя. Заодно Meta говорит, какой
 * Instagram к Странице привязан, — по нему сверяем, что отвечаем от того аккаунта.
 */
async function systemPageGrant(pageId: string, systemToken: string): Promise<Grant> {
  const cacheKey = `${pageId}:${fingerprint(systemToken)}`;
  const cached = grants.get(cacheKey);
  if (cached && Date.now() - cached.at < (cached.ok ? GRANT_TTL_MS : GRANT_FAIL_TTL_MS)) return cached;
  let grant: Grant;
  try {
    const r = await graphJson(
      `${GRAPH}/${encodeURIComponent(pageId)}?fields=access_token,name,instagram_business_account`,
      systemToken
    );
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
        reason: r.ok
          ? "Meta не выдала маркер Страницы — Страница не назначена системному пользователю"
          : graphErrorText(r),
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
  grants.set(cacheKey, grant);
  return grant;
}

export type InstagramRoute =
  | { kind: "instagram_login"; token: string }
  | { kind: "page"; token: string; pageId: string; accountId: string | null };

/**
 * Каким путём говорить с Instagram, если в руках — маркер аккаунта (или уже
 * подменённый маркер Страницы). Никогда не бросает: худший исход — прежний путь.
 */
export async function instagramRouteForToken(token: string): Promise<InstagramRoute> {
  const fallback: InstagramRoute = { kind: "instagram_login", token };
  try {
    const knownPage = pageTokenOwner.get(token);
    if (knownPage) return { kind: "page", token, pageId: knownPage, accountId: null };
    const s = await loadSnapshot();
    if (!s.preferred || !s.systemToken) return fallback;
    const account = s.accounts.find((a) => a.channel === "INSTAGRAM" && a.token === token && a.pageId);
    if (!account?.pageId) return fallback;
    const grant = await systemPageGrant(account.pageId, s.systemToken);
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

/**
 * Маркер для переписки Страницы Facebook: личный маркер Страницы (Settings или
 * аккаунт FACEBOOK) меняется на маркер той же Страницы от системного
 * пользователя. Чужой/неизвестный маркер возвращается как есть.
 */
export async function facebookPageTokenFor(token: string): Promise<string> {
  try {
    if (pageTokenOwner.has(token)) return token;
    const s = await loadSnapshot();
    if (!s.preferred || !s.systemToken) return token;
    let pageId: string | undefined;
    if (s.settingsPageToken && token === s.settingsPageToken) pageId = s.settingsPageId;
    else pageId = s.accounts.find((a) => a.channel === "FACEBOOK" && a.token === token)?.externalId;
    if (!pageId) return token;
    const grant = await systemPageGrant(pageId, s.systemToken);
    return grant.ok ? grant.token : token;
  } catch (err) {
    console.warn("[вечные ключи] маркер Страницы не подменён:", describeError(err));
    return token;
  }
}

const FB_MESSAGES = /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/(me|\d+)\/messages$/;

/**
 * ДВЕРЬ У ФИЗИЧЕСКОГО ВЫЗОВА (meta.ts::callGraph). Только адреса переписки:
 *  - Instagram `/me/messages` → `graph.facebook.com/{page}/messages` маркером
 *    Страницы, тело — Messenger Platform (`messaging_type: RESPONSE` у обычного
 *    ответа, как требует Send API; у sender_action и ответа на комментарий — нет);
 *  - Facebook `/{page}/messages` и `/me/messages` → тот же адрес, маркер
 *    Страницы от системного пользователя.
 * Комментарии, публикации и прочее не трогаем: у системного пользователя может
 * не быть прав, которые есть у личного маркера.
 */
export async function routeMetaMessagingCall(
  url: string,
  token: string,
  body: unknown
): Promise<{ url: string; token: string; body: unknown; route: "instagram_page" | "facebook_page" | "unchanged" }> {
  if (url === instagramApiUrl(`/${GRAPH_VERSION}/me/messages`)) {
    const route = await instagramRouteForToken(token);
    if (route.kind !== "page") return { url, token, body, route: "unchanged" };
    return { url: `${GRAPH}/${route.pageId}/messages`, token: route.token, body: withResponseType(body), route: "instagram_page" };
  }
  if (FB_MESSAGES.test(url)) {
    const swapped = await facebookPageTokenFor(token);
    return { url, token: swapped, body, route: swapped === token ? "unchanged" : "facebook_page" };
  }
  return { url, token, body, route: "unchanged" };
}

function withResponseType(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const value = body as Record<string, unknown>;
  const recipient = value.recipient as Record<string, unknown> | undefined;
  if (!value.message || value.messaging_type || value.sender_action || !recipient || !("id" in recipient)) return body;
  return { ...value, messaging_type: "RESPONSE" };
}

/**
 * Чтение по Instagram (профиль собеседника, «видит ли маркер человека»): тот же
 * выбор пути, адрес graph.facebook.com при вечном ключе. `path` — с версией,
 * например `/v23.0/<IGSID>?fields=username`.
 */
export async function instagramReadRequest(path: string, token: string): Promise<{ url: string; headers: Record<string, string> }> {
  const route = await instagramRouteForToken(token);
  if (route.kind === "page") return { url: `https://graph.facebook.com${path}`, headers: { Authorization: `Bearer ${route.token}` } };
  return instagramRequest(instagramApiUrl(path), token);
}

/** Чей это маркер — для тревоги «ключ умер». Наружу — метка и имя, не маркер. */
export async function describeMetaToken(token: string): Promise<{ key: string; label: string }> {
  const page = pageTokenOwner.get(token);
  if (page) return { key: `system-page:${page}`, label: `Вечный ключ Страницы ${page}` };
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
 * Маркер для отчёта по рекламе: системный — только если у него НЕ МЕНЬШЕ прав
 * на рекламу, чем у личного, и каждый кабинет из Настроек читается. Иначе —
 * личный: правка не имеет права сломать то, что работает сейчас.
 */
export async function eternalAdsToken(personal: string | null, adAccountIds: string[]): Promise<string | null> {
  try {
    const s = await loadSnapshot();
    if (!s.preferred || !s.systemToken || adAccountIds.length === 0) return personal;
    const key = `${fingerprint(s.systemToken)}:${personal ? fingerprint(personal) : "-"}:${adAccountIds.join(",")}`;
    if (adsChoice && adsChoice.key === key && Date.now() - adsChoice.at < (adsChoice.system ? GRANT_TTL_MS : GRANT_FAIL_TTL_MS)) {
      return adsChoice.system ? s.systemToken : personal;
    }
    const system = await adsCheck(s.systemToken, personal, adAccountIds);
    adsChoice = { at: Date.now(), key, system: system.ok };
    return system.ok ? s.systemToken : personal;
  } catch {
    return personal;
  }
}

const ADS_SCOPES = ["ads_read", "ads_management", "business_management"];

async function grantedScopes(token: string): Promise<Set<string> | null> {
  const r = await graphJson(`${GRAPH}/me/permissions`, token);
  if (!r.ok) return null;
  const rows = (r.data?.data ?? []) as Array<{ permission?: string; status?: string }>;
  return new Set(rows.filter((p) => p.status === "granted" && p.permission).map((p) => p.permission as string));
}

async function adsCheck(systemToken: string, personal: string | null, adAccountIds: string[]): Promise<{ ok: boolean; reason?: string }> {
  const sys = await grantedScopes(systemToken);
  if (!sys) return { ok: false, reason: "права системного ключа не прочитаны" };
  if (!sys.has("ads_read") && !sys.has("ads_management")) return { ok: false, reason: "у системного пользователя нет права ads_read" };
  if (personal) {
    const mine = await grantedScopes(personal);
    const missing = mine ? ADS_SCOPES.filter((p) => mine.has(p) && !sys.has(p)) : [];
    if (missing.length) return { ok: false, reason: `у системного пользователя нет прав: ${missing.join(", ")}` };
  }
  for (const id of adAccountIds) {
    const r = await graphJson(`${GRAPH}/${encodeURIComponent(id)}?fields=id`, systemToken);
    if (!r.ok) return { ok: false, reason: `кабинет ${id} не выдан системному пользователю (${graphErrorText(r)})` };
  }
  return { ok: true };
}

// ─────────────────────────────── настройки ───────────────────────────────

// Договор с экраном — в packages/shared (metaEternal.ts): одно место для обеих сторон.
type EternalState = MetaEternalState;
type EternalKeyRow = MetaEternalKeyRow;
type EternalStatus = MetaEternalStatus;

const SHARE_HINT = (what: string) =>
  `Business Suite → Настройки компании → Пользователи → Системные пользователи → royalhome-crm → «Назначить ресурсы» → ${what} → полный доступ.`;

/** Самопроверка для экрана Настроек: кому что докликать. Ничего не меняет. */
export async function metaEternalStatus(): Promise<EternalStatus> {
  snapshot = null; // свежие настройки; кэш маркеров Страниц живой переписке не сбрасываем
  const s = await loadSnapshot();
  const systemUser: EternalStatus["systemUser"] = { configured: Boolean(s.systemToken), ok: false };
  let appId: string | undefined;
  if (s.systemToken) {
    try {
      const me = await graphJson(`${GRAPH}/me?fields=id,name`, s.systemToken);
      systemUser.ok = me.ok;
      systemUser.name = typeof me.data?.name === "string" ? me.data.name : undefined;
      if (!me.ok) systemUser.detail = graphErrorText(me);
      const app = me.ok ? await graphJson(`${GRAPH}/app?fields=id`, s.systemToken) : null;
      appId = typeof app?.data?.id === "string" ? app.data.id : undefined;
      systemUser.appId = appId;
    } catch (err) {
      systemUser.detail = describeError(err);
    }
  }
  const rows: EternalKeyRow[] = [];
  const pageRow = async (base: Omit<EternalKeyRow, "state" | "hint">, igId?: string): Promise<EternalKeyRow> => {
    if (!s.preferred) return { ...base, state: "off", hint: "Рубильник «Вечные ключи» выключен — работает личный маркер." };
    if (!s.systemToken || !systemUser.ok) {
      return { ...base, state: "no_system", hint: "Вставьте ключ системного пользователя royalhome-crm в «Маркер удаления Instagram» (Настройки → Каналы)." };
    }
    if (!base.pageId) return { ...base, state: "no_page", hint: "Нажмите «Найти Страницу» — CRM сама найдёт Страницу Facebook, к которой привязан этот Instagram." };
    const grant = await systemPageGrant(base.pageId, s.systemToken);
    if (!grant.ok) return { ...base, state: "page_not_shared", hint: SHARE_HINT(`Страницы → ${base.pageId}`) };
    if (igId && grant.igId !== igId) {
      return { ...base, pageName: grant.pageName, state: "mismatch", hint: `К этой Странице привязан другой Instagram. Нажмите «Найти Страницу» ещё раз.` };
    }
    const subscribed = await pageSubscribed(base.pageId, grant.token, appId);
    return {
      ...base,
      pageName: grant.pageName,
      subscribed,
      state: "ready",
      // Подписка — запас на случай, если старый путь входящих умрёт: при двух
      // подписках сразу Meta может прислать одно сообщение дважды (ФАКТ, migration guide).
      hint:
        subscribed === false
          ? "Ответы уже идут вечным ключом. «Подписать Страницу» — только если входящие перестанут приходить: при двух подписках сообщение может прийти дважды."
          : "",
    };
  };
  for (const a of s.accounts.filter((x) => x.channel === "INSTAGRAM")) {
    rows.push(await pageRow({ key: `account:${a.id}`, title: `Instagram «${a.title}»${a.username ? ` @${a.username}` : ""}`, channel: "INSTAGRAM", accountId: a.id, pageId: a.pageId }, a.externalId));
  }
  const fbAccounts = s.accounts.filter((x) => x.channel === "FACEBOOK");
  for (const a of fbAccounts) {
    rows.push(await pageRow({ key: `account:${a.id}`, title: `Facebook «${a.title}»`, channel: "FACEBOOK", accountId: a.id, pageId: a.externalId }));
  }
  if (fbAccounts.length === 0 && s.settingsPageId) {
    rows.push(await pageRow({ key: "settings:metaPageToken", title: "Страница Facebook (Messenger)", channel: "FACEBOOK", pageId: s.settingsPageId }));
  }
  const ads = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaAdsEnabled: true, metaAdAccountId: true } });
  if (ads?.metaAdsEnabled && ads.metaAdAccountId) {
    const ids = ads.metaAdAccountId.split(/[\s,]+/).filter(Boolean).map((v) => (v.startsWith("act_") ? v : `act_${v}`));
    let state: EternalState = "off";
    let hint = "Рубильник «Вечные ключи» выключен — работает личный маркер.";
    if (s.preferred) {
      if (!s.systemToken || !systemUser.ok) {
        state = "no_system";
        hint = "Нет ключа системного пользователя.";
      } else {
        const check = await adsCheck(s.systemToken, s.adsToken ?? null, ids).catch((err) => ({ ok: false, reason: describeError(err) }));
        state = check.ok ? "ready" : "page_not_shared";
        hint = check.ok ? "" : `${check.reason}. ${SHARE_HINT("Рекламные аккаунты → каждый кабинет")} Если кабинета нет в списке — сначала его владелец даёт компании партнёрский доступ.`;
      }
    }
    rows.push({ key: "meta-ads", title: "Отчёт по рекламе", channel: "ADS", state, hint });
  }
  return { preferred: s.preferred, systemUser, rows };
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
  grants.delete(`${pageId}:${fingerprint(s.systemToken)}`);
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
 * нашего приложения — POST задаёт список целиком, и голый вызов снял бы,
 * например, `feed` (комментарии). Запускает владелец кнопкой, не код сам.
 */
export async function subscribePageMessaging(pageId: string): Promise<{ ok: true; fields: string[] } | { ok: false; error: string }> {
  const s = await loadSnapshot();
  if (!s.systemToken) return { ok: false, error: "Нет ключа системного пользователя." };
  const grant = await systemPageGrant(pageId, s.systemToken);
  if (!grant.ok) return { ok: false, error: grant.reason };
  const app = await graphJson(`${GRAPH}/app?fields=id`, s.systemToken);
  const appId = typeof app.data?.id === "string" ? app.data.id : undefined;
  const current = await graphJson(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`, grant.token);
  if (!current.ok) return { ok: false, error: graphErrorText(current) };
  const ours = ((current.data?.data ?? []) as Array<{ id?: string; subscribed_fields?: string[] }>).find((x) => appId && x.id === appId);
  const fields = Array.from(new Set([...(ours?.subscribed_fields ?? []), ...PAGE_MESSAGING_FIELDS]));
  const r = await graphJson(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`, grant.token, {
    method: "POST",
    body: new URLSearchParams({ subscribed_fields: fields.join(",") }),
  });
  if (!r.ok) return { ok: false, error: graphErrorText(r) };
  return { ok: true, fields };
}
