import { matchTierLabel, sentAgoText, type MatchEvidence as Evidence, type MatchSendHistory } from "@royal-home/shared";

/**
 * Уровень совпадения чипом: «🎯 Точно подходит / 👍 Можно предложить / ❓ Уточнить».
 * Один и тот же для объекта под клиента и клиента под объект (подбор 2.0,
 * 10.11.2026) — подписи живут в @royal-home/shared, их же пишет помощница в Telegram.
 */
export function MatchTierChip({ tier }: { tier: Evidence["tier"] }) {
  return <span className={`chip${tier === "exact" ? " ok" : tier === "alternative" ? " warn" : ""}`}>{matchTierLabel(tier)}</span>;
}

/** «Уже отправляли 3 дня назад» — чипом среди примет, если отправляли. */
export function MatchSentChip({ history }: { history: MatchSendHistory }) {
  const text = sentAgoText(history);
  return text ? <span className="chip">{text}</span> : null;
}

/**
 * ОБЩЕЕ «ЧЕГО НЕ ЗНАЕМ О КЛИЕНТЕ» (владелец 20.11.2026, кадры с iPhone): на КАЖДОЙ карточке объекта повторялась одна и та же
 * простыня «Не знаем: Клиент не назвал район · бюджет · комнаты / Спросить: …». Что общее для всего списка, выносится
 * один раз над ним, а карточка оставляет только своё («этаж 13 из 15 — уточнить»). Общее — то, что есть у КАЖДОГО объекта
 * списка; при одном объекте выносить нечего.
 */
export interface CommonMatchGaps { unknowns: string[]; ask: string[]; hide: ReadonlySet<string> }
export function commonMatchGaps(items: ReadonlyArray<{ match?: Evidence }>): CommonMatchGaps {
  const withMatch = items.map((i) => i.match).filter((m): m is Evidence => !!m);
  const empty: CommonMatchGaps = { unknowns: [], ask: [], hide: new Set() };
  if (withMatch.length < 2 || withMatch.length !== items.length) return empty;
  const everywhere = (pick: (m: Evidence) => string[]) => pick(withMatch[0]).filter((text) => withMatch.every((m) => pick(m).includes(text)));
  const unknowns = everywhere((m) => m.unknowns);
  const ask = everywhere((m) => m.ask);
  return { unknowns, ask, hide: new Set([...unknowns, ...ask]) };
}

/** Общий блок над списком подбора: один раз, а не на каждой карточке. */
export function MatchCommonGaps({ gaps }: { gaps: CommonMatchGaps }) {
  if (!gaps.unknowns.length && !gaps.ask.length) return null;
  return (
    <div className="client-match-evidence client-match-common" data-testid="match-common-gaps">
      {gaps.unknowns.length > 0 && <p>Чего мы не знаем о клиенте: {gaps.unknowns.join(" · ")}</p>}
      {gaps.ask.length > 0 && <p>Спросить у клиента: {gaps.ask.join(" · ")}</p>}
    </div>
  );
}

/** Что совпало, где уступка, чего не знаем и что спросить — четыре короткие строки. `hide` — общее, уже показанное над списком. */
export function MatchEvidenceLines({ match, hide }: { match: Evidence; hide?: ReadonlySet<string> }) {
  const unknowns = hide ? match.unknowns.filter((t) => !hide.has(t)) : match.unknowns;
  const ask = hide ? match.ask.filter((t) => !hide.has(t)) : match.ask;
  if (!match.reasons.length && !match.tradeoffs.length && !unknowns.length && !ask.length) return null;
  return (
    <div className="client-match-evidence">
      {match.reasons.length > 0 && <p>Совпало: {match.reasons.join(" · ")}</p>}
      {match.tradeoffs.length > 0 && <p className="client-match-tradeoff">Уступка: {match.tradeoffs.join(" · ")}</p>}
      {unknowns.length > 0 && <p>Не знаем: {unknowns.join(" · ")}</p>}
      {ask.length > 0 && <p>Спросить: {ask.join(" · ")}</p>}
    </div>
  );
}
