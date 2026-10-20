import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { decryptSecret } from "../crypto.js";
import { isCustomerPrincipal, revalidateCustomerPrincipal, customerPrincipalAuthenticatedInput } from "./customerPrincipal.js";
import { inspectAuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { loadPublicCommentSource } from "./customerPublicCommentStore.js";
import { samePublicInstallation, publicCommentSourceDigest } from "./publicCommentSourceIdentity.js";
import { customerSellerPrivateReply } from "./customerPublicModerationPolicy.js";

/** Read only OUR actually accepted DM to the exact Meta-returned recipient.
 * Never joins by phone/name/public author ID or imports the public advert into
 * private history. This is conversation context, never a contact/action grant. */
export async function readCustomerPublicOutreachMemory(principal: unknown): Promise<Array<{
  role: "assistant"; text: string; observedAt: number; stableKey: string;
}>> {
  if (!isCustomerPrincipal(principal) || principal.visibility !== "private_dm" || principal.assurance !== "protected_namespace" ||
      !principal.scope.accountId || (await revalidateCustomerPrincipal(principal)).status !== "current") return [];
  const authenticated=customerPrincipalAuthenticatedInput(principal), current=authenticated && inspectAuthenticatedCustomerInput(authenticated);
  if(!current || current.provenance!=="meta_signature")return [];
  const scopes = await prisma.customerEndpointScope.findMany({where:{realmKey:"customer-public",kind:"PUBLIC",
    channel:principal.scope.channel,messengerAccountId:principal.scope.accountId},select:{id:true},take:3});
  const keys=scopes.map(scope=>createHash("sha256").update(JSON.stringify([scope.id,principal.scope.peer])).digest("hex"));
  if(!keys.length)return [];
  const rows=await prisma.customerPublicEffect.findMany({where:{kind:"private_reply",status:"ACCEPTED",providerId:{not:null},
    recipientKey:{in:keys},finishedAt:{gte:new Date(Date.now()-7*24*60*60_000),lte:new Date(current.issuedAt)}},orderBy:{finishedAt:"desc"},take:3});
  const result:Array<{role:"assistant";text:string;observedAt:number;stableKey:string}>=[];
  for(const row of rows){
    const source=await loadPublicCommentSource({table:"meta",id:row.sourceId});
    // Terminal hide/delete increments the live edition. Historical context
    // uses the immutable ORIGINAL proof and unchanged content, never a send grant.
    if(!source?.proof || !source.currentInstallation || source.proof.sourceRevision!==row.sourceRevision.toString() ||
      source.proof.source.table!=="meta" || source.proof.source.id!==row.sourceId ||
      source.proof.policyRevision!==row.policyRevision.toString() || publicCommentSourceDigest(source)!==source.proof.digest ||
      source.currentInstallation.accountId!==principal.scope.accountId || source.target.channel!==principal.scope.channel ||
      source.currentInstallation.id!==row.endpointScopeId || !samePublicInstallation(source.proof.installation,source.currentInstallation)) continue;
    let text: string | null = null;
    try { if(row.payloadEncrypted)text=decryptSecret(row.payloadEncrypted); } catch { /* No plaintext/legacy fallback. */ }
    if(!text || ![customerSellerPrivateReply("ru"),customerSellerPrivateReply("tg")].includes(text) || !row.finishedAt ||
      createHash("sha256").update(JSON.stringify({kind:"private_reply",text})).digest("hex")!==row.payloadHash)continue;
    result.push({role:"assistant",text,observedAt:row.finishedAt.getTime(),stableKey:`public-private:${row.id}`});
  }
  return (await revalidateCustomerPrincipal(principal)).status==="current" ? result : [];
}
