import { prisma } from "../db.js";
import type { PostShowingCallOutcome, Prisma } from "../generated/prisma/client.js";

/**
 * ЛЕНТА ЗВОНКОВ ПОСЛЕ ПОКАЗА ДЛЯ ЭКРАНОВ РУКОВОДИТЕЛЯ И СБ.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ (17.09.2026). До сегодня раздел «Опросы после показа» в
 * Контроле руководителя и плитка красных флагов в кабинете СБ читали таблицу
 * `ShowingSurveyCall` — вторую реализацию того же механизма, собранную 13.09 в
 * другом чате. Владелец 16.09 решил оставить один механизм (этот: окно
 * 09:00–19:00, звоним только там, где клиент сам ничего не сказал, две попытки,
 * разбор с обязательной цитатой, сторона продавца, досье, порог 4).
 *
 * ЭКРАНЫ ПРИ ЭТОМ НЕ СНОСЯТСЯ — владелец 17.09: «учитывать фронт и внедрять
 * мягко, не портя что построено». Поэтому фронт остаётся какой был, а сюда
 * переезжает только источник данных: те же поля, в том же виде, из
 * `PostShowingCall`. Фронт не знает, что под ним поменяли таблицу.
 *
 * РАСШИФРОВКА И ЗАПИСЬ — ИЗ `LiveVoiceSession` ПО `channelId`. Своей копии
 * разговора эта таблица не держит НАМЕРЕННО: живой голос уже пишет расшифровку и
 * запись в одном месте на все звонки (и на пробные, и на продающие), и вторая
 * копия того же текста разъехалась бы с первой при первой же правке моста.
 */

export interface SurveyFeedFlag {
  category: string;
  detail: string;
}

export interface SurveyFeedRow {
  id: string;
  agentId: string;
  clientId: string;
  propertyId: string | null;
  calledAt: Date | null;
  createdAt: Date;
  transcript: string | null;
  recordingUrl: string | null;
  redFlags: SurveyFeedFlag[];
  escalatedAt: Date | null;
  /** Новые поля — старый фронт их игнорирует, новый показывает. */
  outcome: PostShowingCallOutcome | null;
  outcomeLabel: string | null;
  quote: string | null;
  summary: string | null;
}

/** Исходы, из-за которых звонок считается тревожным: у всех троих материал —
 *  прямое противоречие данным CRM (см. ai/postShowingCallParse.ts). */
const RED_OUTCOMES: PostShowingCallOutcome[] = ["NO_MEETING", "AGENT_COMPLAINT", "BYPASS"];

export const POST_SHOWING_OUTCOME_LABELS: Record<PostShowingCallOutcome, string> = {
  LIKED: "Понравилось",
  NOT_SUITABLE: "Не подошло",
  THINKING: "Думает",
  NO_MEETING: "Говорит, что показа не было",
  AGENT_COMPLAINT: "Жалоба на сотрудника",
  BYPASS: "Похоже на сделку мимо компании",
  REFUSED: "Отказался говорить",
  UNCLEAR: "Не разобрано",
};

/** Только те записи, по которым реально набирали номер: запись, пропущенная по
 *  причине (клиент уже сам ответил, нерабочий час, нет телефона), звонком не
 *  была, и в ленте звонков ей делать нечего. */
const DIALED_WHERE: Prisma.PostShowingCallWhereInput = { lastAttemptAt: { not: null } };

/** Тревожные: либо красный исход разбора, либо пометки по агенту. */
const FLAGGED_WHERE: Prisma.PostShowingCallWhereInput = {
  OR: [{ outcome: { in: RED_OUTCOMES } }, { NOT: { redFlags: { isEmpty: true } } }],
};

/**
 * Находки для экрана. Форма — та же, что у прежней таблицы (`{category, detail}`),
 * и это не случайность: экран подписывает чип по `category`, ища её в своём
 * словаре и падая обратно на саму строку, если не нашёл (Oversight.tsx,
 * RED_FLAG_LABELS). Значит человеческая подпись в `category` читается правильно
 * и со старым словарём, и без него — фронт трогать не пришлось.
 */
function toFlags(row: {
  outcome: PostShowingCallOutcome | null;
  redFlags: string[];
  quote: string | null;
  summary: string | null;
}): SurveyFeedFlag[] {
  const flags: SurveyFeedFlag[] = [];
  // Красный исход — сам по себе находка, даже если отдельных пометок модель не
  // выписала: «клиент говорит, что показа не было» это и есть находка.
  if (row.outcome && RED_OUTCOMES.includes(row.outcome)) {
    const label = POST_SHOWING_OUTCOME_LABELS[row.outcome];
    flags.push({ category: label, detail: row.quote ?? row.summary ?? label });
  }
  for (const flag of row.redFlags) flags.push({ category: flag, detail: flag });
  return flags;
}

const ROW_SELECT = {
  id: true,
  agentId: true,
  clientId: true,
  propertyId: true,
  talkedAt: true,
  lastAttemptAt: true,
  createdAt: true,
  channelId: true,
  outcome: true,
  quote: true,
  summary: true,
  redFlags: true,
} satisfies Prisma.PostShowingCallSelect;

type RawRow = Prisma.PostShowingCallGetPayload<{ select: typeof ROW_SELECT }>;

/** Разговоры живого голоса по каналам — одним запросом на всю страницу (правило
 *  проекта про N+1: по запросу на строку список стоил бы сотню обращений). */
async function sessionsByChannel(rows: RawRow[]): Promise<Map<string, { transcript: string | null; recordingUrl: string | null }>> {
  const channelIds = rows.map((r) => r.channelId).filter((id): id is string => !!id);
  if (channelIds.length === 0) return new Map();
  const sessions = await prisma.liveVoiceSession.findMany({
    where: { channelId: { in: channelIds } },
    select: { channelId: true, transcript: true, recordingUrl: true },
  });
  return new Map(sessions.map((s) => [s.channelId, { transcript: s.transcript, recordingUrl: s.recordingUrl }]));
}

function toFeedRow(row: RawRow, session?: { transcript: string | null; recordingUrl: string | null }): SurveyFeedRow {
  return {
    id: row.id,
    agentId: row.agentId,
    clientId: row.clientId,
    propertyId: row.propertyId,
    // «Когда звонили»: состоявшийся разговор вернее попытки, но если разговора не
    // было, показать надо хотя бы час набора — иначе строка выглядит пустой.
    calledAt: row.talkedAt ?? row.lastAttemptAt,
    createdAt: row.createdAt,
    transcript: session?.transcript ?? null,
    recordingUrl: session?.recordingUrl ?? null,
    redFlags: toFlags(row),
    // Аларм руководителю уходит ровно на красный исход (lib/postShowingCall.ts),
    // отдельной колонки под это нет — и заводить её ради одной галочки не стоит.
    escalatedAt: row.outcome && RED_OUTCOMES.includes(row.outcome) ? (row.talkedAt ?? row.lastAttemptAt) : null,
    outcome: row.outcome,
    outcomeLabel: row.outcome ? POST_SHOWING_OUTCOME_LABELS[row.outcome] : null,
    quote: row.quote,
    summary: row.summary,
  };
}

export async function listPostShowingCallFeed(params: {
  page: number;
  pageSize: number;
  onlyFlagged: boolean;
}): Promise<{ items: SurveyFeedRow[]; total: number }> {
  const where: Prisma.PostShowingCallWhereInput = params.onlyFlagged
    ? { AND: [DIALED_WHERE, FLAGGED_WHERE] }
    : DIALED_WHERE;

  const [total, rows] = await Promise.all([
    prisma.postShowingCall.count({ where }),
    prisma.postShowingCall.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: ROW_SELECT,
    }),
  ]);

  const sessions = await sessionsByChannel(rows);
  return { items: rows.map((r) => toFeedRow(r, r.channelId ? sessions.get(r.channelId) : undefined)), total };
}

export async function findPostShowingCallFeedRow(id: string): Promise<SurveyFeedRow | null> {
  const row = await prisma.postShowingCall.findUnique({ where: { id }, select: ROW_SELECT });
  if (!row) return null;
  const sessions = await sessionsByChannel([row]);
  return toFeedRow(row, row.channelId ? sessions.get(row.channelId) : undefined);
}

/** Красные находки за период — плитка кабинета СБ. */
export async function recentFlaggedPostShowingCalls(since: Date, take = 20) {
  const rows = await prisma.postShowingCall.findMany({
    where: { AND: [DIALED_WHERE, FLAGGED_WHERE], createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take,
    select: ROW_SELECT,
  });
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    clientId: row.clientId,
    createdAt: row.createdAt,
    flags: toFlags(row),
  }));
}
