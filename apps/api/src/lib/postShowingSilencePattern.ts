import { prisma } from "../db.js";
import { hasScenarioCallMark } from "./postShowingCalls.js";

/**
 * ПОРОГ 4 ВОРОНКИ — ЗАКОНОМЕРНОСТЬ, А НЕ СЛУЧАЙ
 * (docs/buyer-antifraud-funnel-13-09-2026.md, пороги утверждены владельцем 12.09.2026).
 *
 * ЧТО СЧИТАЕТСЯ. Не конверсия и не «плохо работает»: из десяти показанных людей
 * покупает один, и это норма профессии. Считается ДОЛЯ ПОКАЗОВ, КОНЧИВШИХСЯ
 * ПОЛНОЙ ТИШИНОЙ, — человек съездил, посмотрел и после этого не сказал ни слова
 * ни агенту, ни нам. У честного агента такие случаи тоже есть; вопрос в том,
 * насколько их у него больше, чем у остальных.
 *
 * С КЕМ СРАВНИВАЕМ — С ОСТАЛЬНЫМИ, БЕЗ САМОГО АГЕНТА. Это требование владельца и
 * оно не косметическое: сильный агент с большим числом показов тянет среднюю по
 * агентству вверх и тем самым сам себе поднимает планку, с которой его же и
 * сравнивают. Сравнение «против остальных» этого перекоса не имеет.
 *
 * ШЕСТЬ ПОРОГОВ СХОДЯТСЯ ОДНОВРЕМЕННО, И ЭТО ГЛАВНАЯ ЗАЩИТА ОТ ЛОЖНОЙ ТРЕВОГИ.
 * По отдельности каждый ловит шум: у агента с тремя показами «100% тишины» —
 * это три человека, а не закономерность.
 */

/** Скользящее окно наблюдения. */
export const SILENCE_WINDOW_DAYS = 30;
/** Меньше этого числа показов у агента — считать нечего, слишком мало данных. */
export const SILENCE_MIN_SHOWINGS = 8;
/** Меньше этого числа случаев тишины — это ещё не картина. */
export const SILENCE_MIN_CASES = 4;
/** Во сколько раз доля тишины должна превышать долю остальных. */
export const SILENCE_MIN_RATIO = 2.5;
/** И насколько в абсолюте — в процентных пунктах. */
export const SILENCE_MIN_GAP_PP = 20;
/** Сколько показов должно быть у ОСТАЛЬНЫХ, чтобы их доля вообще что-то значила. */
export const SILENCE_MIN_PEER_SHOWINGS = 20;

export interface AgentSilenceStat {
  agentId: string;
  agentName: string;
  /** Показов с опросом за окно. */
  showings: number;
  /** Из них кончившихся тишиной. */
  silent: number;
  /** Доля тишины у агента, 0–100. */
  ratePercent: number;
  /** Доля тишины у ОСТАЛЬНЫХ (без него), 0–100. */
  peerRatePercent: number;
  peerShowings: number;
  /** Сошлись все шесть порогов. */
  suspicious: boolean;
}

/**
 * ЧТО СЧИТАЕТСЯ ТИШИНОЙ. Ровно то, что осталось неизвестным: не дозвонились
 * вовсе, человек отказался говорить или разговор ничего не прояснил. Клиент,
 * сказавший «не подошла, маленькая кухня», тишиной НЕ считается — исход известен,
 * расследовать нечего. Красные исходы сюда тоже не идут: они поднимают владельца
 * поодиночке и в статистике «доли тишины» им делать нечего.
 */
function isSilent(row: { status: string; outcome: string | null; skipReason?: string | null }): boolean {
  // Трубку брал не тот (жена, чужой номер) — это не молчание покупателя (третий аудит
  // 02.10.2026, В4): пометка `wrong_person` ставится на попытке, где с покупателем не говорили.
  if (row.status === "GIVEN_UP") return !hasScenarioCallMark(row.skipReason, "wrong_person");
  return row.status === "DONE" && (row.outcome === "REFUSED" || row.outcome === "UNCLEAR");
}

/**
 * Доли тишины по агентам за окно. Пропущенные звонки (SKIPPED) в знаменатель не
 * попадают: показ, по которому мы не спрашивали, ничего не говорит об агенте, а
 * попав в знаменатель, он бы ему статистику УЛУЧШАЛ.
 */
export async function computeAgentSilenceStats(
  from: Date,
  to: Date = new Date()
): Promise<AgentSilenceStat[]> {
  const rows = await prisma.postShowingCall.findMany({
    where: { previewOnly: false, createdAt: { gte: from, lt: to }, status: { in: ["GIVEN_UP", "DONE", "NO_ANSWER"] } },
    select: { agentId: true, status: true, outcome: true, skipReason: true, agent: { select: { fullName: true } } },
  });

  const byAgent = new Map<string, { name: string; showings: number; silent: number }>();
  for (const row of rows) {
    const entry = byAgent.get(row.agentId) ?? { name: row.agent.fullName, showings: 0, silent: 0 };
    entry.showings++;
    if (isSilent(row)) entry.silent++;
    byAgent.set(row.agentId, entry);
  }

  const totalShowings = rows.length;
  const totalSilent = rows.filter(isSilent).length;

  const stats: AgentSilenceStat[] = [];
  for (const [agentId, entry] of byAgent) {
    const peerShowings = totalShowings - entry.showings;
    const peerSilent = totalSilent - entry.silent;
    const ratePercent = entry.showings === 0 ? 0 : (entry.silent / entry.showings) * 100;
    const peerRatePercent = peerShowings === 0 ? 0 : (peerSilent / peerShowings) * 100;

    const suspicious =
      entry.showings >= SILENCE_MIN_SHOWINGS &&
      entry.silent >= SILENCE_MIN_CASES &&
      peerShowings >= SILENCE_MIN_PEER_SHOWINGS &&
      peerRatePercent > 0 &&
      ratePercent / peerRatePercent >= SILENCE_MIN_RATIO &&
      ratePercent - peerRatePercent >= SILENCE_MIN_GAP_PP;

    stats.push({
      agentId,
      agentName: entry.name,
      showings: entry.showings,
      silent: entry.silent,
      ratePercent: Math.round(ratePercent),
      peerRatePercent: Math.round(peerRatePercent),
      peerShowings,
      suspicious,
    });
  }

  return stats.sort((a, b) => b.ratePercent - a.ratePercent);
}

export interface ProvableCase {
  clientName: string;
  clientShortId: number;
  agentName: string;
  agentId: string;
  propertyTitle: string | null;
  /** Чем именно случай доказуем — одной строкой. */
  what: string;
  /** Дословная фраза человека. Пусто — доказательство не в словах, а в данных. */
  quote: string | null;
  at: Date;
}

/**
 * САМЫЙ ДОКАЗУЕМЫЙ СЛУЧАЙ МЕСЯЦА — просьба владельца 12.09: в отчёте нужен не
 * самый ДОЛГИЙ и не самый громкий случай, а тот, который можно предъявить, и
 * кликабельный на карточку клиента, чтобы посмотреть хронологию.
 *
 * Порядок силы, сверху вниз:
 *  1. сошлись обе стороны — собственник сказал «уже продал», а покупатель молчит;
 *  2. покупатель прямым текстом описал сделку мимо компании;
 *  3. покупатель говорит, что показа не было вовсе, — а в CRM показ отмечен;
 *  4. жалоба на сотрудника с дословной фразой.
 *
 * У всех четырёх материал — не мнение системы, а слова человека и прямое
 * противоречие данным CRM. Случаи без цитаты сюда не попадают вовсе.
 */
export async function findMostProvableCase(from: Date, to: Date = new Date()): Promise<ProvableCase | null> {
  const [sellerConfirmed, buyerRed] = await Promise.all([
    prisma.sellerProbeCall.findMany({
      where: { previewOnly: false, postShowingCallId: { not: null }, createdAt: { gte: from, lt: to }, outcome: "SOLD_ELSEWHERE", quote: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        quote: true,
        createdAt: true,
        agentId: true,
        agent: { select: { fullName: true } },
        property: { select: { title: true } },
        postShowingCall: { select: { client: { select: { fullName: true, shortId: true } } } },
      },
    }),
    prisma.postShowingCall.findMany({
      where: {
        previewOnly: false,
        outcomeConfidence: { gte: 0.7 },
        createdAt: { gte: from, lt: to },
        outcome: { in: ["BYPASS", "NO_MEETING", "AGENT_COMPLAINT"] },
        quote: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        outcome: true,
        quote: true,
        createdAt: true,
        agentId: true,
        agent: { select: { fullName: true } },
        property: { select: { title: true } },
        client: { select: { fullName: true, shortId: true } },
      },
    }),
  ]);

  const best = sellerConfirmed.find(row => row.postShowingCall !== null);
  if (best?.postShowingCall) {
    return {
      clientName: best.postShowingCall.client.fullName,
      clientShortId: best.postShowingCall.client.shortId,
      agentName: best.agent.fullName,
      agentId: best.agentId,
      propertyTitle: best.property.title,
      what: "В опросе собственника записана продажа в другом месте. Уверенность не записана; цитата требует проверки человеком и сопоставления со сделками. Это не вывод о виновности агента",
      quote: best.quote,
      at: best.createdAt,
    };
  }

  const priority: Record<string, number> = { BYPASS: 0, NO_MEETING: 1, AGENT_COMPLAINT: 2 };
  const whatByOutcome: Record<string, string> = {
    BYPASS: "Покупатель описал сделку мимо компании",
    NO_MEETING: "Покупатель говорит, что показа не было, — а в CRM он отмечен проведённым",
    AGENT_COMPLAINT: "Покупатель пожаловался на сотрудника",
  };
  const top = [...buyerRed].sort(
    (a, b) => (priority[a.outcome ?? ""] ?? 9) - (priority[b.outcome ?? ""] ?? 9)
  )[0];
  if (!top) return null;

  return {
    clientName: top.client.fullName,
    clientShortId: top.client.shortId,
    agentName: top.agent.fullName,
    agentId: top.agentId,
    propertyTitle: top.property?.title ?? null,
    what: whatByOutcome[top.outcome ?? ""] ?? "Красный исход опроса",
    quote: top.quote,
    at: top.createdAt,
  };
}
