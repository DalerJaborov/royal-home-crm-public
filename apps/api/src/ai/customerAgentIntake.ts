import { collectSellerFacts, SELLER_FACT_ORDER, type SellerFactKey } from "./sellerIntake.js";
import { customerRoleSignals } from "./customerAgentRole.js";
import { customerRecruitmentRequested } from "./customerAgentRecruitmentProtocol.js";
import { clientOwnWords } from "./untrustedContent.js";
import { buyerNeedsFromMessages, buyerNeedsKnown, compactBuyerNeeds, customerSearchRequested, readBuyerNeeds } from "./customerBuyerNeeds.js";

const NEGATED_WISH = /(?<![\p{L}\p{N}])(?:не|ни|на)\s*(?:\p{L}+\s+)?(?:хочу|хотим|хотел\p{L}*|ищу|ищем|нужн\p{L}*|планирую|собираюсь|куплю|покупаю|мехоҳам|меҷӯям|мехарам)/iu;

/** «Сколько стоит объект 123?» is a request word without a wish: only a message that names a type, rooms, a place or an amount makes a buyer. */
function namesAWish(text: string): boolean {
  const reading = readBuyerNeeds(text);
  return !!(reading.type || reading.rooms || reading.place || reading.budget);
}

/** Customer words only. This is conversational progress, never identity,
 * consent, a property record, a stored Profile or proof of a completed action.
 * `askedBefore` (a user turn) / `lastAssistant` (the current one) is the bot's own question that message answers: a bare
 * «3» / «5000» / «Сино» names a wish only as an answer to it. */
export function customerAgentIntake(turns: readonly { role: "user" | "assistant"; text: string; askedBefore?: string }[], current = "",
  initialRole: "buyer" | "seller" | "unknown" = "unknown", lastAssistant?: string) {
  const own: string[] = [], asked: Array<string | undefined> = [];
  let previousAssistant: string | undefined;
  for (const turn of turns) {
    if (turn.role === "assistant") { previousAssistant = turn.text; continue; }
    const text = clientOwnWords(turn.text);
    if (text) { own.push(text); asked.push(turn.askedBefore ?? previousAssistant); }
    previousAssistant = undefined;
  }
  const currentText = clientOwnWords(current);
  if (currentText) { own.push(currentText); asked.push(lastAssistant ?? previousAssistant); }
  let role: "buyer" | "seller" | "unknown" = initialRole;
  let start = 0;
  for (let i = 0; i < own.length; i++) {
    const text = own[i];
    // A job inquiry is not a buy/sell role; a landlord is carried as a seller (the "аренда" wording stays in statements).
    const signals = customerRecruitmentRequested(text) ? null : customerRoleSignals(text);
    const seller = !!signals && (signals.sell || signals.landlord) && !signals.buyStrong;
    let buyer = !!signals && (signals.buyStrong || signals.buyWeak) && !(signals.sell || signals.landlord);
    // «Ищу двушку в Сино», «есть ли двушки до 60 тысяч»: a search request names no «хочу купить», but only a buyer asks it. It never
    // flips an established role (a seller asking «сколько стоят двушки?» stays a seller).
    if (!seller && !buyer && role === "unknown" && signals && !signals.rent && !signals.sell && !signals.landlord && !NEGATED_WISH.test(text) &&
        customerSearchRequested(text) && namesAWish(text)) buyer = true;
    if (seller !== buyer) {
      const next = seller ? "seller" : "buyer";
      // What the customer said BEFORE the role became clear («Сино, 3 хонагӣ, до 60 ҳазор» and only then «хочу купить») belongs to the
      // new role; only a switch between two known roles starts the story over.
      if (next !== role && role !== "unknown") start = i;
      role = next;
    }
  }
  const relevant = own.slice(start);
  const facts = role === "seller" ? collectSellerFacts(relevant.map(content => ({ role: "user" as const, content }))) : {};
  // Preserve amounts/currencies and corrections as customer words rather than
  // guessing normalized money. Foreign listing wrappers were removed above.
  const statements = role === "unknown" ? [] : relevant.filter(text =>
    /\d|комнат|двуш|тр[её]ш|сда[мюе]|сдать|аренд|иҷора|ичора|хона|ҳуҷра|хучра|район|ноҳия|нохия|ремонт|таъмир|бюджет|буҷет|назди|тарафи/iu.test(text)
  ).filter(text => text.length <= 360).slice(-6);
  // The buyer's wishes by the one reader (customerBuyerNeeds): the same words fill the search, so what the bot would not ask again is what it searches by.
  const buyerNeeds = role === "buyer"
    ? compactBuyerNeeds(buyerNeedsFromMessages(relevant.map((text, index) => ({ text, asked: asked[start + index] })))) : undefined;
  return { role, sellerKnown: SELLER_FACT_ORDER.filter(key => facts[key]), statements,
    buyerKnown: buyerNeedsKnown(buyerNeeds), ...(buyerNeeds ? { buyerNeeds } : {}) };
}

const labels: Record<SellerFactKey, { ru: string; tg: string }> = {
  rooms: { ru: "число комнат", tg: "шумораи ҳуҷраҳо" },
  area: { ru: "площадь", tg: "масоҳат" }, district: { ru: "район или ориентир", tg: "ноҳия ё нишонӣ" },
  floor: { ru: "этаж", tg: "ошёна" }, condition: { ru: "состояние ремонта", tg: "ҳолати таъмир" },
  price: { ru: "цену с валютой", tg: "нарх бо асъор" },
};
export function customerSellerIntakeQuestion(known: readonly SellerFactKey[], language: "ru" | "tg"): string {
  const missing = SELLER_FACT_ORDER.filter(key => !known.includes(key));
  if (!missing.length) return language === "tg"
    ? "Аксҳо ё видеои хонаи худро дар ҳамин чат фиристода метавонед?"
    : "Можете прислать фото или видео вашей недвижимости в этот чат?";
  const fields = missing.map(key => labels[key][language]).join(", ");
  return language === "tg" ? `Барои фурӯш ${fields}-ро нависед. Ҳамаашро дар як паём фиристода метавонед.`
    : `Для продажи напишите ${fields}. Можно всё одним сообщением.`;
}

/** Every wording customerSellerIntakeQuestion can produce (any subset of known facts), for the read-only memory allow-list. */
export function customerSellerIntakeQuestionLines(): string[] {
  const keys = SELLER_FACT_ORDER, lines: string[] = [];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const known = keys.filter((_, index) => mask & (1 << index));
    for (const language of ["ru", "tg"] as const) lines.push(customerSellerIntakeQuestion(known, language));
  }
  return lines;
}
