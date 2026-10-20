import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { customerAgentDecisionSchema, customerAgentDeliveryObservationSchema, customerAgentDeliveryEvidenceSchema, customerToolCallSchema,
  customerAgentVerifiedContextSchema, type CustomerAgentVerifiedContext, type CustomerAgentDeliveryObservation, type CustomerAgentDeliveryEvidence,
  type CustomerAgentRevision, type CustomerAgentDecision, type CustomerPropertyFactKind } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { isCustomerPrincipal, revalidateCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { customerAgentClaimCurrentTx, customerAgentClaimAcceptsPrincipal, type CustomerAgentClaim } from "./customerAgentClaim.js";
import { inspectPublicCommentPrincipal, revalidatePublicCommentPrincipal, type PublicCommentPrincipal } from "./publicCommentSourceIssuer.js";
import { readPublicSourceRow, publicCommentOrigin } from "./customerPublicCommentStore.js";
import { decodeCustomerAgentRevision } from "./customerAgentRevision.js";
import { readCustomerAgentPublicData, customerAgentPublicDataCurrent } from "./customerAgentPublicReads.js";
import { renderCustomerAgentDecision, customerAgentRenderedQuestion, customerAgentCallbackQuestionText, customerAgentNameQuestionText, type CustomerAgentEvidence } from "../ai/customerAgentRenderer.js";
import type { CustomerAgentAttachmentInput } from "../ai/customerAgentAttachmentInput.js";
import { readCustomerShownSearchProperties, readCustomerPublicShownProperties } from "./customerSearchHistory.js";
import { readCustomerPublicPublicationSource } from "./customerPublicPublicationSource.js";
export { decodeCustomerAgentStoredTextPayload } from "./customerOutboxCodec.js";

type Preference = CustomerAgentDeliveryEvidence["linkPreference"];
type Binding = { surface: "dm"; principal: CustomerPrincipal; claim: CustomerAgentClaim;
  revision: Readonly<CustomerAgentRevision>; deadlineAt: number; linkPreference: Preference } |
  { surface: "public_comment"; principal: PublicCommentPrincipal; operationId: string;
    revision: Readonly<CustomerAgentRevision>; deadlineAt: number; linkPreference: Preference };
declare const readBrand: unique symbol;
declare const bundleBrand: unique symbol;
export type CustomerAgentDataReadWitness = { readonly [readBrand]: true };
export type CustomerAgentDeliveryWitness = { readonly [bundleBrand]: true };
const reads = new WeakMap<object, { binding: Binding; observation: CustomerAgentDeliveryObservation }>();
const bundles = new WeakMap<object, { binding: Binding; text: string; sideband: CustomerAgentDeliveryEvidence }>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(customerAgentDeliveryObservationSchema.parse(value))).digest("hex");
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
async function revision(id: string): Promise<Readonly<CustomerAgentRevision> | null> {
  const [row] = await prisma.$queryRaw<Array<{ id: string; manifestJson: unknown }>>`
    SELECT "id","manifestJson" FROM "CustomerAgentRevision" WHERE "id"=${id}`;
  return row ? decodeCustomerAgentRevision(row) : null;
}
async function dmBinding(principal: CustomerPrincipal, claim: CustomerAgentClaim): Promise<Binding | null> {
  if (!isCustomerPrincipal(principal) || !customerAgentClaimAcceptsPrincipal(claim, principal) || !await customerAgentClaimCurrentTx(prisma, claim) ||
      claim.eventKey !== principal.admission.eventKey || claim.pin.order !== principal.admission.order) return null;
  const stored = await revision(claim.pin.agentRevisionId);
  if (!stored || !isDeepStrictEqual(stored, claim.pin.revision)) return null;
  return { surface: "dm", principal, claim, revision: stored, deadlineAt: claim.deadlineAt,
    linkPreference: principal.visibility === "website_chat" ? "site" : "social" };
}
async function publicBinding(principal: PublicCommentPrincipal, linkPreference: Preference): Promise<Binding | null> {
  const original = inspectPublicCommentPrincipal(principal);
  if (!original || !["site", "social"].includes(linkPreference)) return null;
  const row = await readPublicSourceRow(original.source); if (!row) return null;
  const origin = publicCommentOrigin(row), stored = await revision(origin.agentPin.agentRevisionId);
  if (!stored || origin.proof.sourceRevision !== original.sourceRevision ||
      origin.proof.source.id !== original.source.id || origin.proof.source.table !== original.source.table ||
      !isDeepStrictEqual(origin.proof, original.proof)) return null;
  return { surface: "public_comment", principal, operationId: origin.agentPin.providerOperationId,
    revision: stored, deadlineAt: origin.agentPin.providerDeadlineAt, linkPreference };
}
async function current(binding: Binding, db: Pick<TxClient, "$queryRaw"> = prisma): Promise<boolean> {
  if (Date.now() >= binding.deadlineAt) return false;
  if (binding.surface === "dm") {
    return customerAgentClaimAcceptsPrincipal(binding.claim, binding.principal) &&
      (await revalidateCustomerPrincipal(binding.principal)).status === "current" &&
      await customerAgentClaimCurrentTx(db, binding.claim) && Date.now() < binding.deadlineAt;
  }
  if ((await revalidatePublicCommentPrincipal(binding.principal)).status !== "current") return false;
  const checked = await publicBinding(binding.principal, binding.linkPreference);
  return !!checked && checked.surface === "public_comment" && checked.operationId === binding.operationId &&
    checked.revision.id === binding.revision.id && checked.deadlineAt === binding.deadlineAt && Date.now() < binding.deadlineAt;
}
const same = (a: Binding, b: Binding) => a.surface === b.surface &&
  a.revision.id === b.revision.id && a.deadlineAt === b.deadlineAt && a.linkPreference === b.linkPreference &&
  (a.surface === "dm" && b.surface === "dm" ? a.claim === b.claim && customerAgentClaimAcceptsPrincipal(a.claim, a.principal) && customerAgentClaimAcceptsPrincipal(b.claim, b.principal) :
    a.surface === "public_comment" && b.surface === "public_comment" && a.principal === b.principal && a.operationId === b.operationId);
type ReadResult = { status: "observed"; observation: CustomerAgentDeliveryObservation; serverWitness: CustomerAgentDataReadWitness } |
  { status: "denied" | "unavailable"; reason: string };
/** Reads actual public data itself. Caller/model observations cannot mint a brand. */
async function read(binding: Binding | null, call: unknown): Promise<ReadResult> {
  try {
    if (!binding || !await current(binding)) return { status: "denied", reason: "original_context_changed" };
    const publication = binding.surface === "public_comment" && customerToolCallSchema.safeParse(call).success
      ? await readCustomerPublicPublicationSource(binding.principal, { deadlineAt: binding.deadlineAt }) ?? undefined : undefined;
    const isNextSearch = !!call && typeof call === "object" && "name" in call && call.name === "search_public_properties" &&
      "args" in call && !!call.args && typeof call.args === "object" && "nextPage" in call.args && call.args.nextPage === true;
    const alreadyShownShortIds = !isNextSearch ? [] : binding.surface === "dm" ? await readCustomerShownSearchProperties(binding.principal)
      : await readCustomerPublicShownProperties(binding.principal);
    const result = await readCustomerAgentPublicData(call, { knowledgeSourceHash: binding.revision.knowledgeSourceHash,
      linkPreference: binding.linkPreference, publication, alreadyShownShortIds });
    if (result.status !== "observed") return result;
    const observation = customerAgentDeliveryObservationSchema.parse(result.observation);
    if (!await current(binding)) return { status: "denied", reason: "original_context_changed" };
    const serverWitness = Object.freeze({}) as CustomerAgentDataReadWitness;
    reads.set(serverWitness, { binding, observation: frozen(structuredClone(observation)) });
    return { status: "observed", observation, serverWitness };
  } catch { return { status: "unavailable", reason: "public_read_unavailable" }; }
}
export async function readDmCustomerAgentDataWitness(input: { principal: CustomerPrincipal; claim: CustomerAgentClaim; call: unknown }): Promise<ReadResult> {
  try { return read(await dmBinding(input.principal, input.claim), input.call); }
  catch { return { status: "unavailable", reason: "public_read_unavailable" }; }
}
export async function readPublicCustomerAgentDataWitness(input: { principal: PublicCommentPrincipal; call: unknown; linkPreference: Preference }): Promise<ReadResult> {
  try { return read(await publicBinding(input.principal, input.linkPreference), input.call); }
  catch { return { status: "unavailable", reason: "public_read_unavailable" }; }
}
export interface CustomerAgentDeliveryRender {
  mediaPerception?: import("../ai/customerAgentMediaPerception.js").CustomerAgentMediaPerception;
  decision: CustomerAgentDecision; evidence: readonly CustomerAgentEvidence[]; text: string; language: "ru" | "tg";
  requestedFacts: readonly CustomerPropertyFactKind[]; knownPhoneSource: "none" | "current_input" | "scoped_contact";
  verifiedContext?: CustomerAgentVerifiedContext;
  inputText?: string;
  attachmentInput?: CustomerAgentAttachmentInput;
}
type SealResult = { status: "sealed"; text: string; witness: CustomerAgentDeliveryWitness | null } | { status: "held"; reason: string };
async function seal(binding: Binding | null, render: CustomerAgentDeliveryRender, serverWitnesses: readonly CustomerAgentDataReadWitness[]): Promise<SealResult> {
  try {
    if (!binding || serverWitnesses.length > 8 || render.evidence.length > 16 || !await current(binding)) return { status: "held", reason: "original_context_changed" };
    const context = render.verifiedContext ? customerAgentVerifiedContextSchema.parse(render.verifiedContext) : undefined;
    if (context && (context.surface !== binding.surface || context.revisionId !== binding.revision.id)) {
      return { status: "held", reason: "original_context_changed" };
    }
    const decision = customerAgentDecisionSchema.parse(render.decision);
    const text = renderCustomerAgentDecision({ ...render, decision, verifiedContext: context, surface: binding.surface,
      maxOutputChars: binding.revision.limits.maxOutputChars, knowledgeSourceHash: binding.revision.knowledgeSourceHash });
    if (!text || text !== render.text) return { status: "held", reason: "render_changed" };
    const refs = decision.kind === "propose" ? [decision.ref] :
      decision.kind === "reply" || decision.kind === "clarify" ? decision.refs : [];
    const observations = render.evidence.filter(e => (refs.includes(e.ref) ||
      e.value.kind === "company_information" ||
      render.requestedFacts.length > 0 && e.value.kind === "publication_properties") &&
      (e.value.kind === "company_policy" || e.value.kind === "property_search" || e.value.kind === "publication_properties" || e.value.kind === "company_information"))
      .map(e => customerAgentDeliveryObservationSchema.parse(e.value));
    const callbackQuestion = binding.surface === "dm" && customerAgentRenderedQuestion({ ...render, surface: "dm" }) === "callback_consent" &&
      text.endsWith(customerAgentCallbackQuestionText(render.language))
      ? { version: 1 as const, kind: "callback_consent" as const, language: render.language } : undefined;
    const nameQuestion = binding.surface === "dm" && customerAgentRenderedQuestion({ ...render, surface: "dm" }) === "name" &&
      text.endsWith(customerAgentNameQuestionText(render.language))
      ? { version: 1 as const, kind: "name" as const, language: render.language } : undefined;
    if (!await current(binding)) return { status: "held", reason: "original_context_changed" };
    if (!observations.length && !callbackQuestion && !nameQuestion) return { status: "sealed", text, witness: null };
    for (const observation of observations) {
      if (!serverWitnesses.some(token => {
        const issued = reads.get(token); return !!issued && same(issued.binding, binding) && digest(issued.observation) === digest(observation);
      })) return { status: "held", reason: "server_read_witness_required" };
      if (!await customerAgentPublicDataCurrent(observation, { knowledgeSourceHash: binding.revision.knowledgeSourceHash,
        linkPreference: binding.linkPreference })) return { status: "held", reason: "public_data_changed" };
    }
    if (!await current(binding)) return { status: "held", reason: "original_context_changed" };
    const sideband = frozen(customerAgentDeliveryEvidenceSchema.parse({ version: 1, agentRevisionId: binding.revision.id,
      knowledgeSourceHash: binding.revision.knowledgeSourceHash, linkPreference: binding.linkPreference, observations,
      ...(callbackQuestion ? { callbackQuestion } : {}), ...(nameQuestion ? { nameQuestion } : {}) }));
    const witness = Object.freeze({}) as CustomerAgentDeliveryWitness;
    bundles.set(witness, { binding, text, sideband });
    return { status: "sealed", text, witness };
  } catch { return { status: "held", reason: "evidence_unavailable" }; }
}
export async function sealDmCustomerAgentDeliveryEvidence(input: { principal: CustomerPrincipal; claim: CustomerAgentClaim;
  render: CustomerAgentDeliveryRender; serverWitnesses: readonly CustomerAgentDataReadWitness[] }): Promise<SealResult> {
  try { return seal(await dmBinding(input.principal, input.claim), input.render, input.serverWitnesses); }
  catch { return { status: "held", reason: "evidence_unavailable" }; }
}
export async function sealPublicCustomerAgentDeliveryEvidence(input: { principal: PublicCommentPrincipal;
  render: CustomerAgentDeliveryRender; serverWitnesses: readonly CustomerAgentDataReadWitness[]; linkPreference: Preference }): Promise<SealResult> {
  try { return seal(await publicBinding(input.principal, input.linkPreference), input.render, input.serverWitnesses); }
  catch { return { status: "held", reason: "evidence_unavailable" }; }
}
async function serialize(tx: TxClient, binding: Binding | null, witness: CustomerAgentDeliveryWitness, text: string): Promise<CustomerAgentDeliveryEvidence> {
  const value = bundles.get(witness);
  if (!isActiveTransactionClient(tx) || !binding || !value || !same(value.binding, binding) || value.text !== text || !await current(binding, tx)) {
    throw new Error("Original server delivery evidence required");
  }
  return frozen(structuredClone(value.sideband));
}
/** Call from existing planning TX after its genuine principal/claim/fence checks.
 * This serialization is not a second planner, inbox marker or delivery receipt. */
export async function serializeDmCustomerAgentDeliveryEvidence(tx: TxClient, input: {
  principal: CustomerPrincipal; claim: CustomerAgentClaim; witness: CustomerAgentDeliveryWitness; text: string;
}): Promise<CustomerAgentDeliveryEvidence> {
  return serialize(tx, await dmBinding(input.principal, input.claim), input.witness, input.text);
}
export async function serializePublicCustomerAgentDeliveryEvidence(tx: TxClient, input: {
  principal: PublicCommentPrincipal; witness: CustomerAgentDeliveryWitness; text: string;
}): Promise<CustomerAgentDeliveryEvidence> {
  const stored = bundles.get(input.witness);
  if (!stored || stored.binding.surface !== "public_comment" || stored.binding.principal !== input.principal) throw new Error("Original public delivery witness required");
  return serialize(tx, await publicBinding(input.principal, stored.binding.linkPreference), input.witness, input.text);
}
/** Codec only: stored JSON becomes data for revalidation, never a WeakMap brand. */
/** Data-only pre-POST check in addition to ALL existing DM/public source/P03/
 * ownership/receipt guards. No actor, new age or model authorization from JSON. */
export async function customerAgentStoredPublicDataCurrent(sideband: CustomerAgentDeliveryEvidence, expectedAgentRevisionId: string | null): Promise<boolean> {
  try {
    const value = customerAgentDeliveryEvidenceSchema.parse(sideband);
    if (!expectedAgentRevisionId || value.agentRevisionId !== expectedAgentRevisionId) return false;
    const stored = await revision(value.agentRevisionId);
    if (!stored || stored.knowledgeSourceHash !== value.knowledgeSourceHash) return false;
    for (const observation of value.observations) if (!await customerAgentPublicDataCurrent(observation, {
      knowledgeSourceHash: stored.knowledgeSourceHash, linkPreference: value.linkPreference })) return false;
    return true;
  } catch { return false; }
}
