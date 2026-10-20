/**
 * ИИ-судья для кейсов «Инсайты от ИИ» (аудит 02.09.2026 §4.2).
 *
 * Разбирает кейс через callAiText (единая точка вызова, НЕ прямой Gemini —
 * см. баг №11 в §5 аудита) и возвращает вердикт: что агент сделал неверно
 * (с дословными цитатами), как надо было, краткое резюме для руководителя.
 *
 * checkDailyBudget читает Settings.aiDailyCostCapUsd и агрегирует AiLog за
 * сегодня по Душанбе. generateVerdicts проходит по кейсам без вердикта,
 * проверяя бюджет перед каждым; при превышении пропускает (статус PARTIAL).
 */

import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { callAiText } from "../ai/client.js";
import { logSystemError } from "./systemError.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";

export interface InsightCaseVerdict {
  wrong: { quote: string; why: string }[];
  better: string[];
  summary: string;
}

interface PrismaInsightCase {
  id: string;
  kind: string;
  severity: number;
  timeline: unknown;
  verdict: unknown;
}

/**
 * Разбор одного кейса через ИИ. Возвращает null при ошибке API или отказе —
 * не падает, чтобы один сбойный кейс не останавливал весь диджест.
 */
export async function judgeCase(
  insightCase: PrismaInsightCase,
): Promise<InsightCaseVerdict | null> {
  const isPositive = insightCase.kind === "positive";

  const systemPrompt = isPositive
    ? `Ты разбираешь ПОЛОЖИТЕЛЬНЫЙ кейс для собрания команды. Даны реплики/транскрипт. Выдели что сделано хорошо и что можно масштабировать на всю команду. Краткое резюме для руководителя. Формат СТРОГО JSON: {"wrong":[],"better":["строка1","строка2"],"summary":"строка"}.`
    : `Ты разбираешь кейс для собрания команды. Даны реплики/транскрипт. Выдели неправильные слова/действия агента с ДОСЛОВНЫМИ цитатами из транскрипта и объясни почему это плохо. Предложи как надо было сказать/сделать. Краткое резюме для руководителя. Формат СТРОГО JSON: {"wrong":[{"quote":"дословная цитата","why":"почему это плохо"}],"better":["как надо строка1"],"summary":"строка"}.`;

  try {
    const result = await callAiText<InsightCaseVerdict>({
      endpoint: "insight-case",
      system: systemPrompt,
      user: JSON.stringify({
        kind: insightCase.kind,
        severity: insightCase.severity,
        timeline: insightCase.timeline,
      }),
      maxTokens: 700,
      effort: "low",
    });

    if (!result) return null;

    // Минимальная валидация структуры — модель может вернуть что угодно.
    if (typeof result.summary !== "string") return null;
    if (!Array.isArray(result.better)) return null;
    if (!Array.isArray(result.wrong)) return null;

    return {
      wrong: result.wrong.filter(
        (w): w is { quote: string; why: string } =>
          typeof w?.quote === "string" && typeof w?.why === "string",
      ),
      better: result.better.filter((b): b is string => typeof b === "string"),
      summary: result.summary,
    };
  } catch (err) {
    void logSystemError("ai", `[insights] judgeCase ошибка: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Проверяет дневной потолок расходов на ИИ. Возвращает true если лимит не
 * установлен (null) или текущие расходы за сегодня (по Душанбе) ниже потолка.
 */
export async function checkDailyBudget(): Promise<boolean> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { aiDailyCostCapUsd: true },
    });

    const cap = settings?.aiDailyCostCapUsd;
    if (cap == null) return true; // лимит не установлен

    const startOfDay = dushanbeStartOfToday();
    const agg = await prisma.aiLog.aggregate({
      where: { createdAt: { gte: startOfDay } },
      _sum: { costUsd: true },
    });

    const spent = Number(agg._sum.costUsd ?? 0);
    return spent < Number(cap);
  } catch (err) {
    // При ошибке чтения настроек или AiLog — разрешаем (не блокируем работу).
    void logSystemError(
      "ai",
      `[insights] checkDailyBudget ошибка: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

/**
 * Проходит по кейсам без вердикта, вызывает judgeCase для каждого, обновляет
 * verdict через Prisma. Пропускает кейсы если дневной бюджет превышен.
 */
export async function generateVerdicts(cases: PrismaInsightCase[]): Promise<void> {
  let processed = 0;
  let skipped = 0;

  for (const c of cases) {
    if (c.verdict != null) continue;

    const withinBudget = await checkDailyBudget();
    if (!withinBudget) {
      skipped++;
      continue;
    }

    const verdict = await judgeCase(c);
    if (verdict !== null) {
      try {
        await prisma.insightCase.update({
          where: { id: c.id },
          // Prisma 7 строже относится к типу колонки Json: `Record<string, unknown>`
          // ей больше не подходит, нужен именно `InputJsonValue`.
          data: { verdict: verdict as unknown as Prisma.InputJsonValue },
        });
        processed++;
      } catch (err) {
        void logSystemError(
          "ai",
          `[insights] update verdict ошибка (${c.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      skipped++;
    }
  }

  if (processed > 0 || skipped > 0) {
    void logSystemError(
      "ai",
      `[insights] generateVerdicts: обработано=${processed}, пропущено=${skipped}`,
    );
  }
}