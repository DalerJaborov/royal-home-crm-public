import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { CUSTOMER_RECRUITMENT_UPGRADE_V1 as pair, isCustomerRecruitmentUpgradeV1,
  CUSTOMER_RECRUITMENT_RESUME_UPGRADE_V2 as resume, isCustomerRecruitmentResumeUpgradeV2 } from "../src/lib/customerRecruitmentUpgrade.js";
import { CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V1 as quality,
  isCustomerAgentQualityContinuityUpgradeV1 } from "../src/lib/customerAgentQualityContinuityUpgrade.js";
import { CUSTOMER_AGENT_SYSTEM } from "../src/ai/customerAgentPrompt.js";
import { customerAgentToolDefinitions, CUSTOMER_AGENT_PUBLIC_TOOLS } from "../src/ai/customerAgentToolDefinitions.js";
import { customerAgentPublishRequestSchema, customerAgentRefreshRequestSchema } from "@royal-home/shared";
const prior:{promptHash:string;toolSchemaHash:string}={promptHash:pair.fromPrompt,toolSchemaHash:pair.fromTools};
const next:{promptHash:string;toolSchemaHash:string}={promptHash:pair.toPrompt,toolSchemaHash:pair.toTools};
it("keeps the historical recruitment pair pinned while recognizing the distinct availability catalog",()=>{
  const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
  const names=[...CUSTOMER_AGENT_PUBLIC_TOOLS,"save_contact","request_callback","request_handover","book_showing",
    "reschedule_showing","cancel_showing","ask_owner","save_job_application"] as const;
  const historicalResumeFrom={promptHash:resume.fromPrompt,toolSchemaHash:resume.fromTools};
  const historicalResumeTo={promptHash:resume.toPrompt,toolSchemaHash:resume.toTools};
  expect(isCustomerRecruitmentResumeUpgradeV2(historicalResumeFrom,historicalResumeTo)).toBe(true);
  expect(sha(CUSTOMER_AGENT_SYSTEM)).toBe(quality.toPrompt);
  expect(resume.fromPrompt).toBe(pair.toPrompt);
  expect(resume.toPrompt).toBe(quality.fromPrompt);
  const currentTools=sha(JSON.stringify(customerAgentToolDefinitions(names)));
  expect(currentTools).toBe("16dcce629b9cec908e64942333769bdc05353fbe5675726fe9c9cfd3c9ee7b67");
  expect(currentTools).toBe(quality.toolSchemaHash);
  expect(currentTools).not.toBe(pair.toTools);
  expect(isCustomerAgentQualityContinuityUpgradeV1(
    {promptHash:quality.fromPrompt,toolSchemaHash:quality.toolSchemaHash,knowledgeSchemaHash:quality.fromKnowledgeSchema},
    {promptHash:sha(CUSTOMER_AGENT_SYSTEM),toolSchemaHash:currentTools,knowledgeSchemaHash:quality.toKnowledgeSchema})).toBe(true);
  expect(isCustomerRecruitmentResumeUpgradeV2(historicalResumeFrom,
    {promptHash:sha(CUSTOMER_AGENT_SYSTEM),toolSchemaHash:currentTools})).toBe(false);
  expect(isCustomerRecruitmentUpgradeV1(prior,next)).toBe(true);
  expect(isCustomerRecruitmentUpgradeV1(prior,{promptHash:pair.toPrompt,toolSchemaHash:currentTools})).toBe(false);
});
it("qualifies only the separate versioned résumé protocol from the availability release",()=>{
  expect(isCustomerRecruitmentResumeUpgradeV2({promptHash:resume.fromPrompt,toolSchemaHash:resume.fromTools},
    {promptHash:resume.toPrompt,toolSchemaHash:resume.toTools})).toBe(true);
  expect(isCustomerRecruitmentUpgradeV1(prior,{promptHash:resume.toPrompt,toolSchemaHash:resume.toTools})).toBe(false);
  expect(isCustomerRecruitmentResumeUpgradeV2(prior,{promptHash:resume.toPrompt,toolSchemaHash:resume.toTools})).toBe(false);
});
it("accepts the closed explicit refresh acknowledgement and requires idle advancement for publication",()=>{
  expect(customerAgentRefreshRequestSchema.safeParse({expectedPolicyRevision:"1",reason:"synthetic reviewed source"}).success).toBe(true);
  expect(customerAgentRefreshRequestSchema.safeParse({expectedPolicyRevision:"1",reason:"synthetic reviewed source",confirmRecruitmentResumeUpgrade:true}).success).toBe(true);
  expect(customerAgentRefreshRequestSchema.safeParse({expectedPolicyRevision:"1",reason:"synthetic reviewed source",confirmRecruitmentResumeUpgrade:false}).success).toBe(false);
  expect(customerAgentRefreshRequestSchema.safeParse({expectedPolicyRevision:"1",reason:"synthetic reviewed source",confirmQualityContinuityUpgrade:true}).success).toBe(true);
  expect(customerAgentRefreshRequestSchema.safeParse({expectedPolicyRevision:"1",reason:"synthetic reviewed source",confirmQualityContinuityUpgrade:false}).success).toBe(false);
  const publication={
    expectedPolicyRevision:"1",reason:"synthetic reviewed source",confirmRecruitmentResumeUpgrade:true,
    confirmManagedPaidCalls:true,acknowledgeNoDailyCap:true,
    capabilities:{},rollout:{version:1,cohortId:"10000000-0000-4000-8000-000000000001",candidateRevisionId:"a".repeat(64),percentBasisPoints:5000,
      allowed:[{surface:"dm",channel:"INSTAGRAM",endpointScopeId:"10000000-0000-4000-8000-000000000002"}]},
  };
  expect(customerAgentPublishRequestSchema.safeParse(publication).success).toBe(false);
  expect(customerAgentPublishRequestSchema.safeParse({...publication,advanceIdleRevision:true}).success).toBe(true);
  expect(customerAgentPublishRequestSchema.safeParse({...publication,confirmQualityContinuityUpgrade:true}).success).toBe(false);
  expect(customerAgentPublishRequestSchema.safeParse({...publication,advanceIdleRevision:true,confirmQualityContinuityUpgrade:true}).success).toBe(true);
});
it.each(["prior-prompt","prior-tools","next-prompt","next-tools","reverse","replay"])("keeps résumé v2 closed to another pair: %s",which=>{
  const a={promptHash:resume.fromPrompt,toolSchemaHash:resume.fromTools},b={promptHash:resume.toPrompt,toolSchemaHash:resume.toTools},other="f".repeat(64);
  if(which==="prior-prompt")a.promptHash=other;
  if(which==="prior-tools")a.toolSchemaHash=other;
  if(which==="next-prompt")b.promptHash=other;
  if(which==="next-tools")b.toolSchemaHash=other;
  if(which==="reverse"){const previous={...a};Object.assign(a,b);Object.assign(b,previous);}
  if(which==="replay")Object.assign(a,b);
  expect(isCustomerRecruitmentResumeUpgradeV2(a,b)).toBe(false);
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
it.each(["prior-prompt","prior-tools","prior-knowledge","next-prompt","next-tools","next-knowledge","reverse","replay"])("keeps quality/continuity upgrade closed to another pair: %s",which=>{
  const a={promptHash:quality.fromPrompt,toolSchemaHash:quality.toolSchemaHash,knowledgeSchemaHash:quality.fromKnowledgeSchema};
  const b={promptHash:quality.toPrompt,toolSchemaHash:quality.toolSchemaHash,knowledgeSchemaHash:quality.toKnowledgeSchema},other="f".repeat(64);
  if(which==="prior-prompt")a.promptHash=other;
  if(which==="prior-tools")a.toolSchemaHash=other;
  if(which==="next-prompt")b.promptHash=other;
  if(which==="next-tools")b.toolSchemaHash=other;
  if(which==="prior-knowledge")a.knowledgeSchemaHash=other;
  if(which==="next-knowledge")b.knowledgeSchemaHash=other;
  if(which==="reverse"){const previous={...a};Object.assign(a,b);Object.assign(b,previous);}
  if(which==="replay")Object.assign(a,b);
  expect(isCustomerAgentQualityContinuityUpgradeV1(a,b)).toBe(false);
});
