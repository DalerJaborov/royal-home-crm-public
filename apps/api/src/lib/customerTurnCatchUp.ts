// БОТ САМ ДОГОНЯЕТ (27.11.2026, владелец: «раз и навсегда почини, чтобы бот сам догонял, лиды дособирались
// и всем доотвечали, чтобы мы даже не заметили»).
//
// Прод 27.11, 12:26–12:41 по Душанбе: сотрудник ответил клиенту руками, бот встал на паузу (10 минут или час),
// клиент тут же написал вопрос или номер. Ядро удержало ход (HELD, `original_context_changed`: пока пауза, ход
// не имеет права говорить), а после паузы ответить было уже нельзя — срок хода считался от получения сообщения
// (120 секунд). Старый повтор «зависших» (stuckConversations.ts) для переписок ядра ничего не делал: задание
// ai-reply-retry заканчивалось «полосой ядра» без ответа, раз в 30 минут, по кругу.
//
// Как устроено:
//  1. Сторож (раз в две минуты, крон) находит переписки ядра, где ПОСЛЕДНЕЕ принятое сообщение клиента удержано по
//     причине из RESUMABLE, модель на нём ещё не закреплялась, ответа нашей стороны после него нет, пауза кончилась,
//     клиент не просил не писать, переписку не взял агент по объекту, и сообщению меньше 23 часов (окно Meta — сутки).
//     Ставит ОДНО задание customer-inbox-consume с пометкой resume (ключ задания на билет — второго не будет).
//  2. Задание, когда до него дошла очередь (у очереди ядра одно место, перед ним могут быть живые ходы), ещё раз
//     сверяет те же условия и только тогда ОДИН раз ставит билету "resumedAt" (CAS + триггер в базе). Часы хода —
//     с этого момента (customerTurnClock.ts), поэтому очередь перед заданием срок хода не съедает. Удержанные рядом
//     сообщения той же пачки помечаются `newer_input_resumed`: бот отвечает на всю пачку одним сообщением.
//     Дальше — обычный ход ядра со всеми его проверками.
//  3. Возобновить нельзя (модель на ходе уже закреплялась: пин не продлевается никогда) — пауза только что
//     кончилась, а клиент ждёт: человек узнаёт через одну дверь «бот не ответил клиенту» (пока шла пауза,
//     эта дверь считала переписку отвеченной и молчала).
//
// Номера из таких сообщений попадают в карточку сторожем #497 (phoneLeadWatchdog.ts) и самим ходом ядра.
// Ничего не пишет клиенту сам: ответ — только ход ядра. Рубильник `botCatchUpEnabled` (ВКЛ).
import { Prisma } from "../generated/prisma/client.js";
import { prisma, type TxClient } from "../db.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { logSystemError } from "./systemError.js";
import { NEWER_INPUT_RESUMED } from "./customerNewerInboxInput.js";
import { reportUnansweredCustomerTurn } from "./customerTurnSilence.js";

/** Причины удержания, после которых тот же ход можно честно пройти ещё раз: пауза или смена контекста
 *  (сотрудник ответил, пока шёл ход), сбой хранилища или очереди, смена версии ядра, просрочка. Намеренное молчание
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

/** Сколько догоняющих ходов ставим в очередь за один тик (ревью #503): у очереди ядра одно место, и живые клиенты не
 *  должны ждать за догоняющими. Один ход раз в две минуты. */
export const CATCH_UP_PER_TICK = 1;
/** Бот догоняет только сообщения не старше трёх часов (ревью #503). Старше — ответ бота звучал бы невпопад (пауза 12 ч
 *  после ответа с телефона, deliveryPause.ts; первый прогон после выката не трогает вчерашнее): такое без ответа идёт
 *  человеку через одну дверь «бот не ответил клиенту». */
export const CATCH_UP_MAX_AGE_HOURS = 3;
const CATCH_UP_MAX_AGE = `${CATCH_UP_MAX_AGE_HOURS} hours`;
/** До какого возраста зовём человека по сообщению, которое бот не догоняет: окно Meta на ответ — сутки. */
const REPORT_MAX_AGE = "23 hours";
/** Сколько невозобновимых ходов отдаём человеку за тик; дверь идемпотентна по эпизоду молчания. */
const REPORT_PER_TICK = 10;
/** Сколько раз задание пробует возобновить ход при сбое базы, прежде чем отдать человеку (customerInboxConsume.ts). */
export const CATCH_UP_MAX_ATTEMPTS = 5;
/** Моложе — не трогаем: удержанный ход мог ещё не закончить свои повторы (возобновление отложенного — через 15 с). */
const MIN_AGE = "1 minute";
/** Пачка сообщений, на которую отвечаем вместе (та же граница, что у customerDeferredInput.ts). */
const BURST = "10 minutes";
/** Пауза кончилась недавно — тогда и только тогда зовём человека по невозобновимому ходу: пока шла пауза, дверь «бот не
 *  ответил» считала переписку отвеченной и молчала; без паузы ядро позвало человека само в момент удержания. */
const PAUSE_JUST_ENDED = "30 minutes";

export const catchUpJobKey = (eventKey: string) => `customer-inbox-catch-up:${eventKey}`;

type Candidate = { eventKey: string; errorCode: string };

/** Последнее принятое сообщение переписки ядра, удержано, без ответа нашей стороны. Одно условие — для отбора
 *  сторожем и для сверки в момент возобновления, чтобы они не разъехались. */
function unansweredLatestHeld(minAge: string, maxAge: string): Prisma.Sql {
  return Prisma.sql`
    FROM "CustomerPropertyIngressTicket" t
    JOIN "CustomerInquiry" i ON i."lastAcceptedEventKey" = t."eventKey"
    JOIN "BotConversation" c ON c."id" = t."conversationId"
    WHERE i."closedAt" IS NULL
      AND t."processingState" = 'HELD' AND t."errorCode" = ANY(${[...CUSTOMER_TURN_RESUMABLE_REASONS]}::text[])
      AND t."intakeAgentRevisionId" IS NOT NULL AND t."tombstonedAt" IS NULL
      AND t."originVersion" = 1 AND t."payloadVersion" = 1 AND t."inputRecordedAt" IS NOT NULL
      AND t."managedOutputRecordedAt" IS NULL AND t."plannedAt" IS NULL AND t."leaseOwner" IS NULL
      AND t."conversationId" = t."originalConversationId"
      AND t."receivedAt" > now() - ${maxAge}::interval AND t."receivedAt" < now() - ${minAge}::interval
      AND NOT EXISTS (SELECT 1 FROM "CustomerOutboxPart" p WHERE p."ticketEventKey" = t."eventKey")
      AND c."optedOutAt" IS NULL AND c."propertyChatAgentId" IS NULL
      AND (c."pausedUntil" IS NULL OR c."pausedUntil" <= now())
      -- После сообщения клиента наша сторона не говорила: последняя реплика — его собственная (не эхо сотрудника
      -- из телефона с автором "by").
      AND jsonb_typeof(c.messages) = 'array' AND jsonb_array_length(c.messages) > 0
      AND (c.messages -> -1 ->> 'role') = 'user' AND (c.messages -> -1 -> 'by') IS NULL`;
}

export interface CustomerCatchUpResult { queued: number; reported: number }

/** Тик сторожа. Не бросает: сбой уходит в журнал одной строкой. */
export async function runCustomerTurnCatchUpTick(options: { minAge?: string; maxAge?: string } = {}): Promise<CustomerCatchUpResult> {
  const minAge = options.minAge ?? MIN_AGE, maxAge = options.maxAge ?? CATCH_UP_MAX_AGE;
  const result: CustomerCatchUpResult = { queued: 0, reported: 0 };
  try {
    if (!(await automationSwitchOn("botCatchUpEnabled"))) return result;
    const resumable = await prisma.$queryRaw<Candidate[]>`
      SELECT t."eventKey", t."errorCode"
      ${unansweredLatestHeld(minAge, maxAge)}
        AND t."resumedAt" IS NULL AND t."agentRevisionId" IS NULL AND t."providerOperationId" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "BackgroundJob" j WHERE j."dedupeKey" = 'customer-inbox-catch-up:' || t."eventKey")
      ORDER BY t."receivedAt" ASC LIMIT ${CATCH_UP_PER_TICK}`;
    for (const row of resumable) {
      try {
        // Один ключ на билет: два сторожа в ту же секунду ставят одно задание, второе — P2002 и пропуск.
        await prisma.backgroundJob.create({ data: { type: "customer-inbox-consume",
          payload: { version: 1, eventKey: row.eventKey, resume: true }, maxAttempts: CATCH_UP_MAX_ATTEMPTS, dedupeKey: catchUpJobKey(row.eventKey) } });
        result.queued++;
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      }
    }
    // Бот этот ход не догоняет: пин хода уже был (модель закреплялась — второй ход того же сообщения невозможен по
    // устройству ядра) или сообщение старше окна догоняния. Пока шла пауза, «бот не ответил» молчал (переписка
    // считалась отвеченной): пауза только что кончилась — человек узнаёт сейчас, а не молча никогда. Дверь сама не шлёт
    // второй сигнал на тот же эпизод (silenceAlertFor); такие переписки — в конце списка, чтобы очередь двигалась.
    const forHuman = await prisma.$queryRaw<Candidate[]>`
      SELECT t."eventKey", t."errorCode"
      ${unansweredLatestHeld(minAge, REPORT_MAX_AGE)}
        AND (t."agentRevisionId" IS NOT NULL OR t."receivedAt" <= now() - ${maxAge}::interval)
        AND c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now() - ${PAUSE_JUST_ENDED}::interval
      ORDER BY (c."silenceAlertFor" IS NOT NULL AND c."silenceAlertFor" >= COALESCE((
          SELECT max((m.elem ->> 'at')::timestamptz AT TIME ZONE 'UTC') FROM jsonb_array_elements(c.messages) m(elem)
          WHERE m.elem ->> 'role' = 'assistant' AND m.elem ->> 'at' IS NOT NULL), '-infinity'::timestamp)) ASC,
        t."receivedAt" ASC
      LIMIT ${REPORT_PER_TICK}`;
    for (const row of forHuman) {
      await reportUnansweredCustomerTurn(row.eventKey, row.errorCode);
      result.reported++;
    }
  } catch (error) {
    void logSystemError("ai", `Бот не смог догнать неотвеченные сообщения после паузы: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      { dedupKey: "customer-turn-catch-up-failed", quietPult: true });
  }
  if (result.queued > 0) console.log(`[cron] Бот догоняет: поставлено ходов ${result.queued}`);
  return result;
}

/** resumed — часы поставлены этим вызовом; not_eligible — условия изменились или ход уже возобновляли; failed — сбой базы
 *  (взаимная блокировка, обрыв): не то же самое, что «условия изменились», задание повторит попытку. */
export type CustomerResumeOutcome = "resumed" | "not_eligible" | "failed";

/**
 * Возобновляет ОДИН удержанный ход в момент, когда задание очереди до него дошло: те же условия ещё раз (сотрудник мог
 * ответить, пауза — встать снова, сообщение могло выйти из окна), часы хода с этого момента, соседние удержанные
 * сообщения той же пачки — в слова этого хода. Второй вызов по тому же билету — not_eligible (CAS и триггер в базе).
 * Не бросает: сбой — failed и строка в журнал.
 */
export async function resumeHeldCustomerTurn(eventKey: string): Promise<CustomerResumeOutcome> {
  if (!/^[a-f0-9]{64}$/.test(eventKey)) return "not_eligible";
  try {
    return await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<Candidate & { order: bigint; scopeKey: string; endpointScopeId: string }>>`
        SELECT t."eventKey", t."errorCode", t."order", t."scopeKey", t."endpointScopeId"
        ${unansweredLatestHeld("0 seconds", CATCH_UP_MAX_AGE)}
          AND t."eventKey" = ${eventKey} AND t."resumedAt" IS NULL AND t."agentRevisionId" IS NULL AND t."providerOperationId" IS NULL
        FOR UPDATE OF t`;
      if (!row) return "not_eligible" as const;
      // Часы хода — часы сервера (new Date()), как и все сроки хода ядра (customerAgentRevision.ts), а не часы базы.
      const changed = await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "resumedAt" = ${new Date()}
        WHERE "eventKey" = ${eventKey} AND "resumedAt" IS NULL AND "processingState" = 'HELD' AND "errorCode" = ${row.errorCode}
          AND "agentRevisionId" IS NULL AND "providerOperationId" IS NULL AND "leaseOwner" IS NULL`;
      if (changed !== 1) return "not_eligible" as const;
      await carryBurst(tx, row);
      return "resumed" as const;
    });
  } catch (error) {
    void logSystemError("ai", `Не удалось возобновить ход бота после паузы (задание повторит): ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      { dedupKey: "customer-turn-catch-up-resume-failed", quietPult: true });
    return "failed";
  }
}

/** Сообщения той же пачки (клиент написал три подряд, пока шла пауза) отвечаются ВМЕСТЕ с последним: ход ядра несёт
 *  слова отложенных сообщений (customerDeferredInput.ts::loadCustomerBurst), сами они больше не ходят и не тревожат. */
async function carryBurst(tx: TxClient, row: { eventKey: string; order: bigint; scopeKey: string; endpointScopeId: string }): Promise<void> {
  await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket" d SET "errorCode" = ${NEWER_INPUT_RESUMED}
    WHERE d."scopeKey" = ${row.scopeKey} AND d."endpointScopeId" = ${row.endpointScopeId} AND d."order" < ${row.order}
      AND d."processingState" = 'HELD' AND d."errorCode" = ANY(${[...CUSTOMER_TURN_RESUMABLE_REASONS]}::text[])
      AND d."plannedAt" IS NULL AND d."tombstonedAt" IS NULL AND d."receivedAt" >= (SELECT n."receivedAt" FROM "CustomerPropertyIngressTicket" n WHERE n."eventKey" = ${row.eventKey}) - ${BURST}::interval
      AND NOT EXISTS (SELECT 1 FROM "CustomerOutboxPart" p WHERE p."ticketEventKey" = d."eventKey")
      AND NOT EXISTS (SELECT 1 FROM "CustomerPropertyIngressTicket" x WHERE x."scopeKey" = d."scopeKey"
        AND x."endpointScopeId" = d."endpointScopeId" AND x."order" > d."order" AND x."processingState" = 'PLANNED')`;
}

/** Ход задания с пометкой resume: возобновить (если ещё можно) и пройти обычным путём ядра. Условия изменились (ответил
 *  сотрудник, снова пауза, клиент написал новое) — ход не идёт. Сбой базы при возобновлении — исключение: очередь повторит
 *  задание (до CATCH_UP_MAX_ATTEMPTS раз, дальше — человеку через onGiveUp в customerInboxConsume.ts). Повтор того же
 *  задания после сбоя хода (часы уже стоят, ответа ещё нет) — ход идёт: проверки ядра те же, срок — от возобновления. */
export async function runCustomerCatchUpTurn(eventKey: string): Promise<
  Awaited<ReturnType<typeof import("./customerIngressProducer.js")["consumeCustomerInboxTicket"]>> | null
> {
  if (!(await automationSwitchOn("botCatchUpEnabled"))) return null;
  const outcome = await resumeHeldCustomerTurn(eventKey);
  if (outcome === "failed") throw new Error("Догоняющий ход: сбой базы при возобновлении, задание повторит попытку");
  if (outcome === "not_eligible") {
    const ticket = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey }, select: { resumedAt: true, processingState: true } });
    if (!ticket?.resumedAt || ticket.processingState === "PLANNED") return null;
  }
  const { consumeCustomerInboxTicket } = await import("./customerIngressProducer.js");
  return consumeCustomerInboxTicket(eventKey);
}
