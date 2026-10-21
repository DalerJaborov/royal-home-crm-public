import { isDialableTajikNumber, type CustomerAgentVerifiedContext } from "@royal-home/shared";
import { clientOwnWords } from "../ai/untrustedContent.js";
import { customerAgentPropertyQuestionText } from "../ai/customerAgentRenderer.js";

/** Meaning only. Callers must load real scoped ACCEPTED history themselves.
 * A budget, age, phone or list position never becomes an object by default. */
export function customerBarePropertyNumber(raw: string): number | null {
  const text = clientOwnWords(raw).trim();
  if (!/^[1-9]\d{0,8}$/u.test(text) || isDialableTajikNumber(text)) return null;
  return Number(text);
}
export function customerBarePropertyAnswer(raw: string, context: CustomerAgentVerifiedContext): number | null {
  const number = customerBarePropertyNumber(raw), last = context.turns.at(-1);
  if (number === null || context.surface !== "dm" || context.publicState.topic === "job" || last?.role !== "assistant") return null;
  const lines = last.text.split("\n").map(line => line.trim());
  return (["ru", "tg"] as const).some(language => lines.includes(customerAgentPropertyQuestionText(language))) ? number : null;
}
