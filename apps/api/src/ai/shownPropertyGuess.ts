import { callAiText } from "./client.js";

/**
 * КАКОЙ ИМЕННО ОБЪЕКТ ПОКАЗЫВАЛИ — по переписке и записям звонков.
 *
 * ЗАЧЕМ. Проверка со стороны продавца (порог 5 воронки) начинается с вопроса
 * «чьему собственнику звонить». Ответа в базе часто нет: у показа поле объекта
 * заполняют не всегда, а агент мог отправить покупателю пять объектов и показать
 * из них два. Звонить всем пятерым собственникам нельзя — так мы задёргаем
 * продавцов (прямое указание владельца 16.09.2026).
 *
 * Зато у CRM есть то, чего нет ни в одном поле: живая переписка и расшифровки
 * звонков вокруг дня показа. В них адрес обычно назван вслух — «завтра в
 * двенадцать у Садбарга посмотрим», «ту, что на Айни». Модель читает только
 * СПИСОК УЖЕ ИЗВЕСТНЫХ КАНДИДАТОВ и выбирает из него, а не придумывает объект:
 * выбор номера из списка нельзя «сочинить» так, как можно сочинить адрес.
 *
 * НЕ УВЕРЕНА — ЗНАЧИТ НЕ ЗНАЕМ. Ниже порога уверенности объект считается
 * неустановленным, и проверка продавца по этому показу не идёт вовсе. Позвонить
 * не тому собственнику хуже, чем не позвонить никому: это и ложная тревога, и
 * беспокойство человеку, который ни при чём.
 */

export const SHOWN_PROPERTY_CONFIDENCE_MIN = 0.7;

export interface ShownPropertyCandidate {
  propertyId: string;
  title: string;
  address: string | null;
}

export interface ShownPropertyGuess {
  propertyId: string;
  confidence: number;
  quote: string | null;
}

interface RawGuess {
  candidateNumber?: number;
  confidence?: number;
  quote?: string;
}

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    candidateNumber: {
      type: "number",
      description:
        "Номер объекта из списка кандидатов, про который в переписке или разговоре речь как про ПОКАЗАННЫЙ " +
        "(договорились встретиться, поехали смотреть, обсуждают после просмотра). 0 — понять нельзя.",
    },
    confidence: { type: "number", description: "0-1, насколько уверенно выбран объект." },
    quote: {
      type: "string",
      description: "Дословная фраза, из которой это следует. Нет такой фразы — оставь пустым.",
    },
  },
  required: ["candidateNumber"],
};

const SYSTEM_PROMPT = `Тебе дают список объектов недвижимости, которые агентство отправляло одному покупателю, и куски его переписки и расшифровок звонков за дни вокруг просмотра.

Определи, какой из объектов списка ему РЕАЛЬНО ПОКАЗЫВАЛИ вживую.

Правила:
- Выбирай ТОЛЬКО из списка. Никаких других объектов не существует; если речь про что-то, чего в списке нет, ответ 0.
- «Отправили ссылку», «скинул фото», «посмотрю позже» — это НЕ показ. Показ — это когда встретились и приехали смотреть.
- Реплики бывают на русском, на таджикском и смешанные, расшифровка машинная и неточная. Сомневаешься — снижай уверенность, а не угадывай.
- Адреса и районы в Душанбе часто называют на слух и неточно («у Садбарга», «возле Релакса») — это нормальный признак, если он совпадает с адресом объекта.`;

export async function guessShownProperty(
  candidates: ShownPropertyCandidate[],
  excerpts: string[]
): Promise<ShownPropertyGuess | null> {
  if (candidates.length === 0) return null;
  // Один кандидат — гадать не о чем, и тратить вызов модели незачем.
  if (candidates.length === 1) return { propertyId: candidates[0]!.propertyId, confidence: 1, quote: null };

  const text = excerpts.join("\n").trim();
  if (!text) return null;

  const list = candidates
    .map((c, i) => `${i + 1}. ${c.title}${c.address ? ` — ${c.address}` : ""}`)
    .join("\n");

  const raw = await callAiText<RawGuess>({
    endpoint: "shown-property-guess",
    system: SYSTEM_PROMPT,
    user: `Кандидаты:\n${list}\n\nПереписка и разговоры:\n${text}`,
    maxTokens: 200,
    schema: RESULT_SCHEMA,
    simple: true,
  });
  if (!raw) return null;

  const index = typeof raw.candidateNumber === "number" ? Math.trunc(raw.candidateNumber) - 1 : -1;
  const picked = index >= 0 ? candidates[index] : undefined;
  if (!picked) return null;

  const confidence = typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : 0;
  if (confidence < SHOWN_PROPERTY_CONFIDENCE_MIN) return null;

  return { propertyId: picked.propertyId, confidence, quote: raw.quote?.trim() || null };
}
