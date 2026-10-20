import { decryptSecretSafe, encryptSecret } from "../../crypto.js";
import { prisma } from "../../db.js";
import { fetchWithRetry } from "../../messengers/meta.js";
import { ADS_GRAPH_VERSION } from "./adsGraphVersion.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";

/**
 * ЖИЗНЬ МАРКЕРА РЕКЛАМНОГО КАБИНЕТА.
 *
 * Маркер, который выдаёт Graph API Explorer, живёт час-два. Обменянный на
 * долгоживущий — 60 дней. Дальше он умирает молча: отчёт по рекламе просто
 * перестаёт обновляться, и заметить это можно только по тому, что цифры замерли.
 * Ровно так однажды замолчал WhatsApp на суточном маркере — поэтому здесь то же
 * лечение, что и у маркера Instagram (messengers/instagramFeed.ts): раз в неделю
 * продлеваем сами.
 *
 * ПОЧЕМУ НЕ СИСТЕМНЫЙ ПОЛЬЗОВАТЕЛЬ (у него маркер вечный и продлевать нечего):
 * рекламный кабинет агентства на 20.08.2026 личный (act_751587752930155,
 * «Ваш аккаунт» в Ads Manager), а системные пользователи существуют только внутри
 * бизнес-портфолио. Пока кабинет не переведён в портфолио Royal Home, вечный
 * маркер выписать физически негде.
 *
 * ОБМЕН ТРЕБУЕТ ПАРЫ «приложение + секрет» — оба берутся из Настроек (metaAppId,
 * metaAppSecret). Нет пары — обмен не делается, и это не ошибка: короткий маркер
 * работает, просто недолго, и владельца об этом предупреждает сам экран Настроек.
 */

/** Продлевать не чаще раза в неделю: маркер живёт 60 дней, запас огромный. */
const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const CALL_TIMEOUT_MS = 15_000;

interface AppCredentials {
  appId: string;
  appSecret: string;
}

export async function loadAppCredentials(): Promise<AppCredentials | null> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaAppId: true, metaAppSecret: true },
  });
  const appId = s?.metaAppId?.trim() || process.env.META_APP_ID || "";
  const appSecret = decryptSecretSafe(s?.metaAppSecret ?? null) || process.env.META_APP_SECRET || "";
  return appId && appSecret ? { appId, appSecret } : null;
}

/**
 * Обмен маркера на долгоживущий. Работает и с коротким (первый обмен), и с уже
 * долгим (продление) — у Facebook это одна и та же операция.
 *
 * @returns новый маркер или null, если обменять не удалось (пары приложение/секрет
 *          нет, Meta отказала).
 */
export async function exchangeForLongLivedToken(token: string): Promise<string | null> {
  const app = await loadAppCredentials();
  if (!app) return null;

  const url =
    `https://graph.facebook.com/${ADS_GRAPH_VERSION}/oauth/access_token` +
    `?grant_type=fb_exchange_token&client_id=${encodeURIComponent(app.appId)}` +
    `&client_secret=${encodeURIComponent(app.appSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(token)}`;

  const res = await fetchWithRetry(url, { method: "GET" }, CALL_TIMEOUT_MS);
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: { message?: string };
  };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return body.access_token;
}

/**
 * Продление по расписанию (cron, раз в сутки — сам решает, пора ли).
 * @returns true, если маркер действительно заменён.
 */
export async function refreshMetaAdsTokenIfDue(): Promise<boolean> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaAdsEnabled: true, metaAdsToken: true, metaAdsTokenRefreshedAt: true },
  });
  // Маркер из переменной окружения перезаписать всё равно некуда — продлеваем
  // только свой, из Настроек. Ровно та же оговорка, что у маркера Instagram.
  if (!settings?.metaAdsEnabled || !settings.metaAdsToken) return false;

  const last = settings.metaAdsTokenRefreshedAt?.getTime() ?? 0;
  if (Date.now() - last < REFRESH_EVERY_MS) return false;

  const current = decryptSecretSafe(settings.metaAdsToken);
  if (!current) return false;

  try {
    const fresh = await exchangeForLongLivedToken(current);
    if (!fresh) return false;
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { metaAdsToken: encryptSecret(fresh), metaAdsTokenRefreshedAt: new Date() },
    });
    return true;
  } catch (err) {
    void logSystemError("ads", `Маркер рекламного кабинета не продлён: ${describeError(err)}`);
    return false;
  }
}

/**
 * Сразу после того, как владелец вставил маркер в Настройки: меняем короткий
 * (из Graph API Explorer он живёт час-два) на 60-дневный.
 *
 * Тихая: провал обмена не отменяет сохранение. Короткий маркер тоже рабочий —
 * просто ненадолго, и лучше пусть отчёт соберётся сейчас, чем не соберётся вовсе.
 */
export async function upgradeStoredAdsToken(rawToken: string): Promise<boolean> {
  try {
    const fresh = await exchangeForLongLivedToken(rawToken);
    if (!fresh || fresh === rawToken) return false;
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { metaAdsToken: encryptSecret(fresh), metaAdsTokenRefreshedAt: new Date() },
    });
    return true;
  } catch (err) {
    void logSystemError(
      "ads",
      `Короткий маркер рекламного кабинета не удалось обменять на 60-дневный (${describeError(err)}). ` +
        `Отчёт соберётся, но маркер скоро истечёт — проверьте номер приложения и его секрет в Настройках.`
    );
    return false;
  }
}
