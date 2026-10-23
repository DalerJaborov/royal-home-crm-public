import { collectSellerFacts, SELLER_FACT_ORDER, type SellerFactKey } from "./sellerIntake.js";
import { customerRoleSignals } from "./customerAgentRole.js";
import { customerRecruitmentRequested } from "./customerAgentRecruitmentProtocol.js";
import { clientOwnWords } from "./untrustedContent.js";

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
