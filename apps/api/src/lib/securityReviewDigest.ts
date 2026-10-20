/**
 * НЕДЕЛЬНАЯ СВОДКА СБ (план 03.09.2026, §E, п. 2-3).
 *
 * Раньше проверка СБ была очередью по одной карточке (routes/security.ts,
 * «Клиенты в СБ»/«Потерянные объекты») — открой каждую и разберись. Владелец
 * попросил вместо/в дополнение к ней сводку: «43 отказа за неделю, 5 со сделкой
 * на стороне, из них 3 у Фарруха — у остальных агентов 0-1». Очередь по одной
 * карточке НИКУДА НЕ УБРАНА (routes/security.ts не тронут) — это добавка сверху.
 *
 * ИСТОЧНИК ДАННЫХ — AuditLog, а не Client.securityReview/Interaction.notes.
 * Тот же приём, что у lib/problemReport.ts::buildClientsSection («Отказы берём
 * из журнала действий: у Client.refusalReason нет времени, и по нему нельзя
 * сказать, в каком периоде отказ случился»). meta записи (routes/clients/
 * lifecycle.ts и lib/explicitRefusalDetector.ts, оба пишут под одним и тем же
 * action="CLIENT_REFUSE") с 03.09.2026 несёт reason/comment/competitorName/
 * voiceNoteUrl/assignedAgentId — дословная цитата и ссылка на голосовую заметку
 * читаются прямо отсюда, без второго разбора Interaction.notes регэкспом (как
 * это делает routes/security.ts для инициатора — тот приём здесь не повторяем).
 *
 * АНОМАЛИЯ — ПОРОГ, НЕ СТАТИСТИКА (тот же принцип, что и в lib/marketingFunnel.ts:
 * «без z-score и прочей статистики»). Простое правило по словам владельца
 * («больше 2, когда у остальных 0-1»): у агента 3+ случая ЗА НЕДЕЛЮ, и ни у кого
 * из остальных агентов в этот период не набралось больше одного. Если у двоих
 * сразу по 3+ — оба видны в byAgent без пометки «аномалия» (это уже не «один
 * выделяется на фоне нормы», а вопрос ко всей команде, разбор ведёт человек по
 * самим цифрам, а не по одной галочке).
 */
import { REASONS_REQUIRING_SECURITY_REVIEW, REFUSAL_REASON_LABELS, type RefusalReason } from "@royal-home/shared";
import { prisma } from "../db.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Потолок выборки записей журнала — тот же порядок величины и та же причина,
 *  что у REFUSAL_SAMPLE в lib/problemReport.ts: отказов за неделю десятки, но
 *  маршрут без предела однажды вернёт всё разом. */
const AUDIT_SAMPLE_LIMIT = 1000;
/** Потолок карточек-случаев в самой сводке — реальных случаев «сделка на
 *  стороне» за неделю единицы, но предел обязателен по тому же правилу. */
const CASES_LIMIT = 300;
/** «Аномалия»: минимум случаев у самого агента... */
const ANOMALY_MIN_COUNT = 3;
/** ...и максимум у ЛЮБОГО другого агента за тот же период, чтобы считать
 *  первого выделяющимся, а не «у всей команды так». */
const ANOMALY_PEER_MAX = 1;

export interface SecurityReviewCase {
  clientId: string;
  clientShortId: number | null;
  clientFullName: string | null;
  kind: string | null;
  reason: RefusalReason;
  reasonLabel: string;
  agentId: string | null;
  agentName: string | null;
  /** Дословная цитата — meta.comment записи журнала. У ручного отказа это то,
   *  что агент написал в форме; у детектора переписки — сама фраза клиента с
   *  поясняющим префиксом (см. lib/explicitRefusalDetector.ts). */
  quote: string | null;
  competitorName: string | null;
  /** Ссылка на голосовую заметку, если агент её приложил к отказу — ближайший
   *  существующий в CRM аналог «записи разговора» для этого события (звонка,
   *  который надо было бы слушать отдельно, здесь не бывает: сам отказ либо
   *  оформляется текстом в форме, либо детектором по переписке). null — заметки
   *  не было, это НЕ ошибка и не повод считать случай неполным. */
  recordingUrl: string | null;
  /** true — карточку закрыл детектор явного отказа в переписке, а не агент рукам. */
  autoDetected: boolean;
  createdAt: Date;
}

export interface SecurityReviewAgentBreakdown {
  agentId: string;
  agentName: string;
  count: number;
  anomaly: boolean;
}

export interface SecurityReviewDigest {
  from: Date;
  to: Date;
  /** Все отказы периода (любая причина) — знаменатель для «сколько всего». */
  totalRefusals: number;
  /** Из них — причины из REASONS_REQUIRING_SECURITY_REVIEW (сделка могла
   *  состояться на стороне). */
  securityReviewCount: number;
  byAgent: SecurityReviewAgentBreakdown[];
  cases: SecurityReviewCase[];
}

interface AuditMeta {
  reason?: string;
  comment?: string | null;
  competitorName?: string | null;
  voiceNoteUrl?: string | null;
  assignedAgentId?: string | null;
  autoDetected?: boolean;
}

/** Неделя, оканчивающаяся сегодняшней полуночью по Душанбе — тот же расчёт
 *  периода, что у lib/problemReport.ts::problemPeriodRanges("week"), не заводим
 *  вторую версию «что считать неделей» рядом с уже существующей. */
export function defaultWeeklyRange(now: Date = new Date()): { from: Date; to: Date } {
  const to = dushanbeStartOfToday(now);
  return { from: new Date(to.getTime() - 7 * MS_PER_DAY), to };
}

export async function buildSecurityReviewDigest(range?: { from: Date; to: Date }): Promise<SecurityReviewDigest> {
  const { from, to } = range ?? defaultWeeklyRange();

  const rows = await prisma.auditLog.findMany({
    where: { action: "CLIENT_REFUSE", createdAt: { gte: from, lt: to } },
    orderBy: { createdAt: "desc" },
    take: AUDIT_SAMPLE_LIMIT,
    select: { id: true, entityId: true, agentId: true, agentName: true, meta: true, createdAt: true },
  });

  const totalRefusals = rows.length;

  const securityRows = rows.filter((r) => {
    const meta = r.meta as AuditMeta | null;
    return !!meta?.reason && REASONS_REQUIRING_SECURITY_REVIEW.includes(meta.reason as RefusalReason);
  });

  // Клиенты и агенты — двумя запросами на всю сводку, а не по одному на
  // случай: случаев за неделю единицы, но N+1 остаётся N+1 при любом N.
  const clientIds = [...new Set(securityRows.map((r) => r.entityId).filter((id): id is string => !!id))];
  const agentIdsFromMeta = securityRows
    .map((r) => (r.meta as AuditMeta | null)?.assignedAgentId ?? r.agentId)
    .filter((id): id is string => !!id);
  const agentIds = [...new Set(agentIdsFromMeta)];

  const [clients, agents] = await Promise.all([
    clientIds.length
      ? prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, shortId: true, fullName: true, kind: true } })
      : Promise.resolve([]),
    agentIds.length
      ? prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, fullName: true } })
      : Promise.resolve([]),
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const agentNameById = new Map(agents.map((a) => [a.id, a.fullName]));

  const cases: SecurityReviewCase[] = securityRows.slice(0, CASES_LIMIT).map((r) => {
    const meta = (r.meta as AuditMeta | null) ?? {};
    const client = r.entityId ? clientById.get(r.entityId) : undefined;
    const agentId = meta.assignedAgentId ?? r.agentId ?? null;
    const reason = meta.reason as RefusalReason;
    return {
      clientId: r.entityId ?? "",
      clientShortId: client?.shortId ?? null,
      clientFullName: client?.fullName ?? null,
      kind: client?.kind ?? null,
      reason,
      reasonLabel: REFUSAL_REASON_LABELS[reason] ?? reason,
      agentId,
      agentName: (agentId ? agentNameById.get(agentId) : null) ?? null,
      quote: meta.comment?.trim() || null,
      competitorName: meta.competitorName?.trim() || null,
      recordingUrl: meta.voiceNoteUrl?.trim() || null,
      autoDetected: !!meta.autoDetected,
      createdAt: r.createdAt,
    };
  });

  // Разбивка по агентам — считаем по ВСЕМ securityRows (не только по
  // cases.slice(CASES_LIMIT)): счётчик для аномалии обязан быть честным, даже
  // если карточек-случаев в ответе показывается меньше, чем их было на самом деле.
  const countByAgent = new Map<string, number>();
  for (const r of securityRows) {
    const meta = r.meta as AuditMeta | null;
    const agentId = meta?.assignedAgentId ?? r.agentId;
    if (!agentId) continue;
    countByAgent.set(agentId, (countByAgent.get(agentId) ?? 0) + 1);
  }

  const byAgent: SecurityReviewAgentBreakdown[] = [...countByAgent.entries()]
    .map(([agentId, count]) => ({
      agentId,
      agentName: agentNameById.get(agentId) ?? "Агент",
      count,
      anomaly: false,
    }))
    .sort((a, b) => b.count - a.count);

  // Аномалия считается ПОСЛЕ сортировки, по всей карте сразу: агенту нужно
  // сравнение со ВСЕМИ остальными, не только с соседом по списку.
  for (const row of byAgent) {
    if (row.count < ANOMALY_MIN_COUNT) continue;
    const maxOthers = Math.max(0, ...byAgent.filter((o) => o.agentId !== row.agentId).map((o) => o.count));
    row.anomaly = maxOthers <= ANOMALY_PEER_MAX;
  }

  return {
    from,
    to,
    totalRefusals,
    securityReviewCount: securityRows.length,
    byAgent,
    cases,
  };
}
