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
 *    (одна строка в журнал ошибок; «клиент ждёт» людям говорит сторож молчания, со всеми своими правилами);
 *  - отказ ключа канала — остановка сразу, но ПРИВЯЗАННАЯ К ОТПЕЧАТКУ КЛЮЧА: переподключили аккаунт — отпечаток другой,
 *    и ближайший повтор (крон через ≤30 минут или кнопка) отвечает клиенту; ответственному — один сигнал на эпизод;
 *  - кнопка «Повторить зависшим» снимает остановку и счёт (resetAiRetryCap): решение человека важнее потолка.
 * Новая реплика клиента — новый ключ и новый счёт. «ИИ лежит» и обычный сбой отправки сюда не считаются: у них своя
 * лесенка и своя сдача (aiReplyRetryPolicy.ts, onGiveUp в aiReplyRetry.ts). Рубильник `botRetryCapEnabled` (ВКЛ).
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

const capStop = (base: string) => `${base}:stop`;
const keyStop = (base: string, keyFingerprint: string) => `${base}:stop-key:${keyFingerprint}`;

/** Повтор этой реплики остановлен: потолком или мёртвым ключом С ЭТИМ ЖЕ отпечатком (другой ключ — пробуем снова). */
export async function aiRetryStopped(base: string, keyFingerprint: string): Promise<boolean> {
  const row = await prisma.processedMessage.findFirst({
    where: { channel: LEDGER, messageId: { in: [capStop(base), keyStop(base, keyFingerprint)] } }, select: { id: true } });
  return !!row;
}

/** +1 пустой повтор этой реплики; true — потолок достигнут (повтор пора остановить). */
export async function noteAiRetryNoReply(base: string): Promise<boolean> {
  for (let run = 1; run <= AI_RETRY_NO_REPLY_CAP; run++) {
    if (await claim(`${base}:${run}`)) return run >= AI_RETRY_NO_REPLY_CAP;
  }
  return true;
}

/** Кнопка «Повторить зависшим»: снять остановки и счёт этих переписок (все их реплики). */
export async function resetAiRetryCap(conversationIds: readonly string[]): Promise<number> {
  let removed = 0;
  for (let i = 0; i < conversationIds.length; i += 100) {
    const chunk = conversationIds.slice(i, i + 100);
    const { count } = await prisma.processedMessage.deleteMany({
      where: { channel: LEDGER, OR: chunk.map((id) => ({ messageId: { startsWith: `${id}:` } })) } });
    removed += count;
  }
  return removed;
}

export type AiRetryStop =
  | { reason: "retry_cap" }
  | { reason: "channel_key_dead"; keyFingerprint: string };

/**
 * Остановить повтор реплики. Порядок устойчив к падению (ревью #423): сначала сигнал (одна дверь, один на эпизод
 * молчания — повтор вызова ничего не шлёт) и строка журнала (dedupKey на переписку), и только потом метка остановки.
 * Упали между ними — следующий повтор сделает то же самое, без второго сигнала.
 * Сигнал — только при мёртвом ключе: бот ответ подготовил, а уйти он не может, это техсбой. Пустые повторы людям не
 * сообщаем: «клиент ждёт ответа» говорит сторож молчания со своими правилами (выключатель, «бот отвечает сам», спам,
 * звонок агента, намеренное молчание). Клиенту ничего не отправляется. Никогда не бросает.
 */
export async function stopAiRetry(input: { conversationId: string; base: string; stop: AiRetryStop }): Promise<void> {
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
      `Повтор ответа бота остановлен (${input.conversationId}): ${keyDead ? "ключ канала не работает (повтор продолжится после переподключения аккаунта)" : `${AI_RETRY_NO_REPLY_CAP} пустых повтора`} — ИИ по этому сообщению больше не зовётся.`,
      { dedupKey: `ai-retry-stop:${input.conversationId}`, quietPult: true });
    await claim(input.stop.reason === "channel_key_dead" ? keyStop(input.base, input.stop.keyFingerprint) : capStop(input.base));
  } catch (error) {
    console.error("[ai-retry-cap] остановка повтора:", error instanceof Error ? error.message : "UnknownError");
  }
}
