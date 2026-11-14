// СВЕРКА ПЕРЕПИСОК СТРАНИЦЫ С META: сообщение, которое видно в Messenger
// Страницы, но не дошло до CRM, уходит человеку (15.11.2026).
//
// ЗАЧЕМ. Все сторожа молчания (clientWaitingAlert.ts, customerTurnSilence.ts)
// видят только то, что УЖЕ лежит в CRM. Сообщение, которое Meta не прислала
// вебхуком, для них не существует — клиенту тишина, сотруднику ни сигнала.
// ФАКТ (прод, 13–14.11, чтение Graph API): у Страницы «Arvan estate» за двое суток
// написали 8 человек, в CRM дошёл ОДИН — администратор приложения. Причина —
// у приложения базовый (не расширенный) доступ к Messenger, а Страница чужой
// компании: Meta шлёт вебхук только про людей с ролью в приложении. Ещё один
// путь той же потери — сообщение, оборвавшееся на перезапуске (13.11 12:30,
// фото в Messenger Royal Home).
//
// ЧТО ДЕЛАЕТ. Раз в 10 минут читает последние переписки каждой подключённой
// Страницы (Graph API, только чтение, бесплатно) и сверяет входящие сообщения
// с тем, что CRM получила (ProcessedMessage по mid, лента BotConversation).
// Mid в Graph и в вебхуке совпадает (ФАКТ, сверено на проде 15.11). Не дошедшее
// старше GRACE_MS — один пуш на человека «Ответьте вручную в Meta Business
// Suite» всем, кто читает переписки, и строка в журнале на Страницу.
//
// ЧЕГО НЕ ДЕЛАЕТ. Не пишет клиенту, не запускает бота, не создаёт переписку в
// CRM (ответить из CRM такому человеку Meta всё равно не даст, пока нет
// расширенного доступа). Отметка «уже сказали» — строка ProcessedMessage
// канала `meta-inbox-missed` на mid (живёт 3 дня, как остальные отметки).
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { GRAPH_VERSION } from "../messengers/metaGraph.js";
import { sendPushToAgents } from "../push.js";
import { findAgentsWithPermission } from "./recipients.js";
import { logSystemError } from "./systemError.js";

/** Пока вебхук мог ещё не дойти или бот ждёт склейки сообщений — не тревожим. */
export const GRACE_MS = 5 * 60_000;
/** Глубже не смотрим: старое — дело разовой сверки со «да» владельца, не пуша. */
export const LOOKBACK_MS = 3 * 60 * 60_000;
const CONVERSATIONS_PER_PAGE = 25;
const MESSAGES_PER_CONVERSATION = 10;
const FETCH_TIMEOUT_MS = 15_000;
const CLAIM_CHANNEL = "meta-inbox-missed";

export interface PageInbox {
  pageId: string;
  title: string;
  token: string;
}

export interface InboxMessage {
  mid: string;
  createdAt: Date;
  /** Page-scoped id собеседника — тот же, что subscriberId в BotConversation. */
  fromId: string;
  fromName: string | null;
  text: string;
}

/** Ответ Graph `/{page}/conversations` с вложенными сообщениями (только нужные поля). */
interface GraphConversations {
  data?: Array<{
    messages?: { data?: Array<{ id?: string; created_time?: string; message?: string; from?: { id?: string; name?: string } }> };
  }>;
  error?: { code?: number; error_subcode?: number; message?: string };
}

/**
 * Входящие от людей (не от самой Страницы) в окне [now-lookback, now-grace].
 * Чистая функция — проверяется без сети и базы.
 */
export function incomingFromGraph(pageId: string, body: GraphConversations, now: Date,
  window: { graceMs: number; lookbackMs: number } = { graceMs: GRACE_MS, lookbackMs: LOOKBACK_MS }): InboxMessage[] {
  const out: InboxMessage[] = [];
  const newest = now.getTime() - window.graceMs;
  const oldest = now.getTime() - window.lookbackMs;
  for (const conversation of body.data ?? []) {
    for (const m of conversation.messages?.data ?? []) {
      const fromId = m.from?.id;
      if (!m.id || !m.created_time || !fromId || fromId === pageId) continue;
      const createdAt = new Date(m.created_time);
      const at = createdAt.getTime();
      if (Number.isNaN(at) || at > newest || at < oldest) continue;
      out.push({ mid: m.id, createdAt, fromId, fromName: m.from?.name?.trim() || null, text: (m.message ?? "").trim() });
    }
  }
  return out;
}

/** Все Страницы Facebook, у которых есть ключ: из Настроек и из «Каналов». Одна Страница — один раз. */
export async function listFacebookPageInboxes(): Promise<PageInbox[]> {
  const pages = new Map<string, PageInbox>();
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaPageToken: true, metaPageId: true } });
  const settingsId = settings?.metaPageId || process.env.META_PAGE_ID;
  const settingsToken = decryptSecretSafe(settings?.metaPageToken ?? null) || process.env.META_PAGE_TOKEN;
  const accounts = await prisma.messengerAccount.findMany({
    where: { channel: "FACEBOOK", enabled: true },
    select: { externalId: true, title: true, token: true },
  });
  for (const account of accounts) {
    const token = decryptSecretSafe(account.token);
    if (token) pages.set(account.externalId, { pageId: account.externalId, title: account.title, token });
  }
  if (settingsId && settingsToken && !pages.has(settingsId)) pages.set(settingsId, { pageId: settingsId, title: "Страница Facebook", token: settingsToken });
  return [...pages.values()];
}

export type GraphFetch = (url: string) => Promise<{ json(): Promise<unknown> }>;

const defaultFetch: GraphFetch = (url) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

export async function fetchPageInbox(page: PageInbox, fetchImpl: GraphFetch = defaultFetch): Promise<GraphConversations> {
  const fields = `messages.limit(${MESSAGES_PER_CONVERSATION}){id,created_time,message,from}`;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(page.pageId)}/conversations` +
    `?platform=messenger&limit=${CONVERSATIONS_PER_PAGE}&fields=${encodeURIComponent(fields)}` +
    `&access_token=${encodeURIComponent(page.token)}`;
  const response = await fetchImpl(url);
  return (await response.json()) as GraphConversations;
}

/** Какие из mid CRM получила: отметка вебхука или реплика в ленте переписки. */
export async function knownMessageIds(messages: readonly InboxMessage[]): Promise<Set<string>> {
  if (!messages.length) return new Set();
  const mids = [...new Set(messages.map((m) => m.mid))];
  const peers = [...new Set(messages.map((m) => m.fromId))];
  const marks = await prisma.processedMessage.findMany({
    where: { channel: "FACEBOOK", messageId: { in: mids } },
    select: { messageId: true },
  });
  const known = new Set(marks.map((m) => m.messageId));
  const inChats = await prisma.$queryRaw<Array<{ mid: string }>>`
    SELECT DISTINCT m.elem ->> 'mid' AS "mid"
    FROM "BotConversation" c,
      jsonb_array_elements(CASE WHEN jsonb_typeof(c."messages")='array' THEN c."messages" ELSE '[]'::jsonb END) AS m(elem)
    WHERE c."channel"='FACEBOOK' AND c."subscriberId" = ANY(${peers}::text[]) AND m.elem ->> 'mid' = ANY(${mids}::text[])`;
  for (const row of inChats) if (row.mid) known.add(row.mid);
  return known;
}

/** Текст ошибки без ключа: адрес запроса к Graph содержит access_token. */
export function withoutToken(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/access_token=[^&\s"']+/gi, "access_token=***").slice(0, 300);
}

/** Атомарно: true — этот mid ещё никому не показывали (двое не пройдут). */
async function claimMissed(mid: string): Promise<boolean> {
  const claimed = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
    VALUES (${randomUUID()},${CLAIM_CHANNEL},${mid},now(),now()) ON CONFLICT ("channel","messageId") DO NOTHING`;
  return claimed === 1;
}

export interface MetaInboxReconcileResult {
  pages: number;
  missed: number;
  people: number;
  failedPages: number;
}

/** Тик крона. Никогда не бросает: сбой одной Страницы — строка в журнале, остальные сверяются. */
export async function runMetaInboxReconcile(now: Date = new Date(), fetchImpl: GraphFetch = defaultFetch): Promise<MetaInboxReconcileResult> {
  const result: MetaInboxReconcileResult = { pages: 0, missed: 0, people: 0, failedPages: 0 };
  let pages: PageInbox[];
  try {
    pages = await listFacebookPageInboxes();
  } catch (err) {
    void logSystemError("meta", `Сверка переписок Страниц не запустилась: ${withoutToken(err)}`,
      { dedupKey: "meta-inbox-reconcile-failed" });
    return result;
  }
  let recipients: string[] | null = null;
  for (const page of pages) {
    result.pages++;
    try {
      const body = await fetchPageInbox(page, fetchImpl);
      if (body.error) {
        result.failedPages++;
        // Код и подкод — без текста запроса: в адресе был ключ Страницы.
        void logSystemError("meta", `Сверка переписок: Meta не отдала переписки Страницы «${page.title}» ` +
          `(код ${body.error.code ?? "?"}/${body.error.error_subcode ?? "-"}). Не дошедшие до CRM сообщения этой Страницы сейчас не видны никому.`,
          { dedupKey: `meta-inbox-read-failed:${page.pageId}`, dedupWindowMs: 6 * 60 * 60_000 });
        continue;
      }
      const incoming = incomingFromGraph(page.pageId, body, now);
      const known = await knownMessageIds(incoming);
      const missed = incoming.filter((m) => !known.has(m.mid));
      if (!missed.length) continue;
      // Один пуш на человека за тик, даже если он написал пять сообщений подряд.
      const byPerson = new Map<string, InboxMessage[]>();
      for (const m of missed) {
        if (!(await claimMissed(m.mid))) continue;
        byPerson.set(m.fromId, [...(byPerson.get(m.fromId) ?? []), m]);
      }
      if (!byPerson.size) continue;
      result.missed += [...byPerson.values()].reduce((n, list) => n + list.length, 0);
      result.people += byPerson.size;
      recipients ??= await findAgentsWithPermission("messages.view");
      for (const [fromId, list] of byPerson) {
        list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        const last = list[list.length - 1]!;
        const name = last.fromName ?? "Клиент";
        const excerpt = last.text ? `«${last.text.slice(0, 120)}»` : "вложение без текста";
        if (recipients.length) {
          await sendPushToAgents(recipients, {
            kind: "message",
            level: "CRITICAL",
            title: `Ответьте вручную: ${name} (Facebook «${page.title}»)`,
            body: `${excerpt}${list.length > 1 ? ` и ещё ${list.length - 1}` : ""}. Сообщение не дошло до CRM, бот его не видел. ` +
              `Ответьте в Meta Business Suite (business.facebook.com) → «Входящие» Страницы.`,
            // Ссылка внутри CRM: колокольчик открывает только свои адреса. Где отвечать — сказано в тексте.
            url: "/messages",
            tag: `meta-inbox-missed-${page.pageId}-${fromId}`,
          });
        }
      }
      void logSystemError("meta",
        `Страница «${page.title}»: ${byPerson.size} чел. написали в Messenger, а до CRM сообщения не дошли — бот их не видел, ` +
          `сотрудникам ушёл пуш «Ответьте вручную». Частая причина — у приложения нет расширенного доступа к Messenger ` +
          `(Meta доставляет только людей с ролью в приложении): нужна проверка приложения (App Review).`,
        { dedupKey: `meta-inbox-missed:${page.pageId}`, dedupWindowMs: 6 * 60 * 60_000 });
    } catch (err) {
      result.failedPages++;
      void logSystemError("meta", `Сверка переписок Страницы «${page.title}» оборвалась: ${withoutToken(err)}`,
        { dedupKey: `meta-inbox-reconcile-page-failed:${page.pageId}`, dedupWindowMs: 6 * 60 * 60_000 });
    }
  }
  return result;
}
