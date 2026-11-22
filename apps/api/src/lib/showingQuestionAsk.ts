import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { maskPhonesInText } from "./clientPhone.js";

/**
 * «ДОГОВОРИЛИСЬ О ПОКАЗЕ?» — ЗАВЕСТИ ВОПРОС (владелец 22.11.2026).
 *
 * Отдельный лёгкий модуль нарочно: его зовут разбор звонка (ai/callAnalysis.ts) и
 * детектор ручной договорённости в переписке (lib/operatorShowingDetector.ts), а
 * полная дверь вопросов (lib/showingQuestions.ts) тянет за собой отметку задачи и
 * напоминания — через них круг импортов замыкался бы обратно на детектор. Что
 * дальше с вопросом (отправка в Шабнам, ответ, закрытие фактом) — там.
 */

/** Через сколько после разбора разговора спросить «Договорились о показе?». */
export const AGREEMENT_ASK_DELAY_MS = 60_000;

const QUOTE_MAX = 300;

/** Цитата для агента — коротко, одной строкой, номера и контакты маской (номера видит только директор, 18.11.2026). */
function shortQuote(quote: string | null | undefined): string | null {
  const text = maskPhonesInText((quote ?? "").replace(/\s+/g, " ").trim());
  if (text.length < 6) return null;
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1)}…` : text;
}

export interface AgreementQuestionInput {
  agentId: string;
  clientId: string;
  sourceType: "CALL" | "CONVERSATION";
  /** id звонка или `<канал>:<id переписки>:<день>` — один повод = один вопрос. */
  sourceId: string;
  proposedAt: Date | null;
  /** Доказанный объект или null — объект не поняли. */
  propertyId: string | null;
  quote?: string | null;
  now?: Date;
}

/**
 * Рубильник `showingAgreementAskEnabled` проверяет вызывающий (ему же решать, что
 * делать при «выключено»). Повтор того же повода ничего не заводит.
 */
export async function askShowingAgreement(input: AgreementQuestionInput): Promise<"created" | "exists"> {
  const now = input.now ?? new Date();
  try {
    await prisma.showingQuestion.create({
      data: {
        kind: "AGREEMENT",
        dedupKey: `agreement:${input.sourceType}:${input.sourceId}`,
        agentId: input.agentId,
        clientId: input.clientId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        proposedAt: input.proposedAt,
        propertyId: input.propertyId,
        quote: shortQuote(input.quote),
        askAt: new Date(now.getTime() + AGREEMENT_ASK_DELAY_MS),
      },
    });
    return "created";
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "exists";
    throw err;
  }
}
