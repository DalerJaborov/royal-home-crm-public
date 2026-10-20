/**
 * Серверная логика отбора кейсов для «Инсайтов от ИИ» (аудит 02.09 §4.2).
 *
 * ЧТО ДЕЛАЕТ ЭТОТ ФАЙЛ. Собирает кандидатов из четырёх источников БЕЗ вызова
 * ИИ, ранжирует их по серьёзности и квотам, и строит JSON-снапшот таймлайна
 * для каждого кейса. ИИ подключается позже (в кроне/роуте) только для
 * формулировки вердикта; здесь — чистая выборка и подготовка данных.
 *
 * ПОЧЕМУ БЕЗ ИИ НА ЭТОМ ШАГЕ. Аудит показал, что сырьё уже есть в базе
 * (разборы звонков, штрафы Royal Score, находки судьи бота), но нет ни
 * агрегации по паре клиент+агент, ни отбора «самых важных», ни маскировки
 * телефонов в снапшоте. Вызов модели на каждом кандидате был бы дорогим и
 * бессмысленным: сначала нужно понять, ЧТО показывать, а потом уже просить
 * модель сформулировать «как надо было».
 *
 * ИСТОЧНИКИ КАНДИДАТОВ:
 *   a) call_low_score — CallAnalysis.score <= 40 ИЛИ (нет следующего шага И
 *      не выявлена потребность), запись >= 60 сек. Голосовые кейсы обязательны
 *      для собрания (минимум 3 на выпуск).
 *   b) score_penalty — RoyalScoreEvent с отрицательной дельтой. Ранжирование
 *      по |delta| * вес вида (потерянные клиенты и пропуск окна важнее
 *      остальных штрафов).
 *   c) agent_bypass — BotAuditFinding type=agent_bypassed_crm severity=high.
 *      Всегда входят в выпуск без ограничений по квоте агента.
 *   d) positive — CallAnalysis.score >= 85. Минимум 1 на выпуск, чтобы
 *      собрание не было только негативом.
 *
 * МАСКИРОВКА ТЕЛЕФОНОВ. Используем maskPhonesDeep из lib/clientPhone.ts —
 * единое правило на всю CRM (см. комментарий в том файле). Снапшоты видят
 * сотрудники без права phone, поэтому маскировка безусловна (canSeeFull=false).
 */

import type { InsightCaseKind } from "@royal-home/shared";
import { prisma } from "../db.js";
import { maskPhonesDeep } from "./clientPhone.js";

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

export interface CaseCandidate {
  kind: InsightCaseKind;
  sourceKey: string;
  agentId: string;
  clientId: string;
  severity: number;
  /** Для ранжирования внутри одного уровня severity. */
  rankScore: number;
  /** Сырые данные для snapshotTimeline — не сериализуются в БД напрямую. */
  raw: Record<string, unknown>;
}

export interface TimelineSnapshot {
  kind: InsightCaseKind;
  /** Маскированный текст разговора / переписки / причины штрафа. */
  content: unknown;
  /** Дополнительные метаданные (score, coaching, delta, recordingUrl). */
  meta: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Веса видов RoyalScoreEvent для ранжирования (аудит §4.2b)
// ---------------------------------------------------------------------------

const SCORE_EVENT_WEIGHT: Record<string, number> = {
  client_lost_agent_fault: 3,
  mandatory_window_overdue: 2,
};
const DEFAULT_SCORE_EVENT_WEIGHT = 1;

// ---------------------------------------------------------------------------
// collectCandidates
// ---------------------------------------------------------------------------

/**
 * Собирает кандидатов из четырёх источников за указанный период.
 * НЕ вызывает ИИ, НЕ пишет в БД — только читает и возвращает массив.
 */
export async function collectCandidates(
  periodStart: Date,
  periodEnd: Date,
): Promise<CaseCandidate[]> {
  const [callLow, scorePenalties, agentBypasses, positives] = await Promise.all([
    collectCallLowScore(periodStart, periodEnd),
    collectScorePenalties(periodStart, periodEnd),
    collectAgentBypasses(periodStart, periodEnd),
    collectPositives(periodStart, periodEnd),
  ]);

  return [...callLow, ...scorePenalties, ...agentBypasses, ...positives];
}

// ---------------------------------------------------------------------------
// Источник A: CallAnalysis с низким скором
// ---------------------------------------------------------------------------

async function collectCallLowScore(
  periodStart: Date,
  periodEnd: Date,
): Promise<CaseCandidate[]> {
  const analyses = await prisma.callAnalysis.findMany({
    where: {
      createdAt: { gte: periodStart, lte: periodEnd },
      interaction: { recordingDurationSec: { gte: 60 } },
      OR: [
        { score: { lte: 40 } },
        { agreedNextStep: false, foundNeed: false },
      ],
    },
    include: {
      interaction: {
        select: {
          id: true,
          clientId: true,
          agentId: true,
          transcript: true,
          recordingUrl: true,
          recordingDurationSec: true,
        },
      },
    },
    orderBy: { score: "asc" },
    take: 50,
  });

  return analyses.map((a) => ({
    kind: "call_low_score" as const,
    sourceKey: `call:${a.interactionId}`,
    agentId: a.agentId,
    clientId: a.interaction.clientId,
    severity: a.score <= 20 ? 5 : a.score <= 30 ? 4 : 3,
    rankScore: 100 - a.score,
    raw: {
      interactionId: a.interactionId,
      score: a.score,
      coaching: a.coaching,
      summary: a.summary,
      objections: a.objections,
      greeted: a.greeted,
      foundNeed: a.foundNeed,
      presentedValue: a.presentedValue,
      handledObjection: a.handledObjection,
      agreedNextStep: a.agreedNextStep,
      transcript: a.interaction.transcript,
      recordingUrl: a.interaction.recordingUrl,
      recordingDurationSec: a.interaction.recordingDurationSec,
    },
  }));
}

// ---------------------------------------------------------------------------
// Источник B: RoyalScoreEvent с отрицательной дельтой
// ---------------------------------------------------------------------------

/**
 * `RoyalScoreEvent.sourceId` НЕ равен id клиента (08.09.2026, разведка по
 * мёртвому коду). Поле — общий составной ключ идемпотентности «что породило
 * событие» (см. комментарий у sourceId в schema.prisma: «id сделки, показа,
 * лида», единого формата нет никогда). Код ниже раньше делал
 * `client.findUnique({ where: { id: e.sourceId } })` — сравнение sourceId
 * напрямую с id клиента. Для events, которые вообще попадают в эту функцию
 * (delta < 0, kind содержит client/lead — то есть client_lost_agent_fault и
 * lead_declined_* / lead_ignored), ни одна реальная схема sourceId так не
 * выглядит (см. lifecycle.ts/clientTransfer.ts/me.ts/inactiveTrafficLight.ts:
 * `client-lost-${id}` или `client-lost-traffic-light-${id}`) — сравнение НЕ
 * совпадало никогда. Самые тяжёлые кандидаты «Инсайтов от ИИ» (вес ×3 в
 * SCORE_EVENT_WEIGHT — потери клиентов) не появлялись ни разу с момента
 * внедрения функции (аудит 02.09.2026): таблица InsightCase на проде пуста.
 *
 * Порядок проверки важен: `client-lost-traffic-light-` длиннее и начинается
 * с той же строки, что `client-lost-`; более короткий префикс проверяется
 * ПОСЛЕ, иначе он забрал бы совпадение первым и обрезал clientId неверно
 * (получилось бы "traffic-light-<настоящий id>" вместо самого id).
 */
const CLIENT_LOST_SOURCE_PREFIXES = ["client-lost-traffic-light-", "client-lost-"] as const;

function extractLostClientId(sourceId: string): string | null {
  for (const prefix of CLIENT_LOST_SOURCE_PREFIXES) {
    if (sourceId.startsWith(prefix)) return sourceId.slice(prefix.length);
  }
  // decline-${agentId}-${clientId}-${n} (lead_declined_*) и lead-ignored-${leadId}-${agentId}-${ts}
  // (lead_ignored) тоже проходят фильтр isClientRelated, но клиента в sourceId
  // не кодируют однозначно (decline — вообще никак, lead-ignored — составной
  // ключ с UUID лида, который сам содержит дефисы, парсить по разделителю
  // небезопасно). Эти events сознательно остаются без кандидата, как и раньше —
  // это НЕ регрессия этой правки, чинить их нужно отдельно, добавив clientId
  // прямым полем в RoyalScoreEvent, а не гаданием по sourceId.
  return null;
}

async function collectScorePenalties(
  periodStart: Date,
  periodEnd: Date,
): Promise<CaseCandidate[]> {
  const events = await prisma.royalScoreEvent.findMany({
    where: {
      at: { gte: periodStart, lte: periodEnd },
      delta: { lt: 0 },
    },
    orderBy: { delta: "asc" },
    take: 50,
  });

  // Фильтруем события, где sourceId указывает на клиента/лида.
  // Для событий без привязки к клиенту (kind не содержит 'client'/'lead')
  // пропускаем — InsightCase требует clientId.
  const withClientId = events
    .map((e) => {
      const kindLower = e.kind.toLowerCase();
      const isClientRelated = kindLower.includes("client") || kindLower.includes("lead");
      if (!isClientRelated || !e.sourceId) return null;
      const clientId = extractLostClientId(e.sourceId);
      return clientId ? { event: e, clientId } : null;
    })
    .filter((x): x is { event: (typeof events)[number]; clientId: string } => x !== null);

  if (withClientId.length === 0) return [];

  // Одним запросом на всю пачку, а не по клиенту на событие (было — до 50
  // запросов на один вызов collectCandidates, тот же класс, что и await
  // внутри map по списку из БД в соседних местах CRM).
  const clients = await prisma.client.findMany({
    // deletedAt: null — удалённого (Корзина) клиента разбирать не нужно: тратить
    // на него внимание/ИИ незачем, карточки уже нет в обычных разделах CRM.
    where: { id: { in: withClientId.map((x) => x.clientId) }, deletedAt: null },
    select: { id: true },
  });
  const existingIds = new Set(clients.map((c) => c.id));

  const candidates: CaseCandidate[] = [];
  for (const { event: e, clientId } of withClientId) {
    if (!existingIds.has(clientId)) continue; // клиента с таким id больше нет (слияние дублей, окончательное удаление)

    const weight = SCORE_EVENT_WEIGHT[e.kind] ?? DEFAULT_SCORE_EVENT_WEIGHT;
    const absDelta = Math.abs(e.delta);

    candidates.push({
      kind: "score_penalty",
      sourceKey: `score:${e.id}`,
      agentId: e.agentId,
      clientId,
      severity: absDelta >= 10 ? 5 : absDelta >= 5 ? 4 : absDelta >= 3 ? 3 : 2,
      rankScore: absDelta * weight,
      raw: {
        eventId: e.id,
        eventKind: e.kind,
        delta: e.delta,
        reason: e.reason,
        sourceId: e.sourceId,
      },
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Источник C: BotAuditFinding agent_bypassed_crm severity=high
// ---------------------------------------------------------------------------

async function collectAgentBypasses(
  periodStart: Date,
  periodEnd: Date,
): Promise<CaseCandidate[]> {
  const findings = await prisma.botAuditFinding.findMany({
    where: {
      type: "agent_bypassed_crm",
      severity: "high",
      createdAt: { gte: periodStart, lte: periodEnd },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  const candidates: CaseCandidate[] = [];

  for (const f of findings) {
    // Диалог и клиента берём из таблицы, к которой относится находка (HELPER-FINAL01):
    // BotConversation (Instagram/WhatsApp/Facebook) или TelegramConversation, id
    // у них uuid и не пересекаются (ai/botAudit.ts судит обе таблицы). Клиент уже
    // привязан к диалогу в clientId; прежний поиск по phone=subscriberId находил
    // его только когда идентификатор канала случайно совпадал с телефоном карточки.
    const conversation =
      (await prisma.botConversation.findUnique({
        where: { id: f.conversationId },
        select: { messages: true, clientId: true },
      })) ??
      (await prisma.telegramConversation.findUnique({
        where: { id: f.conversationId },
        select: { messages: true, clientId: true },
      }));

    if (!conversation) continue;

    // Реплики пишутся с `by` в форме MessageSender: бот {kind:"bot"}, сотрудник
    // {kind:"agent", agentId, agentName} (conversationDelivery.ts). Автор нарушения
    // это сотрудник, а не первая реплика assistant (она чаще принадлежит боту).
    const messages = (conversation.messages ?? []) as Array<{
      role?: string;
      by?: { kind?: string; agentId?: string; agentName?: string };
      content?: string;
    }>;
    const agentMessages = messages.filter((m) => m.by?.kind === "agent" && m.by.agentId);
    // Если в диалоге несколько сотрудников — тот, чья реплика содержит цитату находки.
    const agentMsg = (f.quote && agentMessages.find((m) => m.content?.includes(f.quote))) || agentMessages[0];

    const agentId = agentMsg?.by?.agentId;
    const clientId = conversation.clientId;
    if (!agentId || !clientId) continue;

    candidates.push({
      kind: "agent_bypass",
      sourceKey: `audit:${f.id}`,
      agentId,
      clientId,
      severity: 5, // high severity всегда максимальный
      rankScore: 1000, // гарантированно выше остальных при равном severity
      raw: {
        findingId: f.id,
        quote: f.quote,
        why: f.why,
        channel: f.channel,
        conversationId: f.conversationId,
      },
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Источник D: Положительные кейсы (score >= 85)
// ---------------------------------------------------------------------------

async function collectPositives(
  periodStart: Date,
  periodEnd: Date,
): Promise<CaseCandidate[]> {
  const analyses = await prisma.callAnalysis.findMany({
    where: {
      score: { gte: 85 },
      createdAt: { gte: periodStart, lte: periodEnd },
      interaction: { recordingDurationSec: { gte: 60 } },
    },
    include: {
      interaction: {
        select: {
          id: true,
          clientId: true,
          agentId: true,
          transcript: true,
          recordingUrl: true,
          recordingDurationSec: true,
        },
      },
    },
    orderBy: { score: "desc" },
    take: 20,
  });

  return analyses.map((a) => ({
    kind: "positive" as const,
    sourceKey: `call:${a.interactionId}`,
    agentId: a.agentId,
    clientId: a.interaction.clientId,
    severity: 1, // положительные — минимальная серьёзность
    rankScore: a.score,
    raw: {
      interactionId: a.interactionId,
      score: a.score,
      coaching: a.coaching,
      summary: a.summary,
      strengths: [
        a.greeted && "greeted",
        a.foundNeed && "foundNeed",
        a.presentedValue && "presentedValue",
        a.handledObjection && "handledObjection",
        a.agreedNextStep && "agreedNextStep",
      ].filter(Boolean),
      transcript: a.interaction.transcript,
      recordingUrl: a.interaction.recordingUrl,
      recordingDurationSec: a.interaction.recordingDurationSec,
    },
  }));
}

// ---------------------------------------------------------------------------
// rankAndPick
// ---------------------------------------------------------------------------

/**
 * Отбирает 6–12 кейсов из кандидатов с соблюдением квот:
 *   - Все agent_bypass severity=high — всегда входят
 *   - ≤ 3 кейса на одного агента (кроме agent_bypass)
 *   - ≤ 1 кейс на пару клиент+агент
 *   - ≥ 3 голосовых (call_low_score)
 *   - ≥ 1 положительный (positive)
 *   - Остальные ранжируются по severity (desc), затем по rankScore (desc)
 */
export function rankAndPick(
  candidates: CaseCandidate[],
  min = 6,
  max = 12,
): CaseCandidate[] {
  if (candidates.length === 0) return [];

  // Разделяем обязательные и ранжируемые
  const mandatory: CaseCandidate[] = [];
  const pool: CaseCandidate[] = [];

  for (const c of candidates) {
    if (c.kind === "agent_bypass" && c.severity >= 5) {
      mandatory.push(c);
    } else {
      pool.push(c);
    }
  }

  // Сортируем пул: severity desc, rankScore desc
  pool.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    return b.rankScore - a.rankScore;
  });

  const selected: CaseCandidate[] = [...mandatory];
  const agentCount = new Map<string, number>();
  const pairSeen = new Set<string>();

  // Учитываем квоты mandatory (agent_bypass не считается в лимит агента)
  for (const c of mandatory) {
    pairSeen.add(`${c.clientId}:${c.agentId}`);
  }

  // Гарантируем минимумы: сначала набираем голосовые
  const voicePool = pool.filter((c) => c.kind === "call_low_score");
  const positivePool = pool.filter((c) => c.kind === "positive");
  const otherPool = pool.filter(
    (c) => c.kind !== "call_low_score" && c.kind !== "positive",
  );

  let voiceCount = 0;
  let positiveCount = 0;

  // Набираем минимум 3 голосовых
  for (const c of voicePool) {
    if (voiceCount >= 3) break;
    if (selected.length >= max) break;
    if (!fitsQuotas(c, agentCount, pairSeen)) continue;
    selected.push(c);
    trackSelection(c, agentCount, pairSeen);
    voiceCount++;
  }

  // Набираем минимум 1 положительный
  for (const c of positivePool) {
    if (positiveCount >= 1) break;
    if (selected.length >= max) break;
    if (!fitsQuotas(c, agentCount, pairSeen)) continue;
    selected.push(c);
    trackSelection(c, agentCount, pairSeen);
    positiveCount++;
  }

  // Добираем до min из оставшегося пула (уже отсортированного)
  const remaining = [...otherPool, ...voicePool, ...positivePool].filter(
    (c) => !selected.includes(c),
  );
  remaining.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    return b.rankScore - a.rankScore;
  });

  for (const c of remaining) {
    if (selected.length >= max) break;
    if (selected.length >= min && voiceCount >= 3 && positiveCount >= 1) break;
    if (!fitsQuotas(c, agentCount, pairSeen)) continue;
    selected.push(c);
    trackSelection(c, agentCount, pairSeen);
    if (c.kind === "call_low_score") voiceCount++;
    if (c.kind === "positive") positiveCount++;
  }

  // Если не набрали минимум — берём что есть (PARTIAL статус ставит крон)
  return selected.slice(0, max);
}

function fitsQuotas(
  c: CaseCandidate,
  agentCount: Map<string, number>,
  pairSeen: Set<string>,
): boolean {
  const pairKey = `${c.clientId}:${c.agentId}`;
  if (pairSeen.has(pairKey)) return false;
  const count = agentCount.get(c.agentId) ?? 0;
  if (count >= 3) return false;
  return true;
}

function trackSelection(
  c: CaseCandidate,
  agentCount: Map<string, number>,
  pairSeen: Set<string>,
): void {
  pairSeen.add(`${c.clientId}:${c.agentId}`);
  agentCount.set(c.agentId, (agentCount.get(c.agentId) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// snapshotTimeline
// ---------------------------------------------------------------------------

/**
 * Создаёт JSON-снапшот таймлайна для кейса. Телефоны маскируются
 * безусловно (canSeeFull=false) — снапшоты видят сотрудники без права phone.
 */
export async function snapshotTimeline(
  candidate: CaseCandidate,
): Promise<TimelineSnapshot> {
  const masked = <T>(value: T): T =>
    maskPhonesDeep(value, false) as T;

  switch (candidate.kind) {
    case "call_low_score":
    case "positive": {
      const r = candidate.raw;
      return {
        kind: candidate.kind,
        content: masked(r.transcript as string | null),
        meta: masked({
          score: r.score,
          coaching: r.coaching,
          summary: r.summary,
          recordingUrl: r.recordingUrl,
          recordingDurationSec: r.recordingDurationSec,
          ...(candidate.kind === "positive"
            ? { strengths: r.strengths }
            : {
                objections: r.objections,
                greeted: r.greeted,
                foundNeed: r.foundNeed,
                presentedValue: r.presentedValue,
                handledObjection: r.handledObjection,
                agreedNextStep: r.agreedNextStep,
              }),
        }),
      };
    }

    case "score_penalty": {
      const r = candidate.raw;
      return {
        kind: "score_penalty",
        content: masked(r.reason as string),
        meta: {
          eventKind: r.eventKind,
          delta: r.delta,
          sourceId: r.sourceId,
        },
      };
    }

    case "agent_bypass": {
      // Берём последние 20 реплик диалога
      const r = candidate.raw;
      const conversationId = r.conversationId as string;

      // Пробуем BotConversation, затем TelegramConversation
      let messages: unknown[] = [];
      const botConv = await prisma.botConversation.findUnique({
        where: { id: conversationId },
        select: { messages: true },
      });
      if (botConv) {
        messages = (botConv.messages ?? []) as unknown[];
      } else {
        const tgConv = await prisma.telegramConversation.findFirst({
          where: { chatId: conversationId },
          select: { messages: true },
        });
        if (tgConv) {
          messages = (tgConv.messages ?? []) as unknown[];
        }
      }

      const last20 = messages.slice(-20);

      return {
        kind: "agent_bypass",
        content: masked(last20),
        meta: {
          quote: masked(r.quote as string),
          why: masked(r.why as string),
          channel: r.channel,
          findingId: r.findingId,
        },
      };
    }

    default: {
      // client_lost, complaint — пока не реализованы в collectCandidates,
      // но тип требует обработки. Возвращаем пустой снапшот.
      return {
        kind: candidate.kind,
        content: null,
        meta: {},
      };
    }
  }
}