import { expect, it } from "vitest";
import { createCardLinkEvidence } from "../src/ai/assistant/cardLinkEvidence.js";

it("accepts only the related card IDs returned by deal and showing tools", () => {
  const guard = createCardLinkEvidence();
  guard.observe("search_deals", [{ propertyShortId: 88, clientShortId: 12 }]);
  guard.observe("get_upcoming_showings", [{ propertyShortId: 89, clientShortId: 13 }]);
  expect(guard.validate("[Объект](/properties/88) [Клиент](/clients/12) [Показ](/properties/89)").ok).toBe(true);
  expect(guard.validate("[Клиент](/clients/13)").ok).toBe(false);
});

it("rejects invented Markdown and bare card paths without rejecting ordinary numbers", () => {
  const guard = createCardLinkEvidence();
  expect(guard.validate("Цена 123, площадь 45, 2 комнаты")).toEqual({ ok: true });
  expect(guard.validate("[Квартира](/properties/123)").ok).toBe(false);
  expect(guard.validate("Клиент /clients/nonexistent").ok).toBe(false);
  expect(guard.validate("[Клиент](clients/nonexistent)").ok).toBe(false);
  expect(guard.validate("Откройте /clients или [Объекты](/properties/)").ok).toBe(true);
});
it("accepts only current-turn tool identities and canonical server aliases", () => {
  const guard = createCardLinkEvidence();
  guard.observe("search_properties", [{ id: "property-id", shortId: 42, price: 300 }]);
  guard.observe("find_clients", { items: [{ id: "client-id", href: "/clients/7" }] });
  for (const path of ["/properties/property-id", "/properties/42", "/clients/client-id", "/clients/7"])
    expect(guard.validate(`[Открыть](${path})`).ok).toBe(true);
  expect(guard.validate("/clients/property-id").ok).toBe(false);
  expect(createCardLinkEvidence().validate("/properties/42").ok).toBe(false);
});
it("allows property links verified by a single status lookup or a queue result", () => {
  const guard = createCardLinkEvidence();
  guard.observe("get_property_work_status", { code: "ОБ-000132", href: "/properties/132", phase: "WAITING_FOR_EDITOR" });
  guard.observe("get_property_work_status", { total: 3, items: [
    { code: "ОБ-000143", href: "/properties/143", title: "Этап /properties/144" },
    { error: "denied", href: "/properties/145" },
  ] });
  expect(guard.validate("[ОБ-000132](/properties/132) ва [ОБ-000143](/properties/143)").ok).toBe(true);
  expect(guard.validate("/properties/144").ok).toBe(false);
  expect(guard.validate("/properties/145").ok).toBe(false);
});
it("never mines arguments, notes, history, knowledge, failed results or unknown tools", () => {
  const guard = createCardLinkEvidence();
  guard.observe("search_clients", [{ id: "allowed", notes: { href: "/clients/injected" }, name: "[x](/clients/evil)" }]);
  guard.observe("get_client_card", { error: "denied", id: "denied", href: "/clients/denied" });
  for (const name of ["history", "save_company_knowledge", "unknown", "change_client_agent"])
    guard.observe(name, { id: "untrusted", href: "/clients/untrusted", items: [{ id: "untrusted" }] });
  for (const id of ["injected", "evil", "denied", "untrusted"]) expect(guard.validate(`/clients/${id}`).ok).toBe(false);
  expect(guard.validate("/clients/allowed").ok).toBe(true);
});
it("recognizes typed related cards without trusting arbitrary nested href fields", () => {
  const guard = createCardLinkEvidence();
  guard.observe("get_client_card", { id: "client", nextShowing: { property: { href: "/properties/20" } }, notes: { href: "/properties/21" } });
  guard.observe("list_my_tasks", { tasks: [{ client: { href: "/clients/22" } }], overdue: [{ property: { href: "/properties/23" } }] });
  for (const path of ["/clients/client", "/properties/20", "/clients/22", "/properties/23"]) expect(guard.validate(path).ok).toBe(true);
  expect(guard.validate("/properties/21").ok).toBe(false);
});
it("checks encoded paths, fragments, traversal and external-host aliases", () => {
  const guard = createCardLinkEvidence();
  guard.observe("get_property_card", { id: "known" });
  expect(guard.validate("[x](/properties/known). /properties/known,").ok).toBe(true);
  expect(guard.validate("[x](/%70roperties/%6bnown)").ok).toBe(true);
  for (const path of ["/properties/known?redirect=elsewhere", "/properties/known#other", "/properties/known/../bad", "/Properties/known", "/%70roperties/unknown", "https://evil.example/properties/known", "//evil.example/properties/known"])
    expect(guard.validate(`[x](${path})`).ok, path).toBe(false);
});
it("bounds evidence and rejects an oversized reply without unbounded traversal", () => {
  const guard = createCardLinkEvidence();
  guard.observe("search_clients", Array.from({ length: 200 }, (_, id) => ({ id: String(id) })));
  expect(guard.validate("/clients/127").ok).toBe(true);
  expect(guard.validate("/clients/128").ok).toBe(false);
  expect(guard.validate("x".repeat(32001))).toEqual({ ok: false, reason: "response_too_large" });
});
