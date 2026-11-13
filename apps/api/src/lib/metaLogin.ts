import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { fetchWithRetry } from "../messengers/meta.js";
import { loadAgentAccess } from "../auth/middleware.js";
import { ADS_GRAPH_VERSION } from "./ads/adsGraphVersion.js";
import { agentCanWriteAds } from "./ads/adsWriteAccess.js";
import { loadAppCredentials } from "./ads/metaAdsToken.js";
import { crmPublicBase } from "./crmPublicUrl.js";
import { logSystemError } from "./systemError.js";
import { scopesForRequest } from "./tokenScopes.js";

/**
 * ВХОД ЧЕРЕЗ FACEBOOK — ОДНА ДВЕРЬ (13.11.2026).
 *
 * До этой правки вход был один, рекламный (lib/ads/metaAdsOAuth.ts): кнопка
 * «Подключить кабинет» → окно Facebook → маркер рекламы. Владелец попросил так же
 * подключать Страницы и Instagram: «нажать „Войти через Facebook“, дать
 * разрешения — и всё, без игры с токенами». Второй вход рядом с первым означал бы
 * два реестра `state`, две проверки прав и два обмена кода — и рано или поздно
 * разные правила защиты. Поэтому вход один, а ЦЕЛЬ входа (`purpose`) лежит в
 * одноразовом `state`:
 *   - "ads"    — прежняя кнопка рекламы, поведение не меняется;
 *   - "assets" — Страницы, Instagram, кабинеты (lib/metaLoginAssets.ts).
 *
 * Адрес возврата ОБЩИЙ — /api/v1/ads/callback (routes/ads.ts): он уже вписан в
 * приложение Meta, и владельцу не нужно добавлять второй. Колбэк смотрит цель.
 *
 * ЗАЩИТА (как была у рекламы, теперь у обеих целей):
 *  - старт выдаёт только авторизованный сотрудник с нужным правом (маршрут);
 *  - `state` одноразовый, живёт 10 минут, привязан к сотруднику и цели — без
 *    совпадения код не обменивается (иначе чужая ссылка подсунула бы нам маркер
 *    постороннего кабинета или Страницы);
 *  - право проверяется ЗАНОВО в колбэке: за минуты в окне Facebook роль могли
 *    сменить, а колбэк приходит без нашего маркера (до requireAuth).
 * Секрет приложения уходит только в адрес обмена на graph.facebook.com — ни в
 * ответы, ни в журнал (текст ошибки — только из тела ответа Meta).
 */

export type MetaLoginPurpose = "ads" | "assets";

/** Сколько живёт неиспользованный state. Больше нескольких минут человеку не нужно. */
const STATE_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 15_000;

interface PendingState {
  agentId: string;
  purpose: MetaLoginPurpose;
  expiresAt: number;
}

/**
 * Ожидающие подтверждения входы. В памяти процесса, а не в базе: перезапуск API
 * во время подтверждения — редкость, а цена ей — повторное нажатие кнопки.
 */
const pending = new Map<string, PendingState>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, value] of pending) if (value.expiresAt < now) pending.delete(key);
}

export class MetaLoginError extends Error {
  /** Цель входа, если state был узнан: колбэк по ней решает, куда вернуть человека. */
  readonly purpose?: MetaLoginPurpose;
  constructor(message: string, purpose?: MetaLoginPurpose) {
    super(message);
    this.purpose = purpose;
  }
}

/** Кто вправе завершить вход каждой цели. Проверяется и при старте (маршрут), и в колбэке. */
const PURPOSE_ACCESS: Record<MetaLoginPurpose, { allowed: (agentId: string) => Promise<boolean>; denied: string }> = {
  ads: {
    allowed: agentCanWriteAds,
    denied: "Подключать рекламу может только сотрудник с правом «Вести расходы» или маркетинг",
  },
  assets: {
    allowed: async (agentId) => {
      const access = await loadAgentAccess(agentId);
      return Boolean(access?.isActive && access.permissions.has("settings.manage"));
    },
    denied: "Подключать Страницы и кабинеты может только сотрудник с правом менять настройки",
  },
};

/** Куда Facebook вернёт человека. Должен совпадать с адресом в приложении Meta символ в символ. */
export function metaLoginRedirectUri(): string | null {
  const base = crmPublicBase();
  return base ? `${base}/api/v1/ads/callback` : null;
}

async function loginConfigId(): Promise<string | null> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaLoginConfigId: true } });
  const id = s?.metaLoginConfigId?.trim();
  return id && /^\d{1,30}$/.test(id) ? id : null;
}

/** Адрес окна Facebook для выбранной цели. */
export async function buildMetaLoginUrl(agentId: string, purpose: MetaLoginPurpose): Promise<string> {
  const app = await loadAppCredentials();
  if (!app) {
    throw new MetaLoginError(
      "Не заполнены номер приложения Meta и его секрет — без них Facebook не с кем разговаривать",
      purpose
    );
  }
  const redirectUri = metaLoginRedirectUri();
  if (!redirectUri) {
    throw new MetaLoginError("Не задан публичный адрес CRM (CRM_PUBLIC_URL) — Facebook некуда возвращать ответ", purpose);
  }

  sweepExpired();
  const state = randomBytes(24).toString("hex");
  pending.set(state, { agentId, purpose, expiresAt: Date.now() + STATE_TTL_MS });

  const params = new URLSearchParams({ client_id: app.appId, redirect_uri: redirectUri, state, response_type: "code" });
  if (purpose === "ads") {
    // Только чтение статистики: маркер, который умеет тратить деньги, не должен
    // лежать в CRM ради отчёта. Список — общий (lib/tokenScopes.ts).
    params.set("scope", scopesForRequest("META_ADS", ","));
  } else {
    const configId = await loginConfigId();
    if (configId) {
      // Facebook Login for Business: права и ресурсы задаёт конфигурация в Meta.
      // По умолчанию такой вход отдаёт маркер сразу, а нам нужен КОД (обмен на
      // сервере, маркер не проходит через браузер) — отсюда override.
      params.set("config_id", configId);
      params.set("override_default_response_type", "true");
    } else {
      params.set("scope", scopesForRequest("META_LOGIN", ","));
    }
  }
  return `https://www.facebook.com/${ADS_GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

/**
 * Человек нажал «Отмена» в окне Facebook: state гасим и узнаём цель — чтобы
 * вернуть его к той кнопке, которую он нажимал. Незнакомый state — null.
 */
export function dropMetaLoginState(state: string | null): MetaLoginPurpose | null {
  if (!state) return null;
  sweepExpired();
  const entry = pending.get(state);
  if (!entry) return null;
  pending.delete(state);
  return entry.purpose;
}

export interface MetaLoginGrant {
  agentId: string;
  purpose: MetaLoginPurpose;
  /** Маркер входа. Только для сервера: в ответы, журнал и браузер не попадает. */
  token: string;
}

/**
 * Обмен кода на маркер. state сгорает при первом же обращении — повтор того же
 * адреса возврата (обновили вкладку) получает «просрочено».
 *
 * Два шага подряд: код → маркер → попытка долгого (60 дней) через
 * fb_exchange_token. Второй шаг может не получиться (маркер конфигурации входа
 * для бизнеса уже долгий и не обменивается) — тогда работаем на первом.
 */
export async function consumeMetaLoginCode(code: string, state: string): Promise<MetaLoginGrant> {
  sweepExpired();
  const entry = pending.get(state);
  if (!entry) throw new MetaLoginError("Подтверждение просрочено или уже использовано — нажмите кнопку заново");
  pending.delete(state);

  const access = PURPOSE_ACCESS[entry.purpose];
  if (!(await access.allowed(entry.agentId))) throw new MetaLoginError(access.denied, entry.purpose);

  const app = await loadAppCredentials();
  const redirectUri = metaLoginRedirectUri();
  if (!app || !redirectUri) throw new MetaLoginError("Приложение Meta не настроено", entry.purpose);

  let token: string;
  try {
    token = await exchange({ client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void logSystemError("meta", `Вход через Facebook (${entry.purpose === "ads" ? "реклама" : "Страницы и кабинеты"}): Meta не обменяла код — ${message}`);
    throw new MetaLoginError(message, entry.purpose);
  }
  try {
    token = await exchange({
      grant_type: "fb_exchange_token",
      client_id: app.appId,
      client_secret: app.appSecret,
      fb_exchange_token: token,
    });
  } catch {
    // Долгий не выдали — работаем на полученном: для рекламы недельное продление
    // (metaAdsToken.ts) попробует ещё раз само.
  }
  return { agentId: entry.agentId, purpose: entry.purpose, token };
}

async function exchange(params: Record<string, string>): Promise<string> {
  const url = `https://graph.facebook.com/${ADS_GRAPH_VERSION}/oauth/access_token?${new URLSearchParams(params).toString()}`;
  const res = await fetchWithRetry(url, { method: "GET" }, EXCHANGE_TIMEOUT_MS);
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
  if (!res.ok || !body.access_token) throw new Error(body.error?.message ?? `Facebook ответил ${res.status}`);
  return body.access_token;
}

/** Только для тестов: забыть ожидающие входы (модуль живёт весь процесс). */
export function resetMetaLoginStates(): void {
  pending.clear();
}
