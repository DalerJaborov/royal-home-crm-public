import { isDeepStrictEqual } from "node:util";
import { recruitmentFactKeySchema, type RecruitmentFactKey } from "@royal-home/shared";
import type { TxClient } from "../db.js";
import type { inspectCustomerWriteAuthority } from "./customerState.js";
import { customerDeliveryFenceSchema } from "./customerDeliveryContracts.js";
import { decodeCustomerOutboxPayload } from "./customerOutboxCodec.js";
import { recruitmentRequiredQuestion } from "../ai/customerAgentRecruitmentProtocol.js";

type Grant = NonNullable<ReturnType<typeof inspectCustomerWriteAuthority>>;
type Source = Pick<Grant, "fence" | "eventKey" | "order">;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Conversation interpretation only, never authority for a new action. Reads
 * the exact preceding projected/provider-accepted own-inquiry bot question. */
export async function readRecruitmentAnsweredFactTx(tx: TxClient, grant: Source, messages: unknown): Promise<RecruitmentFactKey | null> {
  const nativeId = grant.fence.nativeId;
  if (!nativeId || !Array.isArray(messages)) return null;
  const currentIndexes = messages.flatMap((message, index) => record(message) && message.role === "user" &&
    record(message.customerPropertyAdmission) && message.customerPropertyAdmission.eventKey === grant.eventKey ? [index] : []);
  if (currentIndexes.length !== 1 || currentIndexes[0] < 1) return null;
  const prior = messages[currentIndexes[0] - 1];
  if (!record(prior) || prior.role !== "assistant" || typeof prior.customerOutboxPartId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(prior.customerOutboxPartId)) return null;
  const part = await tx.customerOutboxPart.findFirst({ where: {
    id: prior.customerOutboxPartId, inquiryId: grant.fence.inquiryId, originalNativeId: nativeId,
    conversationId: nativeId, endpointScopeId: grant.fence.endpoint.endpointScopeId,
    sourceKind: "BOT_TURN", mode: "LIVE", status: "ACCEPTED", acceptedAt: { not: null }, projectionRecordedAt: { not: null },
    supersededAt: null, cancelRequestedAt: null, ticket: { is: { order: { lt: BigInt(grant.order) } } },
  }, include: { attempts: { where: { outcome: "ACCEPTED", providerMid: { not: null }, finishedAt: { not: null } }, take: 1 } } });
  if (!part || !part.ticketEventKey || part.sourceKey !== part.ticketEventKey || !part.attempts[0] ||
    part.attempts[0].endpointScopeId !== part.endpointScopeId || part.attempts[0].claimRevision !== part.claimRevision) return null;
  const fence = customerDeliveryFenceSchema.safeParse(part.fenceJson);
  if (!fence.success || fence.data.inquiryId !== grant.fence.inquiryId || fence.data.nativeId !== grant.fence.nativeId ||
    !isDeepStrictEqual(fence.data.endpoint, grant.fence.endpoint) || fence.data.ownerToken !== grant.fence.ownerToken ||
    fence.data.bindingRevision !== grant.fence.bindingRevision || fence.data.ownershipEpoch !== grant.fence.ownershipEpoch ||
    fence.data.scopeRevision !== grant.fence.scopeRevision || fence.data.policyRevision !== grant.fence.policyRevision) return null;
  try {
    const payload = decodeCustomerOutboxPayload(part);
    if (payload.kind !== "text" || prior.content !== payload.text) return null;
    // Existing accepted SMM tool-question wording remains interpretable across
    // the reviewed protocol upgrade; exact stored text only, no fuzzy match.
    if (["Какими программами пользуетесь и какие задачи выполняете самостоятельно?",
      "Аз кадом барномаҳо истифода мебаред ва кадом вазифаҳоро мустақилона иҷро мекунед?"].some(question => payload.text.endsWith(question))) return "tools";
    return recruitmentFactKeySchema.options.find(key => ["ru", "tg"].some(language =>
      payload.text.endsWith(recruitmentRequiredQuestion(key, language as "ru" | "tg")))) ?? null;
  } catch { return null; }
}
