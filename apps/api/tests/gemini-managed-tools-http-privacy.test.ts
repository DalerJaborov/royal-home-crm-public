import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAttemptRecord } from "../src/ai/providerContract.js";
import type { BotTurnTracePayload } from "@royal-home/shared";
const diagnosticSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../src/ai/geminiSettings.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: async () => ({ keys: ["synthetic-managed-http-key"], model: "gemini-3.6-flash", fallbackModels: [],
    transcribeModels: [], imageModel: "unused", liteModel: "", explicitCaching: false }),
}));
vi.mock("../src/lib/systemError.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: diagnosticSpy,
}));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("GEMINI_PROXY_URL", ""); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const echoed = 'thinkingConfig invalid; phone +992931234567; tool args {"phone":"+992931234567","privateTag":"SYNTHETIC_TOOL_PRIVATE"}';
async function fixture() {
  // Same fresh module graph for client, runtime binding and ALS; no global flag reset API.
  const [client,binding,contract,config,cap,trace] = await Promise.all([
    import("../src/ai/geminiClient.js"),import("../src/ai/geminiOperationRuntime.js"),import("../src/ai/providerContract.js"),
    import("../src/ai/customerAgentProviderConfig.js"),import("../src/ai/geminiCapabilities.js"),
    import("../src/lib/botTurnTrace.js"),
  ]);
  const snapshot=config.createCustomerAgentProviderSnapshot(),profile=snapshot.profile,records:ProviderAttemptRecord[]=[],bodies:Record<string,unknown>[]=[];
  const policyHash=config.customerAgentProviderIdentities(snapshot).providerPolicyHash;
  const profileHash=binding.frozenGeminiRuntimeProfileHash(profile),registry=cap.createGeminiCapabilityRegistry(profile.capabilities);
  const key="synthetic-managed-http-key";
  let fail=true;
  const physical=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
    const endpoint=String(url),body=JSON.parse(String(init?.body)) as Record<string,unknown>;
    if(endpoint==="https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:countTokens"){
      bodies.push(body);return new Response('{"totalTokens":100}');
    }
    if(endpoint!=="https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent")throw Error("Forbidden external fetch");
    bodies.push(body);
    if(fail)return new Response(JSON.stringify({error:{code:400,message:echoed}}),{status:400});
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:"synthetic result"}]},finishReason:"STOP"}],
      usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,cachedContentTokenCount:0,thoughtsTokenCount:0}}));
  });vi.stubGlobal("fetch",physical);
  const input={apiKey:key,system:"synthetic system",contents:[{role:"user" as const,parts:[{text:"synthetic input"}]}],
    tools:[{name:"get_agency_contact",description:"Public phone",parameters:{type:"object",properties:{},additionalProperties:false}}],maxTokens:2048};
  const bound=()=>{
    const operation=contract.createProviderOperation({managed:true,deadlineAt:Date.now()+10000,maxAttempts:4,
      profileRevision:profile.profileRevision,policyHash,supports:registry.supports,
      accountant:{reserve:async()=>true,settle:async row=>{records.push(row);}}});
    binding.bindGeminiRuntimeToOperation(operation,{profile,expectedProfileRevision:profile.profileRevision,expectedProfileHash:profileHash,
      keys:[key],countContext:{expectedProviderPolicyHash:policyHash,assertCurrent:async()=>true}});
    return client.callGeminiTools({...input,providerOperation:operation});
  };
  return {bound,legacy:()=>client.callGeminiTools(input),physical,bodies,records,trace,logs:diagnosticSpy,succeed:()=>{fail=false;}};
}
const config=(rows:BotTurnTracePayload[])=>({enabled:true,text:true,secret:"synthetic-managed-http-trace-secret-00000",write:(row:BotTurnTracePayload)=>{rows.push(row);}});

describe("managed HTTP diagnostics and pinned thinking boundary",()=>{
  it("a prior genuine legacy thinking rejection cannot alter the next BOUND minimal wire/spec",async()=>{
    const f=await fixture();await expect(f.legacy()).rejects.toThrow("SYNTHETIC_TOOL_PRIVATE");
    f.succeed();await f.bound();
    expect(f.physical).toHaveBeenCalledTimes(3); // legacy generation, bound count, bound generation
    expect(f.bodies[1]).toMatchObject({generateContentRequest:{generationConfig:{thinkingConfig:{thinkingLevel:"minimal"}}}});
    expect(f.bodies[2]).toMatchObject({generationConfig:{thinkingConfig:{thinkingLevel:"minimal"}}});
    expect(f.records).toHaveLength(1);expect(f.records[0].features?.thinking).toBe("level");
  });
  it("managed400 echo reaches neither log/exception/trace nor the legacy thinking flag",async()=>{
    const f=await fixture(),rows:BotTurnTracePayload[]=[];
    let thrown:unknown;
    await f.trace.withBotTurnTrace({channel:"INSTAGRAM",account:"synthetic-scope",peer:"synthetic-peer",event:"synthetic-event",
      managed:{surface:"dm",phase:"planning"}},async()=>{try{await f.bound();}catch(error){thrown=error;}},config(rows));
    expect(thrown).toMatchObject({status:400,message:"Gemini HTTP 400: managed_provider_http_error"});
    expect(f.logs).toHaveBeenCalled();
    // Безопасные поля отказа Google (code) теперь доходят до журнала; error.message — нет.
    expect(JSON.stringify(f.logs.mock.calls)).toContain("managed_provider_http_error (code=400)");
    const observed=JSON.stringify({logs:f.logs.mock.calls,error:{message:(thrown as Error).message,stack:(thrown as Error).stack},trace:rows});
    expect(observed).not.toMatch(/992931234567|SYNTHETIC_TOOL_PRIVATE|tool args|phone.*privateTag/);
    expect(rows.at(-1)?.modelAttempts).toEqual([expect.objectContaining({endpoint:"assistant-tools",outcome:"blocked"})]);
    // Managed rejection must not poison unbound legacy config on this clean module graph.
    f.succeed();await f.legacy();expect(f.physical).toHaveBeenCalledTimes(3);
    expect(f.bodies[2]).toMatchObject({generationConfig:{thinkingConfig:{thinkingLevel:"minimal"}}});
  });
  it("unmanaged legacy diagnostic and rejection adaptation remain unchanged",async()=>{
    const f=await fixture();await expect(f.legacy()).rejects.toThrow("SYNTHETIC_TOOL_PRIVATE");
    expect(JSON.stringify(f.logs.mock.calls)).toContain("SYNTHETIC_TOOL_PRIVATE");
    f.succeed();await f.legacy();
    expect(f.physical).toHaveBeenCalledTimes(2);
    expect(f.bodies[1]).toHaveProperty("generationConfig");
    expect(f.bodies[1].generationConfig).not.toHaveProperty("thinkingConfig");
  });
});
