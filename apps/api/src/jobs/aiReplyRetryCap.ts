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
 * за сутки, три переписки по 31–35 раз каждая. Хуже того, отказ ключа канала (HTTP 401, код 190) считался обычной
 * неудачей отправки: лесенка до 46 попыток, и каждая заново звала ИИ ради ответа, который не может уйти.
 *
 * ЧТО ТЕПЕРЬ. Счёт — на РЕПЛИКЕ КЛИЕНТА, в базе (тот же приём, что у прогонов ядра, customerChannelCore.ts
 * `channel-core-run`): строки `ProcessedMessage` с каналом `ai-retry-no-reply`, ключ = переписка + реплика + номер.
 * Ни новое задание, ни кнопка «Повторить зависшим» счёт не обнуляют; строки стареют вместе с таблицей (3 дня,
 * webhookDedupe.ts) — дольше любого окна повтора (выборка «зависших» — только сегодняшние).
 *  - пустой повтор (ответа нет, ошибки нет) — +1; на AI_RETRY_NO_REPLY_CAP-м повтор этой реплики останавливается;
 *  - отказ ключа канала — остановка сразу;
 *  - остановлено — следующее задание по этой же реплике завершается сразу: без ИИ, без записи в трассу.
 * Новая реплика клиента — новый ключ и новый счёт. «ИИ лежит» и обычный сбой отправки сюда не считаются: у них своя
 * лесенка и своя сдача (aiReplyRetryPolicy.ts, onGiveUp в aiReplyRetry.ts) — авария поставщика переживается, как раньше.
 * Рубильник `botRetryCapEnabled` (Настройки → автоматика, ВКЛ).
 */
export const AI_RETRY_NO_REPLY_CAP = 3;
const LEDGER = "ai-retry-no-reply";

/** Ключ счёта: переписка + последняя реплика клиента. null — реплики нет (тогда и потолка нет: повторять нечего). */
export function aiRetryLedgerBase(conversationId: string, messages: unknown): string | null {
  const message = channelCoreMessageKey(messages);
  return message ? `${conversationId}:${message}` : null;
}

async function claim(messageId: string): Promise<boolean> {
  const inserted = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
    VALUES (${randomUUID()},${LEDGER},${messageId},now(),now()) ON CONFLICT ("channel","messageId") DO NOTHING`;
  return inserted === 1;
}

/** Повтор этой реплики уже остановлен. */
export async function aiRetryStopped(base: string): Promise<boolean> {
  const row = await prisma.processedMessage.findFirst({ where: { channel: LEDGER, messageId: `${base}:stop` }, select: { id: true } });
  return !!row;
}

/** +1 пустой повтор этой реплики; true — потолок достигнут (повтор пора остановить). */
export async function noteAiRetryNoReply(base: string): Promise<boolean> {
  for (let run = 1; run <= AI_RETRY_NO_REPLY_CAP; run++) {
    if (await claim(`${base}:${run}`)) return run >= AI_RETRY_NO_REPLY_CAP;
  }
  return true;
}

export type AiRetryStopReason = "retry_cap" | "channel_key_dead";

/**
 * Остановить повтор реплики. Ровно один раз на реплику (атомарная метка `:stop`): одна строка в журнал ошибок на
 * переписку (dedupKey) и сигнал ответственному через общую дверь «клиент без ответа» — если молчание не намеренное
 * (ядро удержало ход по правилу: спасибо, реакция, дубль — человека не зовём). Клиенту ничего не отправляется.
 * Никогда не бросает: остановка не должна ронять задание.
 */
export async function stopAiRetry(input: { conversationId: string; base: string; reason: AiRetryStopReason; messages: unknown }): Promise<void> {
  try {
    if (!(await claim(`${input.base}:stop`))) return;
    const why = input.reason === "channel_key_dead"
      ? "Meta не принимает ключ канала (переподключите аккаунт в Настройках → Каналы), ответ не ушёл"
      : `бот ${AI_RETRY_NO_REPLY_CAP} раза пробовал ответить на это сообщение и не смог`;
    await logSystemError("ai",
      `Повтор ответа бота остановлен (${input.conversationId}): ${input.reason === "channel_key_dead" ? "ключ канала не работает" : `${AI_RETRY_NO_REPLY_CAP} пустых повтора`} — клиенту ничего не отправлено, ИИ больше не зовётся.`,
      { dedupKey: `ai-retry-stop:${input.conversationId}`, quietPult: true });
    const { alertClientWaiting, conversationSilenceIntended } = await import("../lib/clientWaitingAlert.js");
    if (await conversationSilenceIntended(input.messages)) return;
    await alertClientWaiting({ conversationId: input.conversationId, trigger: "failed", why });
  } catch (error) {
    console.error("[ai-retry-cap] остановка повтора:", error instanceof Error ? error.message : "UnknownError");
  }
}
