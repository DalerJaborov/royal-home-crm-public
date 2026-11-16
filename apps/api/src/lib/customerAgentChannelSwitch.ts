import { customerAgentLegacyChannelSchema, type CustomerAgentLegacyChannel } from "@royal-home/shared";

/**
 * ONE BRAIN (owner 16.11.2026): a switch per channel that still answers customers with the old bot.
 *
 * `legacy` (the default) is exactly today's behaviour: the old bot answers, the core is not called, nothing is spent.
 * `shadow` (step 2): the old bot still answers; the core runs on the same words with read-only tools and its verdict is
 *   written next to the old one in BotTurnTrace (lib/customerAgentLegacyShadow.ts). Nothing of the core reaches the customer.
 * `core` (step 3): the core channel adapter (lib/customerChannelCore.ts) writes the reply instead of the old bot; the
 *   channel keeps its own delivery, lead capture and retry. Only channels WITHOUT their own core transport may use it.
 *
 * One door per capability:
 *  - Meta DMs (Royal Home and branded accounts such as Arvan) and IG/FB comments go to the core through the EXISTING door —
 *    `CustomerRuntimePolicy.rolloutConfig.allowed` per endpoint scope (+ CUSTOMER_AGENT_LEGACY_CUTOVER for old subjects).
 *    A second switch for the same thing would let the two disagree, so `meta_dm`/`arvan` are NEVER `core` here.
 *  - Telegram (bot), website chat and YouTube comments have no core transport of their own: `core` is their door.
 *
 * Env: CUSTOMER_AGENT_CHANNEL_SHADOW / CUSTOMER_AGENT_CHANNEL_CORE = comma list of channel keys or `all`.
 * A key in both lists is `core` (the shadow of a core channel would compare the core with itself).
 */
export type CustomerAgentChannelMode = "legacy" | "shadow" | "core";

const ALL = customerAgentLegacyChannelSchema.options;
/** Channels whose only door to the core is the channel adapter. */
export const CUSTOMER_AGENT_CORE_ADAPTER_CHANNELS: readonly CustomerAgentLegacyChannel[] = ["telegram", "website", "youtube"];
const warned = new Map<string, string>();

function parseChannelList(raw: string | undefined, name: string, allowed: readonly CustomerAgentLegacyChannel[]): ReadonlySet<CustomerAgentLegacyChannel> {
  const tokens = (raw ?? "").split(",").map(token => token.trim().toLowerCase()).filter(Boolean);
  if (tokens.includes("all")) return new Set(allowed);
  const chosen = new Set<CustomerAgentLegacyChannel>();
  const unknown: string[] = [];
  for (const token of tokens) {
    const parsed = customerAgentLegacyChannelSchema.safeParse(token);
    if (parsed.success && allowed.includes(parsed.data)) chosen.add(parsed.data); else unknown.push(token);
  }
  if (unknown.length && unknown.join(",") !== warned.get(name)) {
    warned.set(name, unknown.join(","));
    console.warn(`[one-brain] ${name}: channel keys ignored (unknown or not allowed here): ${unknown.join(",").slice(0, 200)}`);
  }
  return chosen;
}

/** Pure: the shadow set from the env value. Unknown tokens are ignored (and reported once), never widened to `all`. */
export function customerAgentShadowChannels(raw: string | undefined): ReadonlySet<CustomerAgentLegacyChannel> {
  return parseChannelList(raw, "CUSTOMER_AGENT_CHANNEL_SHADOW", ALL);
}

/** Pure: the channels answered by the core channel adapter. Meta keys are refused here (their door is rolloutConfig). */
export function customerAgentCoreChannels(raw: string | undefined): ReadonlySet<CustomerAgentLegacyChannel> {
  return parseChannelList(raw, "CUSTOMER_AGENT_CHANNEL_CORE", CUSTOMER_AGENT_CORE_ADAPTER_CHANNELS);
}

export function customerAgentChannelMode(key: CustomerAgentLegacyChannel,
  env: Readonly<Record<string, string | undefined>> = process.env): CustomerAgentChannelMode {
  if (customerAgentCoreChannels(env.CUSTOMER_AGENT_CHANNEL_CORE).has(key)) return "core";
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

/** Auto-reply of the model in Telegram channel direct messages (TelegramDirectConversation). Default on = as before;
 *  `off` = the model does not answer there, a person is told (one brain, step 3). Step 3b removes the old bot: then off. */
export function telegramDirectBotReplyEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.TELEGRAM_DIRECT_BOT_REPLY?.trim().toLowerCase() !== "off";
}
