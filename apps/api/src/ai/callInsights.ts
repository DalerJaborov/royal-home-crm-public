import { prisma } from "../db.js";
import { callAiText } from "./client.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";

/**
 * Ночной разбор всех разговоров: где агентство сильно, где просаживается.
 *
 * Отличие от сводки в разделе «Звонки»: та считает цифры (средний счёт, доля
 * договорённостей, частота возражений) — их и должно считать запросами к базе.
 * Здесь другой вопрос — ЧТО С ЭТИМ ДЕЛАТЬ. Цифра «договорённость в 40% разговоров»
 * не говорит, почему так и с чего начать; ответ виден только в самих формулировках
 * клиентов и агентов, и его собирает модель.
 *
 * Разбор строится по РАЗБОРАМ разговоров, а не по расшифровкам: полные тексты за
 * месяц не поместятся ни в один запрос, а сводки уже содержат суть, возражения и
 * договорённости. Это же делает разбор дешёвым — один вызов в сутки.
 */

/** Меньше этого числа разговоров разбирать нечего: выводы по трём звонкам — гадание. */
const MIN_CALLS = 8;
/** Сколько разборов уходит в запрос. Тридцать дней работы агентства помещаются. */
const MAX_ANALYSES = 200;

export interface CallInsightsResult {
  ok: boolean;
  reason?: string;
}

interface InsightsExtract {
  strengths?: string[];
  weaknesses?: string[];
  clientDemand?: string[];
  recommendations?: string[];
}

const insightsSchema = {
  type: "object",
  required: ["strengths", "weaknesses", "recommendations"],
  properties: {
    strengths: {
      type: "array",
      items: { type: "string" },
      maxItems: 4,
      description: "Что у агентства получается в разговорах, коротко и конкретно",
    },
    weaknesses: {
      type: "array",
      items: { type: "string" },
      maxItems: 4,
      description: "Где теряем клиентов: не общие слова, а что именно происходит в разговорах",
    },
    clientDemand: {
      type: "array",
      items: { type: "string" },
      maxItems: 5,
      description: "Что рынок спрашивает: районы, бюджеты, типы жилья, требования — по частоте упоминаний",
    },
    recommendations: {
      type: "array",
      items: { type: "string" },
      maxItems: 4,
      description: "Что сделать руководителю на этой неделе. Конкретные действия, а не пожелания",
    },
  },
};

const SYSTEM_PROMPT =
  "Ты разбираешь работу агентства недвижимости Royal Home (Душанбе) по итогам телефонных разговоров с клиентами. " +
  "На входе — короткие разборы каждого разговора: оценка, что сделано и что нет, возражения клиента, договорённости. " +
  "Твоя задача — увидеть закономерности, а не пересказать отдельные звонки. " +
  // Общие слова («улучшить коммуникацию») читаются один раз и не меняют ничего.
  "Пиши конкретно и по-русски: не «улучшить работу с возражениями», а «на возражение о цене агенты " +
  "соглашаются и заканчивают разговор — нужен ответ про рассрочку и торг». " +
  "Если данных для вывода мало, лучше промолчать, чем придумать. " +
  "Ответ передавай через инструмент submit_reply.";

/**
 * Собирает разбор за период: сильные и слабые стороны, спрос рынка, что делать.
 *
 * Наружу не бросает: ночная задача не должна ронять расписание из-за отказа модели.
 */
export async function buildCallInsights(days = 30): Promise<CallInsightsResult> {
  try {
    // Ровно N суток назад, без выравнивания на начало дня: разбор смотрит на
    // скользящее окно, а не на календарный период, — граница дня тут ничего не решает.
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const analyses = await prisma.callAnalysis.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: MAX_ANALYSES,
      select: {
        score: true,
        foundNeed: true,
        presentedValue: true,
        handledObjection: true,
        agreedNextStep: true,
        objections: true,
        agreements: true,
        summary: true,
        coaching: true,
        agent: { select: { fullName: true } },
      },
    });

    if (analyses.length < MIN_CALLS) {
      return { ok: false, reason: `разговоров пока мало (${analyses.length})` };
    }

    const lines = analyses.map((a) => {
      const steps = [
        a.foundNeed ? "потребность+" : "потребность−",
        a.presentedValue ? "ценность+" : "ценность−",
        a.handledObjection ? "возражение+" : "возражение−",
        a.agreedNextStep ? "договорённость+" : "договорённость−",
      ].join(" ");
      const objections = a.objections.length ? ` | возражения: ${a.objections.join(", ")}` : "";
      const agreements = a.agreements.length ? ` | договорились: ${a.agreements.join(", ")}` : "";
      return `${a.agent.fullName} · ${a.score} · ${steps}${objections}${agreements} — ${a.summary}`;
    });

    const extract = await callAiText<InsightsExtract>({
      endpoint: "call-insights",
      system: SYSTEM_PROMPT,
      user: `Разборы разговоров за ${days} дней (${analyses.length} штук):\n\n${lines.join("\n")}`,
      maxTokens: 900,
      schema: insightsSchema,
    });
    if (!extract) return { ok: false, reason: "модель не ответила" };

    const list = (v: unknown, max = 4) =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()).slice(0, max) : [];

    const strengths = list(extract.strengths);
    const weaknesses = list(extract.weaknesses);
    const recommendations = list(extract.recommendations);
    if (strengths.length === 0 && weaknesses.length === 0 && recommendations.length === 0) {
      return { ok: false, reason: "выводов нет" };
    }

    await prisma.callInsight.create({
      data: {
        days,
        calls: analyses.length,
        strengths,
        weaknesses,
        demand: list(extract.clientDemand, 5),
        actions: recommendations,
      },
    });

    return { ok: true };
  } catch (err) {
    void logSystemError("ai", `Ночной разбор разговоров не удался: ${describeError(err)}`);
    return { ok: false, reason: "ошибка разбора" };
  }
}
