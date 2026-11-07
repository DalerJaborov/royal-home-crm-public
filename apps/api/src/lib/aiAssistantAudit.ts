import { ASSISTANT_LOG_RETENTION_DAYS, type AssistantTurnOutcome } from "@royal-home/shared";
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { phoneSafeText } from "./clientPhone.js";

/**
 * Журнал обращений к ИИ-ассистенту CRM (ai/assistant.ts) — модель
 * AiAssistantAuditLog. НЕ механизм защиты данных (её роль играет `ownScope` в
 * `runTool` на каждом инструменте), а прослеживаемость: если возникнет
 * подозрение, что кто-то использует ассистента для сбора чужих данных, здесь
 * видно, кто, какой функцией и когда пользовался.
 *
 * Единственная точка вызова — цикл выполнения инструментов в `runAssistant`,
 * рядом с самим `runTool`, а не внутри каждой из функций-инструментов: тот же
 * приём, что у `createNotification` в lib/notifications.ts (одна точка на
 * несколько похожих вызовов, не дублировать по местам использования).
 *
 * `argsSummary` хранит только аргументы САМОГО вызова (фильтры, id, текст
 * запроса) — не результат: цель записи — факт обращения, а не копия данных,
 * которые и так под `ownScope`.
 *
 * Сбой записи не должен ронять ответ ассистента — как и `createNotification`,
 * ловит собственные ошибки и уходит в `logSystemError`, а не пробрасывает их.
 */
/** Длина вопроса в журнале: хватает, чтобы понять, о чём спросили, но это не копия переписки. */
export const AUDIT_QUESTION_MAX_CHARS = 500;

/**
 * ВОПРОС СОТРУДНИКА ДЛЯ ЖУРНАЛА (07.11.2026, владелец: «прочитать, где она не справилась»).
 * Одна точка подготовки на все входы (CRM, Telegram, быстрые пути): пробелы схлопнуты,
 * телефоны закрыты той же маской, что везде в CRM (lib/clientPhone.ts), длина ограничена.
 * Журнал читает только «Система» (право auditLog.view).
 */
export function auditQuestionText(question: string | null | undefined): string | null {
  if (typeof question !== "string") return null;
  const flat = question.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const masked = phoneSafeText(flat, false);
  return masked.length > AUDIT_QUESTION_MAX_CHARS ? `${masked.slice(0, AUDIT_QUESTION_MAX_CHARS - 1)}…` : masked;
}

export async function logAssistantToolCall(input: {
  agentId: string;
  tool: string;
  /** Короткое описание аргументов вызова, не результат. Обрезается до разумной длины. */
  argsSummary?: string | null;
  /** Сколько записей вернул инструмент — только для функций, отдающих список. */
  resultCount?: number | null;
  /** Вопрос сотрудника, на который отвечал помощник (сырой: маска и обрезка — здесь). */
  question?: string | null;
}): Promise<void> {
  try {
    await prisma.aiAssistantAuditLog.create({
      data: {
        agentId: input.agentId,
        tool: input.tool,
        argsSummary: input.argsSummary?.slice(0, 500) || null,
        resultCount: input.resultCount ?? null,
        question: auditQuestionText(input.question),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ai:assistant:audit] Не удалось записать журнал обращений:", message);
    void logSystemError("ai", `Не удалось записать журнал обращений ИИ-ассистента (${input.tool}): ${message}`);
  }
}

/**
 * ХОД ПОМОЩНИЦЫ ЦЕЛИКОМ (пачка 2, 07.11.2026) — модель AiAssistantTurnLog, одна строка на ответ.
 * Пишут: конец `runAssistantDetailed` (ai/assistant.ts, все ходы с моделью) и быстрые пути без
 * модели (routes/ai.ts, telegram/assistantBot.ts). Вопрос готовит та же `auditQuestionText`, что
 * и строки инструментов. Текст ответа не хранится — только длина. Сбой записи ответ не роняет.
 */
export interface AssistantTurnLogInput {
  agentId: string;
  channel: string;
  surface?: string | null;
  question?: string | null;
  outcome: AssistantTurnOutcome;
  reason?: string | null;
  route: string;
  rounds: number;
  toolCalls: number;
  replyChars?: number | null;
  ms: number;
}

export async function logAssistantTurn(input: AssistantTurnLogInput): Promise<void> {
  try {
    await prisma.aiAssistantTurnLog.create({
      data: {
        agentId: input.agentId,
        channel: input.channel.slice(0, 32),
        surface: input.surface?.slice(0, 32) ?? null,
        question: auditQuestionText(input.question),
        outcome: input.outcome,
        reason: input.reason?.slice(0, 64) ?? null,
        route: input.route.slice(0, 32),
        rounds: Math.max(0, Math.round(input.rounds)),
        toolCalls: Math.max(0, Math.round(input.toolCalls)),
        replyChars: typeof input.replyChars === "number" ? Math.max(0, Math.round(input.replyChars)) : null,
        ms: Math.max(0, Math.round(input.ms)),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Сотрудника уже нет в базе (удалили посреди хода; в тестах — выдуманный id): строке
    // журнала не к кому привязаться. Это не сбой журнала — без тревоги в «Здоровье системы».
    if ((err as { code?: unknown } | null)?.code === "P2003") {
      console.warn("[ai:assistant:turn-log] ход не записан: сотрудника нет в базе");
      return;
    }
    console.error("[ai:assistant:turn-log] Не удалось записать ход помощницы:", message);
    void logSystemError("ai", `Не удалось записать ход ИИ-помощницы в журнал: ${message}`);
  }
}

/**
 * Ход быстрого пути без модели (номер карточки, телефон, ссылка, очередь монтажа): ответ из
 * базы одним чтением. `found` = 0 — честное «не нашла», в журнале с причиной not_found.
 */
export function logAssistantFastPathTurn(input: {
  agentId: string;
  channel: "crm" | "telegram";
  surface?: string | null;
  question?: string | null;
  reply: string;
  found: number;
  startedAt: number;
}): Promise<void> {
  return logAssistantTurn({
    agentId: input.agentId,
    channel: input.channel,
    surface: input.surface ?? null,
    question: input.question ?? null,
    outcome: "answer",
    reason: input.found > 0 ? null : "not_found",
    route: "fast_path",
    rounds: 0,
    toolCalls: 1,
    replyChars: input.reply.length,
    ms: Date.now() - input.startedAt,
  });
}

/** Срок хранения журнала из настроек, в пределах ASSISTANT_LOG_RETENTION_DAYS. */
export async function loadAssistantLogRetentionDays(): Promise<number> {
  const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { aiAssistantLogRetentionDays: true } });
  const raw = row?.aiAssistantLogRetentionDays ?? ASSISTANT_LOG_RETENTION_DAYS.default;
  if (!Number.isFinite(raw)) return ASSISTANT_LOG_RETENTION_DAYS.default;
  return Math.min(ASSISTANT_LOG_RETENTION_DAYS.max, Math.max(ASSISTANT_LOG_RETENTION_DAYS.min, Math.round(raw)));
}

/**
 * ЧИСТКА ЖУРНАЛА ПОМОЩНИЦЫ ПО СРОКУ (крон «assistant-log-retention», раз в сутки ночью).
 * Старше срока: ходы удаляются целиком; у строк инструментов стирается только текст вопроса —
 * факт обращения (кто, каким инструментом, когда) нужен для разбора и дальше.
 */
export async function sweepAssistantLogs(now: Date = new Date()): Promise<{
  days: number;
  turnsDeleted: number;
  questionsCleared: number;
}> {
  const days = await loadAssistantLogRetentionDays();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const [turns, questions] = await Promise.all([
    prisma.aiAssistantTurnLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.aiAssistantAuditLog.updateMany({
      where: { createdAt: { lt: cutoff }, question: { not: null } },
      data: { question: null },
    }),
  ]);
  return { days, turnsDeleted: turns.count, questionsCleared: questions.count };
}
