import { decryptSecretSafe, encryptSecret } from "../crypto.js";
import { prisma } from "../db.js";
import { fetchWithRetry } from "../messengers/meta.js";
import { ADS_GRAPH_VERSION } from "./ads/adsGraphVersion.js";
import { exchangeForLongLivedToken, loadAppCredentials } from "./ads/metaAdsToken.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";

/**
 * АВТОПРОДЛЕНИЕ МАРКЕРОВ FACEBOOK LOGIN (12.10.2026, владелец: «сделай автопродление 60 дней»).
 *
 * Маркер удаления Instagram (`metaIgManageToken`) и маркер Страницы (`metaPageToken`) выдаёт Facebook Login.
 * Пользовательский маркер из Graph API Explorer живёт час-два, обменянный - 60 дней, и умирает молча: «Снять из
 * соцсетей» вдруг оставляет Instagram «руками», публикация на Страницу перестаёт идти. Маркер Страницы, полученный
 * из долгоживущего пользовательского, и маркер системного пользователя бессрочны - им продление не нужно.
 *
 * ЧТО ДЕЛАЕМ. Раз в сутки спрашиваем у Meta, что это за маркер (`/debug_token`: тип, срок, жив ли). Пользовательский
 * маркер со сроком меньше REFRESH_WITHIN_DAYS дней обмениваем на новый 60-дневный той же операцией, что рекламный
 * (`exchangeForLongLivedToken`: для Facebook продление и первый обмен - одно и то же). Бессрочные не трогаем.
 * Недействительный маркер (сменили пароль, отозвали приложение) обменять нельзя - пишем в журнал, чтобы владелец
 * вставил новый, а не узнал по молчащему Instagram.
 *
 * ПОЧЕМУ БЕЗ НОВОЙ КОЛОНКИ «когда продлевали»: срок читаем у самой Meta, а не помним сами, - состояние не может
 * разойтись с реальностью. Нужна пара «приложение + секрет» из Настроек (как у рекламного маркера); без неё
 * ничего не делаем и не шумим.
 */

export type MetaUserTokenField = "metaIgManageToken" | "metaPageToken";

const FIELD_LABELS: Record<MetaUserTokenField, string> = {
  metaIgManageToken: "Маркер удаления Instagram",
  metaPageToken: "Маркер Страницы Facebook",
};

/** Продлеваем, когда до конца срока осталось меньше этого: ошибка одного суточного тика не успеет стоить маркера. */
const REFRESH_WITHIN_DAYS = 21;
const DAY_MS = 24 * 60 * 60 * 1000;
const CALL_TIMEOUT_MS = 15_000;

export interface MetaTokenInfo {
  valid: boolean;
  /** USER | PAGE | SYSTEM_USER | APP | неизвестное - как отдаёт Meta. */
  type: string | null;
  /** null - бессрочный (Meta отдаёт `expires_at: 0`). */
  expiresAt: Date | null;
  error: string | null;
}

/** Что Meta знает про маркер. null - не смогли спросить (нет пары приложение/секрет). */
export async function inspectMetaToken(token: string): Promise<MetaTokenInfo | null> {
  const app = await loadAppCredentials();
  if (!app) return null;
  // Секрет приложения уходит как `access_token=APP|SECRET` - так устроен /debug_token; адрес запроса нигде не логируем.
  const url =
    `https://graph.facebook.com/${ADS_GRAPH_VERSION}/debug_token` +
    `?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(`${app.appId}|${app.appSecret}`)}`;
  const res = await fetchWithRetry(url, { method: "GET" }, CALL_TIMEOUT_MS);
  const body = (await res.json().catch(() => ({}))) as {
    data?: { is_valid?: boolean; type?: string; expires_at?: number; error?: { message?: string } };
    error?: { message?: string };
  };
  if (!res.ok || !body.data) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  const d = body.data;
  const expires = typeof d.expires_at === "number" && d.expires_at > 0 ? new Date(d.expires_at * 1000) : null;
  return { valid: d.is_valid === true, type: d.type ?? null, expiresAt: expires, error: d.error?.message ?? null };
}

/** Нужно ли менять маркер: пользовательский, со сроком, и срок близок (или маркер уже короткий). */
export function needsRefresh(info: MetaTokenInfo, now: number = Date.now()): boolean {
  if (!info.valid || info.type !== "USER" || !info.expiresAt) return false;
  return info.expiresAt.getTime() - now < REFRESH_WITHIN_DAYS * DAY_MS;
}

interface Summary {
  refreshed: string[];
  failed: string[];
}

async function refreshField(field: MetaUserTokenField, stored: string, summary: Summary): Promise<void> {
  const label = FIELD_LABELS[field];
  const current = decryptSecretSafe(stored);
  if (!current) return;
  try {
    const info = await inspectMetaToken(current);
    if (!info) return;
    if (!info.valid) {
      summary.failed.push(label);
      void logSystemError(
        "meta",
        `${label} недействителен${info.error ? ` (${info.error})` : ""} — вставьте новый в Настройки → Каналы связи. Пока этого не сделано, связанные функции не работают.`,
        { dedupKey: `meta-token-invalid-${field}` }
      );
      return;
    }
    if (!needsRefresh(info)) return;
    const fresh = await exchangeForLongLivedToken(current);
    if (!fresh || fresh === current) return;
    // Условная запись: пока шёл обмен, владелец мог вставить новый маркер - его не затираем.
    const written = await prisma.settings.updateMany({ where: { id: "singleton", [field]: stored }, data: { [field]: encryptSecret(fresh) } });
    if (written.count === 1) summary.refreshed.push(label);
  } catch (err) {
    summary.failed.push(label);
    void logSystemError("meta", `${label} не продлён: ${describeError(err)}`, { dedupKey: `meta-token-refresh-${field}` });
  }
}

/** Суточный тик: пройти оба маркера. Сам решает, пора ли. */
export async function refreshMetaUserTokensIfDue(): Promise<Summary> {
  const summary: Summary = { refreshed: [], failed: [] };
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaIgManageToken: true, metaPageToken: true } });
  if (!settings) return summary;
  for (const field of ["metaIgManageToken", "metaPageToken"] as const) {
    const stored = settings[field];
    if (stored) await refreshField(field, stored, summary);
  }
  return summary;
}

/**
 * Сразу после того, как владелец вставил маркер: короткий (час-два) меняем на 60-дневный, пока он ещё на экране.
 * Тихая: провал не отменяет сохранение, суточный тик доделает.
 */
export async function upgradeStoredMetaUserToken(field: MetaUserTokenField): Promise<boolean> {
  const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaIgManageToken: true, metaPageToken: true } });
  const stored = row?.[field];
  if (!stored) return false;
  const summary: Summary = { refreshed: [], failed: [] };
  await refreshField(field, stored, summary);
  return summary.refreshed.length > 0;
}
