import { prisma } from "../db.js";
import type { CustomerAgentBrand } from "../ai/customerAgentBrand.js";
import { accountBrandName, accountPersona } from "../messengers/accounts.js";

/**
 * The company voice of one account for the core turn (ai/customerAgentBrand.ts). Owner's text lives in ONE place each:
 * the account's own voice (MessengerAccount.systemPrompt) and, when the account has none, the global one from Settings
 * (Settings.botSystemPrompt). No code default: an empty setting means no voice block (the pinned prompt speaks alone).
 * A failed read returns what is known (never throws): the turn without a voice is better than no turn.
 *
 * Switches (default off = exactly today's live core, review #223 M1):
 *  - CUSTOMER_AGENT_BRAND_NAME=on — the account's company name (today only Arvan has one);
 *  - CUSTOMER_AGENT_BRAND_VOICE=on — the owner's voice text: Royal Home Info is already answered by the core, and its
 *    2.9k-char text was written for the old bot; it reaches live customers only after the owner has read the samples.
 *    An account without its own voice gets the global one only when the account has no own company name (review L2:
 *    Arvan must not speak with Royal Home's global text).
 */
export function customerAgentBrandNameEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.CUSTOMER_AGENT_BRAND_NAME?.trim().toLowerCase() === "on";
}
export function customerAgentBrandVoiceEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.CUSTOMER_AGENT_BRAND_VOICE?.trim().toLowerCase() === "on";
}

export async function readCustomerAgentBrand(accountId: string | null | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env): Promise<CustomerAgentBrand | undefined> {
  const voiceOn = customerAgentBrandVoiceEnabled(env);
  const nameOn = customerAgentBrandNameEnabled(env);
  if (!voiceOn && !nameOn) return undefined;
  const [accountName, own] = await Promise.all([accountBrandName(accountId), voiceOn ? accountPersona(accountId) : Promise.resolve(null)]);
  const name = nameOn ? accountName : null;
  let voice = own ?? undefined;
  if (voiceOn && !voice && !accountName) {
    try {
      const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botSystemPrompt: true } });
      voice = settings?.botSystemPrompt?.trim() || undefined;
    } catch { voice = undefined; }
  }
  if (!name && !voice) return undefined;
  return { ...(name ? { name } : {}), ...(voice ? { voice } : {}) };
}
