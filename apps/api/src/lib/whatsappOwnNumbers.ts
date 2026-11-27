/**
 * НАШИ НОМЕРА WHATSAPP — ОДНА ДВЕРЬ (27.11.2026).
 *
 * Собеседник в WhatsApp — это номер телефона. Чтобы бот не отвечал НАШЕМУ ЖЕ номеру
 * (петля двух ботов, как у двух Instagram 16.08.2026 — см. ownAccountGuard.ts), нужно
 * знать номера всех наших аккаунтов WhatsApp цифрами. У Meta номер аккаунта приходит
 * только как `metadata.display_phone_number` в вебхуке ЭТОГО номера, а хранили мы лишь
 * phone_number_id (Settings.metaWaPhoneId, MessengerAccount.externalId).
 *
 * Пока номер был один, хватало получателя из самого сообщения. 26.11.2026 в 14:16 UTC
 * подключили второй номер («Арван», строка MessengerAccount), и проверка ядра
 * (customerIngressClassification.ts) стала держать БЕЗ ОТВЕТА каждое сообщение основного
 * номера — номера «Арвана» она не знала (own_phone_identity_unavailable, 18 клиентов).
 *
 * Здесь — реестр `WhatsappOwnNumber` (phone_number_id → цифры) и три способа его
 * заполнить, все сами, без человека:
 *   1. подписанный вебхук: metadata каждого события нашего номера (learnFromWebhook);
 *   2. подключение номера кнопкой (metaWhatsappConnect.ts → rememberWhatsappOwnNumber);
 *   3. если нужного номера всё ещё нет — один запрос к Meta `GET /{phone_number_id}
 *      ?fields=display_phone_number` ключом этого номера (whatsappOwnNumberLookup.ts).
 * Записываются только НАШИ phone_number_id (Настройки или строка канала): тестовый номер
 * песочницы, подписанный тем же секретом, в реестр не попадает.
 */
import { prisma, type TxClient } from "../db.js";
import { logSystemError } from "./systemError.js";

type ReadDb = Pick<TxClient, "$queryRaw">;
export type WhatsappOwnNumberSource = "webhook" | "connect" | "graph";

/** Номер цифрами с кодом страны (8–15 цифр, E.164) или null. */
export function whatsappOwnDigits(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/[+\s().-]/g, "");
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

export type WhatsappOwnRegistry = {
  /** Строки канала WHATSAPP (включённые и выключенные). */
  accounts: Array<{ id: string; externalId: string; enabled: boolean }>;
  /** phone_number_id → цифры. */
  digits: Map<string, string>;
};

/** Чтение без кэша: проверка ядра на отказе базы обязана упасть в HOLD, а не «никого не знаем». */
export async function readWhatsappOwnRegistry(db: ReadDb): Promise<WhatsappOwnRegistry> {
  const accounts = await db.$queryRaw<Array<{ id: string; externalId: string; enabled: boolean }>>`
    SELECT "id","externalId","enabled" FROM "MessengerAccount" WHERE "channel"='WHATSAPP' ORDER BY "id" LIMIT 129`;
  const rows = await db.$queryRaw<Array<{ phoneNumberId: string; digits: string }>>`
    SELECT "phoneNumberId","digits" FROM "WhatsappOwnNumber" ORDER BY "phoneNumberId" LIMIT 129`;
  if (accounts.length > 128 || rows.length > 128) throw new Error("WhatsApp own number registry unavailable");
  return { accounts, digits: new Map(rows.map(row => [row.phoneNumberId, row.digits])) };
}

/**
 * Какие наши номера должны быть известны цифрами, чтобы узнать «пишет наш же номер»:
 * основной из Настроек и каждый ВКЛЮЧЁННЫЙ номер-строка, кроме самого получателя (его
 * цифры есть в сообщении). Выключенный номер не отвечает и не пишет — его не ждём, но
 * если цифры известны, они всё равно считаются своими.
 */
export function requiredOtherWhatsappNumbers(registry: WhatsappOwnRegistry, installedPhoneId: string | null, recipient: string): string[] {
  return [...new Set([installedPhoneId, ...registry.accounts.filter(a => a.enabled).map(a => a.externalId)])]
    .filter((id): id is string => !!id && id !== recipient);
}

let cache: { at: number; ours: Set<string>; digits: Map<string, string> } | null = null;
const CACHE_MS = 60_000;
export function resetWhatsappOwnNumbersCache(): void { cache = null; }

async function cached(): Promise<{ ours: Set<string>; digits: Map<string, string> }> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const [settings, registry] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaWaPhoneId: true } }),
    readWhatsappOwnRegistry(prisma),
  ]);
  const ours = new Set(registry.accounts.map(a => a.externalId));
  if (settings?.metaWaPhoneId) ours.add(settings.metaWaPhoneId);
  cache = { at: Date.now(), ours, digits: registry.digits };
  return cache;
}

/** Цифры всех наших номеров WhatsApp (кэш на минуту) — для защиты старого бота. Отказ базы — пустое множество. */
export async function knownWhatsappOwnDigits(): Promise<Set<string>> {
  try { return new Set((await cached()).digits.values()); } catch { return new Set(); }
}

/** Записать пару «наш phone_number_id → цифры». Не наш id — не пишется. Возвращает, изменилось ли что-то. */
export async function rememberWhatsappOwnNumber(phoneNumberId: string, rawDigits: unknown, source: WhatsappOwnNumberSource,
  options: { trusted?: boolean } = {}): Promise<boolean> {
  const digits = whatsappOwnDigits(rawDigits);
  if (!phoneNumberId || !digits) return false;
  const known = await cached();
  if (known.digits.get(phoneNumberId) === digits) return false;
  if (!options.trusted && !known.ours.has(phoneNumberId)) {
    // Состав аккаунтов мог поменяться минуту назад (подключили номер): перечитать один раз.
    resetWhatsappOwnNumbersCache();
    if (!(await cached()).ours.has(phoneNumberId)) return false;
  }
  const changed = await prisma.$executeRaw`INSERT INTO "WhatsappOwnNumber" ("phoneNumberId","digits","source","updatedAt")
    VALUES (${phoneNumberId},${digits},${source},now())
    ON CONFLICT ("phoneNumberId") DO UPDATE SET "digits"=EXCLUDED."digits","source"=EXCLUDED."source","updatedAt"=now()
    WHERE "WhatsappOwnNumber"."digits" IS DISTINCT FROM EXCLUDED."digits"`;
  resetWhatsappOwnNumbersCache();
  return changed > 0;
}

/**
 * Подписанный вебхук WhatsApp: у каждого `changes[].value.metadata` есть phone_number_id и
 * display_phone_number НАШЕГО номера (и у сообщений, и у статусов отправки). Ничего не
 * бросает: сбой здесь не должен стоить Meta ответа 503.
 */
export async function learnWhatsappOwnNumbersFromWebhook(body: unknown): Promise<void> {
  try {
    const envelope = body && typeof body === "object" ? body as { object?: unknown; entry?: unknown } : null;
    if (envelope?.object !== "whatsapp_business_account" || !Array.isArray(envelope.entry)) return;
    const pairs = new Map<string, string>();
    for (const entry of envelope.entry.slice(0, 20)) {
      const changes = entry && typeof entry === "object" ? (entry as { changes?: unknown }).changes : null;
      if (!Array.isArray(changes)) continue;
      for (const change of changes.slice(0, 20)) {
        const metadata = (change as { value?: { metadata?: { phone_number_id?: unknown; display_phone_number?: unknown } } })?.value?.metadata;
        const id = typeof metadata?.phone_number_id === "string" ? metadata.phone_number_id : null;
        const digits = whatsappOwnDigits(metadata?.display_phone_number);
        if (id && digits) pairs.set(id, digits);
      }
    }
    for (const [id, digits] of [...pairs].slice(0, 8)) await rememberWhatsappOwnNumber(id, digits, "webhook");
  } catch (error) {
    void logSystemError("meta", `Номер WhatsApp из вебхука не записан: ${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: "whatsapp-own-number-learn-failed", quietPult: true });
  }
}
