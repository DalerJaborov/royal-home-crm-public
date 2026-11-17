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
export function customerAgentAnswerMode(env: Readonly<Record<string, string | undefined>> = process.env, channel?: string): CustomerAgentAnswerMode {
  const value = env.CUSTOMER_AGENT_ANSWER_MODE;
  if (value !== "live") return value === "off" ? "off" : "shadow";
  const listed = customerAgentAnswerLiveChannels(env);
  return !!channel && listed.includes(channel.trim().toUpperCase()) ? "live" : "shadow";
}

/** The channel names the customer core sees on a turn (`principal.scope.channel`). */
export const CUSTOMER_AGENT_ANSWER_CHANNELS = ["WHATSAPP", "INSTAGRAM", "FACEBOOK", "WEBSITE"] as const;
/**
 * Live channel by channel (17.11.2026), safe against an operator slip: CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS is a comma list of the
 * names above (any case, «whatsapp, website») or the explicit word `ALL`. With CUSTOMER_AGENT_ANSWER_MODE=live:
 *  - `ALL`: live on every channel — only when written explicitly;
 *  - a list: live only on the listed channels, every other channel stays shadow;
 *  - empty / unset / only unknown names: live NOWHERE (every channel stays shadow) and an error is logged — one erased line during a
 *    rollback must never switch the new bot on for every customer;
 *  - an unknown name in the list (a typo, «telegram») is ignored and logged.
 * `off` and shadow do not read the list. Rollback in one step: CUSTOMER_AGENT_ANSWER_MODE back to empty (shadow) or `off`; emptying
 * the list also stops live (with a logged error).
 */
export function customerAgentAnswerLiveChannels(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const rawValue = env.CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS ?? "";
  const raw = rawValue.split(",").map(name => name.trim().toUpperCase()).filter(Boolean);
  if (raw.includes("ALL")) {
    const others = raw.filter(name => name !== "ALL" && !(CUSTOMER_AGENT_ANSWER_CHANNELS as readonly string[]).includes(name));
    if (others.length) logLiveChannelsOnce(rawValue, `unknown channel name(s) ignored: ${others.join(", ")}`);
    return [...CUSTOMER_AGENT_ANSWER_CHANNELS];
  }
  const known = [...new Set(raw.filter(name => (CUSTOMER_AGENT_ANSWER_CHANNELS as readonly string[]).includes(name)))];
  const unknown = raw.filter(name => !(CUSTOMER_AGENT_ANSWER_CHANNELS as readonly string[]).includes(name));
  if (unknown.length) logLiveChannelsOnce(rawValue, `unknown channel name(s) ignored: ${unknown.join(", ")}`);
  if (!known.length && env.CUSTOMER_AGENT_ANSWER_MODE === "live") {
    logLiveChannelsOnce(rawValue, `CUSTOMER_AGENT_ANSWER_MODE=live but no channel is listed: live is OFF on every channel (write ALL or e.g. FACEBOOK)`);
  }
  return known;
}

const loggedLiveChannels = new Set<string>();
/** One error line per distinct (value, problem): the switch is read on every turn, the journal must not flood. */
function logLiveChannelsOnce(value: string, problem: string): void {
  const key = `${value}|${problem}`;
  if (loggedLiveChannels.has(key)) return;
  loggedLiveChannels.add(key);
  console.error(`[customer-agent] CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS=${JSON.stringify(value)}: ${problem}`);
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
