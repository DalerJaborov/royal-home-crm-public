import { prisma, type TxClient } from "../db.js";
import { bareOwnPhoneFact, explicitOwnPhoneFact, fullPhoneIdentity, contextualOwnPhoneFact } from "./clientPhoneFacts.js";
import { clientPhoneHash } from "./clientPhoneOrigins.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { isOwnAgencyNumber } from "./publicAgencyContact.js";

/**
 * Номер одним сообщением в переписке с карточкой (27.11.2026): свой рубильник Settings.chatBarePhoneToCardEnabled.
 * Сбой чтения рубильника — не повод терять номер. Вопрос перед сообщением о номере ДРУГОГО человека — решает человек.
 */
async function bareConversationFact(text: string, messages: unknown, at: Date): Promise<ReturnType<typeof bareOwnPhoneFact>> {
  const fact = bareOwnPhoneFact(text, precedingQuestionOf(messages, text, at));
  if (!fact) return null;
  return (await automationSwitchOn("chatBarePhoneToCardEnabled").catch(() => true)) ? fact : null;
}

/**
 * Последняя реплика сотрудника или бота ПЕРЕД этим сообщением клиента. Сообщение уже в переписке (запись ядра, удержанное,
 * проход сторожа) — ищем его по тексту и времени; ещё нет (живой ход пишет после захвата) — берём последнюю нашу реплику.
 */
export function precedingQuestionOf(messages: unknown, text: string, at: Date): string | null {
  if (!Array.isArray(messages)) return null;
  const iso = at.toISOString();
  let end = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown; at?: unknown } | null;
    if (m?.role === "user" && m.content === text && (m.at === iso || typeof m.at !== "string")) { end = i; break; }
  }
  for (let i = end - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (m?.role === "assistant" && typeof m.content === "string") return m.content;
  }
  return null;
}

type Source = { kind: "CALL" | "CONVERSATION"; id: string; at: Date; text: string; clientId: string; telegram?: boolean };
/** Исход записи: saved — записан; skipped — правило не дало записывать (повтор бесполезен); conflict — карточку
 *  поменяли параллельно (оптимистичная проверка), повтор может пройти. */
export type ClientPhoneCaptureOutcome = "saved" | "skipped" | "conflict";

/** Called only with authenticated incoming client text or attributed raw call transcript. Never model output. */
export async function captureExplicitClientPhone(source: Source, tx?: TxClient): Promise<boolean> {
  return (await captureExplicitClientPhoneOutcome(source, tx)) === "saved";
}

/**
 * Повтор при параллельной правке карточки (ревью #497, S7): путь, где записанная копия переписки уже замаскирована
 * (удержанное ядром сообщение), второго шанса через проход сторожа не имеет. До трёх попыток, только на «conflict».
 */
export async function captureClientPhoneWithRetry(source: Source, attempts = 3,
  capture: (s: Source) => Promise<ClientPhoneCaptureOutcome> = (s) => captureExplicitClientPhoneOutcome(s)): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const outcome = await capture(source);
    if (outcome !== "conflict") return outcome === "saved";
  }
  return false;
}

export async function captureExplicitClientPhoneOutcome(source: Source, tx?: TxClient): Promise<ClientPhoneCaptureOutcome> {
  let fact=explicitOwnPhoneFact(source.text,source.kind);
  const conversationText = !fact && source.kind === "CONVERSATION" && !source.telegram;
  /** Факт взят из ответа на вопрос бота «есть ещё номер?» — его перепроверяем под замком ниже. */
  let contextual = false;
  if (conversationText && Number.isFinite(source.at.getTime())) {
    const conversation = await (tx ?? prisma).botConversation.findUnique({ where: { id: source.id }, select: { clientId: true, messages: true } });
    if (conversation?.clientId === source.clientId) {
      fact = contextualOwnPhoneFact(source.text, conversation.messages, undefined, source.at);
      contextual = !!fact;
      if (!fact) fact = await bareConversationFact(source.text, conversation.messages, source.at);
    }
  }
  if(!fact || !Number.isFinite(source.at.getTime())) return "skipped";
  // Номер самого агентства, процитированный клиентом, — не его номер (ревью #497, S5). Сотрудники — ниже, под замком.
  if (isOwnAgencyNumber(fact.phone)) return "skipped";
  const acceptedFact = fact;
  const apply=async(db:TxClient):Promise<ClientPhoneCaptureOutcome>=>{
    const identity=fullPhoneIdentity(acceptedFact.phone);
    await db.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`client-phone:${identity}`}))`;
    if (source.kind === "CALL") await db.$queryRaw`SELECT id FROM "Interaction" WHERE id = ${source.id} FOR UPDATE`;
    else if (source.telegram) await db.$queryRaw`SELECT id FROM "TelegramConversation" WHERE id = ${source.id} FOR UPDATE`;
    else await db.$queryRaw`SELECT id FROM "BotConversation" WHERE id = ${source.id} FOR UPDATE`;
    await db.$queryRaw`SELECT id FROM "Client" WHERE id = ${source.clientId} FOR UPDATE`;
    const client=await db.client.findUnique({where:{id:source.clientId},select:{id:true,phone:true,whatsappPhone:true,extraPhones:true,deletedAt:true,assignedAt:true,assignedAgentId:true,assignmentCompletedAt:true,updatedAt:true}});
    if(!client || client.deletedAt || client.assignmentCompletedAt || source.at < client.assignedAt) return "skipped";
    if(source.kind==='CALL') {
      const call=await db.interaction.findFirst({where:{id:source.id,clientId:client.id,investigationOnly:false,type:'CALL',createdAt:{gte:client.assignedAt}},select:{id:true}});
      if(!call) return "skipped";
    } else {
      const conversation=source.telegram ? await db.telegramConversation.findFirst({where:{id:source.id,clientId:client.id},select:{id:true}}) : await db.botConversation.findFirst({where:{id:source.id,clientId:client.id},select:{id:true,messages:true}});
      if(!conversation) return "skipped";
      if (contextual && contextualOwnPhoneFact(source.text, "messages" in conversation ? conversation.messages : null, client.assignedAt, source.at)?.phone !== acceptedFact.phone) return "skipped";
    }
    if([client.phone,client.whatsappPhone,...client.extraPhones].filter((p):p is string=>!!p).some(p=>fullPhoneIdentity(p)===identity)) return "skipped";
    // Exact full identity: local9 canonicalises only to +992; different country prefixes never collapse.
    const conflict=await db.$queryRaw<Array<{id:string}>>`
      SELECT id FROM "Client" WHERE id <> ${client.id} AND "deletedAt" IS NULL AND EXISTS (
        SELECT 1 FROM unnest(ARRAY[phone, "whatsappPhone"] || COALESCE("extraPhones", ARRAY[]::text[])) p
        WHERE CASE WHEN length(regexp_replace(COALESCE(p,''),'[^0-9]','','g'))=9 THEN '992'||regexp_replace(p,'[^0-9]','','g') ELSE regexp_replace(COALESCE(p,''),'[^0-9]','','g') END = ${identity}) LIMIT 1`;
    if(conflict.length) return "skipped";
    const staff=await db.agent.findMany({select:{phone:true}});
    if(staff.some(a=>a.phone && fullPhoneIdentity(a.phone)===identity)) return "skipped";
    const extra=acceptedFact.correction ? [...client.extraPhones,...(client.phone?[client.phone]:[])] : [...client.extraPhones,acceptedFact.phone];
    const changed=await db.client.updateMany({where:{id:client.id,updatedAt:client.updatedAt,assignedAgentId:client.assignedAgentId,assignedAt:client.assignedAt,assignmentCompletedAt:null,deletedAt:null},data:{extraPhones:[...new Set(extra)],...(acceptedFact.correction?{phone:acceptedFact.phone}:{})}});
    if(!changed.count) return "conflict";
    // Trigger records the timestamp; explicit source is written in the same transaction, never inferred for old numbers.
    if(!acceptedFact.correction) await db.clientPhoneOrigin.updateMany({where:{clientId:client.id,phoneHash:clientPhoneHash(acceptedFact.phone)},data:{source:source.kind,sourceId:source.id}});
    return "saved";
  };
  return tx ? apply(tx) : prisma.$transaction(apply);
}

/** Post-commit enrichment of literal public user messages; transactional append itself stays side-effect free. */
export async function captureConversationPhoneMessages(conversationId: string, messages: Array<{ role: string; content: string; at?: string; by?: unknown; attachments?: unknown[] }>, telegram=false): Promise<void> {
  const eligible=messages.filter(m=>m.role==='user' && !m.by && !m.attachments?.length && m.at && (explicitOwnPhoneFact(m.content,'CONVERSATION') || (!telegram && bareOwnPhoneFact(m.content))));
  // Окончательное решение (вопрос перед сообщением, рубильник, номер агентства и сотрудника) — в самой двери ниже.
  if(!eligible.length) return;
  const conversation=telegram ? await prisma.telegramConversation.findUnique({where:{id:conversationId},select:{clientId:true}}) : await prisma.botConversation.findUnique({where:{id:conversationId},select:{clientId:true}});
  if(!conversation?.clientId) return;
  for(const message of eligible) await captureExplicitClientPhone({kind:'CONVERSATION',id:conversationId,clientId:conversation.clientId,at:new Date(message.at!),text:message.content,telegram});
}
