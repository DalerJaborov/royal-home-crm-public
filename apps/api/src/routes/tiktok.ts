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
import { tiktokAccessToken, tiktokCreatorInfo, type TikTokCredentials } from "../lib/socialPublish.js";
import { scopesForRequest } from "../lib/tokenScopes.js";
import { fetchTikTokInsights } from "../lib/tiktokInsights.js";
import { signState, verifyState } from "../lib/oauthState.js";

/**
 * TikTok Content Posting API — OAuth и служебные роуты (17.09.2026).
 *
 * ОБРАЗЕЦ ВО ВСЁМ — routes/ads.ts (adsRouter/adsCallbackRouter, «подключение
 * кабинета кнопкой»): consent-flow делает сама CRM, потому что redirect_uri
 * обязан быть зарегистрирован в приложении TikTok и быть https — в отличие от
 * YouTube, где владелец получает refresh_token один раз вручную.
 *
 * ДВА РОУТЕРА, как у ads.ts: `tiktokRouter` — с правами (requireAuth +
 * requireMarketingRole, те же, что у кабинета маркетинга), `tiktokCallbackRouter` —
 * БЕЗ авторизации: сюда браузер приходит от TikTok обычным переходом по ссылке,
 * маркер доступа CRM в этом переходе не участвует.
 *
 * STATE — в отличие от ads.ts (in-memory Map), здесь подписанная строка
 * `<ts>.<nonce>.<hmac>` на HMAC-SHA256 от того же секрета, которым подписываются
 * access-токены (JWT_ACCESS_SECRET, см. auth/jwt.ts) — переживает перезапуск
 * процесса между нажатием кнопки и возвратом из TikTok, не требует отдельной
 * таблицы или карты в памяти. `signState`/`verifyState` вынесены в
 * `lib/oauthState.ts` (23.09.2026, второй канал с той же схемой — Threads,
 * routes/threads.ts) — не копия, общий код.
 */

function redirectUri(): string {
  return `${publicAppUrl()}/api/v1/tiktok/oauth/callback`;
}

async function loadAppCredentials(): Promise<{ clientKey: string; clientSecret: string } | null> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { tiktokClientKey: true, tiktokClientSecret: true },
  });
  const clientKey = s?.tiktokClientKey?.trim() || "";
  const clientSecret = decryptSecretSafe(s?.tiktokClientSecret ?? null) || "";
  return clientKey && clientSecret ? { clientKey, clientSecret } : null;
}

export const tiktokRouter = Router();
tiktokRouter.use(requireAuth);
tiktokRouter.use(requireMarketingRole);

/** Адрес окна TikTok, куда фронт делает `window.location.assign(url)`. */
tiktokRouter.get("/oauth/start", async (req, res) => {
  const app = await loadAppCredentials();
  if (!app) {
    return res.status(400).json({ error: "Не заполнены Client key и Client secret TikTok — сначала внесите их в Настройках" });
  }
  const state = signState();
  const params = new URLSearchParams({
    client_key: app.clientKey,
    // Через запятую — так требует API TikTok (в отличие от Meta с "%20"/массивом).
    // ВСЕ права из общего списка (lib/tokenScopes.ts), а не три вписанных здесь
    // руками: до 23.09.2026 кнопка просила user.info.basic, video.publish и
    // video.upload, и каждое переподключение выдавало маркер без video.list, то
    // есть заведомо без статистики. Владелец перевыпускал маркеры «каждые
    // несколько дней» ровно из-за таких мест.
    //
    // includeAwaitingApproval — ТОЛЬКО для песочницы (client key начинается с
    // "sb"): там можно просить ещё не одобренные права (video.list,
    // user.info.profile, user.info.stats), ревью TikTok для sandbox-приложений
    // не требуется. Прод-приложению ("aw…") их просить нельзя — TikTok отвечает
    // отказом во входе целиком на неодобренный scope (см. lib/tokenScopes.ts).
    scope: scopesForRequest("TIKTOK", ",", { includeAwaitingApproval: app.clientKey.startsWith("sb") }),
    response_type: "code",
    redirect_uri: redirectUri(),
    state,
  });
  logAudit(req, "SETTINGS_UPDATE", "Settings", "tiktok", { action: "oauth-start" });
  res.json({ url: `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}` });
});

/**
 * ОТКЛЮЧИТЬ — из самой CRM. Ревокация access-токена (получаем свежий через
 * refresh) лучших усилий: отказ TikTok её выполнить не должен мешать очистить
 * поля здесь — иначе кнопка «Отключить» переставала бы работать из-за чужого
 * отказа.
 */
tiktokRouter.post("/disconnect", async (req, res) => {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { tiktokClientKey: true, tiktokClientSecret: true, tiktokRefreshToken: true },
  });
  const creds: TikTokCredentials = {
    clientKey: settings?.tiktokClientKey ?? undefined,
    clientSecret: decryptSecretSafe(settings?.tiktokClientSecret ?? null) ?? undefined,
    refreshToken: decryptSecretSafe(settings?.tiktokRefreshToken ?? null) ?? undefined,
  };
  if (creds.clientKey && creds.clientSecret && creds.refreshToken) {
    try {
      const accessToken = await tiktokAccessToken(creds);
      await fetchWithRetry(
        "https://open.tiktokapis.com/v2/oauth/revoke/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_key: creds.clientKey,
            client_secret: creds.clientSecret,
            token: accessToken,
          }).toString(),
        },
        15_000
      );
    } catch (err) {
      // Отказ revoke не блокирует отключение — см. докстринг выше.
      void logSystemError("tiktok", `Отзыв токена TikTok при отключении не удался (не критично): ${describeError(err)}`);
    }
  }

  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      tiktokRefreshToken: null,
      tiktokOpenId: null,
      tiktokCreatorUsername: null,
      tiktokCreatorNickname: null,
      tiktokCreatorAvatarUrl: null,
      tiktokConnectedAt: null,
      // clientKey/clientSecret НЕ трогаем (договор задания) — приложение TikTok
      // остаётся зарегистрированным, отключается только аккаунт-канал.
    },
  });
  logAudit(req, "SETTINGS_UPDATE", "Settings", "tiktok", { action: "disconnect" });
  res.json({ ok: true });
});

interface CachedCreatorInfo {
  at: number;
  data: unknown;
}
let creatorInfoCache: CachedCreatorInfo | null = null;
/** 20 запросов/мин на токен (лимит TikTok) — 60с с запасом. */
const CREATOR_INFO_CACHE_MS = 60_000;

/** Для экрана настроек: живой список privacy_level_options и рубильники
 *  аккаунта. `{ connected: false }` — не подключено, дальше смотреть нечего. */
tiktokRouter.get("/creator-info", async (_req, res) => {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      tiktokClientKey: true,
      tiktokClientSecret: true,
      tiktokRefreshToken: true,
      tiktokCreatorUsername: true,
      tiktokCreatorNickname: true,
      tiktokCreatorAvatarUrl: true,
      tiktokConnectedAt: true,
    },
  });
  const creds: TikTokCredentials = {
    clientKey: settings?.tiktokClientKey ?? undefined,
    clientSecret: decryptSecretSafe(settings?.tiktokClientSecret ?? null) ?? undefined,
    refreshToken: decryptSecretSafe(settings?.tiktokRefreshToken ?? null) ?? undefined,
  };
  if (!creds.clientKey || !creds.clientSecret || !creds.refreshToken) {
    return res.json({ connected: false });
  }

  if (creatorInfoCache && Date.now() - creatorInfoCache.at < CREATOR_INFO_CACHE_MS) {
    return res.json({ connected: true, ...(creatorInfoCache.data as object) });
  }

  try {
    const accessToken = await tiktokAccessToken(creds);
    const info = await tiktokCreatorInfo(accessToken);
    const data = {
      username: settings?.tiktokCreatorUsername ?? info.creatorUsername ?? null,
      nickname: settings?.tiktokCreatorNickname ?? info.creatorNickname ?? null,
      avatarUrl: settings?.tiktokCreatorAvatarUrl ?? info.creatorAvatarUrl ?? null,
      connectedAt: settings?.tiktokConnectedAt ?? null,
      privacyLevelOptions: info.privacyLevelOptions,
      commentDisabled: info.commentDisabled,
      duetDisabled: info.duetDisabled,
      stitchDisabled: info.stitchDisabled,
      maxVideoPostDurationSec: info.maxVideoPostDurationSec,
    };
    creatorInfoCache = { at: Date.now(), data };
    res.json({ connected: true, ...data });
  } catch (err) {
    res.status(502).json({ connected: true, error: describeError(err) });
  }
});

/**
 * СТАТИСТИКА TIKTOK: аккаунт + ролики (23.09.2026) — экран «Маркетинг».
 * `user.info.profile`/`user.info.stats`/`video.list` ждут ревизии TikTok
 * (lib/tokenScopes.ts), поэтому `available: false` с честной причиной — рабочий,
 * ожидаемый ответ, а не сбой роута (502 здесь только на неожиданную ошибку).
 */
tiktokRouter.get("/insights", async (_req, res) => {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { tiktokClientKey: true, tiktokClientSecret: true, tiktokRefreshToken: true },
  });
  const creds: TikTokCredentials = {
    clientKey: settings?.tiktokClientKey ?? undefined,
    clientSecret: decryptSecretSafe(settings?.tiktokClientSecret ?? null) ?? undefined,
    refreshToken: decryptSecretSafe(settings?.tiktokRefreshToken ?? null) ?? undefined,
  };
  if (!creds.clientKey || !creds.clientSecret || !creds.refreshToken) {
    return res.json({
      available: false,
      reason: "TikTok не подключён — подключите аккаунт в Настройках → Каналы связи",
      missingScopes: [],
    });
  }
  try {
    const result = await fetchTikTokInsights(creds);
    res.json(result);
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("tiktok", `Статистика TikTok не удалась: ${reason}`);
    res.status(502).json({ available: false, reason, missingScopes: [] });
  }
});

/**
 * ВОЗВРАТ ИЗ TIKTOK. Отдельный роутер (см. докстринг вверху файла) — монтируется
 * ДО tiktokRouter в app.ts, БЕЗ requireAuth: TikTok приводит сюда браузер прямым
 * переходом, JWT CRM в этом переходе не участвует. Подлинность подтверждает
 * подписанный `state`.
 */
export const tiktokCallbackRouter = Router();

tiktokCallbackRouter.get("/", async (req, res) => {
  const base = publicAppUrl();
  const back = (params: Record<string, string>) => `${base}/settings?tab=channels&${new URLSearchParams(params).toString()}`;

  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;

  if (!code || !state) {
    return res.redirect(back({ tiktok: "error", reason: "cancelled" }));
  }
  if (!verifyState(state)) {
    return res.redirect(back({ tiktok: "error", reason: "state" }));
  }

  const app = await loadAppCredentials();
  if (!app) {
    return res.redirect(back({ tiktok: "error", reason: "not-configured" }));
  }

  try {
    const tokenRes = await fetchWithRetry(
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: app.clientKey,
          client_secret: app.clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri(),
        }).toString(),
      },
      15_000
    );
    const tokenBody = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      open_id?: string;
      error_description?: string;
      error?: string;
    };
    if (!tokenRes.ok || !tokenBody.access_token || !tokenBody.refresh_token) {
      throw new Error(tokenBody.error_description ?? tokenBody.error ?? `HTTP ${tokenRes.status}`);
    }

    const info = await tiktokCreatorInfo(tokenBody.access_token);

    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        tiktokRefreshToken: encryptSecret(tokenBody.refresh_token),
        tiktokOpenId: tokenBody.open_id ?? null,
        tiktokCreatorUsername: info.creatorUsername ?? null,
        tiktokCreatorNickname: info.creatorNickname ?? null,
        tiktokCreatorAvatarUrl: info.creatorAvatarUrl ?? null,
        tiktokConnectedAt: new Date(),
      },
    });
    creatorInfoCache = null;
    logAudit(req, "SETTINGS_UPDATE", "Settings", "tiktok", { action: "connected", username: info.creatorUsername ?? null });
    res.redirect(back({ tiktok: "ok" }));
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("tiktok", `Подключение аккаунта TikTok не удалось: ${reason}`);
    res.redirect(back({ tiktok: "error", reason: encodeURIComponent(reason).slice(0, 100) }));
  }
});
