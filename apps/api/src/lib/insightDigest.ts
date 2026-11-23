/**
 * Серверная логика отбора кейсов для «Инсайтов от ИИ» (аудит 02.09 §4.2).
 *
 * ЧТО ДЕЛАЕТ ЭТОТ ФАЙЛ. Собирает кандидатов из трёх источников БЕЗ вызова
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
 *   b) score_penalty — СНЯТ 16.11.2026 вместе с автоматическими штрафами Royal
 *      Score (решение владельца). Вид остался в схеме и на карточке кейса —
 *      старые выпуски должны читаться, — но новых кандидатов не собирает.
 *   c) agent_bypass — источником были находки ночного судьи диалогов; судья
 *      удалён вместе с «Обучением бота», новых таких кейсов нет.
 *      Вид оставлен: его несут уже собранные выпуски.
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
// collectCandidates
// ---------------------------------------------------------------------------

/**
 * Собирает кандидатов из трёх источников за указанный период.
 * НЕ вызывает ИИ, НЕ пишет в БД — только читает и возвращает массив.
 */
export async function collectCandidates(
  periodStart: Date,
  periodEnd: Date,
): Promise<CaseCandidate[]> {
  const [callLow, positives] = await Promise.all([
    collectCallLowScore(periodStart, periodEnd),
    collectPositives(periodStart, periodEnd),
  ]);

  return [...callLow, ...positives];
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