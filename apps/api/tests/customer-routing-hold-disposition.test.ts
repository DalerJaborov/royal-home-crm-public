// Guard (13.11.2026): every HELD reason of the DM routing chain is classified
// ON PURPOSE as retry (503), already handled (quiet 200) or report (200 + error
// log). Unclassified reasons default to "report", but a new held() literal must
// still be added to a list here, so nobody turns a permanent hold into
// "503 until Meta drops the message" again without deciding it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CUSTOMER_ROUTING_HOLD_ALREADY_HANDLED, CUSTOMER_ROUTING_HOLD_REPORT, CUSTOMER_ROUTING_HOLD_RETRY,
  customerRoutingHoldDisposition } from "../src/lib/customerRoutingHold.js";
import { CUSTOMER_NON_INPUT_TICKET_CODES, customerNonInputCode } from "../src/lib/customerIngressNonInput.js";

const src = (file: string) => readFileSync(path.join(__dirname, "../src/lib", file), "utf8");
const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map(match => match[1]);

describe("customer DM routing holds", () => {
  it("every held reason of enrollment and routing is classified explicitly", () => {
    const reasons = new Set([
      ...all(src("customerAgentEnrollment.ts"), /held\("([a-z_]+)"\)/g),
      ...all(src("customerAgentIngressRouting.ts"), /lane: "HELD" as const, reason: "([a-z_]+)"/g),
    ]);
    expect(reasons.size).toBeGreaterThan(15); // the scan itself works
    const known = new Set<string>([...CUSTOMER_ROUTING_HOLD_RETRY, ...CUSTOMER_ROUTING_HOLD_ALREADY_HANDLED, ...CUSTOMER_ROUTING_HOLD_REPORT]);
    expect([...reasons].filter(reason => !known.has(reason))).toEqual([]);
  });

  it("only real races answer 503; the 12.11 reason and unknown reasons are ACKed and reported", () => {
    expect(customerRoutingHoldDisposition("captured_scope_changed")).toBe("retry");
    expect(customerRoutingHoldDisposition("original_native_source_already_observed")).toBe("already_handled");
    expect(customerRoutingHoldDisposition("historical_subject_owned_or_closed")).toBe("report");
    expect(customerRoutingHoldDisposition("owned_subject_stopped")).toBe("report");
    expect(customerRoutingHoldDisposition("some_future_reason")).toBe("report");
  });

  it("non-input frames use the classifier's own codes, so historical rows match", () => {
    const base = { providerEcho: false, referralOnly: false, classifier: { version: 1 as const, bareTemplateEcho: false } };
    expect(customerNonInputCode({ observations: { ...base, providerEcho: true } })).toBe("provider_echo");
    expect(customerNonInputCode({ observations: { ...base, referralOnly: true } })).toBe("referral_only");
    expect(customerNonInputCode({ observations: { ...base, classifier: { version: 1, bareTemplateEcho: true } } })).toBe("bare_template");
    expect(customerNonInputCode({ observations: base })).toBeNull();
    const classifier = src("customerIngressClassification.ts");
    for (const code of CUSTOMER_NON_INPUT_TICKET_CODES) expect(classifier).toContain(`reason: "${code}"`);
  });
});
