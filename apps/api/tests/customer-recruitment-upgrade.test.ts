import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { CUSTOMER_RECRUITMENT_UPGRADE_V1 as pair, isCustomerRecruitmentUpgradeV1 } from "../src/lib/customerRecruitmentUpgrade.js";
import { CUSTOMER_AGENT_SYSTEM } from "../src/ai/customerAgentPrompt.js";
import { customerAgentToolDefinitions, CUSTOMER_AGENT_PUBLIC_TOOLS } from "../src/ai/customerAgentToolDefinitions.js";
const prior:{promptHash:string;toolSchemaHash:string}={promptHash:pair.fromPrompt,toolSchemaHash:pair.fromTools};
const next:{promptHash:string;toolSchemaHash:string}={promptHash:pair.toPrompt,toolSchemaHash:pair.toTools};
it("pins the actual reviewed prompt and exact fourteen-tool catalog instead of accepting future instruction changes",()=>{
  const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
  const names=[...CUSTOMER_AGENT_PUBLIC_TOOLS,"save_contact","request_callback","request_handover","book_showing",
    "reschedule_showing","cancel_showing","ask_owner","save_job_application"] as const;
  expect(sha(CUSTOMER_AGENT_SYSTEM)).toBe(pair.toPrompt);
  expect(sha(JSON.stringify(customerAgentToolDefinitions(names)))).toBe(pair.toTools);
  expect(isCustomerRecruitmentUpgradeV1(prior,next)).toBe(true);
});
it.each(["prior-prompt","prior-tools","next-prompt","next-tools","reverse","replay"])("rejects any other protocol pair: %s",which=>{
  const a={...prior},b={...next},other="f".repeat(64);
  if(which==="prior-prompt")a.promptHash=other;
  if(which==="prior-tools")a.toolSchemaHash=other;
  if(which==="next-prompt")b.promptHash=other;
  if(which==="next-tools")b.toolSchemaHash=other;
  if(which==="reverse") { Object.assign(a,next);Object.assign(b,prior); }
  if(which==="replay")Object.assign(a,next);
  expect(isCustomerRecruitmentUpgradeV1(a,b)).toBe(false);
});
