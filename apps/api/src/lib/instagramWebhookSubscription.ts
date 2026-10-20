import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { describeError, GRAPH_VERSION, instagramApiUrl, instagramRequest } from "../messengers/meta.js";
import { logSystemError } from "./systemError.js";

/**
 * ПОДПИСКА АККАУНТОВ INSTAGRAM НА НАШИ УВЕДОМЛЕНИЯ — ПРОВЕРКА И ПОЧИНКА (02.10.2026).
 *
 * Жалоба владельца: в «Диалогах» под фильтром «Royal Home Info» последние
 * переписки — 21 сентября, хотя в этот аккаунт пишут каждый день. Разбор базы
 * прода: с 17–21.09 по Royal Home Info не пришло НИ ОДНОГО события — ни личных
 * сообщений, ни комментариев, — а у Royal Home за те же дни 240 переписок. Ошибок
 * «неизвестный получатель» нет: письма не уходили в чужой аккаунт, они не
 * доходили до CRM вовсе. Так выглядит слетевшая у Meta подписка аккаунта на
 * уведомления приложения (`subscribed_apps`).
 *
 * Подписку CRM не ставила и не проверяла никогда: её включали руками в панели
 * Meta при подключении, и когда она пропала, этого не заметил никто, — клиенты
 * писали в пустоту одиннадцать дней. Теперь каждые несколько часов:
 *
 *   1. спрашиваем у Meta, на что подписан каждый включённый аккаунт;
 *   2. не хватает нужного (личные сообщения, комментарии) — подписываем заново,
 *      СОХРАНЯЯ всё, на что аккаунт уже был подписан (запрос заменяет список
 *      целиком, и урезать его нельзя);
 *   3. итог — в журнал: восстановили (чтобы владелец знал, что был пропуск) или
 *      не смогли (тогда нужно переподключить аккаунт в Настройках → Каналы).
 *
 * Отдельно — сторож тишины (findSilentInstagramAccounts): подписка может
 * числиться живой, а события всё равно не идти. Аккаунт, у которого раньше были
 * переписки, а за последние дни нет ни одной, пока соседний аккаунт работает, —
 * повод для строки в журнале, а не для одиннадцати дней тишины.
 */

/** Без этих событий аккаунт глух: личные сообщения, кнопки, переход с рекламы, комментарии. */
export const REQUIRED_INSTAGRAM_FIELDS = ["messages", "messaging_postbacks", "messaging_referral", "comments"] as const;

const CALL_TIMEOUT_MS = 10_000;

export type SubscriptionOutcome =
  | { status: "ok"; fields: string[]; appIds: string[] }
  | { status: "restored"; missing: string[]; fields: string[]; appIds: string[] }
  | { status: "failed"; error: string };

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 300);
  }
}

function errorText(status: number, body: unknown): string {
  const message =
    typeof body === "object" && body && "error" in body
      ? (body as { error?: { message?: string } }).error?.message
      : typeof body === "string"
        ? body
        : undefined;
  return `Meta ответила ${status}${message ? `: ${message}` : ""}`;
}

/** На что подписан аккаунт — список полей из ответа `GET /me/subscribed_apps`. */
export function parseSubscribedFields(body: unknown): string[] {
  const data = (body as { data?: Array<{ subscribed_fields?: unknown }> } | null)?.data;
  if (!Array.isArray(data)) return [];
  const fields = new Set<string>();
  for (const entry of data) {
    const list = entry?.subscribed_fields;
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      // Встречаются оба вида: строка и {name: "..."} — принимаем оба.
      const name = typeof f === "string" ? f : (f as { name?: unknown })?.name;
      if (typeof name === "string" && name) fields.add(name);
    }
  }
  return [...fields];
}

/** На какие приложения подписан аккаунт — `data[].id` из того же ответа. */
export function parseSubscribedAppIds(body: unknown): string[] {
  const data = (body as { data?: Array<{ id?: unknown }> } | null)?.data;
  if (!Array.isArray(data)) return [];
  return [...new Set(data.map((d) => d?.id).filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/** Проверить подписку одного маркера и, если чего-то не хватает, подписать заново. */
export async function ensureInstagramSubscription(token: string): Promise<SubscriptionOutcome> {
  try {
    const getReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/me/subscribed_apps`), token);
    const getRes = await fetch(getReq.url, { headers: getReq.headers, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    const getBody = await readJson(getRes);
    if (!getRes.ok) return { status: "failed", error: errorText(getRes.status, getBody) };

    const current = parseSubscribedFields(getBody);
    const appIds = parseSubscribedAppIds(getBody);
    const missing = REQUIRED_INSTAGRAM_FIELDS.filter((f) => !current.includes(f));
    if (missing.length === 0) return { status: "ok", fields: current, appIds };

    const fields = [...new Set([...current, ...REQUIRED_INSTAGRAM_FIELDS])];
    const postReq = instagramRequest(
      instagramApiUrl(`/${GRAPH_VERSION}/me/subscribed_apps?subscribed_fields=${encodeURIComponent(fields.join(","))}`),
      token
    );
    const postRes = await fetch(postReq.url, {
      method: "POST",
      headers: postReq.headers,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const postBody = await readJson(postRes);
    const success = (postBody as { success?: unknown } | null)?.success;
    if (!postRes.ok || success === false) return { status: "failed", error: errorText(postRes.status, postBody) };
    return { status: "restored", missing: [...missing], fields, appIds };
  } catch (err) {
    return { status: "failed", error: describeError(err) };
  }
}

/**
 * Пройти все включённые аккаунты Instagram. Каждый — сам по себе: отказ одного
 * не мешает проверить и починить второй.
 */
export async function checkInstagramSubscriptions(): Promise<{ ok: number; restored: number; failed: number }> {
  const rows = await prisma.messengerAccount.findMany({
    where: { channel: "INSTAGRAM", enabled: true },
    select: { id: true, title: true, token: true },
    take: 50,
  });
  const totals = { ok: 0, restored: 0, failed: 0 };
  const appsByAccount: Array<{ id: string; title: string; appIds: string[] }> = [];
  for (const row of rows) {
    const token = decryptSecretSafe(row.token);
    if (!token) continue;
    const outcome = await ensureInstagramSubscription(token);
    if (outcome.status !== "failed") appsByAccount.push({ id: row.id, title: row.title, appIds: outcome.appIds });
    if (outcome.status === "ok") {
      totals.ok++;
    } else if (outcome.status === "restored") {
      totals.restored++;
      await logSystemError(
        "meta",
        `Instagram «${row.title}»: подписка на уведомления дополнена (добавлено: ${outcome.missing.join(", ")}).`,
        { dedupKey: `ig-subscription-restored:${row.id}` }
      );
    } else {
      totals.failed++;
      await logSystemError(
        "meta",
        `Instagram «${row.title}»: не удалось проверить подписку на сообщения (${outcome.error}). ` +
          `Если письма в этот аккаунт не появляются в CRM — переподключите его в Настройках → Каналы.`,
        { dedupKey: `ig-subscription-failed:${row.id}` }
      );
    }
  }

  /**
   * АККАУНТЫ ПОДПИСАНЫ НА РАЗНЫЕ ПРИЛОЖЕНИЯ (02.10.2026, проверка на проде).
   *
   * У Royal Home Info подписка на `messages` была, а писем всё равно не было:
   * его подписка смотрела на ДРУГОЕ приложение Meta, чем у Royal Home, который
   * работает. События такого аккаунта уходят на адрес чужого приложения и до
   * CRM не доходят, и ни одной ошибки у нас при этом не появляется. Какое из
   * приложений «наше», отсюда не узнать — называем оба, решает человек.
   */
  const allApps = new Set(appsByAccount.flatMap((a) => a.appIds));
  if (allApps.size > 1) {
    const list = appsByAccount.map((a) => `«${a.title}» — ${a.appIds.join(", ") || "нет"}`).join("; ");
    await logSystemError(
      "meta",
      `Аккаунты Instagram подписаны на разные приложения Meta (${list}). Письма аккаунта, подписанного не на наше ` +
        `приложение, в CRM не приходят: подключите его заново в Настройках → Каналы маркером из того же приложения, что и рабочий.`,
      { dedupKey: "ig-subscription-app-mismatch" }
    );
  }
  return totals;
}

/** Сколько дней тишины у аккаунта считаем подозрительными. */
export const SILENCE_DAYS = 3;
/** Меньше переписок за всё время — аккаунт слишком тихий, чтобы судить по паузе. */
const SILENCE_MIN_HISTORY = 10;

/**
 * Аккаунты Instagram, которые замолчали, пока соседний работает.
 *
 * Условие нарочно трусливое: судим, только если у аккаунта было хотя бы
 * `SILENCE_MIN_HISTORY` переписок, а у другого аккаунта за те же дни новые
 * письма есть, — иначе тихие выходные выглядели бы поломкой.
 */
export async function findSilentInstagramAccounts(now: Date = new Date()): Promise<Array<{ id: string; title: string; lastAt: Date | null }>> {
  const since = new Date(now.getTime() - SILENCE_DAYS * 24 * 60 * 60 * 1000);
  const accounts = await prisma.messengerAccount.findMany({
    where: { channel: "INSTAGRAM", enabled: true },
    select: { id: true, title: true },
    take: 50,
  });
  if (accounts.length < 2) return [];
  const stats = await Promise.all(
    accounts.map(async (a) => {
      const [total, recent, last] = await Promise.all([
        prisma.botConversation.count({ where: { accountId: a.id } }),
        prisma.botConversation.count({ where: { accountId: a.id, lastMessageAt: { gte: since } } }),
        prisma.botConversation.findFirst({
          where: { accountId: a.id, lastMessageAt: { not: null } },
          orderBy: { lastMessageAt: "desc" },
          select: { lastMessageAt: true },
        }),
      ]);
      return { ...a, total, recent, lastAt: last?.lastMessageAt ?? null };
    })
  );
  const someoneActive = stats.some((s) => s.recent > 0);
  if (!someoneActive) return [];
  return stats
    .filter((s) => s.total >= SILENCE_MIN_HISTORY && s.recent === 0)
    .map((s) => ({ id: s.id, title: s.title, lastAt: s.lastAt }));
}

/** Тик крона: подписка + сторож тишины, итог — в журнал. */
export async function runInstagramSubscriptionWatch(): Promise<{ ok: number; restored: number; failed: number; silent: number }> {
  const totals = await checkInstagramSubscriptions();
  const silent = await findSilentInstagramAccounts();
  for (const s of silent) {
    const last = s.lastAt ? s.lastAt.toISOString().slice(0, 10) : "давно";
    await logSystemError(
      "meta",
      `Instagram «${s.title}»: новых писем нет с ${last}, хотя другой аккаунт получает сообщения. ` +
        `Похоже, Meta перестала присылать нам его события — проверьте аккаунт в Настройках → Каналы.`,
      { dedupKey: `ig-account-silent:${s.id}` }
    );
  }
  return { ...totals, silent: silent.length };
}
