/**
 * Цифры наших номеров WhatsApp, которых ещё нет в реестре (lib/whatsappOwnNumbers.ts), — у Meta.
 * Отдельным файлом: проверка ядра (customerIngressClassification.ts) читает реестр и не должна
 * тянуть за собой модуль запросов к Meta.
 */
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { metaGraphGet } from "./metaEternalTokens.js";
import { logSystemError } from "./systemError.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { readWhatsappOwnRegistry, rememberWhatsappOwnNumber, whatsappOwnDigits } from "./whatsappOwnNumbers.js";

const FETCH_BACKOFF_MS = 5 * 60_000;
const failedAt = new Map<string, number>();

/**
 * Узнать у Meta цифры тех наших номеров, которых нет в реестре (основной и включённые
 * строки). Ровно один GET на номер, ключом этого номера, с таймаутом запроса Meta; после
 * отказа тот же номер не спрашивается пять минут. Вызывается без открытой транзакции.
 * Возвращает, сколько номеров записано. Ничего не бросает.
 */
export async function fetchMissingWhatsappOwnNumbers(): Promise<number> {
  try {
    const [settings, accounts, registry] = await Promise.all([
      prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaWaPhoneId: true, metaWaToken: true } }),
      prisma.messengerAccount.findMany({ where: { channel: "WHATSAPP", enabled: true }, select: { externalId: true, token: true }, take: 32 }),
      readWhatsappOwnRegistry(prisma),
    ]);
    const candidates = [
      ...(settings?.metaWaPhoneId ? [{ id: settings.metaWaPhoneId, sealed: settings.metaWaToken }] : []),
      ...accounts.map(a => ({ id: a.externalId, sealed: a.token })),
    ].filter(c => !registry.digits.has(c.id) && Date.now() - (failedAt.get(c.id) ?? 0) > FETCH_BACKOFF_MS);
    let stored = 0;
    for (const candidate of candidates.slice(0, 8)) {
      const token = decryptSecretSafe(candidate.sealed ?? null);
      const reply = token ? await metaGraphGet(`/${encodeURIComponent(candidate.id)}?fields=display_phone_number`, token)
        : { ok: false as const, error: "нет ключа номера", auth: false };
      const digits = reply.ok ? whatsappOwnDigits(reply.data?.display_phone_number) : null;
      if (!digits) {
        failedAt.set(candidate.id, Date.now());
        void logSystemError("meta", `Номер WhatsApp ${candidate.id} не узнан у Meta: ${reply.ok ? "в ответе нет номера" : reply.error}. ` +
          `Пока он неизвестен, бот не отвечает клиентам WhatsApp другого нашего номера — проверьте ключ номера в Настройках → Каналы.`,
          { dedupKey: `whatsapp-own-number-fetch-failed:${candidate.id}` });
        continue;
      }
      if (await rememberWhatsappOwnNumber(candidate.id, digits, "graph", { trusted: true })) stored++;
    }
    return stored;
  } catch (error) {
    void logSystemError("meta", `Номера WhatsApp не прочитаны у Meta: ${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: "whatsapp-own-number-fetch-crashed" });
    return 0;
  }
}

export const WA_OWN_NUMBER_HELD_REASON = "own_phone_identity_unavailable";
export const WA_OWN_NUMBER_ALERT_TAG = "wa-own-number-unknown";
const HELD_LOOKBACK_MS = 6 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;

/**
 * Сторож (тик крона «instagram-identity-guard», тот же приём, что у ников Instagram —
 * lib/instagramIdentityGuard.ts): дописать неизвестные номера у Meta, а если ядро всё
 * равно держит сообщения WhatsApp по этой причине и номер так и не узнан — строка в
 * журнале и CRITICAL директору раз в сутки. 26.11 18 клиентов остались без ответа молча.
 */
export async function runWhatsappOwnNumberGuard(now: Date = new Date(),
  countHeld: (since: Date) => Promise<number> = since => prisma.customerPropertyIngressTicket.count({
    where: { processingState: "HELD", errorCode: WA_OWN_NUMBER_HELD_REASON, receivedAt: { gte: since } } }),
): Promise<{ fetched: number; held: number; alerted: boolean }> {
  const fetched = await fetchMissingWhatsappOwnNumbers();
  const held = await countHeld(new Date(now.getTime() - HELD_LOOKBACK_MS));
  if (!held) return { fetched, held, alerted: false };
  const [settings, accounts, registry] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaWaPhoneId: true } }),
    prisma.messengerAccount.findMany({ where: { channel: "WHATSAPP", enabled: true }, select: { externalId: true, title: true }, take: 32 }),
    readWhatsappOwnRegistry(prisma),
  ]);
  const missing = [
    ...(settings?.metaWaPhoneId && !registry.digits.has(settings.metaWaPhoneId) ? ["основной номер из Настроек"] : []),
    ...accounts.filter(a => !registry.digits.has(a.externalId)).map(a => `«${a.title}»`),
  ];
  // Номера уже известны — задержанные остались от прошлой поломки: тревога была бы ложной.
  if (!missing.length) return { fetched, held, alerted: false };
  await logSystemError("ai", `Бот не отвечает в WhatsApp: ${held} входящих задержаны, потому что CRM не знает номер ` +
    `${missing.join(", ")} цифрами и не может проверить, что пишет не наш же номер. Проверьте ключ номера в Настройках → Каналы.`,
    { dedupKey: WA_OWN_NUMBER_ALERT_TAG, dedupWindowMs: DAY });
  const already = await prisma.pendingDirectorAlert.findFirst({
    where: { tag: WA_OWN_NUMBER_ALERT_TAG, createdAt: { gte: new Date(now.getTime() - DAY) } }, select: { id: true } });
  if (already) return { fetched, held, alerted: false };
  await enqueueDirectorAlert({ title: "Бот молчит в WhatsApp — клиенты без ответа",
    body: `CRM не знает номер ${missing.join(", ")}. Настройки → Каналы.`, url: "/settings?tab=channels",
    level: "CRITICAL", severity: "critical", tag: WA_OWN_NUMBER_ALERT_TAG, recipientRoles: ["DIRECTOR", "ADMIN"] });
  return { fetched, held, alerted: true };
}
