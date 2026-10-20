import { callAiText } from "./client.js";

/**
 * РАЗБОР ЗВОНКА С ПРИГЛАШЕНИЕМ НА СОБЕСЕДОВАНИЕ (25.09.2026).
 *
 * Те же правила, что у остальных разборов звонков (sellerProbeCallParse.ts):
 * порог уверенности и отказ модели, который НЕ превращается в благополучный
 * исход. «Придёт» без уверенности хуже «непонятно»: HR перестанет следить, а
 * кандидат не придёт.
 */

export const INTERVIEW_INVITE_OUTCOMES = ["CONFIRMED", "RESCHEDULE", "DECLINED", "UNCLEAR"] as const;
export type InterviewInviteOutcome = (typeof INTERVIEW_INVITE_OUTCOMES)[number];

export const INTERVIEW_INVITE_CONFIDENCE_MIN = 0.7;

export interface InterviewInviteParse {
  outcome: InterviewInviteOutcome;
  confidence: number | null;
  proposedTime: string | null;
  quote: string | null;
  summary: string | null;
}

interface RawParse {
  outcome?: string;
  confidence?: number;
  proposedTime?: string;
  quote?: string;
  summary?: string;
}

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: INTERVIEW_INVITE_OUTCOMES as unknown as string[],
      description:
        "CONFIRMED — согласился прийти в названное время; RESCHEDULE — хочет прийти, но в другое время; " +
        "DECLINED — больше не интересно, не придёт; UNCLEAR — понять нельзя.",
    },
    confidence: { type: "number", description: "0-1, насколько уверенно определён outcome." },
    proposedTime: {
      type: "string",
      description: "Только для RESCHEDULE: какой день и время кандидат назвал удобными, его словами по-русски.",
    },
    quote: { type: "string", description: "ДОСЛОВНАЯ фраза кандидата, из которой следует outcome." },
    summary: { type: "string", description: "Одно-два предложения по-русски: что сказал кандидат." },
  },
  // Без confidence в обязательных модель его часто опускала, и любой ясный
  // ответ становился «непонятно» (проверка робота 02.10.2026).
  required: ["outcome", "confidence", "quote", "summary"],
};

const SYSTEM_PROMPT = `Ты разбираешь расшифровку короткого звонка агентства недвижимости Royal Home кандидату на работу. Агентство пригласило его на собеседование в конкретное время.

Твоя работа — записать, что кандидат ответил.

Правила:
- «Да, приду», «хорошо, буду», «ҳа, меоям», «хуб» в ответ на приглашение — CONFIRMED.
- Согласен прийти, но в другой день или час — RESCHEDULE, и запиши, когда ему удобно.
- «Уже нашёл работу», «не интересно», «не приду» — DECLINED.
- «Подумаю», «перезвоните», оборванный разговор — UNCLEAR.
- Разговор может быть на русском, на таджикском или смешанный; расшифровка машинная и неточная. Сомневаешься — снижай уверенность.
- В ответ бери только слова КАНДИДАТА, не реплики бота. Итог пиши по-русски.`;

export async function parseInterviewInviteCall(transcript: string[]): Promise<InterviewInviteParse | null> {
  const text = transcript.join("\n").trim();
  if (!text) return null;
  const raw = await callAiText<RawParse>({
    endpoint: "interview-invite-call-parse",
    system: SYSTEM_PROMPT,
    user: `Расшифровка разговора:\n${text}`,
    maxTokens: 300,
    schema: RESULT_SCHEMA,
    simple: true,
  });
  if (!raw) return null;
  return normalizeInterviewInviteParse(raw);
}

export function normalizeInterviewInviteParse(raw: RawParse): InterviewInviteParse {
  const outcome = (INTERVIEW_INVITE_OUTCOMES as readonly string[]).includes(raw.outcome ?? "")
    ? (raw.outcome as InterviewInviteOutcome)
    : "UNCLEAR";
  const confidence =
    typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : null;
  const clean = (v: string | undefined) => (v?.trim() ? v.trim() : null);
  const proposedTime = outcome === "RESCHEDULE" ? clean(raw.proposedTime) : null;
  const base = { confidence, proposedTime, quote: clean(raw.quote), summary: clean(raw.summary) };
  // Низкая уверенность — «непонятно». Уверенность не прислана вовсе: «придёт»
  // без неё не верим (HR перестанет следить), а «другое время» и «отказ» HR и
  // так получает уведомлением — их оставляем как есть.
  const unsure =
    confidence === null ? outcome === "CONFIRMED" : confidence < INTERVIEW_INVITE_CONFIDENCE_MIN;
  if (outcome !== "UNCLEAR" && unsure) {
    return { outcome: "UNCLEAR", ...base, proposedTime: null };
  }
  return { outcome, ...base };
}
