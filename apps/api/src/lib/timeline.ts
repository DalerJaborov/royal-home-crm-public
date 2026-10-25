/**
 * ЕДИНСТВЕННАЯ ТОЧКА ЗАПИСИ В ХРОНОЛОГИЮ (Interaction) — 17.09.2026, задание Б1,
 * закон П-10 (`docs/audit/lead-ownership-17-09.md` §2), разбор 88 мест записи
 * `docs/audit/recon-17-09/04-timeline-authorship.md`.
 *
 * ПОЧЕМУ ОДНА ТОЧКА. До этой правки `Interaction.agentId` было `NOT NULL`, и
 * автоматика (кроны, детекторы ИИ, боты, действия клиента) была вынуждена
 * подписываться живым человеком — обычно тем, кого сама же обвиняла или кого
 * нашла последним в цепочке фолбэков (директор/админ «на дежурстве»). В карточке
 * это выглядело так, будто действие совершил конкретный сотрудник, хотя он к
 * событию отношения не имел. Теперь `agentId` nullable, у записи есть `actorKind`
 * (AGENT/SYSTEM/AI/BOT/CLIENT), и функция ниже — единственное место, где
 * решается, как эти два поля сочетаются.
 *
 * ПРАВИЛА (П-10):
 *  - `kind: "agent"` принимает ТОЛЬКО явного человека: `req.agent.id` (сделал
 *    руками в CRM), агента, физически ответившего по добавочному (сверка в
 *    lib/telephony/callRecordings.ts::reconcileCallAuthor), дежурного оператора
 *    входящих. НИКОГДА `client.assignedAgentId` — владение карточкой не значит,
 *    что этот человек сейчас действовал.
 *  - `kind` != "agent" → `agentId` ВСЕГДА `null` (CHECK в БД, миграция №2 —
 *    после бэкофилла). `subjectAgentId` обязателен, если запись заводит задачу
 *    (`nextAction`/`nextActionDate`) — иначе некому будет её увидеть в списке дел.
 *  - Директорский/админский фолбэк («дежурный на всякий случай») в вызывающем
 *    коде быть не должно вовсе — если автора нет, пишите `system` с понятным
 *    `source` и, если нужно, `subjectAgentId`.
 *  - Эскалация нескольким руководителям — ОДНА запись `system` в хронологии
 *    клиента, адресаты получают уведомления, а не свою копию записи (иначе
 *    ровно тот спам, который бэкофилл в миграции №2 вычищает).
 *
 * СТРАЖ: `apps/api/tests/timeline-single-writer.test.ts` запрещает
 * `interaction.create(`/`createMany(` вне этого файла (белый список — тесты и
 * `scripts/`), чтобы новый обходной путь не появился незамеченным.
 */
import { prisma, type TxClient } from "../db.js";
import { recordInvestigationSignal } from "./investigationCases.js";
import { confirmedClientIntents, showingEvidenceIssues } from "@royal-home/shared";
import type { InteractionType, InteractionOutcome, Prisma } from "../generated/prisma/client.js";

/** Shared transaction type also used by multi-write timeline callers. Nested
 * $transaction overload inference incorrectly includes the root client method. */
export type TimelineTx = TxClient;

export type TimelineActor =
  /** Живой человек — см. правила выше. НИКОГДА не выводите agentId из
   *  `client.assignedAgentId`: это владелец карточки, а не тот, кто действовал. */
  | {
      kind: "agent";
      agentId: string;
      /** Explicit task assignee when a human creates a task for somebody else.
       * Does not replace the author or grant access to the resource. */
      subjectAgentId?: string | null;
    }
  | {
      kind: "system" | "ai" | "bot" | "client";
      /** Короткий машинный тег механизма — для дедупа/фильтрации в вызывающем
       *  коде и для журнала (`logSystemError` при задаче без subjectAgentId).
       *  В `notes` НЕ подставляется автоматически (см. docstring выше) — кто
       *  хочет `[source]` в тексте, пишет его сам, тем же приёмом, что
       *  `lib/changeClientAgent.ts`. */
      source: string;
      /** Кому адресована задача (nextAction/nextActionDate), когда автора-человека
       *  нет. Обязательно, если в `input` заполнен nextAction. */
      subjectAgentId?: string | null;
      /** Задача НАМЕРЕННО общая — адресована руководству целиком, а не одному
       *  человеку (эскалация недозвона, lib/noAnswerStreak.ts): её видят все, у
       *  кого список дел без ограничения своими карточками. Такая задача без
       *  subjectAgentId — не пропажа, и строка в журнал о ней не пишется
       *  (25.09.2026: каждая эскалация будила журнал ложной тревогой). */
      sharedTask?: true;
      /** Канал для BOT (whatsapp/instagram/telegram/...) — попадает в подпись в
       *  вебе («Бот (канал)»), см. packages/shared лейблы. */
      channel?: string;
    };

export interface LogTimelineInput {
  clientId: string;
  actor: TimelineActor;
  type: InteractionType;
  notes: string;
  investigationOnly?: boolean;
  /** Server-owned origin only; callers must link all interpretations of one call to one independenceKey. */
  investigationOrigin?: { sourceType: string; sourceId: string; independenceKey: string; kind: string; showingId?: string };
  propertyId?: string | null;
  showingOffCrm?: boolean;
  showingOffCrmDetails?: string | null;
  outcome?: InteractionOutcome | null;
  outcomeSource?: string;
  nextAction?: string | null;
  nextActionDate?: Date | null;
  recordingUrl?: string | null;
  recordingDurationSec?: number | null;
  transcript?: string | null;
  transcriptRu?: string | null;
  /** Запасные номера, найденные и замаскированные в transcript/transcriptRu
   *  (см. lib/telephony/callPhoneMasking.ts::scrubMentionedPhones) — зашифрованные,
   *  для дедупа карточек. Необязательное поле: не передан — Prisma применяет
   *  дефолт схемы `[]`, остальные вызовы logTimeline не затронуты. */
  mentionedPhonesEncrypted?: string[];
  callAttempt?: string | null;
  liveNote?: string | null;
  voiceNoteUrl?: string | null;
  voiceNoteTranscript?: string | null;
  continuesInteractionId?: string | null;
  matchNotifiedPriceTjs?: Prisma.Decimal | number | null;
  completedAt?: Date | null;
  createdAt?: Date;
  tx?: TimelineTx;
  /** Машинный тег автозадачи — см. Interaction.autoTaskKind в schema.prisma и
   *  lib/autoTasks.ts::upsertAutoTask. Ручная задача (агент/ИИ-ассистент) этого
   *  поля не передаёт, остаётся null. */
  autoTaskKind?: string | null;
}

export interface LogTimelineResult {
  id: string;
}

function actorFields(actor: TimelineActor): {
  actorKind: "AGENT" | "SYSTEM" | "AI" | "BOT" | "CLIENT";
  agentId: string | null;
  subjectAgentId: string | null;
} {
  if (actor.kind === "agent") {
    return { actorKind: "AGENT", agentId: actor.agentId, subjectAgentId: actor.subjectAgentId ?? null };
  }
  return {
    actorKind: actor.kind.toUpperCase() as "SYSTEM" | "AI" | "BOT" | "CLIENT",
    agentId: null,
    subjectAgentId: actor.subjectAgentId ?? null,
  };
}

/**
 * `notes` идёт В БАЗУ ТОЧНО ТАК, КАК ПЕРЕДАНО — НИКАКОГО АВТОМАТИЧЕСКОГО
 * ПРЕФИКСА `[source]` (найдено 17.09.2026, живой регресс на своём же коде).
 *
 * Первая версия этой функции сама добавляла `[source]` перед текстом у любого
 * не-agent актора — красиво и единообразно, но десятки вызывающих мест по
 * всему репозиторию узнают СВОЮ же предыдущую запись через
 * `notes: { startsWith: ОБЫЧНЫЙ_ТЕКСТ_МАРКЕР }` (AUTO_MATCH_MARKER в
 * propertyMatchFilter.ts, REMINDER_NOTE_PREFIX в clientInactiveTextDetector.ts,
 * poolMarker/reminderMarker в services/leads/firstCall.ts, «Клиент снова
 * обратился» в services/leads/intake.ts и т.д.) — автопрефикс сдвигал их
 * собственный маркер на второе слово, и дедуп/антиспам-проверки перестали
 * находить свои же записи, что тут же поймали существующие тесты
 * (property-match-alert, client-inactive-text-detector, new-inquiry-detector).
 * Кто хочет тег `[source]` в тексте — пишет его сам в `notes`, как это всегда
 * делал lib/changeClientAgent.ts.
 */

/**
 * Единственная функция, которая пишет `Interaction`.
 *
 * Заводит задачу (nextAction) БЕЗ subjectAgentId у не-агентского актора — НЕ
 * ошибка сама по себе (легитимный случай — клиент без ответственного агента,
 * задача остаётся общей, ничьим личным списком дел не подхватывается), но
 * стоит след в журнале: если это окажется массовым, а не единичным случаем,
 * будет что искать. Никогда не бросает — задача важнее диагностики (найдено
 * 17.09.2026: ранний вариант с throw в test/development ронял ЖИВОЙ конвейер
 * lib/telephony/voicemailIngest.ts на клиенте без агента, и сообщение
 * автоответчика молча не попадало в хронологию вовсе).
 */
export async function logTimeline(input: LogTimelineInput): Promise<LogTimelineResult> {
  const showingIssue = showingEvidenceIssues(input)[0];
  if (showingIssue) throw new Error(showingIssue.message);
  // Use the same row lock as final refusal: either this task is written first and
  // cancelled by refusal, or it observes completion and is born cancelled.
  if ((input.type === "SHOWING" || input.investigationOnly || ((input.nextAction || input.nextActionDate) && !input.completedAt)) && !input.tx) {
    return prisma.$transaction(tx => logTimeline({ ...input, tx }));
  }
  let taskCancelledAt: Date | null = null;
  if ((input.nextAction || input.nextActionDate) && !input.completedAt && input.tx) {
    const [assignment] = await input.tx.$queryRaw<Array<{ assignmentCompletedAt: Date | null }>>`
      SELECT "assignmentCompletedAt" FROM "Client" WHERE id = ${input.clientId} FOR UPDATE`;
    taskCancelledAt = assignment?.assignmentCompletedAt ? new Date() : null;
  }
  const { actorKind, agentId, subjectAgentId } = actorFields(input.actor);

  const sharedTask = input.actor.kind !== "agent" && input.actor.sharedTask === true;
  if (actorKind !== "AGENT" && input.nextAction && !subjectAgentId && !sharedTask) {
    const message =
      `logTimeline: задача без subjectAgentId (actorKind=${actorKind}, source=` +
      `${input.actor.kind === "agent" ? "-" : input.actor.source}, clientId=${input.clientId}) — ` +
      `общая задача, ничей личный список дел её не увидит`;
    const { logSystemError } = await import("./systemError.js");
    void logSystemError("timeline", message);
  }

  let buyerIntentAtCreation: boolean | null = null;
  if (input.type === "SHOWING" && input.tx) {
    await input.tx.$queryRaw`SELECT id FROM "Client" WHERE id=${input.clientId} FOR UPDATE`;
    const intent = await input.tx.client.findUnique({ where: { id: input.clientId },
      select: { kind: true, dualIntent: true, dualIntentConfirmedAt: true } });
    if (intent) buyerIntentAtCreation = confirmedClientIntents(intent).buys;
  }
  const data: Prisma.InteractionUncheckedCreateInput = {
    showingEvidenceVersion: input.type === "SHOWING" ? 1 : 0,
    showingOffCrm: input.type === "SHOWING" && input.showingOffCrm === true,
    showingOffCrmDetails: input.type === "SHOWING" && input.showingOffCrm ? input.showingOffCrmDetails?.trim() : null,
    buyerIntentAtCreation,
    clientId: input.clientId,
    actorKind,
    agentId,
    subjectAgentId,
    type: input.type,
    notes: input.notes,
    investigationOnly: input.investigationOnly ?? false,
    propertyId: input.propertyId ?? null,
    outcome: input.outcome ?? null,
    ...(input.outcomeSource !== undefined ? { outcomeSource: input.outcomeSource } : {}),
    nextAction: input.nextAction ?? null,
    nextActionDate: input.nextActionDate ?? null,
    recordingUrl: input.recordingUrl ?? null,
    recordingDurationSec: input.recordingDurationSec ?? null,
    transcript: input.transcript ?? null,
    transcriptRu: input.transcriptRu ?? null,
    ...(input.mentionedPhonesEncrypted !== undefined ? { mentionedPhonesEncrypted: input.mentionedPhonesEncrypted } : {}),
    callAttempt: input.callAttempt ?? null,
    liveNote: input.liveNote ?? null,
    voiceNoteUrl: input.voiceNoteUrl ?? null,
    voiceNoteTranscript: input.voiceNoteTranscript ?? null,
    continuesInteractionId: input.continuesInteractionId ?? null,
    ...(input.matchNotifiedPriceTjs !== undefined ? { matchNotifiedPriceTjs: input.matchNotifiedPriceTjs } : {}),
    completedAt: input.completedAt ?? null,
    taskCancelledAt,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    autoTaskKind: input.autoTaskKind ?? null,
  };

  const client: Pick<TxClient, "interaction"> = input.tx ?? prisma;
  const created = await client.interaction.create({ data, select: { id: true } });
  if (input.investigationOnly && input.tx && input.investigationOrigin?.sourceType !== "investigation-decision" && !(input.actor.kind !== "agent" && input.actor.source === "investigation-decision")) {
    const assignment = await input.tx.client.findUnique({ where: { id: input.clientId },
      select: { assignedAt: true, assignedAgentId: true } });
    if (assignment) await recordInvestigationSignal({
      clientId: input.clientId, propertyId: input.propertyId, subjectAgentId: subjectAgentId ?? assignment.assignedAgentId,
      assignmentAt: assignment.assignedAt, sourceType: input.investigationOrigin?.sourceType ?? "interaction",
      sourceId: input.investigationOrigin?.sourceId ?? created.id, showingId: input.investigationOrigin?.showingId,
      kind: input.actor.kind === "agent" ? "manual" : input.investigationOrigin?.kind ?? input.actor.source,
      independenceKey: input.actor.kind === "agent" ? `manual:${input.actor.agentId}`
        : input.investigationOrigin?.independenceKey ?? (input.continuesInteractionId ? `interaction:${input.continuesInteractionId}` : "unverified-origin"),
      summary: input.notes, occurredAt: input.createdAt ?? new Date(),
    }, input.tx);
  }
  if (input.type === "SHOWING" && input.propertyId && input.tx) {
    const { recordShowingDeliveryObservation } = await import("./clientWorkflowObservations.js");
    await recordShowingDeliveryObservation(input.tx, { clientId: input.clientId, propertyId: input.propertyId,
      showingId: created.id, occurredAt: input.createdAt ?? new Date() });
  }
  return { id: created.id };
}

/**
 * `createMany` — только для пакетной записи ОДНОГО и того же события нескольким
 * клиентам разом (например бэкофилл/скрипты). Каждый элемент проходит те же
 * правила актора, что и `logTimeline`; `subjectAgentId`-проверка в dev/test не
 * бросает поштучно — считает и логирует одним сообщением, чтобы пакетная запись
 * не падала на середине.
 */
export async function logTimelineMany(
  inputs: Omit<LogTimelineInput, "tx">[],
  tx?: TimelineTx
): Promise<number> {
  if (inputs.length === 0) return 0;
  const rows: Prisma.InteractionUncheckedCreateInput[] = [];
  let missingSubject = 0;
  for (const input of inputs) {
    const { actorKind, agentId, subjectAgentId } = actorFields(input.actor);
    const sharedTask = input.actor.kind !== "agent" && input.actor.sharedTask === true;
    if (actorKind !== "AGENT" && input.nextAction && !subjectAgentId && !sharedTask) missingSubject++;
    rows.push({
      clientId: input.clientId,
      actorKind,
      agentId,
      subjectAgentId,
      type: input.type,
      notes: input.notes,
    investigationOnly: input.investigationOnly ?? false,
      propertyId: input.propertyId ?? null,
      outcome: input.outcome ?? null,
      ...(input.outcomeSource !== undefined ? { outcomeSource: input.outcomeSource } : {}),
      nextAction: input.nextAction ?? null,
      nextActionDate: input.nextActionDate ?? null,
      recordingUrl: input.recordingUrl ?? null,
      recordingDurationSec: input.recordingDurationSec ?? null,
      transcript: input.transcript ?? null,
      transcriptRu: input.transcriptRu ?? null,
      callAttempt: input.callAttempt ?? null,
      liveNote: input.liveNote ?? null,
      voiceNoteUrl: input.voiceNoteUrl ?? null,
      voiceNoteTranscript: input.voiceNoteTranscript ?? null,
      continuesInteractionId: input.continuesInteractionId ?? null,
      ...(input.matchNotifiedPriceTjs !== undefined ? { matchNotifiedPriceTjs: input.matchNotifiedPriceTjs } : {}),
      completedAt: input.completedAt ?? null,
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      autoTaskKind: input.autoTaskKind ?? null,
    });
  }
  if (missingSubject > 0) {
    const message = `logTimelineMany: ${missingSubject} записей с задачей без subjectAgentId`;
    if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") {
      throw new Error(message);
    }
    const { logSystemError } = await import("./systemError.js");
    void logSystemError("timeline", message);
  }
  if (inputs.some(input => input.type === "SHOWING" || input.investigationOnly || ((input.nextAction || input.nextActionDate) && !input.completedAt))) {
    if (!tx) return prisma.$transaction(inner => logTimelineMany(inputs, inner));
    // Stable lock ordering prevents two batches from taking client locks in reverse order.
    for (const clientId of [...new Set(inputs.filter(input => input.type === "SHOWING" || ((input.nextAction || input.nextActionDate) && !input.completedAt)).map(input => input.clientId))].sort()) {
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
    }
    for (const input of inputs) await logTimeline({ ...input, tx });
    return inputs.length;
  }
  const client: Pick<TxClient, "interaction"> = tx ?? prisma;
  const result = await client.interaction.createMany({ data: rows });
  return result.count;
}
