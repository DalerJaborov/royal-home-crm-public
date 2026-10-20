import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { requireMarketingRole } from "./marketing.js";
import { encryptSecret, decryptSecretSafe } from "../crypto.js";
import { publicAppUrl } from "../lib/crmPublicUrl.js";
import { logAudit } from "../lib/audit.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { fetchWithRetry } from "../messengers/meta.js";
import { signState, verifyState } from "../lib/oauthState.js";
import { scopesForRequest } from "../lib/tokenScopes.js";
import { THREADS_GRAPH_BASE } from "../lib/socialPublish.js";

/**
 * Threads (Meta) — OAuth и служебные роуты (23.09.2026,
 * docs/agent-briefs/threads-channel-23-09.md). ОБРАЗЕЦ — routes/tiktok.ts:
 * тот же рецепт consent-flow (redirect_uri зарегистрирован в приложении,
 * поэтому кнопку жмёт сама CRM, а не владелец в ручном обмене, как у
 * YouTube), тот же state (lib/oauthState.ts, теперь общий с TikTok), те же
 * два роутера (`threadsRouter` с правами, `threadsCallbackRouter` без —
 * сюда браузер приходит от Threads обычным переходом, маркер CRM тут не
 * участвует).
 *
 * СВОЁ ПРИЛОЖЕНИЕ. У Threads свой App ID/App Secret (use case «Threads API»
 * в Meta App Dashboard) — НЕ совпадают с Facebook App ID/App Secret
 * (Settings.metaAppSecret и т.д.), хотя аккаунт Threads привязан к нашему
 * Instagram. Обмен токена и сам граф — на graph.threads.net, отдельно от
 * graph.facebook.com/graph.instagram.com.
 */

/** Домен окна авторизации — в новых доках Meta уже threads.com, но threads.net
 *  по-прежнему работает (проверено 23.09.2026); берём net — тот же домен, что и
 *  у graph-хоста, меньше сюрпризов при смене документации. */
const THREADS_AUTH_HOST = "https://www.threads.net";

function redirectUri(): string {
  return `${publicAppUrl()}/api/v1/threads/oauth/callback`;
}

async function loadAppCredentials(): Promise<{ appId: string; appSecret: string } | null> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { threadsAppId: true, threadsAppSecret: true },
  });
  const appId = s?.threadsAppId?.trim() || "";
  const appSecret = decryptSecretSafe(s?.threadsAppSecret ?? null) || "";
  return appId && appSecret ? { appId, appSecret } : null;
}

export const threadsRouter = Router();
threadsRouter.use(requireAuth);
threadsRouter.use(requireMarketingRole);

/** Адрес окна Threads, куда фронт делает `window.location.href = url`. */
threadsRouter.get("/oauth/start", async (req, res) => {
  const app = await loadAppCredentials();
  if (!app) {
    return res.status(400).json({ error: "Не заполнены App ID и App Secret Threads — сначала внесите их в Настройках" });
  }
  const state = signState();
  const params = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: redirectUri(),
    scope: scopesForRequest("THREADS", ","),
    response_type: "code",
    state,
  });
  logAudit(req, "SETTINGS_UPDATE", "Settings", "threads", { action: "oauth-start" });
  res.json({ url: `${THREADS_AUTH_HOST}/oauth/authorize?${params.toString()}` });
});

/**
 * ОТКЛЮЧИТЬ — из самой CRM. У Threads нет ручки отзыва токена (в отличие от
 * TikTok) — просто забываем токен/пользователя/профиль. Ключи приложения
 * (App ID/App Secret) НЕ трогаем — то же решение, что у TikTok: приложение
 * остаётся зарегистрированным, отключается только аккаунт-канал.
 */
threadsRouter.post("/disconnect", async (req, res) => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      threadsAccessToken: null,
      threadsTokenExpiresAt: null,
      threadsUserId: null,
      threadsUsername: null,
      threadsAvatarUrl: null,
      threadsConnectedAt: null,
    },
  });
  profileCache = null;
  logAudit(req, "SETTINGS_UPDATE", "Settings", "threads", { action: "disconnect" });
  res.json({ ok: true });
});

interface CachedProfile {
  at: number;
  data: unknown;
}
let profileCache: CachedProfile | null = null;
const PROFILE_CACHE_MS = 60_000;

/** Живой профиль (`/me`) для экрана настроек: `{ connected: false }` —
 *  не подключено, дальше смотреть нечего. */
threadsRouter.get("/profile", async (_req, res) => {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      threadsUserId: true,
      threadsAccessToken: true,
      threadsUsername: true,
      threadsAvatarUrl: true,
      threadsConnectedAt: true,
      threadsTokenExpiresAt: true,
    },
  });
  const accessToken = decryptSecretSafe(settings?.threadsAccessToken ?? null);
  if (!accessToken || !settings?.threadsUserId) {
    return res.json({ connected: false });
  }

  if (profileCache && Date.now() - profileCache.at < PROFILE_CACHE_MS) {
    return res.json({ connected: true, ...(profileCache.data as object) });
  }

  try {
    const url = `${THREADS_GRAPH_BASE}/v1.0/me?fields=id,username,threads_profile_picture_url&access_token=${encodeURIComponent(accessToken)}`;
    const profileRes = await fetchWithRetry(url, {}, 15_000);
    const body = (await profileRes.json().catch(() => ({}))) as {
      username?: string;
      threads_profile_picture_url?: string;
      error?: { message?: string };
    };
    if (!profileRes.ok) {
      throw new Error(body.error?.message ?? `HTTP ${profileRes.status}`);
    }
    const data = {
      username: body.username ?? settings.threadsUsername ?? null,
      avatarUrl: body.threads_profile_picture_url ?? settings.threadsAvatarUrl ?? null,
      connectedAt: settings.threadsConnectedAt ?? null,
      tokenExpiresAt: settings.threadsTokenExpiresAt ?? null,
    };
    profileCache = { at: Date.now(), data };
    res.json({ connected: true, ...data });
  } catch (err) {
    res.status(502).json({ connected: true, error: describeError(err) });
  }
});

/**
 * ВОЗВРАТ ИЗ THREADS. Отдельный роутер (см. докстринг вверху файла) —
 * монтируется ДО threadsRouter в app.ts, БЕЗ requireAuth.
 */
export const threadsCallbackRouter = Router();

threadsCallbackRouter.get("/", async (req, res) => {
  const base = publicAppUrl();
  const back = (params: Record<string, string>) => `${base}/settings?tab=channels&${new URLSearchParams(params).toString()}`;

  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;

  if (!code || !state) {
    return res.redirect(back({ threads: "error", reason: "cancelled" }));
  }
  if (!verifyState(state)) {
    return res.redirect(back({ threads: "error", reason: "state" }));
  }

  const app = await loadAppCredentials();
  if (!app) {
    return res.redirect(back({ threads: "error", reason: "not-configured" }));
  }

  try {
    // Шаг 1 — код на короткий токен (форма, как требует Threads).
    const tokenRes = await fetchWithRetry(
      `${THREADS_GRAPH_BASE}/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: app.appId,
          client_secret: app.appSecret,
          grant_type: "authorization_code",
          redirect_uri: redirectUri(),
          code,
        }).toString(),
      },
      15_000
    );
    const tokenBody = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string;
      user_id?: string | number;
      error_message?: string;
      error?: { message?: string } | string;
    };
    if (!tokenRes.ok || !tokenBody.access_token || !tokenBody.user_id) {
      const message =
        tokenBody.error_message ??
        (typeof tokenBody.error === "string" ? tokenBody.error : tokenBody.error?.message) ??
        `HTTP ${tokenRes.status}`;
      throw new Error(message);
    }

    // Шаг 2 — сразу меняем на долгий (60 дней) — короткий живёт час, хранить
    // его смысла нет.
    const exchangeUrl =
      `${THREADS_GRAPH_BASE}/access_token?grant_type=th_exchange_token` +
      `&client_secret=${encodeURIComponent(app.appSecret)}&access_token=${encodeURIComponent(tokenBody.access_token)}`;
    const exchangeRes = await fetchWithRetry(exchangeUrl, {}, 15_000);
    const exchangeBody = (await exchangeRes.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: { message?: string };
    };
    if (!exchangeRes.ok || !exchangeBody.access_token) {
      throw new Error(exchangeBody.error?.message ?? `HTTP ${exchangeRes.status} (обмен на долгий токен)`);
    }
    const longToken = exchangeBody.access_token;
    const expiresAt = new Date(Date.now() + (exchangeBody.expires_in ?? 60 * 24 * 60 * 60) * 1000);

    // Профиль — сразу, чтобы карточка подключённого аккаунта не была пустой
    // до первого захода на /profile.
    let username: string | null = null;
    let avatarUrl: string | null = null;
    try {
      const profileUrl = `${THREADS_GRAPH_BASE}/v1.0/me?fields=id,username,threads_profile_picture_url&access_token=${encodeURIComponent(longToken)}`;
      const profileRes = await fetchWithRetry(profileUrl, {}, 15_000);
      const profileBody = (await profileRes.json().catch(() => ({}))) as {
        username?: string;
        threads_profile_picture_url?: string;
      };
      username = profileBody.username ?? null;
      avatarUrl = profileBody.threads_profile_picture_url ?? null;
    } catch (err) {
      // Профиль необязателен для самого подключения — токен уже сохранён ниже,
      // просто карточка первое время покажет "Аккаунт подключён" без ника.
      void logSystemError("threads", `Threads: подключение прошло, но профиль не прочитан: ${describeError(err)}`);
    }

    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        threadsAccessToken: encryptSecret(longToken),
        threadsTokenExpiresAt: expiresAt,
        // user_id в ответе обмена приходит ЧИСЛОМ (как у Instagram Basic Display),
        // колонка строковая — приводим явно, иначе Prisma откажет.
        threadsUserId: String(tokenBody.user_id),
        threadsUsername: username,
        threadsAvatarUrl: avatarUrl,
        threadsConnectedAt: new Date(),
      },
    });
    profileCache = null;
    logAudit(req, "SETTINGS_UPDATE", "Settings", "threads", { action: "connected", username });
    res.redirect(back({ threads: "ok" }));
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("threads", `Подключение аккаунта Threads не удалось: ${reason}`);
    res.redirect(back({ threads: "error", reason: encodeURIComponent(reason).slice(0, 100) }));
  }
});
