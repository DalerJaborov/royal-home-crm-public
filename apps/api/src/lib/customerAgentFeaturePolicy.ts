import type { CustomerAgentSayMode } from "@royal-home/shared";
import { prisma } from "../db.js";
import { leadOnlyAppliesTo } from "../ai/leadOnlyMode.js";
import type { CustomerAgentAnswerMode } from "../ai/customerAgentCore.js";

/** Grounded free-phrase channel mode. Anything but the exact word `live` is `shadow`: the phrase is validated and counted, never sent.
 * Going live is an explicit deploy-time decision (CUSTOMER_AGENT_SAY_MODE=live) taken after the shadow statistics are read; it is deliberately
 * not a Settings column (that would need a schema migration) and not something a customer or the model can influence. */
export function customerAgentSayMode(env: Readonly<Record<string, string | undefined>> = process.env): CustomerAgentSayMode {
  return env.CUSTOMER_AGENT_SAY_MODE === "live" ? "live" : "shadow";
}

/**
 * The model's own words around the server's facts (`answer`, one-brain step 1). Its OWN switch, independent of the phrase switch above
 * (review #211, п.6: one switch for both meant «включи фразы» would also send whole model replies):
 *  - `shadow` (the default, and anything that is not an exact word below): the words are verified and counted, never sent;
 *  - `live`: verified words reach the customer around the template's fact lines;
 *  - `off`: the model is not asked for them at all and the old one-phrase `say` rules ride the turn again.
 * Going live is an explicit deploy-time decision (CUSTOMER_AGENT_ANSWER_MODE=live in the server .env) after the shadow day lines are read.
 */
export function customerAgentAnswerMode(env: Readonly<Record<string, string | undefined>> = process.env): CustomerAgentAnswerMode {
  const value = env.CUSTOMER_AGENT_ANSWER_MODE;
  return value === "live" ? "live" : value === "off" ? "off" : "shadow";
}

/** One brain, step 3: the lead card of the core learns where the property is from the customer's words (another city of
 *  Tajikistan → «Прочие обращения»; possibly abroad → a note). Default off = the core's lead routing as before. */
export function customerIntakeLocationEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.CUSTOMER_AGENT_INTAKE_LOCATION?.trim().toLowerCase() === "on";
}

/** Existing feature switches restrict implemented customer capabilities; a
 * legacy switch never grants a new tool, transport, identity or staff right. */
export async function loadCustomerAgentFeaturePolicy(channel?: string) {
  const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: {
    botCanSendLinks: true, botCanSendPhotos: true, botPhotosPerOffer: true, botCanBookShowings: true, botCanHandleVacancies: true,
    botCanRequestCallback: true, botCanAskOwner: true, botLeadOnlyMode: true,
  } });
  // Режим «только заявки» (13.11.2026): ссылок и фото нет при любых прочих тумблерах, но ТОЛЬКО в
  // WhatsApp/Instagram/Facebook: чат сайта и вызовы без канала остаются прежними (решение 13.11 после ревью).
  // Подборку убирает из инструментов customerDmAgentTurn по тому же правилу.
  const leadOnly = row?.botLeadOnlyMode === true && leadOnlyAppliesTo(channel);
  return { leadOnly, links: !leadOnly && row?.botCanSendLinks === true, photos: !leadOnly && row?.botCanSendPhotos === true,
    photosPerOffer: Math.max(0, Math.min(5, row?.botPhotosPerOffer ?? 0)),
    showings: row?.botCanBookShowings === true, vacancies: row?.botCanHandleVacancies === true,
    // Тумблеры экрана «Бот» (31.10.2026): выключенный — инструмент не предлагается
    // модели на этом ходе. Каталог инструментов в toolSchemaHash ревизии не меняется.
    callbacks: row?.botCanRequestCallback === true, ownerQuestions: row?.botCanAskOwner === true };
}

/** Same switch read from the settings for code that has no policy snapshot at hand (the server-built video answer). */
export async function customerLinksAllowed(channel?: string): Promise<boolean> {
  return (await loadCustomerAgentFeaturePolicy(channel)).links;
}
