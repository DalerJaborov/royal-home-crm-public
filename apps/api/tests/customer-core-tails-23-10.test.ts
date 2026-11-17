import { describe, expect, it, vi } from "vitest";
import type { CustomerPropertyAdmission, CustomerPropertyEvidence } from "@royal-home/shared";
import { customerPropertyShareLink, customerPropertyUrl } from "../src/lib/customerPropertyUrls.js";
import { customerPropertyEvidenceFromText } from "../src/lib/customerPropertyEvidence.js";
import { resolveCustomerPropertyEvidence, type CustomerPropertyRegistry } from "../src/lib/customerPropertyResolver.js";
import { expandCustomerShareLink } from "../src/lib/customerShareLinkExpansion.js";
import { logSystemError } from "../src/lib/systemError.js";

vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: vi.fn() }));

const PROPERTY = "00000000-0000-4000-8000-000000000001";

describe("G1 opaque share links are recognised, never followed by the parser", () => {
  it("canonicalises facebook share links and fb.watch", () => {
    expect(customerPropertyShareLink("https://m.facebook.com/share/r/1AbC/?mibextid=x")).toBe("https://www.facebook.com/share/r/1AbC/");
    expect(customerPropertyShareLink("https://facebook.com/share/p/Z9_x-1")).toBe("https://www.facebook.com/share/p/Z9_x-1/");
    expect(customerPropertyShareLink("https://fb.watch/abcD12/")).toBe("https://fb.watch/abcD12/");
    expect(customerPropertyShareLink("https://www.facebook.com/share/x/1AbC/")).toBeNull();
    expect(customerPropertyShareLink("https://evil.com/share/p/1AbC/")).toBeNull();
    expect(customerPropertyShareLink("https://user:pw@fb.watch/abcD12/")).toBeNull();
    expect(customerPropertyShareLink("https://fb.watch:8080/abcD12/")).toBeNull();
    expect(customerPropertyShareLink("https://fb.watch/a/b/")).toBeNull();
  });
  it("the pure parser itself still refuses them", () => {
    expect(customerPropertyUrl("https://www.facebook.com/share/p/1AbC/")).toEqual({ kind: "unsupported" });
    expect(customerPropertyUrl("https://fb.watch/abcD12/")).toEqual({ kind: "denied" });
  });
  it("typed text becomes url evidence, with and without https://", () => {
    expect(customerPropertyEvidenceFromText("facebook.com/share/p/1AbC/")).toEqual([{ kind: "url", origin: "message", reference: "https://www.facebook.com/share/p/1AbC/" }]);
    expect(customerPropertyEvidenceFromText("глядите https://fb.watch/abcD12/ тут")).toEqual([{ kind: "url", origin: "message", reference: "https://fb.watch/abcD12/" }]);
    expect(customerPropertyEvidenceFromText("fb.watch/abcD12")).toEqual([{ kind: "url", origin: "message", reference: "https://fb.watch/abcD12/" }]);
    // a foreign look-alike stays rejected
    expect(customerPropertyEvidenceFromText("https://evil.com/share/p/1AbC/")).toEqual([{ kind: "untrusted_reference", origin: "message", reference: "untrusted_origin" }]);
  });
});

describe("G1 expandCustomerShareLink: one request, Location only", () => {
  const url = (raw: string) => async () => new URL(raw);
  const answer = (status: number, location?: string) => {
    const cancel = vi.fn(async () => undefined);
    const res = { status, headers: new Headers(location ? { location } : {}), body: { cancel } } as unknown as Response;
    return { res, cancel };
  };
  const run = (status: number, location?: string) => {
    const { res, cancel } = answer(status, location);
    const fetchStub = vi.fn(async () => res);
    const assertPublic = vi.fn(url("https://www.facebook.com/share/p/1AbC/"));
    return { fetchStub, cancel, assertPublic, result: expandCustomerShareLink("https://www.facebook.com/share/p/1AbC/", { fetch: fetchStub as unknown as typeof fetch, assertPublic }) };
  };
  it("returns an allowed destination without following it and without reading the body", async () => {
    const { fetchStub, cancel, assertPublic, result } = run(301, "https://www.facebook.com/royalhome/posts/1234567890/?ref=x");
    expect(await result).toBe("https://www.facebook.com/royalhome/posts/1234567890/?ref=x");
    expect(assertPublic).toHaveBeenCalledOnce();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const init = (fetchStub.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    expect(JSON.stringify(init.headers).toLowerCase()).not.toMatch(/cookie|authorization/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(cancel).toHaveBeenCalled();
  });
  it("accepts instagram and m.facebook destinations, relative Location too", async () => {
    expect(await run(302, "https://www.instagram.com/p/ABC123/").result).toBe("https://www.instagram.com/p/ABC123/");
    expect(await run(302, "https://m.facebook.com/reel/123456").result).toBe("https://m.facebook.com/reel/123456");
    expect(await run(302, "/reel/123456").result).toBe("https://www.facebook.com/reel/123456");
  });
  it("refuses a foreign host, http, credentials, ports and a missing Location", async () => {
    for (const location of ["https://evil.com/reel/1", "http://www.facebook.com/reel/1", "https://u:p@www.facebook.com/reel/1",
      "https://www.facebook.com:8443/reel/1", "https://facebook.com.evil.com/reel/1"]) expect(await run(301, location).result).toBeNull();
    expect(await run(301).result).toBeNull();
    expect(await run(200).result).toBeNull();
    expect(await run(404).result).toBeNull();
  });
  it("transient answers and network failures throw (caller: lookup_unavailable)", async () => {
    await expect(run(503).result).rejects.toThrow(/503/);
    await expect(run(429).result).rejects.toThrow(/429/);
    await expect(expandCustomerShareLink("https://fb.watch/abcD12/", { assertPublic: url("https://fb.watch/abcD12/"),
      fetch: (async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch })).rejects.toThrow();
  });
  it("the SSRF guard runs first and its refusal propagates", async () => {
    const fetchStub = vi.fn();
    await expect(expandCustomerShareLink("https://fb.watch/abcD12/", { assertPublic: async () => { throw new Error("внутренний адрес"); }, fetch: fetchStub as unknown as typeof fetch })).rejects.toThrow();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("G1 the resolver expands a share link once and treats the result as an ordinary link", () => {
  const scope = { conversationId: PROPERTY, scopeKey: "c".repeat(64), accountId: null, channel: "WEBSITE" as const } satisfies Pick<CustomerPropertyAdmission, "conversationId" | "scopeKey" | "accountId" | "channel">;
  const evidence: CustomerPropertyEvidence[] = [{ kind: "url", origin: "message", reference: "https://www.facebook.com/share/p/1AbC/" }];
  const registry = (overrides: Partial<CustomerPropertyRegistry> = {}): CustomerPropertyRegistry => ({ url: async () => [], ad: async () => null,
    media: async () => [], reply: async () => [], selector: async () => [], ...overrides });
  it("share → Meta post → media registry → resolved", async () => {
    const media = vi.fn(async () => [PROPERTY]);
    const expandShare = vi.fn(async () => "https://www.facebook.com/royalhome/posts/1234567890/");
    const url = vi.fn(async (parsed: { kind: string; mediaId?: string }) => parsed.kind === "media" ? media() : []);
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry({ expandShare, url: url as CustomerPropertyRegistry["url"] })))
      .toMatchObject({ status: "resolved", propertyId: PROPERTY });
    expect(url).toHaveBeenCalledWith(expect.objectContaining({ kind: "media", mediaId: "1234567890" }));
    expect(expandShare).toHaveBeenCalledOnce();
  });
  it("an unusable destination is «unsupported», not a failure", async () => {
    const expandShare = vi.fn(async () => null);
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry({ expandShare }))).toMatchObject({ status: "denied", reason: "unsupported" });
    expect(expandShare).toHaveBeenCalledOnce();
    const login = vi.fn(async () => "https://www.facebook.com/login/?next=x");
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry({ expandShare: login }))).toMatchObject({ status: "denied", reason: "unsupported" });
  });
  it("a timeout/refusal is lookup_unavailable, journalled, and costs ONE request despite the immediate retry", async () => {
    vi.mocked(logSystemError).mockClear();
    const expandShare = vi.fn(async () => { throw new Error("share link expansion: HTTP 503"); });
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry({ expandShare }))).toMatchObject({ status: "missing", reason: "lookup_unavailable" });
    expect(expandShare).toHaveBeenCalledTimes(1);
    expect(logSystemError).toHaveBeenCalledWith("api", expect.stringContaining("503"), expect.objectContaining({ dedupKey: "customer-property-lookup-failed" }));
  });
  it("without an expander (old registries) the link stays unsupported", async () => {
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry())).toMatchObject({ status: "denied", reason: "unsupported" });
  });
});

describe("G3 publicState.addressee", () => {
  it("is an optional closed enum of the shared state schema", async () => {
    const { customerPublicStateSchema, customerAgentVerifiedContextSchema } = await import("@royal-home/shared");
    expect(customerPublicStateSchema.parse({})).toEqual({ language: "unknown", topic: "unknown", openQuestion: "none" });
    for (const addressee of ["company", "other_person", "reaction", "self_promo", "unknown"]) {
      expect(customerPublicStateSchema.parse({ addressee })).toMatchObject({ addressee });
      expect(customerAgentVerifiedContextSchema.safeParse({ surface: "public_comment", revisionId: "a".repeat(64), turns: [], publicState: { addressee } }).success).toBe(true);
    }
    expect(customerPublicStateSchema.safeParse({ addressee: "skip" }).success).toBe(false);
    expect(customerPublicStateSchema.safeParse({ addressee: "company", extra: 1 }).success).toBe(false);
  });
  it("labels each server verdict; the skip itself stays server-side", async () => {
    const { classifyPublicCommentAddressee, customerPublicAddresseeLabel } = await import("../src/lib/customerPublicAddressee.js");
    const own = new Set(["royalhome"]);
    const label = (text: string, parent: "none" | "other_person" = "none") => {
      const verdict = classifyPublicCommentAddressee({ text, parent, ownUsernames: own });
      return { label: customerPublicAddresseeLabel(verdict), skip: verdict.skip };
    };
    expect(label("Какая цена?")).toEqual({ label: "company", skip: false });
    expect(label("@royalhome есть вариант?")).toEqual({ label: "company", skip: false });
    expect(label("@anna согласна, красиво", "none")).toEqual({ label: "other_person", skip: true });
    expect(label("Согласен", "other_person")).toEqual({ label: "other_person", skip: true });
    expect(label("😐 ...")).toEqual({ label: "reaction", skip: true });
    expect(label("Подписывайся на мой профиль")).toEqual({ label: "self_promo", skip: false });
    expect(label("Красивая планировка")).toEqual({ label: "unknown", skip: false });
  });
  it("reaches the model inside serverPublicState and the prompt explains it", async () => {
    const { runCustomerAgentTurn } = await import("../src/ai/customerAgentCore.js");
    const { createProviderOperation } = await import("../src/ai/providerContract.js");
    const { CUSTOMER_AGENT_SYSTEM } = await import("../src/ai/customerAgentPrompt.js");
    const hash = "a".repeat(64), controller = new AbortController();
    const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
      accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
    const modelTurn = vi.fn(async () => ({ text: JSON.stringify({ kind: "skip", reason: "no_reply_needed" }), calls: [], modelParts: [] }));
    await runCustomerAgentTurn({ surface: "public_comment", language: "ru", inputText: "Подписывайся на мой профиль", knownPhoneSource: "none", requestedFacts: [],
      revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: hash,
        providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
        limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
      startedAt: Date.now(), operation, tools: [{ name: "get_agency_contact", description: "Contact" }],
      verifiedContext: { surface: "public_comment", revisionId: hash, turns: [], publicState: { language: "unknown", topic: "unknown", openQuestion: "none", addressee: "self_promo" } },
    }, { modelTurn, executeAllowedTool: vi.fn(), assertCurrent: async () => true, requestStop: () => undefined, observeLateToolResult: () => undefined } as never);
    expect(modelTurn).toHaveBeenCalled();
    const contents = (modelTurn.mock.calls[0] as unknown as [{ contents: Array<{ parts: Array<{ text?: string }> }> }])[0].contents;
    const state = contents.flatMap(value => value.parts.map(part => part.text ?? "")).find(value => value.includes("serverPublicState"));
    expect(JSON.parse(state!)).toMatchObject({ serverPublicState: { addressee: "self_promo" } });
    expect(CUSTOMER_AGENT_SYSTEM).toContain("serverPublicState.addressee");
    controller.abort();
  });
});
