import { describe, expect, it } from "vitest";
import { validateCustomerAgentSay, SAY_ENABLED_LANGUAGES, CUSTOMER_AGENT_SAY_TG_REVIEW_SAMPLES, type CustomerAgentSayInput } from "../src/ai/customerAgentSay.js";

// Tajik live phrase (08.11.2026). v1 kept Tajik off until a native speaker reviewed ~50 samples (plan 24.10, section 8);
// production then showed 12 of 12 phrases dropped as "language_disabled" while most customers write Tajik and got bare
// templates. Tajik is now validated like Russian; whether any phrase reaches a customer is still CUSTOMER_AGENT_SAY_MODE=live.
// The review set below is what the owner reads (the same phrases are in the out-of-git tone report); every one must pass,
// and the owner's banned bookish words must never pass.
const check = (say: string, extra: Partial<CustomerAgentSayInput> = {}) =>
  validateCustomerAgentSay({ say, language: "tg", surface: "dm", inputText: "Салом, дар бораи ин хона маълумот мехоҳам", ...extra });
const reason = (say: string) => { const verdict = check(say); return verdict.ok ? "ok" : verdict.reason; };

describe("Tajik say: enabled and grounded", () => {
  it("Tajik is enabled next to Russian", () => { expect([...SAY_ENABLED_LANGUAGES].sort()).toEqual(["ru", "tg"]); });
  it("the owner's review set is about fifty phrases and every one passes the validator", () => {
    expect(CUSTOMER_AGENT_SAY_TG_REVIEW_SAMPLES.length).toBeGreaterThanOrEqual(45);
    const dropped = CUSTOMER_AGENT_SAY_TG_REVIEW_SAMPLES.map(say => [say, reason(say)]).filter(([, verdict]) => verdict !== "ok");
    expect(dropped).toEqual([]);
  });
  it.each([
    "Лутфан, каме сабр кунед.", "Илтимос, бубахшед.", "Агенти мо ҳамаашро муфассал мефаҳмонад.", "Мутахассиси мо шуморо мефаҳмад.",
    "Сипос, ки навиштед.", "Бо камоли майл ҷавоб медиҳам.", "Мо дар хизмати шумо ҳастем.", "Бо эҳтиром, дастаи мо.",
    "Фаҳмидам — шумо хона меҷӯед.",
  ])("the owner's banned wording never passes: %s", say => { expect(reason(say)).not.toBe("ok"); });
  it("facts, numbers, places and promises stay with the server in Tajik too", () => {
    expect(reason("Нархи хона арзон аст.")).toBe("fact_claim");
    expect(reason("Ду ҳуҷра лозим аст.")).toBe("number_or_date");
    expect(reason("Хона дар Сино ҷойгир аст.")).toBe("place");
    expect(reason("Агент ба шумо занг мезанад.")).toBe("promise");
    expect(reason("Рақами худро нависед.")).not.toBe("ok");
  });
});
