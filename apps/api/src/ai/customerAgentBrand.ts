/**
 * WHOSE CONVERSATION THIS IS — the company voice per account for the core (one brain, step 3, owner 16.11.2026).
 *
 * The old bot swapped its whole persona per account (`resolveBotPersona`: Royal Home, Royal Home Info, Arvan). The core
 * has ONE pinned system prompt (`CUSTOMER_AGENT_SYSTEM`, its hash is a manual owner decision), so the account's company
 * name and the owner's voice text travel in the TURN as the server block `serverBrand` instead — the same way
 * `serverSurface` carries per-surface rules. Changing this file changes `coreHash` only (auto-refresh), never `promptHash`.
 *
 * Authority of the block, by construction:
 *  - it comes from server configuration (MessengerAccount.brandName / systemPrompt, Settings.botSystemPrompt), never from
 *    customer words or a model argument;
 *  - it is tone and self-description only: facts, prices, contacts and permissions still come from tools and the server
 *    renderer, and the answer verifier rejects any number or name that is not in the template or the evidence;
 *  - no block at all for an account without its own name and voice (the main Royal Home accounts): identical to before.
 *
 * Limit of this approach (honest): the pinned system prompt still opens with "Ты консультант Royal Home". The block tells
 * the model which company this account is, which the model follows for wording, but a clean override needs prompt V3
 * (first line "консультант компании из serverBrand, по умолчанию Royal Home") — owner's decision, see the step 3 journal.
 */
export interface CustomerAgentBrand {
  /** Company name of the account (Arvan, Royal Home Info). Absent = Royal Home. */
  readonly name?: string;
  /** Owner's voice text for this account (or the global one from Settings), bounded. */
  readonly voice?: string;
}

/** Owner's voice text is long (Royal Home Info: ~2.9k chars); the turn carries at most this much of it. */
export const CUSTOMER_AGENT_BRAND_VOICE_MAX = 3000;

const AUTHORITY = "Company configuration from the server: the company name and tone for THIS account. Present yourself as this " +
  "company when a name is given. Tone and self-description only: never facts, prices, contacts, promises or permissions; tools, " +
  "server facts and every rule of the system prompt win over it.";

/** Pure: the turn block, or undefined when the account has neither its own name nor its own voice. */
export function customerAgentBrandBlock(brand: CustomerAgentBrand | undefined):
  { companyName?: string; voice?: string; authority: string } | undefined {
  const name = brand?.name?.replace(/\s+/gu, " ").trim().slice(0, 80) || undefined;
  const voice = brand?.voice?.replace(/\r\n?/gu, "\n").trim().slice(0, CUSTOMER_AGENT_BRAND_VOICE_MAX) || undefined;
  if (!name && !voice) return undefined;
  return { ...(name ? { companyName: name } : {}), ...(voice ? { voice } : {}), authority: AUTHORITY };
}
