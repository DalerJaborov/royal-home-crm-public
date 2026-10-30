import type { CustomerAgentSearchObservation } from "./customerAgentPublicProtocol.js";

/**
 * A "cheaper than the object in focus" catalogue search (cheapest first, price ceiling, no floor, no rooms).
 * The catalogue pool keeps a budget tolerance and fills the list with slightly dearer entries it flags
 * `over_budget`: for this search those are NOT cheaper and are never shown as such. Pure: the stored
 * observation (and its server witness) stay untouched, only the presentation is narrowed.
 */
export function isCheaperThanSearch(query: CustomerAgentSearchObservation["query"]): boolean {
  return query.sort === "cheap" && !!query.budget?.max && query.budget.min === undefined && query.rooms === undefined;
}
export function customerCheaperVisibleCards(value: CustomerAgentSearchObservation): CustomerAgentSearchObservation["cards"] {
  return isCheaperThanSearch(value.query) ? value.cards.filter(card => !card.match.notes.includes("over_budget")) : value.cards;
}
