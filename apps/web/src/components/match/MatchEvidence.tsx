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

/** Что совпало, где уступка, чего не знаем и что спросить — четыре короткие строки. */
export function MatchEvidenceLines({ match }: { match: Evidence }) {
  if (!match.reasons.length && !match.tradeoffs.length && !match.unknowns.length && !match.ask.length) return null;
  return (
    <div className="client-match-evidence">
      {match.reasons.length > 0 && <p>Совпало: {match.reasons.join(" · ")}</p>}
      {match.tradeoffs.length > 0 && <p className="client-match-tradeoff">Уступка: {match.tradeoffs.join(" · ")}</p>}
      {match.unknowns.length > 0 && <p>Не знаем: {match.unknowns.join(" · ")}</p>}
      {match.ask.length > 0 && <p>Спросить: {match.ask.join(" · ")}</p>}
    </div>
  );
}
