import { collectSellerFacts, SELLER_FACT_ORDER, type SellerFactKey } from "./sellerIntake.js";
import { customerRoleSignals } from "./customerAgentRole.js";
import { customerRecruitmentRequested } from "./customerAgentRecruitmentProtocol.js";
import { clientOwnWords } from "./untrustedContent.js";
import { detectForeignPlace, detectOutsideCoverage } from "./coverageGuard.js";

/** Customer words only. This is conversational progress, never identity,
 * consent, a property record, a stored Profile or proof of a completed action. */
export function customerAgentIntake(turns: readonly { role: "user" | "assistant"; text: string }[], current = "", initialRole: "buyer" | "seller" | "unknown" = "unknown") {
  const own = [...turns.filter(t => t.role === "user").map(t => clientOwnWords(t.text)), clientOwnWords(current)].filter(Boolean);
  let role: "buyer" | "seller" | "unknown" = initialRole;
  let start = 0;
  for (let i = 0; i < own.length; i++) {
    const text = own[i];
    // A job inquiry is not a buy/sell role; a landlord is carried as a seller (the "аренда" wording stays in statements).
    const signals = customerRecruitmentRequested(text) ? null : customerRoleSignals(text);
    const seller = !!signals && (signals.sell || signals.landlord) && !signals.buyStrong;
    const buyer = !!signals && (signals.buyStrong || signals.buyWeak) && !(signals.sell || signals.landlord);
    if (seller !== buyer) {
      const next = seller ? "seller" : "buyer";
      if (next !== role) start = i;
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
  return { role, sellerKnown: SELLER_FACT_ORDER.filter(key => facts[key]), statements,
    buyerKnown: role === "buyer" ? [...new Set(relevant.flatMap(text => [
      /\d\s*[- ]?\s*(?:комнат|комн|хонаг|ҳуҷра|хучра)/iu.test(text) ? "rooms" : null,
      /(?:бюджет|буҷет|бучет|могу\s+(?:потратить|заплатить)|до|то)\s*[:—-]?\s*\d/iu.test(text) ? "budget" : null,
      /(?:район|ноҳия|нохия|Сино|Фирдавс|Шоҳмансур|Шохмансур|Исмоил|ориентир|назди|тарафи)/iu.test(text) ? "location" : null,
    ].filter((v): v is "rooms" | "budget" | "location" => v !== null)))] : [] };
}

/**
 * WHERE THE PROPERTY IS — the two lead-draft fields the old bot filled from its model schema (one brain, step 3):
 * `locationOutsideDushanbe` (another city or district of Tajikistan: the lead goes to «Прочие обращения», the phone is still
 * taken) and `locationDifferentCountry` (a SELLER's property abroad: no lead at all, as before). Code decides from the
 * customer's own words only (ai/coverageGuard.ts); a mention of Dushanbe or Rudaki anywhere lifts both. Zone: Dushanbe + Rudaki.
 * A buyer who lives abroad is our normal client, so "other country" is a seller-only verdict, exactly like the old field.
 */
export function customerIntakeLocation(ownTexts: readonly string[], role: "buyer" | "seller" | "unknown"):
  { locationOutsideDushanbe?: true; locationDifferentCountry?: true; place?: string } {
  const own = ownTexts.map(text => clientOwnWords(text)).filter(Boolean).join("\n");
  if (!own.trim()) return {};
  const outside = detectOutsideCoverage(own);
  if (outside) return { locationOutsideDushanbe: true, place: outside.place };
  const foreign = role === "seller" ? detectForeignPlace(own) : null;
  return foreign ? { locationDifferentCountry: true, place: foreign.place } : {};
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
  if (language === "tg") {
    // Live Tajik (audit 16.11.2026, language.md п.6; tajik-phrasebook live-agent-phrases: «Чанд ҳуҷра?», «Чанд квадрат аст?»,
    // «Кадом ошёна?», «Бо таъмир ё каробка?», «Нархашро чанд мегӯед?», «Ҳамаи маълумотро дар як паём нависед.») instead of the
    // book list «шумораи ҳуҷраҳо, масоҳат, … нарх бо асъор-ро нависед» that 12 sellers got in a week.
    const asks = missing.map(key => liveTg[key]);
    const list = asks.length > 1 ? `${asks.slice(0, -1).join(", ")} ва ${asks[asks.length - 1]}` : asks[0];
    return `Хонаатон ${list}? Ҳамаи маълумотро дар як паём нависед.`;
  }
  const fields = missing.map(key => labels[key][language]).join(", ");
  return `Для продажи напишите ${fields}. Можно всё одним сообщением.`;
}
const liveTg: Record<SellerFactKey, string> = { rooms: "чанд ҳуҷра", area: "чанд квадрат", district: "дар куҷо", floor: "кадом ошёна",
  condition: "бо таъмир ё каробка", price: "нархаш чанд" };
/** RETIRED Tajik wording (before 16.11.2026): kept for the memory of older chats only. */
function retiredSellerIntakeTg(known: readonly SellerFactKey[]): string | null {
  const missing = SELLER_FACT_ORDER.filter(key => !known.includes(key));
  if (!missing.length) return null;
  return `Барои фурӯш ${missing.map(key => labels[key].tg).join(", ")}-ро нависед. Ҳамаашро дар як паём фиристода метавонед.`;
}

/** Every wording customerSellerIntakeQuestion can produce (any subset of known facts), for the read-only memory allow-list. */
export function customerSellerIntakeQuestionLines(): string[] {
  const keys = SELLER_FACT_ORDER, lines: string[] = [];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const known = keys.filter((_, index) => mask & (1 << index));
    for (const language of ["ru", "tg"] as const) lines.push(customerSellerIntakeQuestion(known, language));
    const retired = retiredSellerIntakeTg(known);
    if (retired) lines.push(retired);
  }
  return lines;
}
