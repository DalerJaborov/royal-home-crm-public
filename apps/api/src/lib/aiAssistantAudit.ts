import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";

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
export async function logAssistantToolCall(input: {
  agentId: string;
  tool: string;
  /** Короткое описание аргументов вызова, не результат. Обрезается до разумной длины. */
  argsSummary?: string | null;
  /** Сколько записей вернул инструмент — только для функций, отдающих список. */
  resultCount?: number | null;
}): Promise<void> {
  try {
    await prisma.aiAssistantAuditLog.create({
      data: {
        agentId: input.agentId,
        tool: input.tool,
        argsSummary: input.argsSummary?.slice(0, 500) || null,
        resultCount: input.resultCount ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ai:assistant:audit] Не удалось записать журнал обращений:", message);
    void logSystemError("ai", `Не удалось записать журнал обращений ИИ-ассистента (${input.tool}): ${message}`);
  }
}
