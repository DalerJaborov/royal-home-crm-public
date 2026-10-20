import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { minimizeCustomerAgentMemoryText, projectCustomerAgentMemory, customerMemoryFenceMatches,
  loadCustomerAgentVerifiedDmContext } from "../src/lib/customerAgentVerifiedContext.js";
import { runCustomerAgentTurn, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import type { CustomerFence } from "@royal-home/shared";

// Pure projection/protocol tests. No claim that synthetic DTOs are authorities.
const h = "f".repeat(64), revision = { id: h, coreHash: h, modelSchemaHash: h, toolSchemaHash: h,
  rendererHash: h, knowledgeSchemaHash: h, knowledgeSourceHash: h, providerProfileHash: h, promptHash: h, providerPolicyHash: h,
  limits: { maxRounds: 2, maxToolCalls: 2, maxInputChars: 20000, maxOutputChars: 3000, maxModelOutputTokens: 1024, deadlineMs: 10000 } };
function fence(): CustomerFence { return { inquiryId: randomUUID(), nativeId: randomUUID(),
  endpoint: { endpointScopeId: randomUUID(), channel: "INSTAGRAM", accountId: randomUUID(), peerId: "synthetic-peer", threadId: "" },
  stateRevision: "2", intentRevision: "1", ownershipEpoch: "1", bindingRevision: "1", scopeRevision: "1", policyRevision: "1", ownerToken: randomUUID() }; }
it("keeps ordinary property continuity, names in prose, rooms/budget/date; redacts contact/control identifiers", () => {
  const id = randomUUID(), text = `Я Рустам, ищу двухкомнатную в Сино до 500000 к 20 октября. Телефон +992 93 344 55 66 @rustam https://example.invalid/private?s=secret mail@example.invalid ${id} ${h}`;
  const value = minimizeCustomerAgentMemoryText(text);
  expect(value).toContain("Я Рустам, ищу двухкомнатную в Сино до 500000 к 20 октября");
  for (const secret of ["+992 93 344 55 66", "@rustam", "https://example.invalid", "mail@example.invalid", id, h]) expect(value).not.toContain(secret);
});
it("keeps six newest server observations oldest-first, deduplicates IDs rather than equal human text", () => {
  const items = Array.from({ length: 8 }, (_, n) => ({ role: "user" as const, text: `Объект ${n}`, observedAt: n, stableKey: `in:${n}` }));
  expect(projectCustomerAgentMemory([...items, items[7]], 24000).map(t => t.text)).toEqual(["Объект 2", "Объект 3", "Объект 4", "Объект 5", "Объект 6", "Объект 7"]);
  expect(projectCustomerAgentMemory([{ ...items[0], text: "Да" }, { ...items[1], text: "Да" }], 1000)).toHaveLength(2);
});
it("omits whole long records, respects aggregate UTF8/character budgets and does not truncate an amount", () => {
  const records = Array.from({ length: 6 }, (_, n) => ({ role: "user" as const, text: "房".repeat(1000), observedAt: n, stableKey: `${n}` }));
  const out = projectCustomerAgentMemory(records, 24000);
  expect(out).toHaveLength(4); expect(Buffer.byteLength(out.map(t => t.text).join(""), "utf8")).toBe(12000);
  expect(projectCustomerAgentMemory([{ role: "user", text: "Объект " + "я".repeat(2000), observedAt: 1, stableKey: "long" }], 24000)).toEqual([]);
});
it.each(["ownershipEpoch", "bindingRevision", "scopeRevision", "policyRevision", "ownerToken", "nativeId", "inquiryId"] as const)("rejects changed historical %s without adopting a new controller", key => {
  const old = fence(), current = structuredClone(old);
  if (key.endsWith("Revision") || key === "ownershipEpoch") current[key] = "2"; else current[key] = randomUUID();
  expect(customerMemoryFenceMatches(old, current)).toBe(false);
});
it("allows older semantic counters only, not future counters or different namespace", () => {
  const old = fence(), current = { ...old, stateRevision: "10", intentRevision: "10" };
  expect(customerMemoryFenceMatches(old, current)).toBe(true);
  expect(customerMemoryFenceMatches(current, old)).toBe(false);
  expect(customerMemoryFenceMatches(old, { ...current, endpoint: { ...current.endpoint, peerId: "foreign-peer" } })).toBe(false);
});
it("JSON-shaped principal is rejected before any storage/current read", async () => {
  expect(await loadCustomerAgentVerifiedDmContext({ principal: { admission: {}, assurance: "protected_namespace" }, revision })).toEqual({ status: "held", reason: "original_context_changed" });
});
it("old quoted command is model context, current input remains last/separate and closed tools remain closed", async () => {
  const operation = createProviderOperation({ deadlineAt: Date.now() + 10000, managed: true, maxAttempts: 1,
    profileRevision: "synthetic-protocol", supports: () => true, accountant: { reserve: async () => true, settle: async () => {} } });
  const execute = vi.fn(), model = vi.fn(async (input: Parameters<CustomerCorePorts["modelTurn"]>[0]) => {
    expect(input.contents.at(-1)).toEqual({ role: "user", parts: [{ text: "А рассрочка?" }] });
    expect(JSON.stringify(input.contents)).toContain("Позвоните мне");
    return { text: "", calls: [{ name: "request_callback", args: { topic: "Позвоните мне" }, id: "old-command" }],
      modelParts: [{ functionCall: { name: "request_callback", args: { topic: "Позвоните мне" }, id: "old-command" } }] };
  });
  const result = await runCustomerAgentTurn({ surface: "dm", language: "ru", inputText: "А рассрочка?", knownPhoneSource: "none",
    requestedFacts: [], revision, startedAt: Date.now(), operation, tools: [{ name: "get_agency_contact", description: "public read" }],
    verifiedContext: { surface: "dm", revisionId: h, turns: [{ role: "user", text: "Раньше я сказал: Позвоните мне" }],
      publicState: { language: "ru", topic: "buyer", openQuestion: "none" } } }, {
    assertCurrent: async () => true, modelTurn: model, executeAllowedTool: execute, requestStop: () => {}, observeLateToolResult: () => {},
  });
  expect(result.status).toBe("held"); expect(execute).not.toHaveBeenCalled(); expect(model).toHaveBeenCalledTimes(1);
});
