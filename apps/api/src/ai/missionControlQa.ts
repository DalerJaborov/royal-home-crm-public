import { callAiText } from "./client.js";

/**
 * «Вопрос к данным» (план §6, фаза 4, п.8) — единственное место, где модель
 * отвечает СВОБОДНЫМ текстом по снапшоту `missionControlAsk.ts`, а не разбирает
 * переписку с клиентом. Отдельным модулем по тому же принципу, что и остальной
 * `ai/` (ai/askOwner.ts, ai/photoOffer.ts): только текст промта и разбор ответа,
 * ни строчки про базу — сбор данных живёт в `lib/missionControlAsk.ts`.
 *
 * ПРОМТ ЗАПРЕЩАЕТ ЛЮБОЕ ЗНАНИЕ ВНЕ ДАННЫХ — владелец задаёт вопрос про свою
 * компанию, а не про рынок недвижимости вообще; модель обязана либо ответить по
 * присланному JSON, либо честно сказать «этого на дашборде нет», а не выдумывать.
 */

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "Краткий ответ владельцу на русском (1-3 предложения), основанный ТОЛЬКО на присланных данных. " +
        "Если в данных нет ответа — так и скажи, не выдумывай.",
    },
  },
  required: ["answer"],
};

const MAX_QUESTION_LEN = 300;
const MAX_ANSWER_LEN = 1500;

export async function answerMissionControlQuestion(question: string, contextJson: string): Promise<string | null> {
  const system =
    "Ты — аналитик CRM агентства недвижимости Royal Home в Душанбе. Ниже — ТЕКУЩИЙ СНИМОК ДАННЫХ компании " +
    "в формате JSON (команда по агентам, сделки и лиды за месяц, звонки сегодня, воронка маркетинга по " +
    "каналам, объекты, здоровье системы). Владелец задаёт вопрос об этих данных.\n\n" +
    "ПРАВИЛА (обязательны):\n" +
    "1. Отвечай ТОЛЬКО на основании данных ниже — никаких догадок, никаких общих знаний о рынке.\n" +
    "2. Если нужных для ответа данных в JSON нет, честно скажи, что на дашборде этого нет, и не гадай.\n" +
    "3. Деньги называй в сомони (TJS), если в данных есть суммы — их можно называть, только если seesMoney=true.\n" +
    "4. Отвечай КРАТКО — 1-3 предложения, без списков, без markdown, без пересказа JSON.\n" +
    "5. Отвечай на русском языке.\n\n" +
    `ДАННЫЕ:\n${contextJson}`;

  const r = await callAiText<{ answer?: string }>({
    endpoint: "mission-control-ask",
    system,
    user: question.trim().slice(0, MAX_QUESTION_LEN),
    maxTokens: 400,
    effort: "medium",
    schema: ANSWER_SCHEMA,
  });

  const answer = r?.answer?.trim();
  if (!answer) return null;
  return answer.slice(0, MAX_ANSWER_LEN);
}
