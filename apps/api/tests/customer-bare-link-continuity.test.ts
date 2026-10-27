import { describe, expect, it } from "vitest";
import { runCustomerAgentTurn, type CustomerAgentModelTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import type { CustomerAgentVerifiedContext } from "@royal-home/shared";

const hash = "b".repeat(64);
const revision = { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash,
  knowledgeSchemaHash: hash, knowledgeSourceHash: hash, providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } };
const bareUrl = "https://external.example.test/share/clip?id=7";
const unknownContext = (turns: CustomerAgentVerifiedContext["turns"] = []): CustomerAgentVerifiedContext => ({
  surface: "dm", revisionId: hash, turns, publicState: { language: "unknown", topic: "unknown", openQuestion: "none" },
});
const final = (decision: unknown): CustomerAgentModelTurn => ({ text: JSON.stringify(decision), calls: [], modelParts: [] });
const toolTurn = (name: "get_company_information" | "get_property_facts" | "request_callback", args: Record<string, unknown>, id: string): CustomerAgentModelTurn => ({
  text: "", calls: [{ name, args, id }], modelParts: [{ functionCall: { name, args, id } }],
});

function fixture(inputText: string, responses: CustomerAgentModelTurn[], options: {
  context?: CustomerAgentVerifiedContext; requestedFacts?: CustomerCoreFrame["requestedFacts"];
  tools?: CustomerCoreFrame["tools"]; toolResult?: Awaited<ReturnType<CustomerCorePorts["executeAllowedTool"]>>;
} = {}) {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 4,
    signal: controller.signal, accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const frame: CustomerCoreFrame = { surface: "dm", language: "ru", inputText, knownPhoneSource: "none",
    requestedFacts: options.requestedFacts ?? [], verifiedContext: options.context ?? unknownContext(),
    revision, startedAt: Date.now(), operation,
    tools: options.tools ?? [{ name: "get_company_information", description: "Synthetic public read" }],
  };
  const script = [...responses];
  const modelTurn: CustomerCorePorts["modelTurn"] = async () => {
    const next = script.shift(); if (!next) throw new Error("synthetic_script_exhausted"); return next;
  };
  const executeAllowedTool: CustomerCorePorts["executeAllowedTool"] = async () => options.toolResult ?? ({ status: "unavailable", reason: "synthetic_read_unavailable" });
  const ports: CustomerCorePorts = { modelTurn, executeAllowedTool, assertCurrent: async () => true,
    requestStop: reason => controller.abort(reason), observeLateToolResult: () => {} };
  return { run: () => runCustomerAgentTurn(frame, ports), frame, operation, ports, script };
}

const unsupported = () => ({ kind: "skip", reason: "unsupported" });
const noReplyNeeded = () => ({ kind: "skip", reason: "no_reply_needed" });
const moderation = () => ({ kind: "moderation_proposal", action: "hide", reason: "spam" });

describe("bare external URL decision recovery", () => {
  it("clarifies an unresolved lone external URL after a read was unavailable, without another model round", async () => {
    const f = fixture(bareUrl, [
      toolTurn("get_company_information", {}, "read-1"),
      final(unsupported()),
      final(unsupported()),
    ]);
    const result = await f.run();

    expect(result).toMatchObject({ status: "ready", rounds: 2, toolCalls: 1 });
    if (result.status !== "ready") return;
    expect(result.text).toBe("Что пояснить подробнее?");
  });

  it.each(["no_reply_needed", "duplicate", "moderation"] as const)("does not replace authorized %s suppression with a clarification", async kind => {
    const f = fixture(bareUrl, kind === "moderation"
      ? [final(moderation()), final(moderation())]
      : [final(kind === "duplicate" ? { kind: "skip", reason: "duplicate" } : noReplyNeeded()),
        final(kind === "duplicate" ? { kind: "skip", reason: "duplicate" } : noReplyNeeded())]);
    const result = await f.run();

    expect(result).toMatchObject({ status: "held", reason: "surface_decision_denied" });
    expect(result.status === "ready" ? result.text : "").not.toContain("Что пояснить подробнее?");
  });

  it.each([
    ["no_reply_needed", noReplyNeeded()],
    ["duplicate", { kind: "skip", reason: "duplicate" }],
    ["moderation", moderation()],
  ] as const)("does not forget an earlier %s suppression if the correction changes to unsupported", async (_kind, first) => {
    const f = fixture(bareUrl, [final(first), final(unsupported())]);
    const result = await f.run();

    expect(result).toMatchObject({ status: "held", reason: "surface_decision_denied", rounds: 2 });
  });

  it("does not replace a pending proposal confirmation with a URL clarification", async () => {
    const context = unknownContext([{ role: "assistant", text: "Отклик сохранён. Подтверждаете?" }]);
    const f = fixture(bareUrl, [final(unsupported()), final(unsupported())], { context });
    const result = await f.run();

    expect(result).toMatchObject({ status: "held", reason: "surface_decision_denied", rounds: 2 });
  });

  it("keeps a resolved own-property read on the verified-facts path", async () => {
    const facts = { propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "123456.78", currency: "TJS" as const,
      availability: "AVAILABLE" as const, publicAddress: "Synthetic district", addressPolicy: "district_city_only" as const,
      builder: null, publicLink: null, updatedAt: "2026-10-26T00:00:00.000Z", signature: hash };
    const f = fixture("https://royalhome.tj/listing/123", [
      final(unsupported()),
      final({ kind: "reply", refs: ["e0"], social: "none", question: "none" }),
    ], { requestedFacts: ["price"], tools: [{ name: "get_property_facts", description: "Synthetic verified fact read" }],
      toolResult: { status: "observed", observation: { kind: "facts", facts, kinds: ["price"] } } });
    const result = await f.run();

    expect(result).toMatchObject({ status: "ready", rounds: 2, toolCalls: 1 });
    if (result.status !== "ready") return;
    expect(result.text).toContain("123 456.78 сомони");
    expect(result.text).not.toContain("Что пояснить подробнее?");
  });

  it("keeps a committed receipt instead of replacing it with a URL clarification", async () => {
    const f = fixture(bareUrl, [
      toolTurn("request_callback", { topic: "synthetic" }, "callback-1"),
      final(unsupported()),
      final({ kind: "reply", refs: ["e0"], social: "none", question: "none" }),
    ], { tools: [{ name: "request_callback", description: "Synthetic authorized write" }],
      toolResult: { status: "observed", observation: { kind: "receipt", outcome: "callback_requested" } } });
    const result = await f.run();

    expect(result).toMatchObject({ status: "ready", rounds: 3, toolCalls: 1 });
    if (result.status !== "ready") return;
    expect(result.text).toContain("Запрос на звонок создан.");
    expect(result.text).not.toContain("Что пояснить подробнее?");
  });

  it("keeps an UNKNOWN write held for reconciliation without clarifying or retrying", async () => {
    const f = fixture(bareUrl, [toolTurn("request_callback", { topic: "synthetic" }, "callback-unknown")], {
      tools: [{ name: "request_callback", description: "Synthetic authorized write" }],
      toolResult: { status: "unknown", reason: "synthetic_delivery_unknown" },
    });
    const result = await f.run();

    expect(result).toMatchObject({ status: "held", reason: "effect_unknown", rounds: 1, toolCalls: 1,
      unknownToolCalls: [{ callKey: "callback-unknown", name: "request_callback" }] });
    expect(f.script).toHaveLength(0);
  });
});
