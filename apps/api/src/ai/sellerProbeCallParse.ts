import { callAiText } from "./client.js";
import { quoteIsInTranscript, withQuoteNotConfirmedNote } from "./callQuoteCheck.js";
import { confidenceBelow } from "./postShowingCallParse.js";
import type { SellerProbeCallOutcome } from "../generated/prisma/client.js";

/**
 * РАЗБОР РАЗГОВОРА С СОБСТВЕННИКОМ (порог 5.2 воронки).
 *
 * Правила те же, что у разбора опроса покупателя (`postShowingCallParse.ts`), и
 * по тем же причинам: порог уверенности, обязательная дословная цитата у
 * «продал» и отказ модели, который НЕ превращается в благополучный исход.
 *
 * Отдельный модуль, а не ветка в том разборе: вопросы разные, исходы разные, а
 * общий «универсальный» промт на два сценария всегда кончается тем, что правки
 * под один ломают другой.
 */

export const SELLER_PROBE_CONFIDENCE_MIN = 0.7;

export interface SellerProbeParse {
  outcome: SellerProbeCallOutcome;
  confidence: number | null;
  quote: string | null;
  summary: string | null;
  /**
   * Тревожный исход («продал», «передумал»), названный уверенно, но с цитатой, не
   * подтверждённой расшифровкой: исход понижен до UNCLEAR, директору уходит дело
   * «проверьте звонок», а не аларм (третий аудит 02.10.2026, В1).
   */
  unconfirmedOutcome?: SellerProbeCallOutcome | null;
}

interface RawParse {
  outcome?: string;
  confidence?: number;
  quote?: string;
  summary?: string;
}

const OUTCOMES: SellerProbeCallOutcome[] = [
  "STILL_SELLING",
  "SOLD_ELSEWHERE",
  "OWNER_CHANGED_MIND",
  "REFUSED",
  "UNCLEAR",
];

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: OUTCOMES as unknown as string[],
      description:
        "STILL_SELLING — квартира в продаже, всё как было; SOLD_ELSEWHERE — уже продал или продаёт кому-то " +
        "конкретному, сделка идёт; OWNER_CHANGED_MIND — передумал продавать, снимает с продажи (не продал); " +
        "REFUSED — отказался разговаривать; UNCLEAR — понять нельзя.",
    },
    confidence: { type: "number", description: "0-1, насколько уверенно определён outcome." },
    quote: {
      type: "string",
      description:
        "ДОСЛОВНАЯ фраза собственника, из которой следует outcome. Обязательна только для SOLD_ELSEWHERE. " +
        "Для остальных исходов и когда подходящей фразы нет — верни пустую строку \"\": это нормальный ответ, " +
        "не пересказывай и не выдумывай.",
    },
    summary: { type: "string", description: "Одно предложение: что сказал собственник." },
  },
  // Все поля обязательны (02.10.2026, аудит №8) — см. postShowingCallParse.ts.
  required: ["outcome", "confidence", "quote", "summary"],
};

const SYSTEM_PROMPT = `Ты разбираешь расшифровку короткого звонка агентства недвижимости Royal Home СОБСТВЕННИКУ квартиры. Агентство спросило, актуально ли объявление: квартира ещё в продаже или он передумал.

Твоя работа — записать, что человек ответил. Никаких выводов о сотрудниках агентства не делай: их в этом разговоре не обсуждали и обсуждать было нельзя.

Правила:
- «Продал» и «передумал продавать» — РАЗНЫЕ ответы, не путай их.
- «Пока думаю», «подождите», «перезвоните» — это не отказ и не продажа, это UNCLEAR.
- Разговор может быть на русском, на таджикском или смешанный; расшифровка машинная и неточная. Сомневаешься — снижай уверенность.
- В ответ бери только слова СОБСТВЕННИКА, не реплики бота.`;

export async function parseSellerProbeCall(transcript: string[]): Promise<SellerProbeParse | null> {
  const text = transcript.join("\n").trim();
  if (!text) return null;

  const raw = await callAiText<RawParse>({
    endpoint: "seller-probe-call-parse",
    system: SYSTEM_PROMPT,
    user: `Расшифровка разговора:\n${text}`,
    maxTokens: 300,
    schema: RESULT_SCHEMA,
    simple: true,
  });
  if (!raw) return null;

  return normalizeSellerProbeParse(raw, transcript);
}

export function normalizeSellerProbeParse(raw: RawParse, transcript?: readonly string[]): SellerProbeParse {
  const outcome = OUTCOMES.includes(raw.outcome as SellerProbeCallOutcome)
    ? (raw.outcome as SellerProbeCallOutcome)
    : "UNCLEAR";
  const confidence =
    typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : null;
  const rawQuote = raw.quote?.trim() ? raw.quote.trim() : null;
  const rawSummary = raw.summary?.trim() ? raw.summary.trim() : null;

  // ЦИТАТА ОБЯЗАНА НАЙТИСЬ В РАСШИФРОВКЕ (02.10.2026, аудит А3): модель способна
  // выдумать «дословную» фразу собственника, а с ней уходит аларм директору.
  // Не нашли в словах человека — цитата отбрасывается, а исход, по которому
  // директору что-то поручают или о чём тревожат («продал», «передумал»),
  // понижается до «непонятно» с пометкой в сводке. Дальше правила идут как
  // обычно (третий аудит, В1а): ранний `return` обходил порог уверенности.
  const alarming = outcome === "SOLD_ELSEWHERE" || outcome === "OWNER_CHANGED_MIND";
  let quote = rawQuote;
  let summary = rawSummary;
  let unconfirmedOutcome: SellerProbeCallOutcome | null = null;
  let downgraded: SellerProbeCallOutcome = outcome;
  if (transcript && quote && !quoteIsInTranscript(quote, transcript)) {
    quote = null;
    summary = withQuoteNotConfirmedNote(summary);
    if (alarming) {
      downgraded = "UNCLEAR";
      if (confidence !== null && !confidenceBelow(raw.confidence, SELLER_PROBE_CONFIDENCE_MIN)) unconfirmedOutcome = outcome;
    }
  }
  if (downgraded === "UNCLEAR" && outcome !== "UNCLEAR") {
    return { outcome: "UNCLEAR", confidence, quote, summary, unconfirmedOutcome };
  }

  // «Продал мимо нас» без дословной фразы — пересказ машины, а не показание
  // человека. С таким к владельцу не приходят.
  if (outcome === "SOLD_ELSEWHERE" && (!quote || (confidence ?? 0) < SELLER_PROBE_CONFIDENCE_MIN)) {
    return { outcome: "UNCLEAR", confidence, quote, summary };
  }
  // Обычный исход понижается только при ЯВНО низкой уверенности: пропущенное
  // поле не делает «ещё в продаже» непонятным (аудит 02.10.2026, №8).
  if (outcome !== "UNCLEAR" && confidenceBelow(raw.confidence, SELLER_PROBE_CONFIDENCE_MIN)) {
    return { outcome: "UNCLEAR", confidence, quote, summary };
  }
  return { outcome, confidence, quote, summary };
}
