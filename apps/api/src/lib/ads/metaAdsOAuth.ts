import { randomBytes } from "node:crypto";
import { decryptSecretSafe, encryptSecret } from "../../crypto.js";
import { prisma } from "../../db.js";
import { fetchWithRetry } from "../../messengers/meta.js";
import { ADS_GRAPH_VERSION } from "./adsGraphVersion.js";
import { crmPublicBase } from "../crmPublicUrl.js";
import { scopesForRequest } from "../tokenScopes.js";
import { agentCanWriteAds } from "./adsWriteAccess.js";

/**
 * ПОДКЛЮЧЕНИЕ РЕКЛАМНОГО КАБИНЕТА ОДНОЙ КНОПКОЙ.
 *
 * Зачем, если маркер можно вставить руками: потому что вставить руками — нельзя.
 * 20.08.2026 владелец час не мог перенести маркер из Graph API Explorer в Настройки:
 * не работал буфер обмена. Маркер — это 200 символов, которые не наберёшь с клавиатуры,
 * и вся затея с отчётом по рекламе упёрлась не в код, а в Ctrl+C.
 *
 * Здесь тот же обмен, что делает Explorer, только выполняет его CRM: человек жмёт
 * кнопку, подтверждает доступ в окне Facebook и возвращается обратно — маркер
 * оказывается в Настройках, минуя буфер обмена, глаза и мессенджеры (куда его иначе
 * пересылают, а это худший способ хранения ключа из возможных).
 *
 * ЗАЩИТА. Кнопку нажимает авторизованный сотрудник с правом вести финансы: адрес
 * выдаёт POST /ads/connect, и вместе с ним — одноразовый `state`. Facebook возвращает
 * его в /ads/callback, и без совпадения обмен не делается: иначе чужая ссылка в
 * почте могла бы подсунуть нам маркер постороннего кабинета.
 */

/** Сколько живёт неиспользованный state. Больше нескольких минут человеку не нужно. */
const STATE_TTL_MS = 10 * 60 * 1000;

interface PendingState {
  agentId: string;
  expiresAt: number;
}

/**
 * Ожидающие подтверждения запросы. В памяти процесса, а не в базе: перезапуск API
 * во время подтверждения — редкость, а цена ей — повторное нажатие кнопки. Заводить
 * ради этого таблицу и миграцию не стоит.
 */
const pending = new Map<string, PendingState>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, value] of pending) if (value.expiresAt < now) pending.delete(key);
}

export interface MetaAppCredentials {
  appId: string;
  appSecret: string;
}

async function loadAppCredentials(): Promise<MetaAppCredentials | null> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaAppId: true, metaAppSecret: true },
  });
  const appId = s?.metaAppId?.trim() || process.env.META_APP_ID || "";
  const appSecret = decryptSecretSafe(s?.metaAppSecret ?? null) || process.env.META_APP_SECRET || "";
  return appId && appSecret ? { appId, appSecret } : null;
}

/** Куда Facebook вернёт человека после подтверждения. Должен совпадать с адресом,
 *  вписанным в настройках приложения Meta, символ в символ. */
export function adsRedirectUri(): string | null {
  const base = crmPublicBase();
  return base ? `${base}/api/v1/ads/callback` : null;
}

export class MetaAdsConnectError extends Error {}

/** Адрес окна Facebook, куда отправляем человека. */
export async function buildConnectUrl(agentId: string): Promise<string> {
  const app = await loadAppCredentials();
  if (!app) {
    throw new MetaAdsConnectError(
      "Не заполнены номер приложения Meta и его секрет — без них Facebook не с кем разговаривать"
    );
  }
  const redirectUri = adsRedirectUri();
  if (!redirectUri) {
    throw new MetaAdsConnectError("Не задан публичный адрес CRM (CRM_PUBLIC_URL) — Facebook некуда возвращать ответ");
  }

  sweepExpired();
  const state = randomBytes(24).toString("hex");
  pending.set(state, { agentId, expiresAt: Date.now() + STATE_TTL_MS });

  const params = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    // Только чтение статистики. Права управлять рекламой не просим сознательно:
    // маркер, который умеет тратить деньги, не должен лежать в CRM ради отчёта.
    // Список — общий для всех маркеров (lib/tokenScopes.ts), по нему же суточная
    // проверка говорит, чего маркеру не хватает.
    scope: scopesForRequest("META_ADS", ","),
  });
  return `https://www.facebook.com/${ADS_GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

/**
 * Обмен кода на маркер и сохранение. Возвращает true, если маркер сохранён.
 *
 * Делает два шага подряд: код → короткий маркер → 60-дневный. Второй обмен здесь же,
 * а не «потом кроном»: маркер из первого шага живёт час-два, и отложить продление
 * значит гарантированно проспать его.
 */
export async function completeConnect(code: string, state: string): Promise<void> {
  sweepExpired();
  const entry = pending.get(state);
  if (!entry) throw new MetaAdsConnectError("Подтверждение просрочено или уже использовано — нажмите кнопку заново");
  pending.delete(state);

  // Право проверяется ЗАНОВО, а не только при выдаче state: между нажатием кнопки
  // и возвратом от Facebook роль могли сменить на «только просмотр» или отключить
  // учётку, а колбэк без нашего токена не проходит requireAuth (lib/ads/adsWriteAccess.ts).
  if (!(await agentCanWriteAds(entry.agentId))) {
    throw new MetaAdsConnectError("Подключать рекламу может только сотрудник с правом «Вести расходы» или маркетинг");
  }

  const app = await loadAppCredentials();
  const redirectUri = adsRedirectUri();
  if (!app || !redirectUri) throw new MetaAdsConnectError("Приложение Meta не настроено");

  const shortLived = await exchange({
    client_id: app.appId,
    client_secret: app.appSecret,
    redirect_uri: redirectUri,
    code,
  });

  let token = shortLived;
  try {
    token = await exchange({
      grant_type: "fb_exchange_token",
      client_id: app.appId,
      client_secret: app.appSecret,
      fb_exchange_token: shortLived,
    });
  } catch {
    // 60-дневный не выдали — работаем на коротком: отчёт соберётся сейчас, а
    // недельное продление (metaAdsToken.ts) попробует ещё раз само.
  }

  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      metaAdsToken: encryptSecret(token),
      metaAdsTokenRefreshedAt: new Date(),
      // Подключение через кнопку означает намерение включить — иначе человек
      // подтвердил доступ в Facebook и не понял, почему в CRM по-прежнему пусто.
      metaAdsEnabled: true,
    },
  });
}

async function exchange(params: Record<string, string>): Promise<string> {
  const url = `https://graph.facebook.com/${ADS_GRAPH_VERSION}/oauth/access_token?${new URLSearchParams(params).toString()}`;
  const res = await fetchWithRetry(url, { method: "GET" }, 15_000);
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
  if (!res.ok || !body.access_token) {
    throw new MetaAdsConnectError(body.error?.message ?? `Facebook ответил ${res.status}`);
  }
  return body.access_token;
}
