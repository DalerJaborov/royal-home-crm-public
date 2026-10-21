import {createHash,randomUUID} from "node:crypto";
import {beforeAll,expect,it} from "vitest";
import {prisma,type TxClient} from "../src/db.js";
import {registerCurrentCustomerAgentRevision} from "../src/lib/customerAgentRegistration.js";
import {createCustomerAgentMediaProviderSnapshot} from "../src/ai/customerAgentProviderConfig.js";
import {customerAgentManifestId} from "../src/lib/customerAgentRevision.js";
import {customerAgentRevisionReachable,readApprovedCustomerWordRevisions} from "../src/lib/customerAgentRevisionAdvance.js";
import {ensureCustomerEndpoint} from "../src/lib/customerConversationScope.js";
import {enrollCustomerAgentSubjectTx} from "../src/lib/customerAgentEnrollment.js";
import {encryptSecret} from "../src/crypto.js";

let manifest:Omit<Awaited<ReturnType<typeof registerCurrentCustomerAgentRevision>>,"id">;
beforeAll(async()=>{const {id:_,...value}=await registerCurrentCustomerAgentRevision(createCustomerAgentMediaProviderSnapshot());manifest=value;});
class RollbackFixture extends Error {}
async function rollback(run:(tx:TxClient)=>Promise<void>){
  try{await prisma.$transaction(async tx=>{await run(tx);throw new RollbackFixture();},{timeout:60000});}
  catch(error){if(!(error instanceof RollbackFixture))throw error;}
}
async function chain(tx:TxClient,length:number,approvedAt?:Date){
  const tag=randomUUID(),nodes=[] as Array<{id:string;cohort:string}>;
  for(let i=0;i<=length;i++){
    const value={...manifest,coreHash:createHash("sha256").update(`${tag}:${i}`).digest("hex")},id=customerAgentManifestId(value);
    await tx.$executeRaw`INSERT INTO "CustomerAgentRevision" ("id","manifestJson","createdAt") VALUES (${id},${JSON.stringify(value)}::jsonb,now())`;
    nodes.push({id,cohort:randomUUID()});
  }
  const install=async(node:{id:string;cohort:string})=>{
    await tx.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"='ACTIVE',"activeAgentRevisionId"=${node.id},
      "rolloutConfig"=${JSON.stringify({version:1,cohortId:node.cohort,candidateRevisionId:node.id,percentBasisPoints:5000,allowed:[]})}::jsonb WHERE "id"='singleton'`;
  };
  await install(nodes[0]);
  for(let i=1;i<nodes.length;i++){
    const p=await tx.customerRuntimePolicy.findUniqueOrThrow({where:{id:"singleton"}});
    await tx.$executeRaw`INSERT INTO "CustomerAgentRevisionAdvance" ("id","fromRevisionId","fromCohortId","toRevisionId","toCohortId","policyRevision","approvedAt")
      VALUES (${randomUUID()},${nodes[i-1].id},${nodes[i-1].cohort},${nodes[i].id},${nodes[i].cohort},${p.policyRevision+1n},${approvedAt??new Date("2026-10-21T00:00:00Z")})`;
    await install(nodes[i]);
  }
  return nodes;
}
async function ownedInput(tx:TxClient,nodes:Array<{id:string;cohort:string}>,target=nodes.at(-1)!){
  const id=randomUUID(),externalId=`synthetic-lineage-${id}`,peer=`synthetic-peer-${id}`;
  await tx.messengerAccount.create({data:{id,channel:"INSTAGRAM",externalId,title:"Synthetic lineage",token:encryptSecret("synthetic-not-used"),enabled:true}});
  const endpoint=await ensureCustomerEndpoint(tx,{channel:"INSTAGRAM",subscriberId:peer,accountId:id,accountExternalId:externalId});
  const allowed=[{surface:"dm",channel:"INSTAGRAM",endpointScopeId:endpoint.endpointScopeId}];
  const install=async(node:{id:string;cohort:string})=>{
    await tx.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "activeAgentRevisionId"=${node.id},
      "rolloutConfig"=${JSON.stringify({version:1,cohortId:node.cohort,candidateRevisionId:node.id,percentBasisPoints:10000,allowed})}::jsonb WHERE "id"='singleton'`;
  };
  await install(nodes[0]);
  const route=await enrollCustomerAgentSubjectTx(tx,{surface:"dm",endpoint:{endpointScopeId:endpoint.endpointScopeId,scopeRevision:endpoint.scopeRevision,
    channel:"INSTAGRAM",accountId:id,transportKey:endpoint.transportKey},peer});
  expect(route.lane).toBe("CORE");if(route.lane!=="CORE"||!route.assignment)throw Error("Owned routing fixture required");
  await install(target);
  const p=await tx.customerRuntimePolicy.findUniqueOrThrow({where:{id:"singleton"}});
  return{assignmentId:route.assignment.id,endpointScopeId:endpoint.endpointScopeId,revisionId:target.id,receivedAt:new Date("2026-10-21T01:00:00Z"),policyRevision:String(p.policyRevision)};
}

it.each([17,18,65])("retains an actually approved %i-edge path instead of expiring its oldest subjects",async length=>{
  await rollback(async tx=>{
    const nodes=await chain(tx,length),first=nodes[0],last=nodes.at(-1)!;
    expect(await customerAgentRevisionReachable(tx,{candidateRevisionId:first.id,cohortId:first.cohort},last.id,last.cohort)).toBe(true);
    expect(await customerAgentRevisionReachable(tx,{candidateRevisionId:first.id,cohortId:randomUUID()},last.id,last.cohort)).toBe(false);
    expect(await customerAgentRevisionReachable(tx,{candidateRevisionId:first.id,cohortId:first.cohort},last.id,randomUUID())).toBe(false);
    expect(await customerAgentRevisionReachable(tx,{candidateRevisionId:last.id,cohortId:last.cohort},first.id,first.cohort)).toBe(false);
  });
});
it("the actual insertion guard rejects a cycle whose return path exceeds sixteen edges",async()=>{
  await rollback(async tx=>{
    const nodes=await chain(tx,65),first=nodes[0],last=nodes.at(-1)!;
    const p=await tx.customerRuntimePolicy.findUniqueOrThrow({where:{id:"singleton"}});
    await expect(tx.$executeRaw`INSERT INTO "CustomerAgentRevisionAdvance" ("id","fromRevisionId","fromCohortId","toRevisionId","toCohortId","policyRevision","approvedAt")
      VALUES (${randomUUID()},${last.id},${last.cohort},${first.id},${first.cohort},${p.policyRevision+1n},now())`).rejects.toThrow();
  });
});
it("own-word ancestry follows the exact current cohort across65 steps while retaining source-time, scope and policy fences",async()=>{
  await rollback(async tx=>{
    const nodes=await chain(tx,65),input=await ownedInput(tx,nodes);
    const revisions=await readApprovedCustomerWordRevisions(tx,input);
    expect(revisions.size).toBe(65);expect(revisions.has(nodes[0].id)).toBe(true);expect(revisions.has(input.revisionId)).toBe(false);
    for(const changed of [{endpointScopeId:randomUUID()},{assignmentId:randomUUID()},{receivedAt:new Date(0)},
      {policyRevision:String(BigInt(input.policyRevision)+1n)},{revisionId:nodes[3].id}]){
      expect((await readApprovedCustomerWordRevisions(tx,{...input,...changed})).size).toBe(0);
    }
    const p=await tx.customerRuntimePolicy.findUniqueOrThrow({where:{id:"singleton"}});
    await tx.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=jsonb_set("rolloutConfig",'{cohortId}',${JSON.stringify(randomUUID())}::jsonb) WHERE "id"='singleton'`;
    const changed=await tx.customerRuntimePolicy.findUniqueOrThrow({where:{id:"singleton"}});
    expect(changed.activeAgentRevisionId).toBe(p.activeAgentRevisionId);
    expect((await readApprovedCustomerWordRevisions(tx,{...input,policyRevision:String(changed.policyRevision)})).size).toBe(0);
  });
});
it("future-approved edges supply no own-word continuity even though a structural registry path exists",async()=>{
  await rollback(async tx=>{
    const nodes=await chain(tx,18,new Date("2100-01-01T00:00:00Z")),input=await ownedInput(tx,nodes);
    expect(await customerAgentRevisionReachable(tx,{candidateRevisionId:nodes[0].id,cohortId:nodes[0].cohort},input.revisionId,nodes.at(-1)!.cohort)).toBe(true);
    expect((await readApprovedCustomerWordRevisions(tx,input)).size).toBe(0);
  });
});
it("own-word traversal stops at the current target and never borrows later registered descendants",async()=>{
  await rollback(async tx=>{
    const nodes=await chain(tx,66),input=await ownedInput(tx,nodes,nodes[65]);
    const revisions=await readApprovedCustomerWordRevisions(tx,input);
    expect(revisions.size).toBe(65);expect(revisions.has(nodes[64].id)).toBe(true);expect(revisions.has(nodes[66].id)).toBe(false);
  });
});
