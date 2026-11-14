vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn(), $queryRaw: vi.fn(() => { throw new Error("Unexpected database access"); }) } }));
import { describe, expect, it, vi } from "vitest";
import { createAssistantEmbeddingMoneyGuard, createAssistantMoneyGuard, createAssistantMoneyWallet } from "../src/ai/assistant/moneyBudget.js";
import { dollarLimit, generationReservation } from "../src/ai/assistant/moneyPolicy.js";

const now = () => Date.UTC(2026, 10, 3, 12);
const attempt = () => ({ model: "gemini-3.1-pro-preview", apiKey: "test-key", kind: "generate" as const,
  body: { contents: [{ role: "user", parts: [{ text: "Салом" }] }], systemInstruction: { parts: [{ text: "Simple words" }] },
    tools: [{ functionDeclarations: [{ name: "lookup", description: "CRM" }] }], generationConfig: { maxOutputTokens: 8192 } } });
const fakeFetch = (tokens = 32768) => vi.fn(async () => new Response(JSON.stringify({ totalTokens: tokens }))) as unknown as typeof fetch;

describe("conservative monetary policy", () => {
  it("uses exact upper bounds including output thoughts without free-tier assumptions", () => {
    expect(generationReservation("gemini-3.1-pro-preview",32768,8192,now())).toBe(163840);
    expect(generationReservation("gemini-3.6-flash",32768,8192,now())).toBe(55296);
    expect(dollarLimit("0.300001")).toBe(300001);
  });
  it.each(["0", "-1", "NaN", "Infinity", "0.0000001", "2148", "1e3"])("rejects invalid config %s", value => {
    expect(() => dollarLimit(value)).toThrow();
  });
  it("fails closed for unknown models and price expiration", () => {
    expect(() => generationReservation("gemini-unknown",1,1,now())).toThrow(/Неизвестный тариф/);
    expect(() => generationReservation("gemini-3.6-flash",1,1,Date.UTC(2027,0,1))).toThrow(/повторной проверки/);
  });
  it("reserves local budget synchronously across concurrent calls", async () => {
    const daily = vi.fn(async () => true);
    const wallet = createAssistantMoneyWallet({now,turnUsd:"0.30",dailyUsd:"3",reserveDaily:daily});
    const results = await Promise.allSettled(Array.from({length:10}, () => wallet.reserve(100000)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(3);
    expect(daily).toHaveBeenCalledTimes(3);
  });
  it("defaults: $1 per turn, $30 per day when env is unset (14.11.2026)", async () => {
    vi.stubEnv("ASSISTANT_GEMINI_DAILY_USD", ""); vi.unstubAllEnvs();
    delete process.env.ASSISTANT_GEMINI_DAILY_USD; delete process.env.ASSISTANT_GEMINI_TURN_USD;
    const daily = vi.fn(async () => true);
    const wallet = createAssistantMoneyWallet({ now, reserveDaily: daily });
    await wallet.reserve(1_000_000); // $1 fits the turn envelope
    await expect(wallet.reserve(1)).rejects.toThrow(/лимит/);
    expect(daily).toHaveBeenCalledWith(1_000_000, expect.any(String), 30_000_000);
  });
  it("empty env strings (docker-compose `${VAR:-}`) fall back to the defaults", async () => {
    vi.stubEnv("ASSISTANT_GEMINI_DAILY_USD", ""); vi.stubEnv("ASSISTANT_GEMINI_TURN_USD", "  ");
    const daily = vi.fn(async () => true);
    const wallet = createAssistantMoneyWallet({ now, reserveDaily: daily });
    await wallet.reserve(1_000_000);
    expect(daily).toHaveBeenCalledWith(1_000_000, expect.any(String), 30_000_000);
    vi.unstubAllEnvs();
  });
  it("does not refund an uncertain database outcome", async () => {
    const daily = vi.fn(async () => { throw new Error("uncertain"); });
    const wallet = createAssistantMoneyWallet({now,turnUsd:"0.10",dailyUsd:"3",reserveDaily:daily});
    await expect(wallet.reserve(100000)).rejects.toMatchObject({code:"assistant_attempt_limit",status:402});
    await expect(wallet.reserve(1)).rejects.toThrow();
    expect(daily).toHaveBeenCalledTimes(1);
  });
  it("rejects daily and day-rollover limits", async () => {
    let clock = now(); const daily = vi.fn(async () => true);
    const wallet = createAssistantMoneyWallet({now:()=>clock,turnUsd:"3",dailyUsd:"0.1",reserveDaily:daily});
    await expect(wallet.reserve(100001)).rejects.toThrow();
    clock += 86400000;
    await expect(wallet.reserve(1)).rejects.toThrow();
    expect(daily).not.toHaveBeenCalled();
  });
});

describe("count and reserve before every generation", () => {
  it("charges every retry and refuses an already aborted request", async () => {
    const reserve = vi.fn(async()=>{}); const fetch = fakeFetch();
    const guard = createAssistantMoneyGuard({now,fetch,wallet:{reserve}});
    await guard(attempt()); await guard(attempt());
    expect(reserve).toHaveBeenCalledTimes(2);
    const abort = new AbortController(); abort.abort();
    await expect(guard({...attempt(),signal:abort.signal})).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("counts full request including system, tools and output config, then reserves", async () => {
    const reserve = vi.fn(async () => {}); const fetch = fakeFetch(); const request = attempt();
    await createAssistantMoneyGuard({now,fetch,wallet:{reserve}})(request);
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(JSON.parse(init.body as string)).toEqual({generateContentRequest:{...request.body,model:`models/${request.model}`}});
    expect(init.redirect).toBe("error"); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(reserve).toHaveBeenCalledWith(163840,expect.any(AbortSignal));
  });
  it.each([0, -1, 32769, 1.5, "20", null])("rejects invalid count %s before reserving", async tokens => {
    const reserve = vi.fn(async () => {});
    const fetch = vi.fn(async()=>new Response(JSON.stringify({totalTokens:tokens}))) as unknown as typeof globalThis.fetch;
    await expect(createAssistantMoneyGuard({now,fetch,wallet:{reserve}})(attempt())).rejects.toMatchObject({status:402});
    expect(reserve).not.toHaveBeenCalled();
  });
  it("rejects oversized and failed count responses", async () => {
    for (const response of [new Response("x".repeat(20000)),new Response("{}",{status:500})]) {
      const reserve = vi.fn(async()=>{});
      await expect(createAssistantMoneyGuard({now,wallet:{reserve},fetch:(async()=>response) as typeof fetch})(attempt())).rejects.toThrow();
      expect(reserve).not.toHaveBeenCalled();
    }
  });
  it("rejects unbounded search and unknown models before any network call", async () => {
    const fetch = fakeFetch(); const guard = createAssistantMoneyGuard({now,fetch,wallet:{reserve:async()=>{}}});
    await expect(guard({...attempt(),kind:"grounded"})).rejects.toThrow();
    await expect(guard({...attempt(),model:"unknown"})).rejects.toThrow(/Неизвестный тариф/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects request mutation during count and after reservation", async () => {
    const first = attempt(); const reserve = vi.fn(async()=>{});
    const fetch = (async()=>{first.body.contents[0]!.parts[0]!.text="changed";return new Response('{"totalTokens":10}');}) as typeof globalThis.fetch;
    await expect(createAssistantMoneyGuard({now,fetch,wallet:{reserve}})(first)).rejects.toThrow(/изменился/);
    expect(reserve).not.toHaveBeenCalled();
    const second = attempt();
    await expect(createAssistantMoneyGuard({now,fetch:fakeFetch(),wallet:{reserve:async()=>{second.body.generationConfig.maxOutputTokens=10000;}}})(second)).rejects.toThrow(/изменился/);
  });
  it("allows bounded inline Pro PDF but rejects remote files", async () => {
    const guard = createAssistantMoneyGuard({now,fetch:fakeFetch(),wallet:{reserve:async()=>{}}});
    await expect(guard({...attempt(),body:{...attempt().body,contents:[{parts:[{inline_data:{mime_type:"application/pdf",data:"AA=="}}]}]}})).resolves.toBeUndefined();
    await expect(guard({...attempt(),body:{...attempt().body,contents:[{parts:[{fileData:{fileUri:"https://remote"}}]}]}})).rejects.toThrow();
  });
  it("shares wallet across generation and embedding", async () => {
    const daily = vi.fn(async()=>true);
    const wallet = createAssistantMoneyWallet({now,turnUsd:"0.164",dailyUsd:"3",reserveDaily:daily});
    await createAssistantEmbeddingMoneyGuard({now,wallet})({model:"gemini-embedding-001",inputCharacters:1112,taskType:"RETRIEVAL_DOCUMENT",outputDimensions:768});
    await expect(createAssistantMoneyGuard({now,wallet,fetch:fakeFetch()})(attempt())).rejects.toThrow();
    expect(daily).toHaveBeenCalledTimes(1);expect(daily.mock.calls[0]).toEqual([308,"2026-11-03",3000000]);
  });
  it("rejects unknown embedding models, oversized inputs and changed vector spaces", async () => {
    const reserve = vi.fn(async()=>{});
    const guard = createAssistantEmbeddingMoneyGuard({now,wallet:{reserve}});
    const baseline = {model:"gemini-embedding-001",inputCharacters:200,taskType:"RETRIEVAL_QUERY" as const,outputDimensions:768};
    for (const change of [{model:"gemini-embedding-2"},{inputCharacters:1201},{outputDimensions:3072}]) {
      await expect(guard({...baseline,...change})).rejects.toThrow();
    }
    expect(reserve).not.toHaveBeenCalled();
  });
});
