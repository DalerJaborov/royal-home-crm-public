import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { prisma, type TxClient } from "../db.js";
import type { CustomerAgentRevision } from "@royal-home/shared";
import { CUSTOMER_AGENT_SYSTEM } from "../ai/customerAgentPrompt.js";
import { customerAgentToolDefinitions, CUSTOMER_AGENT_PUBLIC_TOOLS } from "../ai/customerAgentToolDefinitions.js";
import { decodeCustomerAgentProviderSnapshot, customerAgentProviderIdentities,
  type CustomerAgentProviderSnapshot } from "../ai/customerAgentProviderConfig.js";
import { currentCustomerAgentKnowledgeHash } from "./customerAgentPublicReads.js";
import { customerAgentManifestId, decodeCustomerAgentRevision, type CustomerAgentManifest } from "./customerAgentRevision.js";
import { archiveCustomerAgentRuntimeTx, loadPinnedCustomerAgentRuntime } from "./customerAgentRuntimeArchive.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sharedEntry = import.meta.resolve("@royal-home/shared");
function apiFile(path: string): URL {
  // Production uses dist/*.js. The isolated tsx stand hashes its ACTUAL *.ts
  // files; its revision is deliberately different and cannot be copied to prod.
  return new URL(import.meta.url.endsWith(".ts") ? path.replace(/\.js$/, ".ts") : path, import.meta.url);
}
async function fileGroup(paths: readonly URL[]): Promise<string> {
  const files = await Promise.all(paths.map(async path => {
    const bytes = await readFile(path);
    if (bytes.byteLength > 2 * 1024 * 1024) throw new TypeError("Unexpected customer artifact size");
    return sha(bytes);
  }));
  return sha(JSON.stringify(files));
}
const allTools = [...CUSTOMER_AGENT_PUBLIC_TOOLS, "save_contact", "request_callback", "request_handover", "book_showing",
  "reschedule_showing", "cancel_showing", "ask_owner"] as const;

/** Explicit artifact coverage, not a claim to hash every dependency/package in
 * the monorepo. Container/release identity is independently verified by ship.
 * The full version covers common decision, guards, renderer, schemas, prompt,
 * knowledge and exact provider configuration. No keys/customer data enter it. */
export async function buildCurrentCustomerAgentManifest(rawSnapshot: unknown): Promise<CustomerAgentManifest> {
  const snapshot = decodeCustomerAgentProviderSnapshot(rawSnapshot), identity = customerAgentProviderIdentities(snapshot);
  const [coreHash, rendererHash, modelSchemaHash, knowledgeSchemaHash] = await Promise.all([
    fileGroup(["../ai/customerAgentCore.js", "../ai/customerAgentModel.js", "../ai/customerAgentToolDefinitions.js", "../ai/customerAgentIntake.js", "../ai/sellerIntake.js", "./customerCompanyInformation.js", "./customerAgentFeaturePolicy.js",
      "../ai/providerContract.js", "../ai/providerBudget.js", "../ai/geminiClient.js", "../ai/geminiOperationRuntime.js", "../ai/geminiCountedTools.js",
      "../ai/geminiFunctionDeclarations.js", "../ai/geminiManagedToolsUsage.js", "../ai/geminiManagedMedia.js",
      "../ai/geminiCapabilities.js", "../ai/customerAgentMediaPerception.js", "../ai/customerAgentModelContracts.js", "../ai/clientLanguage.js", "../ai/untrustedContent.js", "./customerDmMediaContent.js", "./customerAgentMediaObservation.js", "./customerAgentMediaFocus.js",
      "./customerPropertyFocus.js", "./customerPropertyEvidence.js", "./customerPropertyResolver.js", "./customerPropertyRegistry.js", "./customerSharedPublication.js", "./safeFetch.js", "./customerMediaAudioTrack.js", "./ffmpeg.js", "../messengers/attachments.js",
      "./customerAgentClaim.js", "./customerAgentRevision.js", "./customerAgentContinuation.js", "./customerDmCoreContext.js",
      "./customerDmAgentTurn.js", "./customerDmAttachmentInput.js", "./customerAgentMutationSession.js", "./customerContactIntent.js", "./customerAgentDeliveryEvidence.js", "./customerAgentVerifiedContext.js",
      "./customerHandoverAck.js", "./customerDeliveryContracts.js", "./customerDeliveryDispatcher.js", "./customerDeliveryAdapters.js", "./customerOutboxEcho.js", "../messengers/inFlightEcho.js",
      "./customerDeliveryObservation.js", "./botTurnTrace.js", "./botTurnTracePrivacy.js", "./customerAgentDeliveryTrace.js", "../jobs/customerOutboxDispatch.js",
      "./customerPublicAgentTurn.js", "./customerPublicThreadContext.js", "./customerPublicPublicationSource.js", "./customerPublicationCatalog.js", "./customerSearchHistory.js", "./customerSearchSelection.js", "./customerOutboxCodec.js", "./customerAgentPublicReads.js", "./searchPlace.js", "../ai/geoMentions.js", "./geoNormalize.js", "../ai/folkPlaces.js", "./customerPublicCommentStore.js", "./customerPublicAgentFailure.js", "./customerAgentRevisionAdvance.js", "../messengers/comments.js", "../messengers/customerQualifierTurn.js",
      "./customerAgentEnrollment.js", "./customerAgentIngressRouting.js", "./customerAgentRoutingReference.js", "./customerAgentOwnerPolicy.js", "./customerQualifierContext.js",
      "./customerIngressProducer.js", "./customerIngressAuthority.js", "./customerIngressPayload.js", "./customerIngressNormalize.js", "./customerIngressRecovery.js",
      "./customerIngressClassification.js", "./customerOriginPayload.js", "./customerQualifierLedger.js",
      "./customerAgentRegistration.js", "./customerAgentRuntimeArchive.js", "./customerAgentRuntime.js", "./customerState.js", "./customerActionJournal.js",
      "./customerCallbackConsent.js", "./customerAcceptedCallbackQuestion.js",
      "./customerOutbox.js", "./customerPublicOrigin.js", "./customerPublicModeration.js", "./customerPublicModerationPolicy.js",
      "./incomingSpam.js", "./commentHate.js", "./listingAd.js", "./customerPublicOutreachMemory.js"].map(apiFile)),
    fileGroup(["../ai/customerAgentRenderer.js", "../ai/customerAgentIntake.js", "../ai/sellerIntake.js", "../ai/customerAgentAttachmentInput.js", "../ai/customerAgentMediaPerception.js", "../ai/customerAgentConversationPolicy.js", "../ai/customerAgentPublicProtocol.js", "./publicAgencyContact.js",
      "./customerPropertyFacts.js"].map(apiFile).concat(["customerPropertyPresentation.js", "propertyFinish.js", "propertyTypeFields.js"].map(path => new URL(path, sharedEntry)))),
    fileGroup(["customerAgent.js", "customerMutation.js", "customerState.js", "customerTools.js", "customerHandoverAck.js", "botTurnTrace.js", "customerAgentRollout.js", "customerAgentOwnerControls.js"].map(path => new URL(path, sharedEntry))),
    fileGroup(["customerAgentPublicReads.js", "customerAgentDeliveryEvidence.js", "customerPropertyContext.js"].map(path => new URL(path, sharedEntry))),
  ]);
  return { coreHash, rendererHash, modelSchemaHash, knowledgeSchemaHash,
    toolSchemaHash: sha(JSON.stringify(customerAgentToolDefinitions(allTools))),
    knowledgeSourceHash: currentCustomerAgentKnowledgeHash(), promptHash: sha(CUSTOMER_AGENT_SYSTEM),
    providerProfileHash: identity.providerProfileHash, providerPolicyHash: identity.providerPolicyHash,
    limits: { ...snapshot.turn, maxModelOutputTokens: snapshot.wire.maxOutputTokens } };
}

/** Server-only explicit registration. Caller authorization/rollout is separate;
 * this function deliberately cannot set activeAgentRevisionId or capabilities.
 * The exact CURRENT artifacts are computed here, not accepted from a model or
 * an HTTP manifest/hash JSON. Insertions and archive association commit together. */
export async function registerCurrentCustomerAgentRevision(rawSnapshot: unknown, callbacks: {
  beforeWrite?(tx: TxClient): Promise<void>;
  afterWrite?(tx: TxClient, revision: Readonly<CustomerAgentRevision>): Promise<void>;
} = {}): Promise<Readonly<CustomerAgentRevision>> {
  const snapshot = decodeCustomerAgentProviderSnapshot(rawSnapshot), now = Date.now();
  if (now < Date.parse(snapshot.wire.validFrom) || now >= Date.parse(snapshot.wire.validUntil)) throw new TypeError("Runtime registration outside validity window");
  const manifest = await buildCurrentCustomerAgentManifest(snapshot), id = customerAgentManifestId(manifest);
  return prisma.$transaction(async tx => {
    await callbacks.beforeWrite?.(tx);
    await archiveCustomerAgentRuntimeTx(tx, snapshot);
    await tx.$executeRaw`INSERT INTO "CustomerAgentRevision" ("id","manifestJson","createdAt")
      VALUES (${id},${JSON.stringify(manifest)}::jsonb,now()) ON CONFLICT ("id") DO NOTHING`;
    const [row] = await tx.$queryRaw<Array<{ id: string; manifestJson: unknown }>>`
      SELECT "id","manifestJson" FROM "CustomerAgentRevision" WHERE "id"=${id}`;
    if (!row || !isDeepStrictEqual(row.manifestJson, manifest)) throw new TypeError("Immutable current manifest collision");
    const registered = decodeCustomerAgentRevision(row);
    await callbacks.afterWrite?.(tx, registered);
    return registered;
  });
}

const currentArtifacts = new Map<string, Promise<CustomerAgentManifest>>();
/** Process-local cache of immutable RELEASE artifacts only. Authority and data
 * are never cached here. New model/prompt/knowledge/deploy requires a new revision;
 * an incompatible old turn stays held rather than switching its brain silently. */
export async function loadVerifiedCustomerAgentRevision(revision: Readonly<CustomerAgentRevision>): Promise<
  { status: "current"; revision: Readonly<CustomerAgentRevision>; snapshot: Readonly<CustomerAgentProviderSnapshot>; system: string } |
  { status: "held"; reason: string }
> {
  const runtime = await loadPinnedCustomerAgentRuntime(revision);
  if (runtime.status !== "current") return runtime;
  try {
    const key = `${revision.providerProfileHash}:${revision.providerPolicyHash}`;
    let current = currentArtifacts.get(key);
    if (!current) {
      current = buildCurrentCustomerAgentManifest(runtime.snapshot);
      currentArtifacts.set(key, current);
      void current.catch(() => { if (currentArtifacts.get(key) === current) currentArtifacts.delete(key); });
    }
    const manifest = await current;
    if (customerAgentManifestId(manifest) !== revision.id || !isDeepStrictEqual({ ...manifest, id: revision.id }, revision) ||
        currentCustomerAgentKnowledgeHash() !== revision.knowledgeSourceHash) return { status: "held", reason: "current_artifact_revision_mismatch" };
    return { status: "current", revision, snapshot: runtime.snapshot, system: CUSTOMER_AGENT_SYSTEM };
  } catch {
    return { status: "held", reason: "current_artifact_verification_unavailable" };
  }
}
