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
