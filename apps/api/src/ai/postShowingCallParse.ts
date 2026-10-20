import { callAiText } from "./client.js";
import { quoteIsInTranscript, withQuoteNotConfirmedNote } from "./callQuoteCheck.js";
import type { PostShowingCallOutcome } from "../generated/prisma/client.js";

/**
 * РАЗБОР РАЗГОВОРА ПОСЛЕ ПОКАЗА — один вызов модели по готовой расшифровке.
 *
 * ПОЧЕМУ НЕ ВО ВРЕМЯ ЗВОНКА, ИНСТРУМЕНТОМ. Модель в разговоре занята разговором;
 * исход, названный ею на ходу, всё равно пришлось бы перепроверять по
 * расшифровке — два источника правды на один факт хуже одного. Здесь виден весь
 * разговор целиком, включая то, что человек сказал вскользь в конце.
 *
 * ПОРОГ УВЕРЕННОСТИ 0,7 — тот же и по той же причине, что в
 * `lib/clientInactiveTextDetector.ts`: ниже него модель начинает «узнавать»
 * жалобу в обычном «да нормально всё, просто квартира не та». Цена ошибки здесь
 * выше, чем там: там она приостановит работу с клиентом, здесь — поднимет
 * руководителя на сотрудника.
 *
 * ЦИТАТА ОБЯЗАТЕЛЬНА ДЛЯ КРАСНЫХ ИСХОДОВ, и это не украшение отчёта. Владельцу
 * предъявляется то, что человек СКАЗАЛ, а не то, как это поняла машина; без
 * дословной фразы разговор превращается в пересказ пересказа, а на таком
 * основании нельзя ни спросить с агента, ни закрыть вопрос. Нет цитаты —
 * исход понижается до «непонятно», то есть обвинения не будет.
 *
 * ОТКАЗ МОДЕЛИ — НЕ ПУСТОЙ ИСХОД. `callAiText` сам повторяет попытку и пишет
 * отказ в журнал; сюда он возвращает null, и звонок остаётся неразобранным
 * (UNCLEAR). Это намеренно: «модель промолчала» не должно выглядеть как
 * «клиенту всё понравилось» — иначе тишина поставщика тихо улучшала бы
 * статистику агента.
 */

export const POST_SHOWING_CALL_CONFIDENCE_MIN = 0.7;

/** Исходы, которые поднимают руководителя ОДИНОЧНЫМ случаем: у всех трёх
 *  материал один — прямое противоречие тому, что записано в CRM. */
export const POST_SHOWING_CALL_RED_OUTCOMES: PostShowingCallOutcome[] = ["NO_MEETING", "AGENT_COMPLAINT", "BYPASS"];

export interface PostShowingCallParse {
  outcome: PostShowingCallOutcome;
  confidence: number | null;
  quote: string | null;
  redFlags: string[];
  summary: string | null;
  /**
   * Красный исход, который модель назвала с высокой уверенностью, но цитата по
   * расшифровке не подтвердилась: исход понижен до UNCLEAR, а руководителю уходит
   * НЕ обвинение, а дело «проверьте звонок» (третий аудит 02.10.2026, В1). Иначе
   * настоящая жалоба, пересказанная моделью чуть иначе, гасла молча.
   */
  unconfirmedOutcome?: PostShowingCallOutcome | null;
}

interface RawParse {
  outcome?: string;
  confidence?: number;
  quote?: string;
  redFlags?: string[];
  summary?: string;
}

const OUTCOMES: PostShowingCallOutcome[] = [
  "LIKED",
  "NOT_SUITABLE",
  "THINKING",
  "NO_MEETING",
  "AGENT_COMPLAINT",
  "BYPASS",
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
        "LIKED — понравилось, думает брать или уже договорились через агентство; NOT_SUITABLE — не подошла; " +
        "THINKING — думает, сравнивает; NO_MEETING — говорит, что показа НЕ БЫЛО, никуда не ездил, никто не " +
        "приезжал; AGENT_COMPLAINT — жалуется на сотрудника (опоздал, не пришёл, показал не то, давил, грубил, " +
        "назвал другую цену); BYPASS — из его слов следует, что дело идёт МИМО агентства: общается с " +
        "сотрудником по личному номеру или в личном мессенджере, договариваются напрямую с собственником, " +
        "задаток или документы без агентства; REFUSED — отказался разговаривать; UNCLEAR — по разговору " +
        "понять нельзя.",
    },
    confidence: { type: "number", description: "0-1, насколько уверенно определён outcome." },
    quote: {
      type: "string",
      description:
        "ДОСЛОВНАЯ фраза собеседника, из которой следует outcome, — без пересказа и без склейки разных реплик. " +
        "Обязательна только для NO_MEETING, AGENT_COMPLAINT и BYPASS. Для остальных исходов и когда подходящей " +
        "дословной фразы нет — верни пустую строку \"\": это нормальный ответ, ничего не выдумывай.",
    },
    redFlags: {
      type: "array",
      items: { type: "string" },
      description:
        "Короткие пометки о сотруднике, если они были: «опоздал», «не пришёл», «показал другой объект», " +
        "«дал личный номер», «просил номер», «предлагал без агентства», «назвал другую цену», «давил», " +
        "«ушёл от ответа про агента». Ничего такого не прозвучало — пустой список.",
    },
    summary: {
      type: "string",
      description: "Одно-два предложения: что человек сказал. Без выводов и без обвинений.",
    },
  },
  // Все четыре поля обязательны (02.10.2026, аудит сценарных звонков №8): без
  // `confidence` в required модель вправе его не прислать, и раньше это валило
  // любой ответ в UNCLEAR. Нормализация ниже всё равно держит пропуск мягко.
  required: ["outcome", "confidence", "quote", "summary"],
};

const SYSTEM_PROMPT = `Ты разбираешь расшифровку короткого телефонного разговора: отдел качества агентства недвижимости Royal Home позвонил ПОКУПАТЕЛЮ через пару часов после просмотра квартиры и спросил, как всё прошло.

Твоя работа — вытащить из разговора факты, а не оценить сотрудника. Выводов не делай, обвинений не строй: ты отвечаешь только на вопрос «что человек сказал».

Правила:
- Разговор может быть на русском, на таджикском или смешанный — это норма для Душанбе.
- Расшифровка машинная: слова бывают распознаны неверно. Если фраза допускает два прочтения, бери более безобидное и снижай уверенность.
- Вежливое «да всё нормально» на вопрос про сотрудника жалобой НЕ является.
- Недовольство КВАРТИРОЙ (дорого, далеко, маленькая, шумно) — это NOT_SUITABLE, а не жалоба на сотрудника.
- «Не помню», «не знаю», уход от ответа — это не NO_MEETING. NO_MEETING только тогда, когда человек прямо говорит, что показа не было.
- Ничего не додумывай за собеседника и не переноси в ответ слова БОТА: тебя интересует только то, что сказал человек.`;

/**
 * Разбирает расшифровку. `null` — модель не ответила (отказ поставщика уже
 * записан в журнал внутри callAiText): звонок останется неразобранным.
 */
export async function parsePostShowingCall(transcript: string[]): Promise<PostShowingCallParse | null> {
  const text = transcript.join("\n").trim();
  if (!text) return null;

  const raw = await callAiText<RawParse>({
    endpoint: "post-showing-call-parse",
    system: SYSTEM_PROMPT,
    user: `Расшифровка разговора:\n${text}`,
    maxTokens: 400,
    schema: RESULT_SCHEMA,
    simple: true,
  });
  if (!raw) return null;

  return normalizePostShowingCallParse(raw, transcript);
}

/**
 * Приведение ответа модели к тому, что можно положить в базу и показать
 * руководителю. Вынесено отдельно от вызова модели, чтобы правила понижения
 * исхода проверялись тестами без сети.
 */
export function normalizePostShowingCallParse(raw: RawParse, transcript?: readonly string[]): PostShowingCallParse {
  const outcome = OUTCOMES.includes(raw.outcome as PostShowingCallOutcome)
    ? (raw.outcome as PostShowingCallOutcome)
    : "UNCLEAR";
  const confidence = typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : null;
  const rawQuote = raw.quote?.trim() ? raw.quote.trim() : null;
  const redFlags = Array.isArray(raw.redFlags) ? raw.redFlags.filter((f) => typeof f === "string" && f.trim()).slice(0, 10) : [];
  const rawSummary = raw.summary?.trim() ? raw.summary.trim() : null;

  const isRed = POST_SHOWING_CALL_RED_OUTCOMES.includes(outcome);

  // ЦИТАТА ОБЯЗАНА НАЙТИСЬ В РАСШИФРОВКЕ (02.10.2026, аудит А3). Модель способна
  // выдумать «дословную» фразу; выдуманная цитата в красном сигнале руководителю —
  // ложное обвинение сотрудника. Не нашли в словах человека — цитата отбрасывается
  // (в базу и в сигнал она не попадёт), красный исход понижается до «непонятно» с
  // пометкой в сводке. НО дальше правила идут как обычно (третий аудит, В1а):
  // прежний ранний `return` обходил порог уверенности, и LIKED с уверенностью 0,2
  // и ненайденной цитатой оставался LIKED и шёл в статистику агента.
  let quote = rawQuote;
  let summary = rawSummary;
  let unconfirmedOutcome: PostShowingCallOutcome | null = null;
  if (transcript && quote && !quoteIsInTranscript(quote, transcript)) {
    quote = null;
    summary = withQuoteNotConfirmedNote(summary);
    // Исход назван уверенно, а доказать его нечем — человеку проверить звонок, не обвиняя.
    if (isRed && !confidenceBelow(raw.confidence, POST_SHOWING_CALL_CONFIDENCE_MIN) && confidence !== null) {
      unconfirmedOutcome = outcome;
    }
  }

  // Красный исход без цитаты или без уверенности — не исход, а догадка.
  // Понижаем до «непонятно»: пометки и сводка остаются, и человек их прочитает,
  // но обвинения система не выдвигает. Пропущенная уверенность здесь тоже
  // «ниже порога»: обвинение требует явной уверенности.
  if (isRed && (!quote || (confidence ?? 0) < POST_SHOWING_CALL_CONFIDENCE_MIN)) {
    return { outcome: "UNCLEAR", confidence, quote, redFlags, summary, unconfirmedOutcome };
  }
  // Обычный исход ниже порога — тоже «непонятно»: неверный исход здесь портит
  // не только карточку, но и статистику доли тишины по агенту. Но только
  // ЯВНО низкая (или негодная) уверенность: поле, которое модель просто не
  // прислала, не превращает «понравилось» в «непонятно» (аудит 02.10.2026, №8).
  if (!isRed && outcome !== "UNCLEAR" && confidenceBelow(raw.confidence, POST_SHOWING_CALL_CONFIDENCE_MIN)) {
    return { outcome: "UNCLEAR", confidence, quote, redFlags, summary };
  }

  return { outcome, confidence, quote, redFlags, summary };
}

/**
 * «Уверенность ниже порога» для обычного (не обвиняющего) исхода. Поля нет
 * вовсе — не ниже: модель могла его не прислать, а ответ от этого не хуже.
 * Число вне 0..1 или не число — негодно, значит ниже.
 */
export function confidenceBelow(raw: unknown, min: number): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "number" || !(raw >= 0 && raw <= 1)) return true;
  return raw < min;
}
