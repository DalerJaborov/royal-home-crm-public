import {
  formatClientName,
  formatPropertyCode,
  SHOWING_NEXT_STEP_LABELS,
  type ShowingNextStep,
  type ShowingQuestionAnswer,
  type ShowingQuestionKind,
  type ShowingQuestionPropertyOption,
  type ShowingQuestionView,
} from "@royal-home/shared";
import type { ShowingQuestion } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { bookShowing, cancelShowingById, rescheduleShowingById, showingTimeLabel, type BookingProblem, type ShowingActor } from "./showingBooking.js";
import { completeInteractionTask } from "./taskCompletion.js";
import { logTimeline } from "./timeline.js";
import { dushanbeDateString, dushanbeInputToDate, dushanbeStartOfToday, dushanbeTimeString } from "./dushanbeTime.js";
import { findMatchingPropertiesForClient } from "../routes/matching.js";
import { editHtmlMessage } from "../telegram/api.js";
import { describeError } from "./describeError.js";

/**
 * ВОПРОСЫ АГЕНТУ О ПОКАЗЕ — ОДНА ДВЕРЬ (владелец 22.11.2026).
 *
 * Решение владельца: «лучше показы делать уведомлением с кнопками в Шабнам, там люди
 * охотнее нажимают кнопку, и после разговора можно своими словами отвечать Шабнам: да,
 * у нас показ». CRM — хранилище, Шабнам — главный способ ответить, карточка и пуш в
 * CRM — страховка (нет Telegram или нет ответа).
 *
 * Здесь всё, что касается вопроса и ответа, без Telegram: завести вопрос, решить, что
 * он закрыт фактом, выдать его экрану, исполнить ответ. Отправка в Шабнам и кнопки —
 * telegram/showingQuestionNotice.ts; она и экран CRM зовут answerShowingQuestion, поэтому
 * ответ в одном месте закрывает вопрос в другом.
 *
 * Ответы исполняют СУЩЕСТВУЮЩИЕ двери, своей логики показов тут нет:
 *  - записать показ — bookShowing (часы 09:00–20:00, дубль, перенос — как у бота и помощницы);
 *  - «показ был» — completeInteractionTask (та же, что «Отметить выполненной» в календаре);
 *  - перенести / отменили — rescheduleShowingById / cancelShowingById (как в календаре);
 *  - следующий шаг — запись хронологии с задачей (logTimeline).
 *
 * ВОПРОС ЗАКРЫВАЕТСЯ ФАКТОМ, а не только ответом: показ записали кнопкой в карточке,
 * помощница по словам агента, перенесли или отметили в календаре — вопрос снимается
 * сам (closedByFact). Поэтому свободный ответ Шабнам («да, у нас показ завтра в шесть»)
 * исполняют её обычные инструменты, а вопрос гаснет следом.
 */

/** Через сколько после времени показа спросить «У вас был показ?». */
export const OUTCOME_ASK_AFTER_MS = 60 * 60_000;
/** Вечерний показ (20:00 → вопрос в 21:00) вне часов агента дождётся утра — но не дольше. */
export const OUTCOME_LOOKBACK_MS = 18 * 60 * 60_000;
/** Спросили в Шабнам и нет ответа столько — тот же вопрос пушем в CRM (страховка). */
export const SAFETY_PUSH_AFTER_MS = 3 * 60 * 60_000;
/** Вопрос без ответа дольше этого снимается: договорённость и показ давно в прошлом. */
export const QUESTION_TTL_MS = 3 * 24 * 60 * 60_000;
/** Часы, когда агента можно спросить (те же, что у напоминаний агенту, meetingReminders.ts). */
export const AGENT_ASK_START = "08:00";
export const AGENT_ASK_END = "22:00";

const LIST_LIMIT = 20;

export type ShowingQuestionRow = ShowingQuestion;

// Завести «Договорились о показе?» — lib/showingQuestionAsk.ts (лёгкий модуль без зависимостей:
// его зовут разбор звонка и детектор переписки, а здешние двери показов замкнули бы круг импортов).
export { AGREEMENT_ASK_DELAY_MS, askShowingAgreement, type AgreementQuestionInput } from "./showingQuestionAsk.js";

/**
 * Показ записан с часом, а не «на день». Дата без часа хранится полночью UTC (форма без
 * времени) или полночью по Душанбе (19:00 UTC, фронт) — «через час после показа» у неё
 * нет, и вопрос «был показ?» в 06:00 был бы неправдой (то же правило, что hasExactTime и
 * hasRealShowingHour в meetingReminders.ts).
 */
function hasShowingHour(at: Date): boolean {
  const m = at.getUTCMinutes();
  const h = at.getUTCHours();
  return !(m === 0 && (h === 0 || h === 19));
}

/**
 * «У вас был показ?» — заводит вопросы по показам, время которых прошло час назад
 * (крон раз в минуту). Отменённый, перенесённый, уже отмеченный показ, клиент в
 * Корзине — вопроса нет. Один показ — один вопрос (dedupKey), повтор тика безопасен.
 */
export async function planShowingOutcomeQuestions(now: Date = new Date()): Promise<number> {
  if (!(await automationSwitchOn("showingOutcomeAskEnabled"))) return 0;
  const showings = await prisma.interaction.findMany({
    where: {
      type: "SHOWING",
      nextAction: { not: null },
      completedAt: null,
      taskCancelledAt: null,
      declinedAt: null,
      investigationOnly: false,
      nextActionDate: { gte: new Date(now.getTime() - OUTCOME_LOOKBACK_MS), lte: new Date(now.getTime() - OUTCOME_ASK_AFTER_MS) },
      client: { deletedAt: null, assignmentCompletedAt: null },
    },
    select: { id: true, clientId: true, agentId: true, subjectAgentId: true, propertyId: true, nextActionDate: true },
    orderBy: { nextActionDate: "asc" },
    take: 200,
  });
  if (showings.length === 0) return 0;
  const known = new Set(
    (await prisma.showingQuestion.findMany({
      where: { dedupKey: { in: showings.map((s) => `outcome:${s.id}`) } },
      select: { dedupKey: true },
    })).map((q) => q.dedupKey)
  );
  const rows = showings
    .filter((s) => !known.has(`outcome:${s.id}`) && (s.subjectAgentId ?? s.agentId) && s.nextActionDate && hasShowingHour(s.nextActionDate))
    .map((s) => ({
      kind: "OUTCOME",
      dedupKey: `outcome:${s.id}`,
      agentId: (s.subjectAgentId ?? s.agentId)!,
      clientId: s.clientId,
      showingId: s.id,
      propertyId: s.propertyId,
      proposedAt: s.nextActionDate,
      askAt: new Date(s.nextActionDate!.getTime() + OUTCOME_ASK_AFTER_MS),
    }));
  if (rows.length === 0) return 0;
  const { count } = await prisma.showingQuestion.createMany({ data: rows, skipDuplicates: true });
  return count;
}

// ───────────────────────── закрыт фактом ─────────────────────────

/**
 * Вопрос уже не нужен: ответ случился другим путём. null — вопрос живой.
 *  - клиент в Корзине или работа с ним закончена — спрашивать не о ком;
 *  - AGREEMENT: у клиента после разговора появился показ (кнопкой, помощницей, ботом);
 *  - OUTCOME: показ отмечен, отменён, снят или перенесён на будущее.
 */
export async function closedByFact(q: ShowingQuestionRow, now: Date = new Date()): Promise<{ answer: string; showingId?: string } | null> {
  const client = await prisma.client.findUnique({ where: { id: q.clientId }, select: { deletedAt: true, assignmentCompletedAt: true } });
  if (!client || client.deletedAt || client.assignmentCompletedAt) return { answer: "client_gone" };
  if (q.askAt.getTime() < now.getTime() - QUESTION_TTL_MS) return { answer: "expired" };
  if (q.kind === "AGREEMENT") {
    const booked = await prisma.interaction.findFirst({
      where: { clientId: q.clientId, type: "SHOWING", taskCancelledAt: null, declinedAt: null, createdAt: { gte: new Date(q.createdAt.getTime() - 5 * 60_000) } },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    return booked ? { answer: "booked_elsewhere", showingId: booked.id } : null;
  }
  if (!q.showingId) return { answer: "no_showing" };
  const showing = await prisma.interaction.findUnique({
    where: { id: q.showingId },
    select: { completedAt: true, taskCancelledAt: true, declinedAt: true, nextAction: true, nextActionDate: true },
  });
  if (!showing || showing.completedAt || showing.taskCancelledAt || showing.declinedAt || !showing.nextAction) return { answer: "marked_elsewhere" };
  if (showing.nextActionDate && showing.nextActionDate.getTime() > now.getTime()) return { answer: "rescheduled_elsewhere" };
  return null;
}

/** Снять вопрос фактом (условно: только живой). true — снял этот вызов. */
export async function closeQuestion(q: ShowingQuestionRow, fact: { answer: string; showingId?: string }, now: Date = new Date()): Promise<boolean> {
  const { count } = await prisma.showingQuestion.updateMany({
    where: { id: q.id, status: "OPEN" },
    data: { status: "CLOSED", answer: fact.answer, answeredVia: "fact", answeredAt: now, ...(fact.showingId ? { showingId: fact.showingId } : {}) },
  });
  if (count > 0) await markTelegramAnswered(q, "Вопрос снят: уже отмечено в CRM.");
  return count > 0;
}

// ───────────────────────── для экрана и Шабнам ─────────────────────────

export interface ShowingQuestionDetails {
  q: ShowingQuestionRow;
  client: { id: string; shortId: number; fullName: string; kind: "BUYER" | "SELLER" | "OTHER"; dualIntent: boolean };
  property: ShowingQuestionPropertyOption | null;
  options: ShowingQuestionPropertyOption[];
  at: Date | null;
}

/** Всё, что нужно показать вопрос: клиент, объект, время, варианты объекта. null — клиента нет. */
export async function loadQuestionDetails(q: ShowingQuestionRow): Promise<ShowingQuestionDetails | null> {
  const client = await prisma.client.findUnique({
    where: { id: q.clientId },
    select: { id: true, shortId: true, fullName: true, kind: true, dualIntent: true },
  });
  if (!client) return null;
  const property = q.propertyId
    ? await prisma.property.findFirst({ where: { id: q.propertyId, deletedAt: null }, select: { id: true, shortId: true, title: true } })
    : null;
  let options: ShowingQuestionPropertyOption[] = [];
  if (q.kind === "AGREEMENT" && !property) {
    // Строгий подбор — тот же, что у автоназначения; пусто — агент назовёт объект сам.
    const matched = await findMatchingPropertiesForClient(q.clientId, { take: 3 }).catch(() => []);
    options = matched.map((m) => ({ id: m.propertyId, shortId: m.shortId, title: m.title }));
  }
  return { q, client, property, options, at: q.proposedAt };
}

export function toView(d: ShowingQuestionDetails): ShowingQuestionView {
  return {
    id: d.q.id,
    kind: d.q.kind as ShowingQuestionKind,
    clientId: d.client.id,
    clientShortId: d.client.shortId,
    clientName: formatClientName(d.client),
    showingId: d.q.showingId,
    at: d.at?.toISOString() ?? null,
    property: d.property,
    options: d.options,
    quote: d.q.quote,
    askedAt: d.q.askAt.toISOString(),
  };
}

/**
 * Открытые вопросы агента, время которых наступило (экран CRM). Закрытые фактом
 * снимаются здесь же — экран не покажет вопрос о показе, который уже отмечен.
 */
export async function listShowingQuestions(agentId: string, opts: { clientId?: string; now?: Date } = {}): Promise<ShowingQuestionView[]> {
  const now = opts.now ?? new Date();
  const rows = await prisma.showingQuestion.findMany({
    where: { agentId, status: "OPEN", askAt: { lte: now }, ...(opts.clientId ? { clientId: opts.clientId } : {}) },
    orderBy: { askAt: "asc" },
    take: LIST_LIMIT,
  });
  const out: ShowingQuestionView[] = [];
  for (const q of rows) {
    const fact = await closedByFact(q, now);
    if (fact) {
      await closeQuestion(q, fact, now);
      continue;
    }
    const details = await loadQuestionDetails(q);
    if (details) out.push(toView(details));
  }
  return out;
}

/** Время показа словами: «23.11 в 18:00». */
export function questionTimeLabel(at: Date | null): string | null {
  return at ? showingTimeLabel(at) : null;
}

export function propertyLabel(p: ShowingQuestionPropertyOption): string {
  return `${formatPropertyCode(p.shortId)} · ${p.title}`;
}

// ───────────────────────── ответ ─────────────────────────

export type AnswerResult = { ok: true; message: string } | { ok: false; status: number; error: string };

const BOOKING_PROBLEMS: Record<BookingProblem, string> = {
  no_time: "Время показа не понятно",
  outside_hours: "Показы записываются с 09:00 до 20:00",
  past: "Это время уже прошло или наступит меньше чем через 30 минут",
  too_far: "Показ можно записать не дальше чем на 30 дней вперёд",
  no_property: "Объект не найден",
  unavailable: "Объект уже недоступен для показа",
  no_client: "Клиент не найден",
  no_agent: "За клиентом не закреплён агент",
};

const SHOWING_PROBLEMS: Record<string, string> = {
  not_found: "Показ не найден",
  not_showing: "Это не показ с назначенным временем",
  already_cancelled: "Показ уже отменён или отмечен",
  past: "Новое время должно быть в будущем",
};

/** Завтра в HH:MM по Душанбе. */
function tomorrowAt(hhmm: string, now: Date): Date {
  const tomorrow = new Date(dushanbeStartOfToday(now).getTime() + 36 * 60 * 60_000);
  return dushanbeInputToDate(dushanbeDateString(tomorrow), hhmm);
}

/** Срок задачи: будущее и не дальше 90 дней. */
function validTaskDate(at: Date, now: Date): boolean {
  return at.getTime() > now.getTime() && at.getTime() <= now.getTime() + 90 * 86_400_000;
}

/** Задача по умолчанию, когда агент нажал «Думает, перезвонить» без даты (кнопка Шабнам): завтра в 11:00. */
export function defaultCallbackAt(now: Date = new Date()): Date {
  return tomorrowAt("11:00", now);
}

interface AnswerInput {
  questionId: string;
  /** Кто отвечает. */
  actorId: string;
  /** Руководство (clients.assign) отвечает и за чужие вопросы. */
  canActForOthers: boolean;
  via: "telegram" | "crm";
  answer: ShowingQuestionAnswer;
  now?: Date;
}

/**
 * Исполнить ответ — одна дверь для кнопок Шабнам и карточки CRM.
 *
 * Вопрос сначала ЗАНИМАЕТСЯ условным переходом OPEN → ANSWERED: две одновременные
 * кнопки (Шабнам и CRM, повторная доставка нажатия) не исполнят действие дважды. Не
 * удалось исполнить (время вне часов показов, объект продан) — вопрос возвращается в
 * OPEN, человек видит причину и отвечает заново.
 */
export async function answerShowingQuestion(input: AnswerInput): Promise<AnswerResult> {
  const now = input.now ?? new Date();
  const q = await prisma.showingQuestion.findUnique({ where: { id: input.questionId } });
  if (!q) return { ok: false, status: 404, error: "Вопрос не найден" };
  if (q.agentId !== input.actorId && !input.canActForOthers) return { ok: false, status: 403, error: "Это вопрос другого сотрудника" };
  if (q.status !== "OPEN") return { ok: false, status: 409, error: "На этот вопрос уже ответили" };
  const kindOk = q.kind === "AGREEMENT" ? ["book", "no"].includes(input.answer.action) : ["held", "reschedule", "cancelled"].includes(input.answer.action);
  if (!kindOk) return { ok: false, status: 400, error: "Такой ответ к этому вопросу не подходит" };

  const fact = await closedByFact(q, now);
  if (fact) {
    await closeQuestion(q, fact, now);
    return { ok: false, status: 409, error: "Уже отмечено в CRM — вопрос снят" };
  }

  const claimed = await prisma.showingQuestion.updateMany({
    where: { id: q.id, status: "OPEN" },
    data: { status: "ANSWERED", answer: input.answer.action, answeredVia: input.via, answeredById: input.actorId, answeredAt: now },
  });
  if (claimed.count === 0) return { ok: false, status: 409, error: "На этот вопрос уже ответили" };

  const release = async () => {
    await prisma.showingQuestion.updateMany({
      where: { id: q.id, status: "ANSWERED", answeredAt: now },
      data: { status: "OPEN", answer: null, answeredVia: null, answeredById: null, answeredAt: null },
    });
  };

  try {
    const result = await execute(q, input, now);
    if (!result.ok) {
      await release();
      return result;
    }
    if (result.showingId) await prisma.showingQuestion.update({ where: { id: q.id }, data: { showingId: result.showingId } });
    // Ответили в CRM — в Шабнам кнопки снимаются тем же текстом (в Шабнам их правит сам обработчик кнопки).
    if (input.via === "crm") await markTelegramAnswered(q, `✅ ${result.message} (ответ в CRM)`);
    return { ok: true, message: result.message };
  } catch (err) {
    await release();
    throw err;
  }
}

async function actorOf(agentId: string): Promise<ShowingActor> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { fullName: true } });
  return { kind: "agent", agentId, agentName: agent?.fullName ?? "сотрудник" };
}

async function execute(
  q: ShowingQuestionRow,
  input: AnswerInput,
  now: Date
): Promise<{ ok: true; message: string; showingId?: string } | { ok: false; status: number; error: string }> {
  const answer = input.answer;
  const actor = await actorOf(input.actorId);
  switch (answer.action) {
    case "no":
      return { ok: true, message: "Записала: о показе не договорились" };
    case "book": {
      const at = new Date(answer.at);
      const property = await prisma.property.findFirst({ where: { id: answer.propertyId }, select: { shortId: true } });
      if (!property) return { ok: false, status: 404, error: "Объект не найден" };
      const booked = await bookShowing({
        clientId: q.clientId,
        request: { action: "book", propertyCode: property.shortId, day: dushanbeDateString(at), time: dushanbeTimeString(at) },
        actor,
        now,
        // Отказ показываем самому агенту (кнопка, карточка), а не записью «Бот не смог назначить показ».
        reportFailures: false,
      });
      if (!booked.ok) return { ok: false, status: 422, error: BOOKING_PROBLEMS[booked.reason] ?? "Показ записать не удалось" };
      return {
        ok: true,
        message: `${booked.rescheduled ? "Перенесла показ" : "Записала показ"}: ${booked.propertyTitle}, ${showingTimeLabel(booked.at)}`,
        showingId: booked.interactionId,
      };
    }
    case "held": {
      const showing = q.showingId ? await prisma.interaction.findUnique({ where: { id: q.showingId } }) : null;
      if (!showing) return { ok: false, status: 404, error: "Показ не найден" };
      await completeInteractionTask(showing);
      const step = answer.next as ShowingNextStep;
      let task: { nextAction: string; nextActionDate: Date } | null = null;
      if (step === "pick_others") task = { nextAction: "Подобрать другие объекты после показа", nextActionDate: tomorrowAt("12:00", now) };
      if (step === "callback") {
        const at = answer.callbackAt ? new Date(answer.callbackAt) : defaultCallbackAt(now);
        if (!validTaskDate(at, now)) return { ok: false, status: 400, error: "Когда перезвонить — укажите время в будущем, не дальше трёх месяцев" };
        task = { nextAction: "Перезвонить клиенту после показа", nextActionDate: at };
      }
      await logTimeline({
        clientId: q.clientId,
        actor: { kind: "agent", agentId: input.actorId },
        type: "SYSTEM",
        notes: `Итог показа: показ был. Дальше: ${SHOWING_NEXT_STEP_LABELS[step]}.`,
        ...(task ?? {}),
      });
      const tail =
        step === "another_showing" ? "Запишите новый показ."
          : step === "refused" ? "Отказ оформите в карточке клиента: «Завершить сделку» → «Без сделки»."
            : task ? `Задача: ${task.nextAction.toLowerCase()}, ${showingTimeLabel(task.nextActionDate)}.` : "";
      return { ok: true, message: `Отметила: показ был. ${tail}`.trim() };
    }
    case "reschedule": {
      if (!q.showingId) return { ok: false, status: 404, error: "Показ не найден" };
      const result = await rescheduleShowingById({
        interactionId: q.showingId,
        at: new Date(answer.at),
        actor,
        reason: "Перенесли (ответ агента на «У вас был показ?»)",
        now,
      });
      if (!result.ok) return { ok: false, status: 409, error: SHOWING_PROBLEMS[result.reason] ?? BOOKING_PROBLEMS[result.reason as BookingProblem] ?? "Перенести не удалось" };
      return { ok: true, message: `Перенесла показ на ${showingTimeLabel(result.at)}`, showingId: result.interactionId };
    }
    case "cancelled": {
      if (!q.showingId) return { ok: false, status: 404, error: "Показ не найден" };
      const result = await cancelShowingById({ interactionId: q.showingId, actor, reason: answer.reason, now });
      if (!result.ok) return { ok: false, status: 409, error: SHOWING_PROBLEMS[result.reason] ?? "Отменить не удалось" };
      return { ok: true, message: "Записала: показ отменили" };
    }
  }
}

/** Снять кнопки у вопроса в Шабнам и дописать итог. Сбой Telegram не отменяет записанный ответ. */
export async function markTelegramAnswered(q: Pick<ShowingQuestionRow, "telegramChatId" | "telegramMessageId">, text: string): Promise<void> {
  if (!q.telegramChatId || !q.telegramMessageId) return;
  await editHtmlMessage(q.telegramChatId, q.telegramMessageId, text.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;")), null).catch(
    (err: unknown) => console.error("[showing-question] правка сообщения Шабнам:", describeError(err))
  );
}
