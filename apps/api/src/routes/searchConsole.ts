import { Router } from "express";
import { searchOverviewQuerySchema, yandexAppSchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { requireMarketingRole } from "./marketing.js";
import { encryptSecret } from "../crypto.js";
import { publicAppUrl } from "../lib/crmPublicUrl.js";
import { logAudit } from "../lib/audit.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { fetchWithRetry } from "../messengers/meta.js";
// signState/verifyState вынесены из routes/tiktok.ts в lib/oauthState.ts (23.09.2026,
// когда появился второй канал с той же схемой consent-flow — Threads); searchConsole
// добавлен позже (24.09.2026) ещё на прямой импорт из tiktok.ts, здесь сведено к общему.
import { signState, verifyState } from "../lib/oauthState.js";
import {
  SEARCH_CONSOLE_SCOPE,
  listSites,
  loadGoogleApp,
  loadSearchOverview,
  pickSite,
  resetSearchConsoleCache,
  siteHost,
} from "../lib/searchConsole.js";
import {
  listYandexHosts,
  loadYandexApp,
  loadYandexOverview,
  pickYandexHost,
  resetYandexWebmasterCache,
  yandexToken,
  yandexUserId,
} from "../lib/yandexWebmaster.js";

/**
 * «САЙТ И ПОИСК» — подключение Google Search Console и чтение данных
 * (24.09.2026). Устроено как подключение TikTok (routes/tiktok.ts): кнопка в
 * CRM ведёт на вход Google, Google возвращает браузер на callback без маркера
 * CRM, подлинность подтверждает тот же подписанный `state`.
 *
 * В Google Cloud у Google-приложения (того же, что YouTube) должны быть
 * включены Search Console API и адрес возврата
 * `<адрес CRM>/api/v1/search-console/oauth/callback`. Без него Google покажет
 * ошибку redirect_uri_mismatch ещё до входа — экран подсказывает этот адрес.
 */

export function searchConsoleRedirectUri(): string {
  return `${publicAppUrl()}/api/v1/search-console/oauth/callback`;
}

export const searchConsoleRouter = Router();
searchConsoleRouter.use(requireAuth);
searchConsoleRouter.use(requireMarketingRole);

searchConsoleRouter.get("/overview", async (req, res) => {
  const parsed = searchOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Период — 7, 28 или 90 дней" });
  const result = await loadSearchOverview(parsed.data.days, { forceRefresh: parsed.data.refresh === "1" });
  res.json({ ...result, redirectUri: searchConsoleRedirectUri() });
});

/** Адрес входа Google, куда фронт делает `window.location.assign(url)`. */
searchConsoleRouter.get("/oauth/start", async (req, res) => {
  const app = await loadGoogleApp();
  if (!app) {
    return res.status(400).json({
      error: "Не внесены Client ID и Client secret Google — Настройки → Каналы связи → YouTube",
    });
  }
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: searchConsoleRedirectUri(),
    response_type: "code",
    scope: SEARCH_CONSOLE_SCOPE,
    // offline + consent — иначе Google при повторном входе не выдаёт refresh-токен.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: signState(),
  });
  logAudit(req, "SETTINGS_UPDATE", "Settings", "search-console", { action: "oauth-start" });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
});

searchConsoleRouter.post("/disconnect", async (req, res) => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { searchConsoleRefreshToken: null, searchConsoleSiteUrl: null, searchConsoleConnectedAt: null },
  });
  resetSearchConsoleCache();
  logAudit(req, "SETTINGS_UPDATE", "Settings", "search-console", { action: "disconnected" });
  res.json({ ok: true });
});

/**
 * ВОЗВРАТ ИЗ GOOGLE — без requireAuth (браузер приходит прямым переходом),
 * монтируется в app.ts ДО searchConsoleRouter. Итог — обратно на вкладку
 * «Сайт и поиск» с `?sc=ok` или `?sc=error&reason=…`.
 */
export const searchConsoleCallbackRouter = Router();

searchConsoleCallbackRouter.get("/", async (req, res) => {
  const back = (params: Record<string, string>) =>
    `${publicAppUrl()}/marketing?tab=search&${new URLSearchParams(params).toString()}`;

  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  if (!code || !state) return res.redirect(back({ sc: "error", reason: "cancelled" }));
  if (!verifyState(state)) return res.redirect(back({ sc: "error", reason: "state" }));

  const app = await loadGoogleApp();
  if (!app) return res.redirect(back({ sc: "error", reason: "not-configured" }));

  try {
    const tokenRes = await fetchWithRetry(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: searchConsoleRedirectUri(),
        }).toString(),
      },
      15_000
    );
    const body = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokenRes.ok || !body.access_token || !body.refresh_token) {
      throw new Error(body.error_description ?? body.error ?? `HTTP ${tokenRes.status}`);
    }

    const siteUrl = pickSite(await listSites(body.access_token), siteHost());
    if (!siteUrl) {
      // Вошли не тем аккаунтом Google: у него нет ресурса нашего сайта.
      return res.redirect(back({ sc: "error", reason: "no-site" }));
    }

    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        searchConsoleRefreshToken: encryptSecret(body.refresh_token),
        searchConsoleSiteUrl: siteUrl,
        searchConsoleConnectedAt: new Date(),
      },
    });
    resetSearchConsoleCache();
    logAudit(req, "SETTINGS_UPDATE", "Settings", "search-console", { action: "connected", siteUrl });
    res.redirect(back({ sc: "ok" }));
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("api", `Подключение Search Console не удалось: ${reason}`);
    res.redirect(back({ sc: "error", reason: reason.slice(0, 100) }));
  }
});

/**
 * ЯНДЕКС ВЕБМАСТЕР (24.09.2026) — вторая половина «Сайт и поиск», тем же
 * устройством: своё приложение Яндекса (ID и пароль вносят на вкладке),
 * кнопка входа, возврат на callback без маркера CRM с подписанным `state`.
 * В приложении на oauth.yandex.ru — право «Яндекс.Вебмастер: получение
 * информации о сайтах» и адрес возврата `<адрес CRM>/api/v1/search-console/yandex/oauth/callback`.
 */
export function yandexRedirectUri(): string {
  return `${publicAppUrl()}/api/v1/search-console/yandex/oauth/callback`;
}

searchConsoleRouter.get("/yandex/overview", async (req, res) => {
  const parsed = searchOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Период — 7, 28 или 90 дней" });
  const result = await loadYandexOverview(parsed.data.days, { forceRefresh: parsed.data.refresh === "1" });
  res.json({ ...result, redirectUri: yandexRedirectUri() });
});

searchConsoleRouter.put("/yandex/app", async (req, res) => {
  const parsed = yandexAppSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Проверьте ID и пароль" });
  // Другое приложение — прежний вход к нему не подходит: подключаться заново.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      yandexWebmasterClientId: parsed.data.clientId,
      yandexWebmasterClientSecret: encryptSecret(parsed.data.clientSecret),
      yandexWebmasterRefreshToken: null,
      yandexWebmasterUserId: null,
      yandexWebmasterHostId: null,
      yandexWebmasterConnectedAt: null,
    },
  });
  resetYandexWebmasterCache();
  logAudit(req, "SETTINGS_UPDATE", "Settings", "yandex-webmaster", { action: "app-saved" });
  res.json({ ok: true });
});

searchConsoleRouter.get("/yandex/oauth/start", async (req, res) => {
  const app = await loadYandexApp();
  if (!app) return res.status(400).json({ error: "Сначала внесите ID и пароль приложения Яндекса" });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: yandexRedirectUri(),
    state: signState(),
    // Всегда спрашивать аккаунт: вошли не тем — можно выбрать другой.
    force_confirm: "yes",
  });
  logAudit(req, "SETTINGS_UPDATE", "Settings", "yandex-webmaster", { action: "oauth-start" });
  res.json({ url: `https://oauth.yandex.ru/authorize?${params.toString()}` });
});

searchConsoleRouter.post("/yandex/disconnect", async (req, res) => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      yandexWebmasterRefreshToken: null,
      yandexWebmasterUserId: null,
      yandexWebmasterHostId: null,
      yandexWebmasterConnectedAt: null,
    },
  });
  resetYandexWebmasterCache();
  logAudit(req, "SETTINGS_UPDATE", "Settings", "yandex-webmaster", { action: "disconnected" });
  res.json({ ok: true });
});

/** Возврат из Яндекса — без requireAuth, монтируется в app.ts ДО searchConsoleRouter. */
export const yandexCallbackRouter = Router();

yandexCallbackRouter.get("/", async (req, res) => {
  const back = (params: Record<string, string>) =>
    `${publicAppUrl()}/marketing?tab=search&engine=yandex&${new URLSearchParams(params).toString()}`;

  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  if (!code || !state) return res.redirect(back({ sc: "error", reason: "cancelled" }));
  if (!verifyState(state)) return res.redirect(back({ sc: "error", reason: "state" }));

  const app = await loadYandexApp();
  if (!app) return res.redirect(back({ sc: "error", reason: "not-configured" }));

  try {
    const tokens = await yandexToken(app, { code });
    if (!tokens.refreshToken) throw new Error("Яндекс не выдал постоянный доступ (refresh_token)");
    const userId = await yandexUserId(tokens.accessToken);
    const host = pickYandexHost(await listYandexHosts(tokens.accessToken, userId), siteHost());
    if (!host?.host_id) return res.redirect(back({ sc: "error", reason: "no-site" }));

    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        yandexWebmasterRefreshToken: encryptSecret(tokens.refreshToken),
        yandexWebmasterUserId: userId,
        yandexWebmasterHostId: host.host_id,
        yandexWebmasterConnectedAt: new Date(),
      },
    });
    resetYandexWebmasterCache();
    logAudit(req, "SETTINGS_UPDATE", "Settings", "yandex-webmaster", { action: "connected", hostId: host.host_id });
    res.redirect(back({ sc: "ok" }));
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("api", `Подключение Яндекс Вебмастера не удалось: ${reason}`);
    res.redirect(back({ sc: "error", reason: reason.slice(0, 100) }));
  }
});
