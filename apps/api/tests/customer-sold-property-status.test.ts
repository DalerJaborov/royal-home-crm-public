import { expect, it, vi } from "vitest";
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn() } }));
import { customerPropertyFactsSchema, customerPropertyAvailabilityLine } from "@royal-home/shared";
import { projectCustomerPropertyFacts, renderCustomerPropertyFacts } from "../src/lib/customerPropertyFacts.js";
import { renderCustomerAgentDecision, customerAgentRenderedQuestion } from "../src/ai/customerAgentRenderer.js";

const row = () => ({ id: "00000000-0000-4000-8000-000000000712", shortId: 712, price: "987654", currency: "TJS",
  status: "SOLD", deletedAt: null, offSite: false, publishedOnSite: true, publishedChannels: [], instagramUrl: null,
  siteListingId: 98, updatedAt: new Date("2026-10-22T00:00:00Z"), district: { name: "Synthetic district", city: "Synthetic city" },
  type: "APARTMENT", rooms: 3, areaSqm: "99", floor: 7, totalFloors: 9 });
it("returns a distinct status-only observation for a publicly known sold CRM card", () => {
  const facts = projectCustomerPropertyFacts(row(), "INSTAGRAM");
  expect(facts).toMatchObject({ shortId: 712, availability: "SOLD", price: null, publicAddress: null, publicLink: null, builder: null });
  expect(facts?.characteristics).toBeUndefined();
  expect(JSON.stringify({ ...facts, signature: undefined })).not.toMatch(/987654|Synthetic district|rooms/);
});
it.each(["private", "deleted", "never-published", "withdrawn"])("does not reveal the %s card as sold", reason => {
  const value = row();
  if (reason === "private") value.offSite = true;
  if (reason === "deleted") Object.assign(value, { deletedAt: new Date() });
  if (reason === "never-published") value.publishedOnSite = false;
  if (reason === "withdrawn") value.status = "WITHDRAWN";
  expect(projectCustomerPropertyFacts(value, "INSTAGRAM")).toBeNull();
});
it.each(["ru", "tg"] as const)("renders sold status for price/availability questions in %s without old facts or contact collection", language => {
  const facts = projectCustomerPropertyFacts(row(), "INSTAGRAM")!;
  const evidence = [{ ref: "e0", value: { kind: "facts" as const, facts, kinds: ["price", "address", "characteristics"] as const } }];
  const expected = language === "ru" ? "Объект №712 уже продан." : "Объекти №712 аллакай фурӯхта шудааст.";
  expect(customerPropertyAvailabilityLine(facts, language)).toBe(expected);
  expect(renderCustomerPropertyFacts(facts, ["price", "address"], language)).toBe(expected);
  const input = { decision: { kind: "reply" as const, refs: ["e0"], social: "none" as const, question: "phone" as const },
    evidence: evidence.map(e => ({ ...e, value: { ...e.value, kinds: [...e.value.kinds] } })),
    requestedFacts: ["price" as const], language, surface: "dm" as const, knownPhoneSource: "none" as const, maxOutputChars: 1000 };
  expect(renderCustomerAgentDecision(input)).toBe(expected);
  expect(customerAgentRenderedQuestion(input)).toBe("none");
});
it("rejects a forged SOLD observation carrying old price, address, characteristics or a sales link", () => {
  const facts = projectCustomerPropertyFacts(row(), "INSTAGRAM")!;
  for (const patch of [{ price: "987654" }, { publicAddress: "Synthetic street" }, { publicLink: "https://royalhome.tj/listing/98" },
    { characteristics: { type: "APARTMENT", rooms: 3, areaSqm: "99", landAreaSotka: null, floor: 7, totalFloors: 9, condition: null, marketType: null, stage: null } }]) {
    expect(customerPropertyFactsSchema.safeParse({ ...facts, ...patch }).success).toBe(false);
  }
});
it("changes the freshness signature when an available card becomes sold", () => {
  const current = row(), available = projectCustomerPropertyFacts({ ...current, status: "AVAILABLE" }, "INSTAGRAM")!;
  const sold = projectCustomerPropertyFacts(current, "INSTAGRAM")!;
  expect(sold.signature).not.toBe(available.signature);
});
it("does not repeat the sold line when automatic and model fact reads observe the same card", () => {
  const facts = projectCustomerPropertyFacts(row(), "INSTAGRAM")!;
  const value = { kind: "facts" as const, facts, kinds: ["availability" as const] };
  expect(renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0", "e1"], social: "none", question: "none" },
    evidence: [{ ref: "e0", value }, { ref: "e1", value }], requestedFacts: ["availability"], language: "ru",
    surface: "dm", knownPhoneSource: "none", maxOutputChars: 1000 })).toBe("Объект №712 уже продан.");
});
it("does not disable the customer's separate explicit request for a callback", () => {
  const facts = projectCustomerPropertyFacts(row(), "INSTAGRAM")!;
  expect(customerAgentRenderedQuestion({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "phone" },
    evidence: [{ ref: "e0", value: { kind: "facts", facts, kinds: ["availability"] } }],
    inputText: "Позвоните мне насчёт других вариантов", requestedFacts: [], surface: "dm", knownPhoneSource: "none" })).toBe("phone");
});
it("does not even parse or hash historical sale terms for a sold card", () => {
  const value = row();
  Object.defineProperty(value, "price", { get() { throw Error("Old price must not be read"); } });
  Object.defineProperty(value, "district", { get() { throw Error("Old address must not be read"); } });
  expect(projectCustomerPropertyFacts(value, "INSTAGRAM")?.availability).toBe("SOLD");
});
