import { prisma } from "../db.js";
import { callGemini } from "../ai/geminiClient.js";
import { ROYAL_SCORE_CATEGORIES, type RoyalScoreCategoryKey } from "./scoreJournal.js";

/**
 * ИИ-совет «как повысить Royal Score» — живой текст, а не жёсткие правила
 * (решение владельца 05.08.2026: персонализация важнее предсказуемости).
 *
 * Кэшируется в Agent.lastScoreAdvice на сутки — открытие карточки не должно
 * стоить денег на каждый визит. Обновляется отдельным вызовом (см.
 * routes/me.ts), не при каждом чтении /me/royal-score.
 */

const CACHE_HOURS = 24;
// Old advice may summarize private investigation events. Do not reuse it.
const SAFE_ADVICE_PREFIX = "[operational-score-v1]\n";

export interface ScoreAdvice {
  text: string;
  updatedAt: string;
}

function weakestCategory(
  breakdown: Record<RoyalScoreCategoryKey, number>
): { key: RoyalScoreCategoryKey; label: string; sum: number } {
  let weakest = ROYAL_SCORE_CATEGORIES[0];
  let weakestSum = breakdown[weakest.key];
  for (const c of ROYAL_SCORE_CATEGORIES) {
    if (breakdown[c.key] < weakestSum) {
      weakest = c;
      weakestSum = breakdown[c.key];
    }
  }
  return { key: weakest.key, label: weakest.label, sum: weakestSum };
}

/** Отдаёт кэш, если он не старше суток; иначе null — вызывающий решает, генерировать ли заново. */
export async function loadCachedScoreAdvice(agentId: string): Promise<ScoreAdvice | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { lastScoreAdvice: true, lastScoreAdviceAt: true },
  });
  if (!agent?.lastScoreAdvice?.startsWith(SAFE_ADVICE_PREFIX) || !agent.lastScoreAdviceAt) return null;
  const ageHours = (Date.now() - agent.lastScoreAdviceAt.getTime()) / 3_600_000;
  if (ageHours > CACHE_HOURS) return null;
  return { text: agent.lastScoreAdvice.slice(SAFE_ADVICE_PREFIX.length), updatedAt: agent.lastScoreAdviceAt.toISOString() };
}

/**
 * Генерирует новый совет через Gemini — короткий персонализированный текст, не
 * архитектурная задача, а один поставщик ИИ на всю CRM (решение владельца
 * 02.08.2026) означает, что заводить ради этой фичи отдельный ключ Anthropic
 * не нужно. Кэширует результат в БД. При отказе модели возвращает null —
 * вызывающий должен показать нейтральный fallback, не пустоту.
 */
export async function generateScoreAdvice(
  agentId: string,
  score: number,
  breakdown: Record<RoyalScoreCategoryKey, number>,
  recentEvents: { reason: string; delta: number }[]
): Promise<ScoreAdvice | null> {
  const weak = weakestCategory(breakdown);
  const eventsList = recentEvents
    .slice(0, 15)
    .map((e) => `${e.delta >= 0 ? "+" : ""}${e.delta}: ${e.reason}`)
    .join("\n");

  const system = `Ты — тренер отдела продаж недвижимости в Душанбе. По разбору Royal Score агента
даёшь ОДИН короткий совет (2-3 предложения, на русском), что именно улучшить, чтобы
поднять счёт. Опирайся на самую слабую категорию и реальные события из журнала —
без общих слов вроде "работайте усерднее". Пиши по-дружески, но по делу, как
наставник, а не как отчёт. Не упоминай проценты весов категорий, только суть.`;

  const user = `Текущий счёт: ${score} из 100.
Разбивка по категориям (сумма событий за окно, не проценты):
${ROYAL_SCORE_CATEGORIES.map((c) => `${c.label}: ${breakdown[c.key]}`).join("\n")}

Самая слабая категория: ${weak.label} (${weak.sum}).

Последние события журнала:
${eventsList || "событий за окно ещё не было"}`;

  const result = await callGemini<{ advice: string }>({
    endpoint: "score_recommendation",
    system,
    user,
    maxTokens: 300,
    schema: {
      type: "object",
      properties: { advice: { type: "string" } },
      required: ["advice"],
    },
  });
  if (!result?.advice) return null;

  const updated = await prisma.agent.update({
    where: { id: agentId },
    data: { lastScoreAdvice: SAFE_ADVICE_PREFIX + result.advice, lastScoreAdviceAt: new Date() },
    select: { lastScoreAdviceAt: true },
  });
  return { text: result.advice, updatedAt: updated.lastScoreAdviceAt!.toISOString() };
}
