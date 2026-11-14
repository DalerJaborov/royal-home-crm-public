import { prisma } from "../db.js";
import { sendPushToAgent } from "../push.js";
import { SPAM_MUTED_NO_REPLY, customerSpamMuteActive, customerSpamMuteFrom } from "../ai/customerSpamMute.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { fetchLastCallContactByClient } from "./botPauseWatch.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { logSystemError } from "./systemError.js";
import { reportCronRowError } from "./cronHeartbeat.js";

/**
 * «КЛИЕНТ НАПИСАЛ — ЕМУ НИКТО НЕ ОТВЕТИЛ» (14.11.2026, аудит скрытых механизмов №4).
 *
 * ЗАЧЕМ. Новое ядро бота держит часть сообщений без ответа (HELD) — по делу
 * (эхо своих сообщений, склейка подряд идущих) и не по делу: модель решила
 * «передать сотруднику», а передача не оформлена (`staff_or_supported_reply_required`),
 * сломался контекст, кончились круги. Клиенту в этих случаях — тишина, сотруднику —
 * ни сигнала: был только журнал трассировки. ФАКТ (прод, 7 дней до 14.11): 41 диалог
 * без ответа бота дольше 6 часов. Тот же исход у диалогов, где бот на паузе, а агент
 * не ответил (87 «вечных» пауз, где клиент написал последним).
 *
 * ОДНА ДВЕРЬ — `alertClientWaiting`. Её зовут два места:
 *   1. ядро бота сразу, когда модель выбрала «передать сотруднику», а ответа нет
 *      (lib/customerDmAgentTurn.ts, причины STAFF_NEEDED_NOW_REASONS);
 *   2. сторож `runClientSilenceSweep` (cron.ts, раз в 10 минут, только в часы
 *      раздачи): реплика клиента без ответа бота или человека дольше 30 минут —
 *      ловит ВСЕ остальные причины молчания, не перечисляя их.
 *
 * КОМУ. Закреплённому агенту (действующему) — пушем «Сообщения клиентов». Агента нет —
 * руководству через очередь тревог как СРОЧНОЕ (мимо часов алармов): без агента
 * отвечать должен бот, и раз он молчит, это сбой, а не чья-то медлительность.
 *
 * НЕ ЧАЩЕ ОДНОГО РАЗА НА ЭПИЗОД МОЛЧАНИЯ. Эпизод — от первой неотвеченной реплики
 * клиента до ответа. Клиент дописал ещё — эпизод тот же, второго сигнала нет; ему
 * ответили, а потом он снова остался без ответа — новый эпизод. Метка эпизода —
 * `BotConversation.silenceAlertFor`, ставится атомарно ДО отправки (двое не пройдут).
 *
 * ЧЕГО СТОРОЖ НЕ ТРОГАЕТ: молчание, выбранное намеренно (чужой ролик без вопроса,
 * спам, повтор вложения после нашего вопроса), отписавшихся, клиентов в корзине,
 * и случай, когда агент после реплики ПОЗВОНИЛ клиенту — разговор состоялся.
 */

/** Сколько клиент ждёт ответа, прежде чем сторож скажет человеку. */
export const CLIENT_WAITING_MINUTES = 30;
/** Глубже суток не смотрим: старое молчание — дело утреннего отчёта и сторожа пауз, а не пуша. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Предел выборки за тик (правило «у любой выборки есть предел»). */
const SWEEP_LIMIT = 300;

/** Ядро промолчало НАМЕРЕННО — это решение, а не сбой, человека не зовём. */
export const INTENTIONAL_SILENCE_REASONS: ReadonlySet<string> = new Set([
  "foreign_share_no_reply",
  SPAM_MUTED_NO_REPLY,
  "attachment_question_repeat_no_reply",
]);

/** Модель сама решила, что нужен сотрудник, а ответа клиенту нет — звать сразу, не ждать 30 минут. */
export const STAFF_NEEDED_NOW_REASONS: ReadonlySet<string> = new Set(["staff_or_supported_reply_required"]);

type StoredMessage = {
  role?: unknown;
  at?: unknown;
  silentCapture?: unknown;
  deliveryStatus?: unknown;
  customerPropertyAdmission?: { eventKey?: unknown } | null;
};

export interface WaitingEpisode {
  /** Первая неотвеченная реплика клиента — начало эпизода и его ключ. */
  since: Date;
  /** eventKey тикетов ядра у неотвеченных реплик (у старого бота их нет). */
  eventKeys: string[];
  /** Сколько неотвеченных реплик без тикета ядра (их намеренность не доказать). */
  untracked: number;
}

/**
 * Хвост неотвеченных реплик клиента. Чистая функция — проверяется без базы.
 *
 * Ответом считается любая ДОСТАВЛЕННАЯ реплика с нашей стороны — бот, агент из CRM,
 * сотрудник из приложения мессенджера. Реплика бота с `deliveryStatus: "failed"`
 * клиенту не дошла — молчание продолжается. Реплику клиента, записанную самим кодом
 * (`silentCapture`, тихий приём номера), клиент не писал — она не начинает эпизод.
 * Реплика без отметки времени (до 01.08.2026) начало доказать не может — нет эпизода.
 */
export function waitingEpisodeOf(messages: unknown): WaitingEpisode | null {
  if (!Array.isArray(messages)) return null;
  let since: Date | null = null;
  const eventKeys: string[] = [];
  let untracked = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as StoredMessage | null;
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant") {
      if (m.deliveryStatus === "failed") continue;
      break;
    }
    if (m.role !== "user" || m.silentCapture === true) continue;
    const at = typeof m.at === "string" ? new Date(m.at) : null;
    if (!at || Number.isNaN(at.getTime())) return null;
    since = at;
    const key = m.customerPropertyAdmission?.eventKey;
    if (typeof key === "string") eventKeys.push(key);
    else untracked++;
  }
  return since ? { since, eventKeys, untracked } : null;
}

export type ClientWaitingTrigger = "escalate" | "silence";
export type ClientWaitingOutcome = "agent" | "director" | "skipped";

const CHANNEL_NAME: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  WHATSAPP: "WhatsApp",
  TELEGRAM: "Telegram",
  WEBSITE: "чат сайта",
};

/**
 * ОДНА ДВЕРЬ: сказать ответственному, что клиент ждёт ответа. Идемпотентна по
 * эпизоду молчания: второй вызов на тот же эпизод (ядро + сторож, два тика)
 * ничего не шлёт.
 */
export async function alertClientWaiting(input: {
  conversationId: string;
  trigger: ClientWaitingTrigger;
  now?: Date;
}): Promise<ClientWaitingOutcome> {
  const now = input.now ?? new Date();
  const chat = await prisma.botConversation.findUnique({
    where: { id: input.conversationId },
    select: {
      id: true,
      name: true,
      channel: true,
      messages: true,
      optedOutAt: true,
      silenceAlertFor: true,
      client: {
        select: {
          fullName: true,
          deletedAt: true,
          assignedAgent: { select: { id: true, isActive: true } },
        },
      },
    },
  });
  if (!chat || chat.optedOutAt || chat.client?.deletedAt) return "skipped";
  const episode = waitingEpisodeOf(chat.messages);
  // Ядро держит ход ДО записи ответа, но реплика клиента к этому моменту уже в
  // истории; нет её (или нет времени) — для эскалации начало эпизода «сейчас».
  const since = episode?.since ?? (input.trigger === "escalate" ? now : null);
  if (!since) return "skipped";
  if (chat.silenceAlertFor && chat.silenceAlertFor.getTime() >= since.getTime()) return "skipped";

  // Атомарная метка эпизода ДО отправки: два одновременных вызова не пройдут оба.
  const previous = chat.silenceAlertFor;
  const claimed = await prisma.botConversation.updateMany({
    where: { id: chat.id, OR: [{ silenceAlertFor: null }, { silenceAlertFor: { lt: since } }] },
    data: { silenceAlertFor: since },
  });
  if (claimed.count !== 1) return "skipped";

  const name = chat.client?.fullName?.trim() || chat.name?.trim() || `клиент из ${CHANNEL_NAME[chat.channel] ?? chat.channel}`;
  const waitedMin = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000));
  const body =
    input.trigger === "escalate"
      ? `${name}: бот решил, что нужен сотрудник, и не ответил. Ответьте клиенту.`
      : `${name}: ждёт ответа в переписке ${waitedMin} мин. Ни бот, ни сотрудник не ответили.`;
  const url = `/messages?open=${chat.id}`;
  const tag = `client-waiting-${chat.id}`;
  const agent = chat.client?.assignedAgent?.isActive ? chat.client.assignedAgent.id : null;

  try {
    if (agent) {
      await sendPushToAgent(agent, { kind: "message", level: "CRITICAL", title: "💬 Клиент ждёт ответа", body, url, tag });
      return "agent";
    }
    const queued = await enqueueDirectorAlert({
      title: "💬 Клиент ждёт ответа, агента нет",
      body,
      url,
      kind: "message",
      level: "CRITICAL",
      severity: "critical",
      tag,
      recipientRoles: ["DIRECTOR", "ADMIN"],
    });
    if (!queued) throw new Error("очередь тревог руководству недоступна");
    return "director";
  } catch (err) {
    // Сигнал не ушёл — снимаем метку эпизода, следующий тик попробует снова.
    await prisma.botConversation
      .updateMany({ where: { id: chat.id, silenceAlertFor: since }, data: { silenceAlertFor: previous } })
      .catch(() => {});
    void logSystemError(
      "api",
      `Сигнал «клиент ждёт ответа» не отправлен: ${err instanceof Error ? err.message : String(err)}`,
      { dedupKey: "client-waiting-alert-failed" }
    );
    return "skipped";
  }
}

export interface ClientSilenceSweepResult {
  checked: number;
  alerted: number;
  skippedOffHours: boolean;
}

/**
 * СТОРОЖ МОЛЧАНИЯ — тик крона. Только в часы раздачи (то же окно, что у круга
 * лидов и у тихих часов пушей, lib/workingHours.ts): ночью отвечать некому, а
 * утренний первый тик подберёт ночные эпизоды.
 */
export async function runClientSilenceSweep(now: Date = new Date()): Promise<ClientSilenceSweepResult> {
  if (!(await isWithinWorkingHours(now))) return { checked: 0, alerted: 0, skippedOffHours: true };

  // Предвыборка в базе: последняя реплика — клиента (или недоставленный ответ бота),
  // переписка свежая, не отписан. Хвост и эпизод считает waitingEpisodeOf.
  const rows = await prisma.$queryRaw<
    Array<{ id: string; messages: unknown; leadDraft: unknown; silenceAlertFor: Date | null; clientId: string | null }>
  >`
    SELECT bc.id, bc.messages, bc."leadDraft", bc."silenceAlertFor", bc."clientId"
    FROM "BotConversation" bc
    LEFT JOIN "Client" c ON c.id = bc."clientId"
    WHERE bc."lastMessageAt" >= ${new Date(now.getTime() - LOOKBACK_MS)}
      AND bc."optedOutAt" IS NULL
      AND c."deletedAt" IS NULL
      AND jsonb_typeof(bc.messages) = 'array'
      AND jsonb_array_length(bc.messages) > 0
      AND (
        bc.messages -> -1 ->> 'role' = 'user'
        OR (bc.messages -> -1 ->> 'role' = 'assistant' AND bc.messages -> -1 ->> 'deliveryStatus' = 'failed')
      )
    -- Ещё ни разу не сигналившие — первыми: уже сказанное о прошлом эпизоде не должно
    -- вытеснить из предела новое молчание.
    ORDER BY (bc."silenceAlertFor" IS NOT NULL) ASC, bc."lastMessageAt" ASC
    LIMIT ${SWEEP_LIMIT}
  `;

  const threshold = now.getTime() - CLIENT_WAITING_MINUTES * 60_000;
  const due: Array<{ id: string; clientId: string | null; episode: WaitingEpisode }> = [];
  for (const row of rows) {
    const episode = waitingEpisodeOf(row.messages);
    if (!episode || episode.since.getTime() > threshold) continue;
    if (row.silenceAlertFor && row.silenceAlertFor.getTime() >= episode.since.getTime()) continue;
    const draft = row.leadDraft;
    const spam = draft && typeof draft === "object" && !Array.isArray(draft) ? (draft as Record<string, unknown>).spamMute : undefined;
    if (customerSpamMuteActive(customerSpamMuteFrom(spam), now)) continue;
    due.push({ id: row.id, clientId: row.clientId, episode });
  }
  if (due.length === 0) return { checked: rows.length, alerted: 0, skippedOffHours: false };

  // Намеренное молчание ядра: эпизод пропускаем, только если ВСЕ его реплики
  // удержаны намеренно. Одним запросом на пачку, не в цикле.
  const keys = [...new Set(due.flatMap((d) => d.episode.eventKeys))];
  const tickets = keys.length
    ? await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: keys } }, select: { eventKey: true, errorCode: true } })
    : [];
  const intentional = new Set(tickets.filter((t) => t.errorCode && INTENTIONAL_SILENCE_REASONS.has(t.errorCode)).map((t) => t.eventKey));
  // Звонок агента после первой неотвеченной реплики — разговор был, тоже одним запросом.
  const lastCall = await fetchLastCallContactByClient([...new Set(due.map((d) => d.clientId).filter((id): id is string => !!id))]);

  let alerted = 0;
  for (const d of due) {
    try {
      const allIntentional = d.episode.untracked === 0 && d.episode.eventKeys.every((k) => intentional.has(k));
      if (allIntentional) continue;
      const called = d.clientId ? lastCall.get(d.clientId) : undefined;
      if (called && called.getTime() > d.episode.since.getTime()) continue;
      const outcome = await alertClientWaiting({ conversationId: d.id, trigger: "silence", now });
      if (outcome !== "skipped") alerted++;
    } catch (err) {
      reportCronRowError("Сторож «клиент ждёт ответа»", d.id, err);
    }
  }
  return { checked: rows.length, alerted, skippedOffHours: false };
}
