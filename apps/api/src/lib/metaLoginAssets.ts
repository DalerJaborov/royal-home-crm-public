import { randomBytes } from "node:crypto";
import type {
  MetaLoginAdAccount,
  MetaLoginAssets,
  MetaLoginConnectInput,
  MetaLoginConnectResult,
  MetaLoginInstagram,
  MetaLoginKeyKind,
  MetaLoginPage,
  MetaLoginWhatsapp,
} from "@royal-home/shared";
import { encryptSecret } from "../crypto.js";
import { prisma } from "../db.js";
import { loadAppCredentials } from "./ads/metaAdsToken.js";
import { parseAdAccountIds } from "./ads/metaAdsApi.js";
import { logAgentAudit } from "./audit.js";
import { describeError } from "./describeError.js";
import { metaGraphGet } from "./metaEternalTokens.js";
import { connectFacebookPage, connectInstagramViaPage } from "./metaPageConnect.js";
import {
  connectWhatsappNumber,
  loginKeyKind,
  readWhatsappNumbers,
  settingsWaPhoneId,
  type LoginWaNumber,
  type WabaSubscribeResult,
} from "./metaWhatsappConnect.js";
import { logSystemError } from "./systemError.js";

/**
 * ЧТО НАШЛОСЬ ПОСЛЕ ВХОДА ЧЕРЕЗ FACEBOOK И ЧТО ИЗ ЭТОГО ПОДКЛЮЧИТЬ (13.11.2026).
 *
 * Вход (lib/metaLogin.ts, цель "assets") отдаёт сюда маркер человека. Дальше:
 *  1. сессия выбора в памяти: случайный id, 30 минут, привязана к сотруднику;
 *     маркер внутри сервера, наружу уходит только id сессии;
 *  2. экран спрашивает «что нашлось» — Страницы, их Instagram, кабинеты;
 *  3. человек ставит галочки — каждый ВИД подключается своей функцией
 *     (KIND_CONNECTORS ниже), а Страница и Instagram — общей дверью
 *     lib/metaPageConnect.ts, той же, что у кнопки «Подключить Messenger».
 *
 * ТОЧКА РАСШИРЕНИЯ. Новый вид = поле в схемах
 * packages/shared/src/metaEternal.ts (metaLoginAssetsSchema,
 * metaLoginConnectInputSchema, metaLoginAssetKindSchema) + чтение в
 * readLoginAssets + своя функция в KIND_CONNECTORS + права в
 * lib/tokenScopes.ts (META_LOGIN). Существующие виды при этом не трогаются.
 * Так добавлены номера WhatsApp Business (пачка 2, 13.11.2026): чтение и
 * подключение — lib/metaWhatsappConnect.ts.
 */

const SESSION_TTL_MS = 30 * 60 * 1000;
/** Сколько страниц выдачи Graph читать (по 100) — больше Страниц у компании не бывает. */
const MAX_PAGES = 5;

interface LoginPageRow {
  id: string;
  name: string;
  canMessage: boolean;
  /** Маркер Страницы из входа. Только сервер. */
  token: string | null;
  ig: { id: string; username: string | null } | null;
}

interface LoginAdAccountRow {
  id: string;
  name: string;
  status: number | null;
}

interface Session {
  agentId: string;
  token: string;
  expiresAt: number;
  pages?: LoginPageRow[];
  adAccounts?: LoginAdAccountRow[];
  whatsapp?: LoginWaNumber[];
  keyKind?: MetaLoginKeyKind;
  warnings?: string[];
}

const sessions = new Map<string, Session>();

function sweep(): void {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
}

/** Сессия выбора после входа. Возвращает её id — его и только его видит браузер. */
export function openMetaLoginSession(agentId: string, token: string): string {
  sweep();
  const id = randomBytes(18).toString("hex");
  sessions.set(id, { agentId, token, expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}

/** Чужая, просроченная или незнакомая сессия — null (маршрут отвечает 404). */
function sessionFor(id: string, agentId: string): Session | null {
  sweep();
  const s = sessions.get(id);
  return s && s.agentId === agentId ? s : null;
}

const MESSAGING_TASKS = ["MESSAGING", "MANAGE"];

async function readPaged<T>(firstPath: string, token: string, map: (row: Record<string, unknown>) => T | null): Promise<{ ok: true; rows: T[] } | { ok: false; error: string }> {
  const rows: T[] = [];
  let path: string | null = firstPath;
  for (let i = 0; i < MAX_PAGES && path; i++) {
    const r = await metaGraphGet(path, token);
    if (!r.ok) return { ok: false, error: r.error };
    for (const raw of ((r.data?.data ?? []) as Array<Record<string, unknown>>)) {
      const row = map(raw);
      if (row) rows.push(row);
    }
    const paging = r.data?.paging as { next?: string; cursors?: { after?: string } } | undefined;
    const after = paging?.next ? paging.cursors?.after : undefined;
    path = after ? `${firstPath}&after=${encodeURIComponent(after)}` : null;
  }
  return { ok: true, rows };
}

/** Перечитать у Meta, что выдано входу. Маркеры Страниц остаются в сессии. */
async function readLoginAssets(session: Session): Promise<void> {
  const warnings: string[] = [];
  const pagesQuery = new URLSearchParams({ fields: "id,name,tasks,access_token,instagram_business_account{id,username}", limit: "100" });
  const pages = await readPaged<LoginPageRow>(`/me/accounts?${pagesQuery.toString()}`, session.token, (p) => {
    if (typeof p.id !== "string") return null;
    const tasks = Array.isArray(p.tasks) ? p.tasks.map(String) : [];
    const ig = p.instagram_business_account as { id?: string; username?: string } | undefined;
    return {
      id: p.id,
      name: typeof p.name === "string" ? p.name : p.id,
      canMessage: tasks.some((t) => MESSAGING_TASKS.includes(t)),
      token: typeof p.access_token === "string" ? p.access_token : null,
      ig: ig?.id ? { id: ig.id, username: ig.username ?? null } : null,
    };
  });
  if (pages.ok) {
    session.pages = pages.rows;
  } else {
    session.pages = [];
    warnings.push(`Страницы не прочитаны: ${pages.error}`);
    void logSystemError("meta", `Вход через Facebook: Страницы не прочитаны — ${pages.error}`);
  }

  const adsQuery = new URLSearchParams({ fields: "account_id,name,account_status", limit: "100" });
  const ads = await readPaged<LoginAdAccountRow>(`/me/adaccounts?${adsQuery.toString()}`, session.token, (a) => {
    const digits = typeof a.account_id === "string" ? a.account_id.replace(/\D/g, "") : "";
    if (!digits) return null;
    return {
      id: `act_${digits}`,
      name: typeof a.name === "string" ? a.name : `act_${digits}`,
      status: typeof a.account_status === "number" ? a.account_status : null,
    };
  });
  if (ads.ok) {
    session.adAccounts = ads.rows;
  } else {
    session.adAccounts = [];
    // Без права ads_read Meta отказывает — это не авария, просто кабинетов не покажем.
    warnings.push(`Рекламные кабинеты не прочитаны: ${ads.error}`);
  }

  // Номера WhatsApp Business. Чей ключ — спрашиваем один раз: от этого зависит
  // предупреждение «ключ личный» (для WhatsApp оно важнее всего).
  session.keyKind = await loginKeyKind(session.token);
  const wa = await readWhatsappNumbers(session.token, await loadAppCredentials(), session.keyKind);
  session.whatsapp = wa.numbers;
  if (wa.numbers.length === 0 && wa.errors.length > 0) {
    // Без права whatsapp_business_management Meta отказывает — не авария.
    warnings.push(`Номера WhatsApp не прочитаны: ${wa.errors[0]}`);
  }
  session.warnings = warnings;
}

/** Что нашёл вход и что из этого уже в CRM. null — сессии нет (или она чужая). */
export async function metaLoginAssets(sessionId: string, agentId: string): Promise<MetaLoginAssets | null> {
  const session = sessionFor(sessionId, agentId);
  if (!session) return null;
  await readLoginAssets(session);

  const [settings, accounts, mainWaPhone] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaPageId: true, metaAdAccountId: true } }),
    prisma.messengerAccount.findMany({
      where: { channel: { in: ["FACEBOOK", "INSTAGRAM", "WHATSAPP"] } },
      select: { channel: true, externalId: true, pageId: true },
    }),
    settingsWaPhoneId(),
  ]);
  const mainPage = settings?.metaPageId?.trim() || process.env.META_PAGE_ID || null;
  const adIds = new Set(parseAdAccountIds(settings?.metaAdAccountId ?? null));

  const pages: MetaLoginPage[] = (session.pages ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    canMessage: p.canMessage,
    ig: p.ig,
    connected: accounts.some((a) => a.channel === "FACEBOOK" && a.externalId === p.id) ? "account" : mainPage === p.id ? "settings" : null,
  }));
  const instagram: MetaLoginInstagram[] = (session.pages ?? [])
    .filter((p) => p.ig)
    .map((p) => {
      const account = accounts.find((a) => a.channel === "INSTAGRAM" && a.externalId === p.ig!.id);
      return {
        id: p.ig!.id,
        username: p.ig!.username,
        pageId: p.id,
        pageName: p.name,
        connected: account ? (account.pageId === p.id ? "page" : "account") : null,
      };
    });
  const adAccounts: MetaLoginAdAccount[] = (session.adAccounts ?? []).map((a) => ({ ...a, connected: adIds.has(a.id) }));
  const whatsapp: MetaLoginWhatsapp[] = (session.whatsapp ?? []).map((n) => ({
    ...n,
    connected: mainWaPhone === n.id ? "settings" : accounts.some((a) => a.channel === "WHATSAPP" && a.externalId === n.id) ? "account" : null,
  }));
  return { pages, instagram, adAccounts, whatsapp, keyKind: session.keyKind ?? "unknown", warnings: session.warnings ?? [] };
}

type ResultRow = MetaLoginConnectResult["results"][number];

interface ConnectContext {
  session: Session;
  agentId: string;
  appId: string | undefined;
  /** Подписка аккаунта WhatsApp Business — один запрос на аккаунт за подключение. */
  waSubscriptions: Map<string, Promise<WabaSubscribeResult>>;
}

/** Страницы → Messenger. Каждая — через общую дверь подключения Страницы. */
async function connectPages(ids: string[], ctx: ConnectContext): Promise<ResultRow[]> {
  const out: ResultRow[] = [];
  for (const id of ids) {
    const page = ctx.session.pages?.find((p) => p.id === id);
    const say = (ok: boolean, message: string): ResultRow => ({ kind: "page", id, name: page?.name ?? id, ok, message });
    if (!page) { out.push(say(false, "Этой Страницы нет среди найденных при входе")); continue; }
    if (!page.canMessage) { out.push(say(false, "У вас на этой Странице нет доступа к сообщениям — попросите задачу «Сообщения» в Business Suite")); continue; }
    if (!page.token) { out.push(say(false, "Facebook не выдал ключ этой Страницы — войдите ещё раз и отметьте её в окне Facebook")); continue; }
    try {
      const r = await connectFacebookPage({
        pageId: page.id,
        pageName: page.name,
        pageToken: page.token,
        igId: page.ig?.id ?? null,
        appId: ctx.appId,
        agentId: ctx.agentId,
        source: "facebook_login",
      });
      if (!r.ok) { out.push(say(false, r.error)); continue; }
      out.push(
        say(
          true,
          `${r.created ? "Подключена" : "Ключ обновлён"}${r.subscription.ok ? "" : `, но сообщения не придут: Страница не подписана (${r.subscription.error})`}`
        )
      );
    } catch (err) {
      out.push(say(false, describeError(err)));
    }
  }
  return out;
}

/** Instagram → через свою Страницу. */
async function connectInstagram(ids: string[], ctx: ConnectContext): Promise<ResultRow[]> {
  const out: ResultRow[] = [];
  for (const id of ids) {
    const page = ctx.session.pages?.find((p) => p.ig?.id === id);
    const name = page?.ig?.username ? `@${page.ig.username}` : id;
    const say = (ok: boolean, message: string): ResultRow => ({ kind: "instagram", id, name, ok, message });
    if (!page?.ig) { out.push(say(false, "Этого Instagram нет среди найденных при входе")); continue; }
    if (!page.token) { out.push(say(false, `Facebook не выдал ключ Страницы «${page.name}» — без неё Instagram не ответит`)); continue; }
    const r = await connectInstagramViaPage({
      igId: page.ig.id,
      username: page.ig.username,
      pageId: page.id,
      pageName: page.name,
      pageToken: page.token,
      appId: ctx.appId,
      agentId: ctx.agentId,
    });
    out.push(r.ok ? say(true, r.message) : say(false, r.error));
  }
  return out;
}

/**
 * Кабинеты → отчёт по рекламе. Маркер рекламы заменяется маркером входа ТОЛЬКО
 * если вход видит ВСЕ кабинеты, которые после этого будут в CRM: иначе отчёт по
 * уже подключённому кабинету молча перестал бы собираться. Не видит — ничего не
 * меняем и говорим, какой кабинет мешает.
 */
async function connectAdAccounts(ids: string[], ctx: ConnectContext): Promise<ResultRow[]> {
  const wanted = parseAdAccountIds(ids.join(","));
  if (wanted.length === 0) return [];
  const nameOf = (id: string) => ctx.session.adAccounts?.find((a) => a.id === id)?.name ?? id;
  const row = (id: string, ok: boolean, message: string): ResultRow => ({ kind: "adAccount", id, name: nameOf(id), ok, message });
  const NOT_SEEN = "Ваш Facebook не видит этот кабинет — проверьте доступ к нему в Business Suite";

  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaAdAccountId: true } });
  const current = parseAdAccountIds(settings?.metaAdAccountId ?? null);
  const toCheck = Array.from(new Set([...current, ...wanted]));
  const checks = await Promise.all(
    toCheck.map(async (id) => ({ id, ok: (await metaGraphGet(`/${encodeURIComponent(id)}?fields=id`, ctx.session.token)).ok }))
  );
  const seen = new Set(checks.filter((c) => c.ok).map((c) => c.id));

  const oldUnseen = current.filter((id) => !seen.has(id));
  if (oldUnseen.length) {
    const why =
      `Не добавлен: ваш Facebook не видит ${oldUnseen.length > 1 ? "кабинеты" : "кабинет"} ${oldUnseen.join(", ")}, ` +
      "который уже в CRM, а с одним ключом рекламы отчёт по нему остановился бы. Войдите тем Facebook, у которого доступ ко всем кабинетам.";
    return wanted.map((id) => row(id, false, seen.has(id) ? why : NOT_SEEN));
  }
  const added = wanted.filter((id) => seen.has(id));
  if (added.length === 0) return wanted.map((id) => row(id, false, NOT_SEEN));

  const all = [...current, ...added.filter((id) => !current.includes(id))];
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      metaAdAccountId: all.join(", "),
      metaAdsToken: encryptSecret(ctx.session.token),
      metaAdsTokenRefreshedAt: new Date(),
      metaAdsEnabled: true,
    },
  });
  logAgentAudit(ctx.agentId, "SETTINGS_UPDATE", "Settings", "singleton", {
    metaAdAccountId: all.join(", "),
    metaAdsToken: "replaced_by_facebook_login",
    metaAdsEnabled: true,
  });
  return wanted.map((id) =>
    !seen.has(id) ? row(id, false, NOT_SEEN) : row(id, true, current.includes(id) ? "Уже был в CRM — ключ рекламы обновлён" : "Подключён к отчёту по рекламе")
  );
}

/** Номера WhatsApp Business → переписка в CRM. Каждый — через общую дверь lib/metaWhatsappConnect.ts. */
async function connectWhatsapp(ids: string[], ctx: ConnectContext): Promise<ResultRow[]> {
  const out: ResultRow[] = [];
  for (const id of ids) {
    const number = ctx.session.whatsapp?.find((n) => n.id === id);
    const name = number ? [number.name, number.phone].filter(Boolean).join(" · ") || id : id;
    const say = (ok: boolean, message: string): ResultRow => ({ kind: "whatsapp", id, name, ok, message });
    if (!number) { out.push(say(false, "Этого номера нет среди найденных при входе")); continue; }
    const r = await connectWhatsappNumber({
      number,
      token: ctx.session.token,
      keyKind: ctx.session.keyKind ?? "unknown",
      agentId: ctx.agentId,
      subscriptions: ctx.waSubscriptions,
    });
    out.push(r.ok ? say(true, r.message) : say(false, r.error));
  }
  return out;
}

/**
 * ВИДЫ И ИХ ПОДКЛЮЧЕНИЕ — порядок важен: Страницы до Instagram (новому
 * Instagram достаются имя компании и промт только что подключённой Страницы).
 * Новый вид — новой строкой здесь.
 */
const KIND_CONNECTORS: Array<{ pick: (input: MetaLoginConnectInput) => string[]; run: (ids: string[], ctx: ConnectContext) => Promise<ResultRow[]> }> = [
  { pick: (i) => i.pageIds, run: connectPages },
  { pick: (i) => i.instagramIds, run: connectInstagram },
  { pick: (i) => i.adAccountIds, run: connectAdAccounts },
  { pick: (i) => i.whatsappIds, run: connectWhatsapp },
];

/** Подключить выбранное. null — сессии нет (или она чужая). */
export async function connectMetaLoginAssets(sessionId: string, agentId: string, input: MetaLoginConnectInput): Promise<MetaLoginConnectResult | null> {
  const session = sessionFor(sessionId, agentId);
  if (!session) return null;
  if (!session.pages || !session.adAccounts || !session.whatsapp) await readLoginAssets(session);
  const ctx: ConnectContext = { session, agentId, appId: (await loadAppCredentials())?.appId, waSubscriptions: new Map() };
  const results: ResultRow[] = [];
  for (const kind of KIND_CONNECTORS) {
    const ids = Array.from(new Set(kind.pick(input)));
    if (ids.length) results.push(...(await kind.run(ids, ctx)));
  }
  logAgentAudit(agentId, "META_LOGIN_CONNECT", "MetaLogin", null, {
    pages: input.pageIds,
    instagram: input.instagramIds,
    adAccounts: input.adAccountIds,
    whatsapp: input.whatsappIds,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });
  return { results };
}

/** Только для тестов. */
export function resetMetaLoginSessions(): void {
  sessions.clear();
}
