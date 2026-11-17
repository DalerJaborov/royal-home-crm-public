import { customerAgentLegacyChannelSchema, type CustomerAgentLegacyChannel } from "@royal-home/shared";

/**
 * ONE BRAIN, STEP 2 (owner 16.11.2026): a switch per channel that still answers customers with the old bot.
 *
 * `legacy` (the default) is exactly today's behaviour: the old bot answers, the core is not called, nothing is spent.
 * `shadow`: the old bot still answers; the core runs on the same words with read-only tools and its verdict is written
 * next to the old one in BotTurnTrace (lib/customerAgentLegacyShadow.ts). Nothing of the core reaches the customer.
 *
 * There is deliberately NO `live` value here. One door per capability:
 *  - Meta DMs (Royal Home and branded accounts such as Arvan) and IG/FB comments go live through the EXISTING door —
 *    `CustomerRuntimePolicy.rolloutConfig.allowed` per endpoint scope (+ CUSTOMER_AGENT_LEGACY_CUTOVER for old subjects).
 *    A second switch for the same thing would let the two disagree.
 *  - Telegram, website chat and YouTube have no core transport yet; a `live` value would promise what does not exist.
 *
 * Env: CUSTOMER_AGENT_CHANNEL_SHADOW = comma list of channel keys (meta_dm, arvan, website, youtube, telegram) or `all`.
 */
export type CustomerAgentChannelMode = "legacy" | "shadow";

const ALL = customerAgentLegacyChannelSchema.options;
let warnedTokens = "";

/** Pure: the shadow set from the env value. Unknown tokens are ignored (and reported once), never widened to `all`. */
export function customerAgentShadowChannels(raw: string | undefined): ReadonlySet<CustomerAgentLegacyChannel> {
  const tokens = (raw ?? "").split(",").map(token => token.trim().toLowerCase()).filter(Boolean);
  if (tokens.includes("all")) return new Set(ALL);
  const chosen = new Set<CustomerAgentLegacyChannel>();
  const unknown: string[] = [];
  for (const token of tokens) {
    const parsed = customerAgentLegacyChannelSchema.safeParse(token);
    if (parsed.success) chosen.add(parsed.data); else unknown.push(token);
  }
  if (unknown.length && unknown.join(",") !== warnedTokens) {
    warnedTokens = unknown.join(",");
    console.warn(`[one-brain] CUSTOMER_AGENT_CHANNEL_SHADOW: unknown channel keys ignored: ${warnedTokens.slice(0, 200)}`);
  }
  return chosen;
}

export function customerAgentChannelMode(key: CustomerAgentLegacyChannel,
  env: Readonly<Record<string, string | undefined>> = process.env): CustomerAgentChannelMode {
  return customerAgentShadowChannels(env.CUSTOMER_AGENT_CHANNEL_SHADOW).has(key) ? "shadow" : "legacy";
}

/** Shadow turns per process per day; the core shares the provider budget with live core turns. 0 switches shadow off. */
export function customerAgentShadowDailyCap(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.CUSTOMER_AGENT_SHADOW_DAILY_CAP?.trim();
  if (!raw) return 200;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 5000 ? value : 200;
}

/**
 * Which switch a legacy turn belongs to. `brandName` is the server's own account setting (MessengerAccount.brandName):
 * an account with its own company name (today: Arvan) is its own channel, so it can be compared and moved separately.
 * Unknown channels return null: no shadow.
 */
export function customerAgentLegacyChannelKey(channel: string, brandName: string | null | undefined): CustomerAgentLegacyChannel | null {
  if (channel === "TELEGRAM") return "telegram";
  if (channel === "WEBSITE") return "website";
  if (channel === "YOUTUBE") return "youtube";
  if (channel === "INSTAGRAM" || channel === "FACEBOOK" || channel === "WHATSAPP") return brandName?.trim() ? "arvan" : "meta_dm";
  return null;
}
