import { describe, expect, it } from "vitest";
import { selectQualifierPromptMemory, type ScopedCustomerQualifierContext } from "../src/ai/customerPromptMemory.js";
import type { ContactProfileForPrompt } from "../src/ai/contactProfileBlock.js";
import type { LeadDraft } from "../src/ai/leadQualifier.js";
import type { ChatMessage } from "../src/ai/client.js";

const profile: ContactProfileForPrompt = { category: "VENDOR", previousCategories: [], selfName: "PRIVATE_NAME",
  language: "ru", history: "PRIVATE_HISTORY", buyer: ["PRIVATE_BUYER"], seller: [], job: [], crm: "PRIVATE_CRM" };
function context(knownPhoneSource: ScopedCustomerQualifierContext["knownPhoneSource"] = "none"): ScopedCustomerQualifierContext {
  return { mode: "scoped_customer", history: [{ role: "user", content: "Здравствуйте" }], draft: { stage: "chatting" }, knownPhoneSource };
}
describe("minimized customer qualifier memory selector (not authorization)", () => {
  it("drops inherited profile, draft and messages, even alongside legacy phoneKnown=true", () => {
    const selected = selectQualifierPromptMemory([{ role: "user", content: "PRIVATE_OLD_MESSAGE" }],
      { stage: "done", whoIsThis: "VENDOR", notes: "PRIVATE_OLD_DRAFT" }, { contactProfile: profile, phoneKnown: true, customerContext: context() });
    expect(selected).toEqual({ history: [{ role: "user", content: "Здравствуйте" }], draft: { stage: "chatting" },
      contactProfile: null, phoneKnown: false, allowLegacyJobRead: false });
    expect(JSON.stringify(selected)).not.toContain("PRIVATE_");
  });
  it.each(["current_input", "scoped_contact"] as const)("preserves only the minimized %s phone flag", source => {
    const selected = selectQualifierPromptMemory([], { stage: "done" }, { phoneKnown: false, customerContext: context(source) });
    expect(selected.phoneKnown).toBe(true); expect(selected.contactProfile).toBeNull();
    expect(Object.keys(selected)).not.toEqual(expect.arrayContaining(["authority", "clientId", "phone", "receipt"]));
  });
  it("snapshots nested caller data before asynchronous qualification", () => {
    const input = context();
    const draft = input.draft as LeadDraft;
    draft.pendingShowing = { action: "cancel", propertyCode: "synthetic-property" };
    const selected = selectQualifierPromptMemory([], { stage: "done" }, { customerContext: input });
    (input.history as ChatMessage[])[0].content = "PRIVATE_LATE_MESSAGE";
    draft.pendingShowing.propertyCode = "PRIVATE_LATE_PROPERTY";
    expect(selected.history[0].content).toBe("Здравствуйте");
    expect(selected.draft.pendingShowing?.propertyCode).toBe("synthetic-property");
  });
  it("keeps legacy/profile/TG call inputs unchanged without an explicit scoped projection", () => {
    const history: ChatMessage[] = [{ role: "user", content: "Legacy input" }]; const draft: LeadDraft = { stage: "chatting" };
    const selected = selectQualifierPromptMemory(history, draft, { contactProfile: profile, phoneKnown: true });
    expect(selected.history).toBe(history); expect(selected.draft).toBe(draft);
    expect(selected.contactProfile).toBe(profile); expect(selected.phoneKnown).toBe(true); expect(selected.allowLegacyJobRead).toBe(true);
  });
});
