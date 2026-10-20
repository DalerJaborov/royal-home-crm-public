import { prisma } from "../db.js";
import { callAiText } from "./client.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { sanitizeStyleText } from "./styleLearning.js";

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
  botAnswers?: { question: string; answer: string }[];
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
    botAnswers: {
      type: "array",
      maxItems: 5,
      description: "Частые вопросы клиентов и лучший ответ на них из разговоров — для обучения бота",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
        },
      },
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
 * Кладёт удачные ответы агентов в очередь обучения бота.
 *
 * Дубли отсекаются по вопросу: «есть ли рассрочка» звучит в каждом втором разговоре,
 * и без проверки очередь за месяц наполнилась бы одним и тем же, а каждый случай в
 * ней стоит отдельного вызова модели при ночном разборе.
 *
 * Правила отсюда попадают в промт бота (learnedRulesBlock) и, как все остальные,
 * выключаются владельцем в разделе «Чему бот научился».
 */
async function saveBotAnswers(pairs: InsightsExtract["botAnswers"]): Promise<void> {
  if (!Array.isArray(pairs)) return;
  for (const pair of pairs.slice(0, 5)) {
    // sanitizeStyleText обязателен (26.08.2026): пары берутся из расшифровок
    // ТЕЛЕФОННЫХ разговоров, где агент диктует номера и имена постоянно, а урок
    // из них уезжает в промт каждого диалога с любым клиентом. StyleExample эту
    // угрозу давно чистит — здесь чистки не было вовсе.
    const question = typeof pair?.question === "string" ? sanitizeStyleText(pair.question).slice(0, 400) : "";
    const answer = typeof pair?.answer === "string" ? sanitizeStyleText(pair.answer).slice(0, 600) : "";
    if (!question || !answer) continue;
    try {
      const duplicate = await prisma.botLesson.findFirst({
        where: { kind: "call_answer", botMessage: question },
        select: { id: true },
      });
      if (duplicate) continue;
      await prisma.botLesson.create({
        data: { kind: "call_answer", channel: "PHONE", botMessage: question, humanMessage: answer },
      });
    } catch (err) {
      void logSystemError("ai", `Ответ агента не сохранён для обучения бота: ${describeError(err)}`);
    }
  }
}

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

    // Бот учится у живых продавцов. Пары «о чём спрашивают клиенты» → «как отвечают
    // агенты» уходят в тот же механизм обучения, что работает с ошибками бота
    // (lib/botLessons.ts): ночной разбор выведет из них короткие правила, и они
    // подмешаются в промт. Это самый качественный источник из трёх — не догадка
    // модели и не разбор чужой ошибки, а то, как в агентстве отвечают на самом деле.
    await saveBotAnswers(extract.botAnswers);

    return { ok: true };
  } catch (err) {
    void logSystemError("ai", `Ночной разбор разговоров не удался: ${describeError(err)}`);
    return { ok: false, reason: "ошибка разбора" };
  }
}
