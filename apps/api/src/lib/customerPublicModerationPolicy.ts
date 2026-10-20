import { detectSpam } from "./incomingSpam.js";
import { detectHate } from "./commentHate.js";
import { detectAgencyAd, detectListingAd } from "./listingAd.js";
import { looksLikeRentRequest } from "../ai/rentGuard.js";
import { AGENCY_FACTS } from "../ai/agencyFacts.js";

export type CustomerPublicEffectKind = "hide" | "delete" | "private_reply";
export interface CustomerPublicModerationPlan {
  category: "spam" | "abuse" | "agency_ad" | "seller_ad";
  steps: readonly CustomerPublicEffectKind[];
}
/** Existing conservative classifiers, not a model's permission to delete.
 * Seller adverts are hidden before DM; irreversible removal follows its receipt.
 * Criticism/direct seller requests are not advertisements. */
export function customerPublicModerationPlan(text: string): CustomerPublicModerationPlan | null {
  if (detectSpam(text, { comment: true })) return { category: "spam", steps: ["hide"] };
  if (detectHate(text)) return { category: "abuse", steps: ["delete"] };
  // Old advert detector only exempted '?'. A direct request remains a lead even
  // when the person gives a full description and forgets the question mark.
  if (/(?:помоги(?:те)?\s+(?:мне\s+)?продать|продать\s+(?:через\s+вас|вам)|(?:кумак|кӯмак)\s+кунед|бо\s+шумо\s+кор)/iu.test(text)) return null;
  if (detectAgencyAd(text)) return { category: "agency_ad", steps: ["delete"] };
  if (detectListingAd(text)) {
    if (!AGENCY_FACTS.rent && looksLikeRentRequest(text)) return { category: "spam", steps: ["hide"] };
    return { category: "seller_ad", steps: ["hide", "private_reply", "delete"] };
  }
  return null;
}

/** Reuses the old seller approach, without unverified buyers or sales promises. */
export function customerSellerPrivateReply(language: "ru" | "tg"): string {
  return language === "tg"
    ? "Салом! Мо Royal Home, агентии амвол дар Душанбе ҳастем. Эълони фурӯши хонаи шуморо дидем. Агар хоҳед, дар фурӯш кӯмак мекунем. Хона дар кадом ноҳия аст?"
    : "Здравствуйте! Это Royal Home, агентство недвижимости в Душанбе. Увидели ваше объявление о продаже. Если хотите, поможем с продажей. В каком районе находится объект?";
}
