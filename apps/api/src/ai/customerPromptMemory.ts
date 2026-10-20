import type { ChatMessage } from "./shared.js";
import type { LeadDraft } from "./leadDraft.js";
import type { ContactProfileForPrompt } from "./contactProfileBlock.js";

/** Already-minimized server input, supplied after canonical-IN/fence checks and
 * legacy-memory quarantine. This is prompt data, never identity, consent or a
 * write/private-read grant. Do not parse it from a request or model response. */
export interface ScopedCustomerQualifierContext {
  readonly mode: "scoped_customer";
  readonly history: readonly ChatMessage[];
  readonly draft: Readonly<LeadDraft>;
  readonly knownPhoneSource: "none" | "current_input" | "scoped_contact";
}

export interface QualifierMemoryOptions {
  contactProfile?: ContactProfileForPrompt | null;
  phoneKnown?: boolean;
  customerContext?: ScopedCustomerQualifierContext;
}

/** Copy scoped inputs before the first await so later mutations of the caller's
 * projection cannot reintroduce inherited memory. Existing legacy calls retain
 * their exact inputs; staff/profile/TG compatibility is not changed here. */
export function selectQualifierPromptMemory(
  history: ChatMessage[],
  draft: LeadDraft,
  options: QualifierMemoryOptions
): { history: ChatMessage[]; draft: LeadDraft; contactProfile: ContactProfileForPrompt | null | undefined;
  phoneKnown: boolean; allowLegacyJobRead: boolean } {
  const scoped = options.customerContext;
  if (!scoped) return { history, draft, contactProfile: options.contactProfile,
    phoneKnown: options.phoneKnown ?? false, allowLegacyJobRead: true };
  return {
    history: structuredClone([...scoped.history]),
    draft: structuredClone(scoped.draft),
    contactProfile: null,
    phoneKnown: scoped.knownPhoneSource === "current_input" || scoped.knownPhoneSource === "scoped_contact",
    allowLegacyJobRead: false,
  };
}
