// БОТ САМ ДОГОНЯЕТ (27.11.2026, владелец: «раз и навсегда почини, чтобы бот сам догонял, лиды дособирались
// и всем доотвечали, чтобы мы даже не заметили»).
//
// Прод 27.11, 12:26–12:41 по Душанбе: сотрудник ответил клиенту руками, бот встал на паузу (10 минут или час),
// клиент тут же написал вопрос или номер. Ядро удержало ход (HELD, `original_context_changed`: пока пауза, ход
// не имеет права говорить), а после паузы ответить было уже нельзя — срок хода считался от получения сообщения
// (120 секунд). Старый повтор «зависших» (stuckConversations.ts) для переписок ядра ничего не делал: задание
// ai-reply-retry заканчивалось «полосой ядра» без ответа, раз в 30 минут, по кругу.
//
// Что делает этот сторож (раз в две минуты, крон worker):
//  1. Находит переписки ядра, где ПОСЛЕДНЕЕ принятое сообщение клиента удержано по причине из RESUMABLE,
//     модель на нём ещё не закреплялась, ответа нашей стороны после него нет, пауза закончилась, клиент не
//     просил не писать, переписку не взял агент по объекту, и сообщению меньше 23 часов (окно Meta — сутки).
//  2. ОДИН раз ставит билету "resumedAt" (CAS + триггер в базе: второй раз нельзя) и в той же транзакции
//     ставит задание customer-inbox-consume. Ход идёт обычным путём ядра со всеми его проверками, только
//     часы хода считаются от возобновления (customerTurnClock.ts). Удержанные рядом сообщения той же пачки
//     помечаются `newer_input_resumed`, и бот отвечает на всю пачку одним сообщением (customerDeferredInput.ts).
//  3. Возобновить нельзя (модель на ходе уже закреплялась: пин не продлевается никогда) — пауза только что
//     кончилась, а клиент ждёт: человек узнаёт через одну дверь «бот не ответил клиенту» (пока шла пауза,
//     эта дверь считала переписку отвеченной и молчала).
//
// Номера из таких сообщений попадают в карточку сторожем #497 (phoneLeadWatchdog.ts) и самим ходом ядра.
// Ничего не пишет клиенту сам: ответ — только ход ядра. Рубильник `botCatchUpEnabled` (ВКЛ).
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { logSystemError } from "./systemError.js";
import { NEWER_INPUT_RESUMED } from "./customerNewerInboxInput.js";
import { reportUnansweredCustomerTurn } from "./customerTurnSilence.js";

/** Причины удержания, после которых тот же ход можно честно пройти ещё раз: пауза или смена контекста
 *  (сотрудник ответил, пока шёл ход), сбой хранилища или очереди, смена версии ядра. Намеренное молчание
 *  (customerIntendedSilence.ts), спам, «не пишите мне» и брошенные ходы (customerTicketOrphanReasons.ts) — не здесь. */
export const CUSTOMER_TURN_RESUMABLE_REASONS: readonly string[] = [
  "original_context_changed",
  "current_artifact_revision_mismatch",
  "storage_unavailable",
  "consume_job_gave_up",
  "customer_core_unavailable",
  "context_deadline",
  "original_runtime_deadline",
  "expired",
];

/** Сколько переписок догоняем за один тик: остальное — следующему тику через две минуты. */
export const CATCH_UP_PER_TICK = 20;
/** Окно Meta на ответ — сутки; час запаса на сам ход и очередь. */
const MAX_AGE = "23 hours";
/** Моложе — не трогаем: удержанный ход мог ещё не закончить свои повторы (возобновление отложенного — через 15 с). */
const MIN_AGE = "1 minute";
/** Пачка сообщений, на которую отвечаем вместе (та же граница, что у customerDeferredInput.ts). */
const BURST = "10 minutes";
/** Пауза кончилась недавно — тогда и только тогда зовём человека по невозобновимому ходу (дальше — сторож #174). */
const PAUSE_JUST_ENDED = "30 minutes";

type Candidate = { eventKey: string; errorCode: string; conversationId: string; scopeKey: string; endpointScopeId: string; order: bigint;
  pinned: boolean };

/** Общая часть отбора: последнее принятое сообщение переписки ядра, удержано, без ответа нашей стороны. */
function unansweredLatestHeld(minAge: string): Prisma.Sql {
  return Prisma.sql`
    FROM "CustomerInquiry" i
    JOIN "CustomerPropertyIngressTicket" t ON t."eventKey" = i."lastAcceptedEventKey"
    JOIN "BotConversation" c ON c."id" = t."conversationId"
    WHERE i."closedAt" IS NULL
      AND t."processingState" = 'HELD' AND t."errorCode" = ANY(${[...CUSTOMER_TURN_RESUMABLE_REASONS]}::text[])
      AND t."intakeAgentRevisionId" IS NOT NULL AND t."tombstonedAt" IS NULL
      AND t."originVersion" = 1 AND t."payloadVersion" = 1 AND t."inputRecordedAt" IS NOT NULL
      AND t."managedOutputRecordedAt" IS NULL AND t."plannedAt" IS NULL
      AND t."conversationId" = t."originalConversationId"
      AND t."receivedAt" > now() - ${MAX_AGE}::interval AND t."receivedAt" < now() - ${minAge}::interval
      AND NOT EXISTS (SELECT 1 FROM "CustomerOutboxPart" p WHERE p."ticketEventKey" = t."eventKey")
      AND c."optedOutAt" IS NULL AND c."propertyChatAgentId" IS NULL
      AND (c."pausedUntil" IS NULL OR c."pausedUntil" <= now())
      -- После сообщения клиента наша сторона не говорила: последняя реплика — его собственная (не эхо сотрудника
      -- из телефона с автором "by", не тихая запись системы).
      AND jsonb_typeof(c.messages) = 'array' AND jsonb_array_length(c.messages) > 0
      AND (c.messages -> -1 ->> 'role') = 'user' AND (c.messages -> -1 -> 'by') IS NULL
      AND COALESCE(c.messages -> -1 ->> 'silentCapture', 'false') <> 'true'`;
}

export interface CustomerCatchUpResult { resumed: number; reported: number }

/** Тик сторожа. Не бросает: сбой уходит в журнал одной строкой. */
export async function runCustomerTurnCatchUpTick(options: { minAge?: string } = {}): Promise<CustomerCatchUpResult> {
  const minAge = options.minAge ?? MIN_AGE;
  const result: CustomerCatchUpResult = { resumed: 0, reported: 0 };
  try {
    if (!(await automationSwitchOn("botCatchUpEnabled"))) return result;
    const resumable = await prisma.$queryRaw<Candidate[]>`
      SELECT t."eventKey", t."errorCode", t."conversationId", t."scopeKey", t."endpointScopeId", t."order", false AS "pinned"
      ${unansweredLatestHeld(minAge)}
        AND t."resumedAt" IS NULL AND t."agentRevisionId" IS NULL AND t."providerOperationId" IS NULL
      ORDER BY t."receivedAt" ASC LIMIT ${CATCH_UP_PER_TICK}`;
    for (const row of resumable) {
      if (await resumeHeldCustomerTurn(row)) result.resumed++;
    }
    // Пин хода уже был (модель закреплялась, ход сорвался) — второй ход того же сообщения невозможен по устройству
    // ядра. Пока шла пауза, «бот не ответил» молчал (переписка считалась отвеченной): пауза только что кончилась —
    // человек узнаёт сейчас. Дверь сама не шлёт второй сигнал на тот же эпизод молчания.
    const pinned = await prisma.$queryRaw<Candidate[]>`
      SELECT t."eventKey", t."errorCode", t."conversationId", t."scopeKey", t."endpointScopeId", t."order", true AS "pinned"
      ${unansweredLatestHeld(minAge)}
        AND t."agentRevisionId" IS NOT NULL
        AND c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now() - ${PAUSE_JUST_ENDED}::interval
      ORDER BY t."receivedAt" ASC LIMIT ${CATCH_UP_PER_TICK}`;
    for (const row of pinned) {
      await reportUnansweredCustomerTurn(row.eventKey, row.errorCode);
      result.reported++;
    }
  } catch (error) {
    void logSystemError("ai", `Бот не смог догнать неотвеченные сообщения после паузы: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      { dedupKey: "customer-turn-catch-up-failed", quietPult: true });
  }
  if (result.resumed > 0) console.log(`[cron] Бот догоняет: возобновлено ходов ${result.resumed}`);
  return result;
}

/**
 * Возобновляет ОДИН удержанный ход: часы хода с этого момента, соседние удержанные сообщения той же пачки — в слова
 * этого хода, задание очереди в той же транзакции. Второй вызов по тому же билету — false (CAS по "resumedAt" и
 * уникальный ключ задания). Не бросает.
 */
export async function resumeHeldCustomerTurn(row: Pick<Candidate, "eventKey" | "errorCode" | "scopeKey" | "endpointScopeId" | "order">): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Часы хода — часы сервера (new Date()), как и все сроки хода ядра (customerAgentRevision.ts), а не часы базы.
      const changed = await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "resumedAt" = ${new Date()}
        WHERE "eventKey" = ${row.eventKey} AND "resumedAt" IS NULL AND "processingState" = 'HELD' AND "errorCode" = ${row.errorCode}
          AND "agentRevisionId" IS NULL AND "providerOperationId" IS NULL AND "leaseOwner" IS NULL AND "tombstonedAt" IS NULL
          AND "receivedAt" > now() - ${MAX_AGE}::interval`;
      if (changed !== 1) return false;
      // Сообщения той же пачки (клиент написал три подряд, пока шла пауза) отвечаются ВМЕСТЕ с последним: ход ядра
      // несёт слова отложенных сообщений (customerDeferredInput.ts::loadCustomerBurst), сами они больше не ходят.
      await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket" d SET "errorCode" = ${NEWER_INPUT_RESUMED}
        WHERE d."scopeKey" = ${row.scopeKey} AND d."endpointScopeId" = ${row.endpointScopeId} AND d."order" < ${row.order}
          AND d."processingState" = 'HELD' AND d."errorCode" = ANY(${[...CUSTOMER_TURN_RESUMABLE_REASONS]}::text[])
          AND d."plannedAt" IS NULL AND d."tombstonedAt" IS NULL
          AND d."receivedAt" >= (SELECT n."receivedAt" FROM "CustomerPropertyIngressTicket" n WHERE n."eventKey" = ${row.eventKey}) - ${BURST}::interval
          AND NOT EXISTS (SELECT 1 FROM "CustomerOutboxPart" p WHERE p."ticketEventKey" = d."eventKey")
          AND NOT EXISTS (SELECT 1 FROM "CustomerPropertyIngressTicket" x WHERE x."scopeKey" = d."scopeKey"
            AND x."endpointScopeId" = d."endpointScopeId" AND x."order" > d."order" AND x."processingState" = 'PLANNED')`;
      await tx.backgroundJob.create({ data: { type: "customer-inbox-consume", payload: { version: 1, eventKey: row.eventKey },
        maxAttempts: 5, dedupeKey: `customer-inbox-catch-up:${row.eventKey}` } });
      return true;
    });
  } catch (error) {
    // Ключ задания уже занят (второй сторож в ту же секунду) — откат всей транзакции, ход не тронут: это не сбой.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    void logSystemError("ai", `Не удалось возобновить ход бота после паузы: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      { dedupKey: "customer-turn-catch-up-resume-failed", quietPult: true });
    return false;
  }
}
