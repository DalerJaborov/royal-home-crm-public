import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { instagramTokenIdentity } from "../messengers/meta.js";
import { resetAccountsCache } from "../messengers/accounts.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { logSystemError } from "./systemError.js";

/**
 * СТОРОЖ НИКОВ INSTAGRAM (10.11.2026).
 *
 * Ядро клиентского бота узнаёт наши собственные аккаунты во входящем по нику и
 * держит ВСЁ входящее Instagram, пока хотя бы у одного аккаунта Instagram ник
 * пуст (lib/customerIngressClassification.ts, `instagramComplete` →
 * HELD `own_identity_registry_incomplete`). Так и случилось: Arvan Estate
 * подключили 07.11 без ника, и с 08.11 по 10.11 бот молча не ответил в 23
 * диалогах всех трёх аккаунтов — ни строки в журнале, ни пуша.
 *
 * Два слоя:
 *   1. `fillMissingInstagramIdentities` — спрашивает Meta «чей маркер» и
 *      дописывает пустые ник и идентификатор личных сообщений (Meta отдаёт их
 *      тем же запросом). Самопочинка без человека.
 *   2. `reportHeldOwnIdentityTickets` — если ядро всё равно держит тикеты по этой
 *      причине, строка в журнале и CRITICAL-пуш директору, раз в сутки.
 */

const CALL_TIMEOUT_MS = 5_000;
const DAY = 24 * 60 * 60_000;
/** За какой срок смотрим задержанные тикеты: дольше крона, короче суток. */
export const HELD_LOOKBACK_MS = 6 * 60 * 60_000;
export const OWN_IDENTITY_HELD_REASON = "own_identity_registry_incomplete";
export const OWN_IDENTITY_ALERT_TAG = "ig-own-identity-registry-incomplete";

export async function fillMissingInstagramIdentities(): Promise<{ filled: number; failed: number }> {
  const rows = await prisma.messengerAccount.findMany({
    where: { channel: "INSTAGRAM", OR: [{ username: null }, { username: "" }, { messagingId: null }] },
    select: { id: true, title: true, token: true, username: true, messagingId: true },
    take: 50,
  });
  let filled = 0;
  let failed = 0;
  for (const row of rows) {
    const needsName = !row.username?.trim();
    const token = decryptSecretSafe(row.token);
    if (!token) {
      if (needsName) failed++;
      continue;
    }
    const identity = await instagramTokenIdentity(token, CALL_TIMEOUT_MS);
    if (!identity.ok) {
      if (needsName) {
        failed++;
        await logSystemError("meta", `Instagram «${row.title}»: ник не подтянут из Meta (${identity.error}).`, {
          dedupKey: `ig-identity-fill-failed:${row.id}`,
        });
      }
      continue;
    }
    const patch: { username?: string; messagingId?: string } = {};
    if (needsName && identity.username?.trim()) patch.username = identity.username.trim();
    if (!row.messagingId && identity.messagingId) patch.messagingId = identity.messagingId;
    if (Object.keys(patch).length === 0) {
      if (needsName) failed++;
      continue;
    }
    await prisma.messengerAccount.update({ where: { id: row.id }, data: patch });
    filled++;
  }
  if (filled > 0) resetAccountsCache();
  return { filled, failed };
}

/** Сколько входящих ядро держит из-за пустого ника — с `since`. */
export function countHeldOwnIdentityTickets(since: Date): Promise<number> {
  return prisma.customerPropertyIngressTicket.count({
    where: { processingState: "HELD", errorCode: OWN_IDENTITY_HELD_REASON, receivedAt: { gte: since } },
  });
}

export async function reportHeldOwnIdentityTickets(
  now: Date = new Date(),
  countHeld: (since: Date) => Promise<number> = countHeldOwnIdentityTickets,
): Promise<{ held: number; alerted: boolean }> {
  const held = await countHeld(new Date(now.getTime() - HELD_LOOKBACK_MS));
  if (held === 0) return { held, alerted: false };
  const missing = await prisma.messengerAccount.findMany({
    where: { channel: "INSTAGRAM", OR: [{ username: null }, { username: "" }] },
    select: { title: true },
    take: 20,
  });
  const names = missing.map((m) => `«${m.title}»`).join(", ") || "не найден (проверьте ники аккаунтов)";
  await logSystemError(
    "ai",
    `Бот не отвечает в Instagram: ${held} входящих задержаны, потому что у аккаунта Instagram пуст ник: ${names}. ` +
      `Пока ник пуст, бот молчит во ВСЕХ аккаунтах Instagram. Впишите ник в Настройках → Каналы или переподключите аккаунт.`,
    { dedupKey: OWN_IDENTITY_ALERT_TAG, dedupWindowMs: DAY },
  );
  const already = await prisma.pendingDirectorAlert.findFirst({
    where: { tag: OWN_IDENTITY_ALERT_TAG, createdAt: { gte: new Date(now.getTime() - DAY) } },
    select: { id: true },
  });
  if (already) return { held, alerted: false };
  await enqueueDirectorAlert({
    title: "Бот молчит в Instagram — клиенты без ответа",
    body: `У аккаунта Instagram пуст ник (${names}). Настройки → Каналы.`,
    url: "/settings?tab=channels",
    level: "CRITICAL",
    tag: OWN_IDENTITY_ALERT_TAG,
    recipientRoles: ["DIRECTOR", "ADMIN"],
  });
  return { held, alerted: true };
}

/** Тик крона: сначала самопочинка, потом — тревога, если держим всё равно. */
export async function runInstagramIdentityGuard(now: Date = new Date()) {
  const fill = await fillMissingInstagramIdentities();
  const report = await reportHeldOwnIdentityTickets(now);
  return { ...fill, ...report };
}
