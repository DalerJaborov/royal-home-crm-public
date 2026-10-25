import { prisma, type TxClient } from "../db.js";
import { explicitOwnPhoneFact, fullPhoneIdentity } from "./clientPhoneFacts.js";
import { clientPhoneHash } from "./clientPhoneOrigins.js";

type Source = { kind: "CALL" | "CONVERSATION"; id: string; at: Date; text: string; clientId: string; telegram?: boolean };
/** Called only with authenticated incoming client text or attributed raw call transcript. Never model output. */
export async function captureExplicitClientPhone(source: Source, tx?: TxClient): Promise<boolean> {
  const fact=explicitOwnPhoneFact(source.text,source.kind);
  if(!fact || !Number.isFinite(source.at.getTime())) return false;
  const apply=async(db:TxClient)=>{
    const identity=fullPhoneIdentity(fact.phone);
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`client-phone:${identity}`}))`;
    if (source.kind === "CALL") await db.$queryRaw`SELECT id FROM "Interaction" WHERE id = ${source.id} FOR UPDATE`;
    else if (source.telegram) await db.$queryRaw`SELECT id FROM "TelegramConversation" WHERE id = ${source.id} FOR UPDATE`;
    else await db.$queryRaw`SELECT id FROM "BotConversation" WHERE id = ${source.id} FOR UPDATE`;
    await db.$queryRaw`SELECT id FROM "Client" WHERE id = ${source.clientId} FOR UPDATE`;
    const client=await db.client.findUnique({where:{id:source.clientId},select:{id:true,phone:true,whatsappPhone:true,extraPhones:true,deletedAt:true,assignedAt:true,assignedAgentId:true,assignmentCompletedAt:true,updatedAt:true}});
    if(!client || client.deletedAt || client.assignmentCompletedAt || source.at < client.assignedAt) return false;
    if(source.kind==='CALL') {
      const call=await db.interaction.findFirst({where:{id:source.id,clientId:client.id,investigationOnly:false,type:'CALL',createdAt:{gte:client.assignedAt}},select:{id:true}});
      if(!call) return false;
    } else {
      const conversation=source.telegram ? await db.telegramConversation.findFirst({where:{id:source.id,clientId:client.id},select:{id:true}}) : await db.botConversation.findFirst({where:{id:source.id,clientId:client.id},select:{id:true}});
      if(!conversation) return false;
    }
    if([client.phone,client.whatsappPhone,...client.extraPhones].filter((p):p is string=>!!p).some(p=>fullPhoneIdentity(p)===identity)) return false;
    // Exact full identity: local9 canonicalises only to +992; different country prefixes never collapse.
    const conflict=await db.$queryRaw<Array<{id:string}>>`
      SELECT id FROM "Client" WHERE id <> ${client.id} AND "deletedAt" IS NULL AND EXISTS (
        SELECT 1 FROM unnest(ARRAY[phone, "whatsappPhone"] || COALESCE("extraPhones", ARRAY[]::text[])) p
        WHERE CASE WHEN length(regexp_replace(COALESCE(p,''),'[^0-9]','','g'))=9 THEN '992'||regexp_replace(p,'[^0-9]','','g') ELSE regexp_replace(COALESCE(p,''),'[^0-9]','','g') END = ${identity}) LIMIT 1`;
    if(conflict.length) return false;
    const staff=await db.agent.findMany({select:{phone:true}});
    if(staff.some(a=>a.phone && fullPhoneIdentity(a.phone)===identity)) return false;
    const extra=fact.correction ? [...client.extraPhones,...(client.phone?[client.phone]:[])] : [...client.extraPhones,fact.phone];
    const changed=await db.client.updateMany({where:{id:client.id,updatedAt:client.updatedAt,assignedAgentId:client.assignedAgentId,assignedAt:client.assignedAt,assignmentCompletedAt:null,deletedAt:null},data:{extraPhones:[...new Set(extra)],...(fact.correction?{phone:fact.phone}:{})}});
    if(!changed.count) return false;
    // Trigger records the timestamp; explicit source is written in the same transaction, never inferred for old numbers.
    if(!fact.correction) await db.clientPhoneOrigin.updateMany({where:{clientId:client.id,phoneHash:clientPhoneHash(fact.phone)},data:{source:source.kind,sourceId:source.id}});
    return true;
  };
  return tx ? apply(tx) : prisma.$transaction(apply);
}

/** Post-commit enrichment of literal public user messages; transactional append itself stays side-effect free. */
export async function captureConversationPhoneMessages(conversationId: string, messages: Array<{ role: string; content: string; at?: string; by?: unknown; attachments?: unknown[] }>, telegram=false): Promise<void> {
  const eligible=messages.filter(m=>m.role==='user' && !m.by && !m.attachments?.length && m.at && explicitOwnPhoneFact(m.content,'CONVERSATION'));
  if(!eligible.length) return;
  const conversation=telegram ? await prisma.telegramConversation.findUnique({where:{id:conversationId},select:{clientId:true}}) : await prisma.botConversation.findUnique({where:{id:conversationId},select:{clientId:true}});
  if(!conversation?.clientId) return;
  for(const message of eligible) await captureExplicitClientPhone({kind:'CONVERSATION',id:conversationId,clientId:conversation.clientId,at:new Date(message.at!),text:message.content,telegram});
}
