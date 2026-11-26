import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { channelCoreMessageKey } from "../lib/customerMessageKey.js";
import { logSystemError } from "../lib/systemError.js";

/**
 * ПОТОЛОК ФОНОВОГО ПОВТОРА ОТВЕТА БОТА (разбор прода 24.11.2026).
 *
 * ЧТО БЫЛО. Крон «здоровье системы» (cron.ts, каждые 30 минут) ставит задание ai-reply-retry на каждую переписку, где
 * последняя реплика клиента без ответа. Задание проигрывает ход заново; если ответа нет по правилам (ход ведёт ядро,
 * аккаунт выключен, бот промолчал…), оно завершается УСПЕХОМ, а переписка остаётся «без ответа» — и через 30 минут крон
 * ставит новое задание. Счёт попыток жил в задании и умирал вместе с ним: Instagram 325 пустых повторов на 23 переписки
 * за сутки, три переписки по 31–35 раз каждая. Отказ ключа канала (HTTP 401, код 190) считался обычной неудачей
 * отправки: лесенка до 46 попыток, и каждая заново звала ИИ ради ответа, который не может уйти.
 *
 * ЧТО ТЕПЕРЬ. Счёт — на РЕПЛИКЕ КЛИЕНТА, в базе (тот же приём, что у прогонов ядра, customerChannelCore.ts
 * `channel-core-run`): строки `ProcessedMessage` с каналом `ai-retry-no-reply`, ключ = переписка + реплика + номер.
 * Новое задание крона счёт не обнуляет; строки стареют вместе с таблицей (3 дня, webhookDedupe.ts).
 *  - пустой повтор (ответа нет, ошибки нет) — +1; на AI_RETRY_NO_REPLY_CAP-м повтор этой реплики останавливается молча
 *    НА СРОК CAP_STOP_MS (одна строка в журнал ошибок; «клиент ждёт» людям говорит сторож молчания со своими правилами);
 *    после срока — одна новая попытка, снова пусто — ещё срок;
 *  - вердикт транспорта «ключ канала мёртв» (messengers/meta.ts → MetaGraphCallError.channelKeyDead) — остановка сразу,
 *    НА СРОК KEY_STOP_MS: ключ ожил или его переподключили — после срока повтор снова пробует (один ход ИИ на срок).
 *    Отпечаток ключа в метке — только для разбора (какой ключ отказал); снять остановку раньше срока может кнопка;
 *    ответственному — один сигнал на эпизод;
 *  - кнопка «Повторить зависшим» снимает остановки и счёт (resetAiRetryCap); остановку, которую допишет задание,
 *    начатое ДО нажатия, метка сброса перекрывает (сравнение по времени начала задания).
 * Новая реплика клиента — новый ключ и новый счёт. «ИИ лежит» и обычный сбой отправки сюда не считаются: у них своя
 * лесенка и своя сдача (aiReplyRetryPolicy.ts, onGiveUp в aiReplyRetry.ts). Рубильник `botRetryCapEnabled` (ВКЛ).
 */
export const AI_RETRY_NO_REPLY_CAP = 3;
/** Сколько держится остановка по мёртвому ключу: минутный 401 не должен глушить переписку на весь день. */
export const KEY_STOP_MS = 2 * 60 * 60 * 1000;
/** Сколько держится остановка после трёх пустых повторов: дольше рабочего дня не глушим (аккаунт включили, ход освободился). */
export const CAP_STOP_MS = 6 * 60 * 60 * 1000;
const LEDGER = "ai-retry-no-reply";

/** Ключ счёта: переписка + последняя реплика клиента. null — реплики нет (тогда и потолка нет: повторять нечего). */
export function aiRetryLedgerBase(conversationId: string, messages: unknown): string | null {
  const message = channelCoreMessageKey(messages);
  return message ? `${conversationId}:${message}` : null;
}

async function claim(messageId: string, at: Date = new Date()): Promise<boolean> {
  const inserted = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
    VALUES (${randomUUID()},${LEDGER},${messageId},${at},now()) ON CONFLICT ("channel","messageId") DO NOTHING`;
  return inserted === 1;
}

const capStop = (base: string) => `${base}:stop`;
const keyStopPrefix = (base: string) => `${base}:stop-key:`;
const resetMark = (conversationId: string) => `${conversationId}:reset`;
const conversationOf = (base: string) => base.slice(0, base.indexOf(":"));

/** Повтор этой реплики остановлен: потолком не дольше CAP_STOP_MS назад или мёртвым ключом не дольше KEY_STOP_MS назад,
 *  и после последнего нажатия кнопки. */
export async function aiRetryStopped(base: string, now: Date = new Date()): Promise<boolean> {
  const rows = await prisma.processedMessage.findMany({
    where: { channel: LEDGER, OR: [
      { messageId: capStop(base), createdAt: { gte: new Date(now.getTime() - CAP_STOP_MS) } },
      { messageId: { startsWith: keyStopPrefix(base) }, createdAt: { gte: new Date(now.getTime() - KEY_STOP_MS) } },
      { messageId: resetMark(conversationOf(base)) },
    ] }, select: { messageId: true, createdAt: true } });
  const reset = rows.find((r) => r.messageId === resetMark(conversationOf(base)))?.createdAt.getTime() ?? 0;
  return rows.some((r) => r.messageId !== resetMark(conversationOf(base)) && r.createdAt.getTime() > reset);
}

/** +1 пустой повтор этой реплики; true — потолок достигнут (повтор пора остановить). */
export async function noteAiRetryNoReply(base: string): Promise<boolean> {
  for (let run = 1; run <= AI_RETRY_NO_REPLY_CAP; run++) {
    if (await claim(`${base}:${run}`)) return run >= AI_RETRY_NO_REPLY_CAP;
  }
  return true;
}

/** Кнопка «Повторить зависшим»: снять остановки и счёт этих переписок (все их реплики) и поставить метку сброса. */
export async function resetAiRetryCap(conversationIds: readonly string[], now: Date = new Date()): Promise<number> {
  let removed = 0;
  for (let i = 0; i < conversationIds.length; i += 100) {
    const chunk = conversationIds.slice(i, i + 100);
    const { count } = await prisma.processedMessage.deleteMany({
      where: { channel: LEDGER, OR: chunk.map((id) => ({ messageId: { startsWith: `${id}:` } })) } });
    removed += count;
    for (const id of chunk) await claim(resetMark(id), now);
  }
  return removed;
}

/**
 * НОВЫЙ КЛЮЧ АККАУНТА — ОСТАНОВКИ «КЛЮЧ МЁРТВ» СНИМАЮТСЯ (25.11.2026). Остановка по мёртвому ключу держится KEY_STOP_MS
 * (2 часа); человек, нажавший «Заменить маркер», ждал бы ответа клиентам до двух часов. Снимаем только остановки по
 * ключу (счёт пустых повторов и остановки потолком не трогаем) у переписок этого аккаунта за последние 3 суток (столько
 * живут строки счёта, webhookDedupe.ts). Повтор поставит крон health-automation в ближайшие 30 минут. Не бросает.
 */
export async function releaseAiRetryKeyStops(accountId: string, now: Date = new Date()): Promise<number> {
  try {
    const conversations = await prisma.botConversation.findMany({
      where: { accountId, lastMessageAt: { gte: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000) } },
      select: { id: true }, take: 2000,
    });
    let removed = 0;
    for (let i = 0; i < conversations.length; i += 100) {
      const chunk = conversations.slice(i, i + 100);
      const { count } = await prisma.processedMessage.deleteMany({
        where: { channel: LEDGER, messageId: { contains: ":stop-key:" }, OR: chunk.map((c) => ({ messageId: { startsWith: `${c.id}:` } })) } });
      removed += count;
    }
    return removed;
  } catch (error) {
    console.error("[ai-retry-cap] снятие остановок по ключу:", error instanceof Error ? error.message : "UnknownError");
    return 0;
  }
}

export type AiRetryStop =
  | { reason: "retry_cap" }
  | { reason: "channel_key_dead"; keyFingerprint: string };

/**
 * Остановить повтор реплики. Порядок устойчив к падению (ревью #423): сначала сигнал (одна дверь, один на эпизод
 * молчания — повтор вызова ничего не шлёт) и строка журнала (dedupKey на переписку), и только потом метка остановки.
 * Упали между ними — следующий повтор сделает то же самое, без второго сигнала. Метка датируется НАЧАЛОМ задания
 * (`startedAt`): нажатие кнопки посреди задания её перекрывает.
 * Сигнал — только при мёртвом ключе: бот ответ подготовил, а уйти он не может, это техсбой. Пустые повторы людям не
 * сообщаем: «клиент ждёт ответа» говорит сторож молчания со своими правилами. Клиенту ничего не отправляется. Не бросает.
 */
export async function stopAiRetry(input: { conversationId: string; base: string; stop: AiRetryStop; startedAt: Date }): Promise<void> {
  try {
    const keyDead = input.stop.reason === "channel_key_dead";
    if (keyDead) {
      const { alertClientWaiting } = await import("../lib/clientWaitingAlert.js");
      // Агенту нечего переподключать (прав нет): ему — ответить вручную; руководству о ключе говорит транспорт (channelKeyAlarm.ts).
      await alertClientWaiting({ conversationId: input.conversationId, trigger: "failed",
        // Дверь допишет «— клиент без ответа.» и подсказку, где ответить («Ответьте клиенту.»).
        why: "ответ бота не ушёл, ключ канала не работает (руководство об этом знает)" });
    }
    await logSystemError("ai",
      `Повтор ответа бота остановлен (${input.conversationId}): ${keyDead ? "ключ канала не работает (через 2 часа повтор попробует снова)" : `${AI_RETRY_NO_REPLY_CAP} пустых повтора (через 6 часов одна новая попытка)`} — ИИ по этому сообщению сейчас не зовётся.`,
      { dedupKey: `ai-retry-stop:${input.conversationId}`, quietPult: true });
    // Снова пусто (снова мёртв) после срока — срок продлевается: иначе устаревшая метка разрешала бы ход ИИ каждые 30 минут.
    const messageId = input.stop.reason === "channel_key_dead" ? `${keyStopPrefix(input.base)}${input.stop.keyFingerprint}` : capStop(input.base);
    await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
      VALUES (${randomUUID()},${LEDGER},${messageId},${input.startedAt},now())
      ON CONFLICT ("channel","messageId") DO UPDATE SET "createdAt" = GREATEST("ProcessedMessage"."createdAt", EXCLUDED."createdAt")`;
  } catch (error) {
    console.error("[ai-retry-cap] остановка повтора:", error instanceof Error ? error.message : "UnknownError");
  }
}
