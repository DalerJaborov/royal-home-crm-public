// Owner policy publication: fresh permissions, original revision and atomic audit.
// customer identity. Only the authenticated settings actor can publish policy.
import { z } from "zod";
import { ROLES, resolvePermissions, parsePermissionOverrides, isReadOnlyRole, customerAgentPublishRequestSchema,
  customerAgentKillRequestSchema, customerAgentRegisterRequestSchema, customerAgentOwnerStateSchema, customerAgentRefreshRequestSchema } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { isElevated } from "./stepUp.js";
import { settingsMaintenanceUntil, type SettingsMaintenanceActor } from "./settingsMaintenance.js";
import { decodeCustomerAgentRevision } from "./customerAgentRevision.js";
import { loadVerifiedCustomerAgentRevision, registerCurrentCustomerAgentRevision } from "./customerAgentRegistration.js";
import { createCustomerAgentMediaProviderSnapshot as createCustomerAgentProviderSnapshot, isCustomerAgentMediaProfileUpgrade } from "../ai/customerAgentProviderConfig.js";
import { loadPinnedCustomerAgentRuntime } from "./customerAgentRuntimeArchive.js";
import { decryptSecretSafe } from "../crypto.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { customerAgentRolloutConfigSchema } from "@royal-home/shared";
import { customerAgentRevisionReachable } from "./customerAgentRevisionAdvance.js";
import { isCustomerRecruitmentUpgradeV1, isCustomerRecruitmentResumeUpgradeV2 } from "./customerRecruitmentUpgrade.js";

export class CustomerAgentOwnerError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function fail(status: number, code: string): never { throw new CustomerAgentOwnerError(status,code); }
async function actorTx(tx: TxClient, id: string, elevation = true) {
  if (!z.string().uuid().safeParse(id).success) fail(401,"unauthenticated");
  const [row] = await tx.$queryRaw<Array<{ id: string; role: string; fullName: string; permissions: unknown; isActive: boolean; totpEnabled: boolean }>>`
    SELECT "id","role","fullName","permissions","isActive","totpEnabled" FROM "Agent" WHERE "id"=${id} FOR SHARE`;
  const role = z.enum(ROLES).safeParse(row?.role);
  if (!row || !row.isActive || !role.success || !["DIRECTOR","ADMIN"].includes(role.data) || isReadOnlyRole(role.data) ||
      !resolvePermissions(role.data,parsePermissionOverrides(row.permissions)).has("settings.manage")) fail(403,"settings_permission_revoked");
  if (elevation && !settingsStepUpSatisfied(row)) fail(428,"step_up_required");
  return row;
}
function settingsStepUpSatisfied(actor: SettingsMaintenanceActor & { id: string }) {
  return isElevated(actor.id) || !!settingsMaintenanceUntil(actor);
}
async function auditTx(tx: TxClient, actor: SettingsMaintenanceActor & { id: string; fullName: string }, action: string, entityId: string,
  meta: Record<string, string | number | boolean | null | string[]>) {
  const until = !isElevated(actor.id) ? settingsMaintenanceUntil(actor) : null;
  await tx.auditLog.create({ data: { action, entityType: "CustomerAgentPolicy", entityId, agentId: actor.id, agentName: actor.fullName,
    meta: { ...meta, ...(until && meta.authority !== "retained_policy_refresh" ? { authority: "settings_maintenance", settingsMaintenanceUntil: until } : {}) } } });
}
export async function registerCustomerAgentForOwner(actorId: string, raw: unknown) {
  const body = customerAgentRegisterRequestSchema.parse(raw), snapshot = createCustomerAgentProviderSnapshot();
  if (body.configId !== snapshot.configRevision) fail(409,"factory_changed");
  // Actual artifact/file awaits occur in the original registration helper;
  // callbacks run inside its SAME transaction, preserving atomic auth/audit.
  let actor: Awaited<ReturnType<typeof actorTx>> | undefined;
  const revision = await registerCurrentCustomerAgentRevision(snapshot, {
    beforeWrite: async tx => { actor = await actorTx(tx,actorId); },
    afterWrite: async (tx,value) => {
      if (!actor || !settingsStepUpSatisfied(actor)) fail(428,"step_up_required");
      await auditTx(tx,actor,"CUSTOMER_AGENT_REGISTER",value.id,{configId:body.configId,reason:body.reason});
      if (!settingsStepUpSatisfied(actor)) fail(428,"step_up_required");
    },
  });
  return { revisionId: revision.id, activated: false as const };
}
export async function readCustomerAgentOwnerState(actorId: string) {
  return prisma.$transaction(async tx => {
    await actorTx(tx,actorId,false);
    const p = await tx.customerRuntimePolicy.findUniqueOrThrow({ where: { id:"singleton" } });
    const scopes = await tx.$queryRaw<Array<{ id:string; channel:string; realmKey:string; kind:string; displayLabel:string }>>`
      SELECT s."id",s."channel",s."realmKey",s."kind",
      COALESCE(NULLIF(trim(a."title"),''),s."channel" || ' — основной аккаунт') AS "displayLabel"
      FROM "CustomerEndpointScope" s LEFT JOIN "MessengerAccount" a ON a."id"=s."messengerAccountId" WHERE
      (s."realmKey"='royal-home' AND s."kind"='NORMAL' AND s."channel" IN ('INSTAGRAM','FACEBOOK','WHATSAPP')) OR
      (s."realmKey"='customer-public' AND s."kind"='PUBLIC' AND s."channel" IN ('INSTAGRAM','FACEBOOK')) ORDER BY s."id" LIMIT 101`;
    const counts = await tx.$queryRaw<Array<{lane:string; n:bigint}>>`SELECT "lane",count(*)::bigint AS n FROM "CustomerAgentRolloutAssignment" GROUP BY "lane"`;
    return customerAgentOwnerStateSchema.parse({ policyRevision:p.policyRevision.toString(),contractVersion:p.contractVersion,rolloutMode:p.rolloutMode,
      activeAgentRevisionId:p.activeAgentRevisionId,rollout:p.rolloutConfig,capabilities:p.capabilities,
      scopes:scopes.slice(0,100).map(s=>({endpointScopeId:s.id,channel:s.channel,displayLabel:s.displayLabel.slice(0,160),surface:s.realmKey==='royal-home'?'dm':'public_comment',writeAssurance:'per_event_required'})),
      moreScopes:scopes.length>100,counts:counts.map(r=>({lane:r.lane,count:r.n.toString()})),
      disabled:['SHADOW','WEBSITE','TELEGRAM','YOUTUBE','PHONE'],
      stickyScope:'new_unassigned_only',existingPromotion:'not_implemented',dailyCap:'not_configured',
      configId:createCustomerAgentProviderSnapshot().configRevision });
  });
}
type PublishSpec = Pick<z.infer<typeof customerAgentPublishRequestSchema>, 'expectedPolicyRevision'|'rollout'|'capabilities'|'advanceIdleRevision'|'confirmMediaProfileUpgrade'|'confirmCatalogFactsUpgrade'|'confirmRecruitmentResumeUpgrade'|'reason'>;
type PublishAuthority = 'step_up' | 'retained_policy_refresh';

/** No client policy/manifest/config overrides. This is an explicit signed-in
 * administrator action, not an automatic recovery, fallback or new grant. */
export async function refreshCurrentCustomerAgentForOwner(actorId:string,raw:unknown) {
  const body=customerAgentRefreshRequestSchema.parse(raw);
  const current=await prisma.$transaction(async tx=>{
    await actorTx(tx,actorId,false);
    const policy=await tx.customerRuntimePolicy.findUniqueOrThrow({where:{id:'singleton'}});
    if(policy.policyRevision.toString()!==body.expectedPolicyRevision) fail(409,'policy_changed');
    if(policy.contractVersion!=='scoped'||policy.rolloutMode!=='ACTIVE') fail(409,'routine_refresh_requires_active_policy');
    const rollout=customerAgentRolloutConfigSchema.safeParse(policy.rolloutConfig);
    if(!rollout.success||policy.activeAgentRevisionId!==rollout.data.candidateRevisionId) fail(409,'routine_refresh_policy_invalid');
    return {policy,rollout:rollout.data,capabilities:customerAgentOwnerStateSchema.shape.capabilities.parse(policy.capabilities)};
  });
  const factory=createCustomerAgentProviderSnapshot();
  const revision=await registerCurrentCustomerAgentRevision(factory,{
    beforeWrite:async tx=>{await actorTx(tx,actorId,false);},
    afterWrite:async(tx,value)=>{
      const actor=await actorTx(tx,actorId,false);
      await auditTx(tx,actor,'CUSTOMER_AGENT_REGISTER',value.id,{configId:factory.configRevision,reason:body.reason,authority:'retained_policy_refresh'});
    },
  });
  if(revision.id===current.policy.activeAgentRevisionId) {
    if(body.confirmRecruitmentResumeUpgrade) fail(409,'recruitment_resume_upgrade_not_required');
    const verified=await loadVerifiedCustomerAgentRevision(revision);
    if(verified.status!=='current') fail(409,'revision_not_current');
    return prisma.$transaction(async tx=>{
      await actorTx(tx,actorId,false);
      const row=await tx.customerRuntimePolicy.findUniqueOrThrow({where:{id:'singleton'}});
      if(row.policyRevision.toString()!==body.expectedPolicyRevision) fail(409,'policy_changed');
      if(row.contractVersion!==current.policy.contractVersion||row.rolloutMode!==current.policy.rolloutMode||
        row.activeAgentRevisionId!==revision.id||!isDeepStrictEqual(row.rolloutConfig,current.policy.rolloutConfig)||
        !isDeepStrictEqual(row.capabilities,current.policy.capabilities)) fail(409,'routine_refresh_configuration_changed');
      return {policyRevision:row.policyRevision.toString(),rolloutMode:row.rolloutMode,alreadyCurrent:true};
    });
  }
  const old=await prisma.customerAgentRevision.findUnique({where:{id:current.policy.activeAgentRevisionId!}});
  if(!old) fail(409,'revision_advance_original_missing');
  const prior=decodeCustomerAgentRevision(old);
  return publishVerifiedCustomerAgentForOwner(actorId,{
    expectedPolicyRevision:body.expectedPolicyRevision,reason:body.reason,
    rollout:{...current.rollout,candidateRevisionId:revision.id,cohortId:randomUUID()},
    capabilities:current.capabilities,advanceIdleRevision:true,
    ...(body.confirmRecruitmentResumeUpgrade?{confirmRecruitmentResumeUpgrade:true as const}:{}),
    ...(prior.toolSchemaHash!==revision.toolSchemaHash||prior.knowledgeSchemaHash!==revision.knowledgeSchemaHash?{confirmCatalogFactsUpgrade:true as const}:{}),
  },'retained_policy_refresh');
}

export async function publishCustomerAgentForOwner(actorId:string,raw:unknown) {
  return publishVerifiedCustomerAgentForOwner(actorId,customerAgentPublishRequestSchema.parse(raw),'step_up');
}
async function publishVerifiedCustomerAgentForOwner(actorId:string,body:PublishSpec,authority:PublishAuthority) {
  const routine=authority==='retained_policy_refresh';
  // Authorize before artifact reads AND reread after those awaits in final TX.
  await prisma.$transaction(tx=>actorTx(tx,actorId,!routine));
  const stored=await prisma.customerAgentRevision.findUnique({where:{id:body.rollout.candidateRevisionId}});
  if(!stored) fail(409,"revision_not_registered");
  const verified=await loadVerifiedCustomerAgentRevision(decodeCustomerAgentRevision(stored));
  if(verified.status!=='current') fail(409,"revision_not_current");
  const factory=createCustomerAgentProviderSnapshot();
  if(verified.snapshot.configRevision!==factory.configRevision || verified.snapshot.budget.maxDailyUsd!==null) fail(409,"spending_configuration_not_supported");
  return prisma.$transaction(async tx=>{
    const actor=await actorTx(tx,actorId,!routine);
    // Lock credentials BEFORE scopes/policy. Rotation cannot acquire opposite
    // locks after our policy row. Values stay inside server, never audit/result.
    await tx.$queryRaw`SELECT "id" FROM "Settings" WHERE "id"='singleton' FOR SHARE`;
    const scopeIds=[...new Set(body.rollout.allowed.map(v=>v.endpointScopeId))].sort();
    const accountIds=await tx.$queryRaw<Array<{id:string}>>`SELECT DISTINCT "messengerAccountId" AS id FROM "CustomerEndpointScope"
      WHERE "id"=ANY(${scopeIds}::text[]) AND "messengerAccountId" IS NOT NULL`;
    for(const id of accountIds.map(a=>a.id).sort()) await tx.$queryRaw`SELECT "id" FROM "MessengerAccount" WHERE "id"=${id} FOR SHARE`;
    for(const id of scopeIds) await tx.$queryRaw`SELECT "id" FROM "CustomerEndpointScope" WHERE "id"=${id} FOR SHARE`;
    for(const expected of body.rollout.allowed) {
      const scope=await tx.customerEndpointScope.findUnique({where:{id:expected.endpointScopeId}});
      const permitted=expected.surface==='dm' ? ['INSTAGRAM','FACEBOOK','WHATSAPP'] : ['INSTAGRAM','FACEBOOK'];
      if(!scope || scope.channel!==expected.channel || !permitted.includes(expected.channel) ||
        scope.kind!==(expected.surface==='dm'?'NORMAL':'PUBLIC') || scope.realmKey!==(expected.surface==='dm'?'royal-home':'customer-public')) fail(409,"scope_not_supported");
      if(scope.messengerAccountId) {
        const account=await tx.messengerAccount.findUnique({where:{id:scope.messengerAccountId}});
        if(!account?.enabled || account.channel!==scope.channel || !decryptSecretSafe(account.token) ||
          (expected.surface==='dm' ? scope.transportKey!==`messenger-account:${account.id}`
            : ![account.externalId,account.messagingId,...account.extraExternalIds].includes(scope.publicResourceId))) fail(409,"installation_disabled");
      } else if(expected.surface==='public_comment') {
        const settings=await tx.settings.findUniqueOrThrow({where:{id:'singleton'}});
        if(scope.channel!=='FACEBOOK' || scope.publicResourceId!==settings.metaPageId || scope.transportKey!==`public:FACEBOOK:${settings.metaPageId}` ||
          !scope.publicCredentialFingerprint || !decryptSecretSafe(settings.metaPageToken) || !decryptSecretSafe(settings.metaAppSecret)) fail(409,"public_installation_unbound");
      } else {
        const settings=await tx.settings.findUniqueOrThrow({where:{id:'singleton'}});
        const ok=scope.channel==='WHATSAPP' ? !!settings.metaWaPhoneId&&!!decryptSecretSafe(settings.metaWaToken)&&!!decryptSecretSafe(settings.metaAppSecret)&&scope.transportKey===`settings:WHATSAPP:${settings.metaWaPhoneId}`
          :scope.channel==='FACEBOOK'&&!!settings.metaPageId&&!!decryptSecretSafe(settings.metaPageToken)&&!!decryptSecretSafe(settings.metaAppSecret)&&scope.transportKey===`settings:FACEBOOK:${settings.metaPageId}`;
        if(!ok) fail(409,"settings_installation_unbound");
      }
    }
    const [current]=await tx.$queryRaw<Array<{policyRevision:bigint;contractVersion:string;rolloutMode:string;activeAgentRevisionId:string|null;rolloutConfig:unknown;capabilities:unknown}>>`
      SELECT "policyRevision","contractVersion","rolloutMode","activeAgentRevisionId","rolloutConfig","capabilities" FROM "CustomerRuntimePolicy" WHERE "id"='singleton' FOR UPDATE`;
    if(!current || current.policyRevision.toString()!==body.expectedPolicyRevision) fail(409,"policy_changed");
    if(routine) {
      const before=customerAgentRolloutConfigSchema.safeParse(current.rolloutConfig);
      if(current.contractVersion!=='scoped'||current.rolloutMode!=='ACTIVE'||!before.success||
        current.activeAgentRevisionId!==before.data.candidateRevisionId||!body.advanceIdleRevision||body.confirmMediaProfileUpgrade||
        !isDeepStrictEqual({...body.rollout,candidateRevisionId:before.data.candidateRevisionId,cohortId:before.data.cohortId},before.data)||
        !isDeepStrictEqual(customerAgentOwnerStateSchema.shape.capabilities.parse(current.capabilities),body.capabilities)) fail(409,'routine_refresh_configuration_changed');
    }
    let recruitmentProtocolUpgrade=false, recruitmentResumeUpgrade=false;
    if(body.confirmRecruitmentResumeUpgrade&&!body.advanceIdleRevision) fail(409,'recruitment_resume_upgrade_requires_idle');
    // Updating existing CORE requires an explicit owner-approved idle edge.
    // Assignments, original sources and receipts are never rewritten.
    const [incumbent]=await tx.$queryRaw<Array<{blocked:boolean}>>`SELECT EXISTS(SELECT 1 FROM "CustomerAgentRolloutAssignment" WHERE "lane"='CORE'
      AND NOT customer_agent_revision_reachable("candidateRevisionId","cohortId",${body.rollout.candidateRevisionId},${body.rollout.cohortId})) AS blocked`;
    if(incumbent?.blocked && !body.advanceIdleRevision) fail(409,"existing_core_requires_idle_promotion");
    const [inflight]=await tx.$queryRaw<Array<{blocked:boolean}>>`SELECT
      EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" WHERE "intakeAgentRevisionId" IS NOT NULL
        AND "processingState" IN ('RECEIVED','CLAIMED')) OR
      EXISTS(SELECT 1 FROM "InstagramComment" WHERE "publicOriginCiphertext" IS NOT NULL AND "status" IN ('PENDING','WORKING','WORKING_STAFF','ERROR')) OR
      EXISTS(SELECT 1 FROM "TelegramGroupComment" WHERE "publicOriginCiphertext" IS NOT NULL AND "status" IN ('PENDING','WORKING','WORKING_STAFF','ERROR')) OR
      customer_agent_delivery_requires_idle() OR
      EXISTS(SELECT 1 FROM "CustomerPublicEffect" WHERE "status"='IN_FLIGHT' AND "createdAt">clock_timestamp()-interval '5 minutes') OR
      EXISTS(SELECT 1 FROM "AiProviderOperation" WHERE "policyKey"='royal-customer-gemini' AND "reservedUsd">0
        AND "status"='OPEN' AND "deadlineAt">clock_timestamp()) AS blocked`;
    // Current policyRevision is also an execution/credential fence. Until the
    // separate enrollment-only CAS below is reviewed, never silently invalidate
    // READY/RAW turns merely to change a percentage. Kill remains unconditional.
    if(inflight?.blocked) fail(409,"core_work_requires_idle_publication");
    const [cohort]=await tx.$queryRaw<Array<{blocked:boolean}>>`SELECT EXISTS(SELECT 1 FROM "CustomerAgentRolloutAssignment" WHERE "cohortId"=${body.rollout.cohortId}
      AND "candidateRevisionId" IS DISTINCT FROM ${body.rollout.candidateRevisionId}) AS blocked`;
    if(cohort?.blocked) fail(409,"cohort_candidate_immutable");
    if(body.advanceIdleRevision) {
      const before=customerAgentRolloutConfigSchema.safeParse(current.rolloutConfig);
      if(!before.success || current.activeAgentRevisionId!==before.data.candidateRevisionId ||
        current.activeAgentRevisionId===body.rollout.candidateRevisionId || before.data.cohortId===body.rollout.cohortId) fail(409,"revision_advance_invalid");
      const old=await tx.customerAgentRevision.findUnique({where:{id:current.activeAgentRevisionId!}});
      if(!old) fail(409,"revision_advance_original_missing");
      const prior=decodeCustomerAgentRevision(old), next=verified.revision;
      // Ordinary hotfixes cannot change instructions. The reviewed recruitment
      // v1 pair pins BOTH prompt and tool definitions and still requires the
      // existing catalog acknowledgement and all configuration/idle guards.
      for(const field of ['knowledgeSourceHash','limits'] as const)
        if(!isDeepStrictEqual(prior[field],next[field])) fail(409,"revision_advance_configuration_changed");
      const catalogChanged = prior.knowledgeSchemaHash !== next.knowledgeSchemaHash || prior.toolSchemaHash !== next.toolSchemaHash;
      const resumePair=isCustomerRecruitmentResumeUpgradeV2(prior,next);
      if(resumePair&&!body.confirmRecruitmentResumeUpgrade) fail(409,'recruitment_resume_upgrade_confirmation_required');
      if(body.confirmRecruitmentResumeUpgrade&&!resumePair) fail(409,'recruitment_resume_upgrade_not_qualified');
      recruitmentResumeUpgrade=resumePair&&body.confirmRecruitmentResumeUpgrade===true;
      recruitmentProtocolUpgrade=recruitmentResumeUpgrade || body.confirmCatalogFactsUpgrade===true && isCustomerRecruitmentUpgradeV1(prior,next);
      if(prior.promptHash!==next.promptHash && !recruitmentProtocolUpgrade) fail(409,"revision_advance_configuration_changed");
      if (catalogChanged && !body.confirmCatalogFactsUpgrade && !recruitmentResumeUpgrade) fail(409,"catalog_facts_upgrade_confirmation_required");
      if (!catalogChanged && body.confirmCatalogFactsUpgrade && !recruitmentResumeUpgrade) fail(409,"catalog_facts_upgrade_not_required");
      if ((catalogChanged || recruitmentResumeUpgrade) && (prior.providerProfileHash !== next.providerProfileHash || prior.providerPolicyHash !== next.providerPolicyHash ||
        !isDeepStrictEqual([...before.data.allowed].sort((a,b)=>a.endpointScopeId.localeCompare(b.endpointScopeId)),
          [...body.rollout.allowed].sort((a,b)=>a.endpointScopeId.localeCompare(b.endpointScopeId))) ||
        before.data.percentBasisPoints !== body.rollout.percentBasisPoints ||
        !isDeepStrictEqual(customerAgentOwnerStateSchema.shape.capabilities.parse(current.capabilities),body.capabilities))) {
        fail(409,"catalog_facts_upgrade_configuration_changed");
      }
      const profileChanged=prior.providerProfileHash!==next.providerProfileHash || prior.providerPolicyHash!==next.providerPolicyHash;
      if(routine&&profileChanged) fail(409,'routine_refresh_provider_changed');
      if(profileChanged) {
        if(!body.confirmMediaProfileUpgrade) fail(409,"media_profile_upgrade_confirmation_required");
        const originalRuntime=await loadPinnedCustomerAgentRuntime(prior,tx);
        if(originalRuntime.status!=="current" || !isCustomerAgentMediaProfileUpgrade(originalRuntime.snapshot,verified.snapshot) ||
          !isDeepStrictEqual([...before.data.allowed].sort((a,b)=>a.endpointScopeId.localeCompare(b.endpointScopeId)),
            [...body.rollout.allowed].sort((a,b)=>a.endpointScopeId.localeCompare(b.endpointScopeId))) || before.data.percentBasisPoints!==body.rollout.percentBasisPoints ||
          !isDeepStrictEqual(customerAgentOwnerStateSchema.shape.capabilities.parse(current.capabilities),body.capabilities)) fail(409,"media_profile_upgrade_not_qualified");
      } else if(body.confirmMediaProfileUpgrade) fail(409,"media_profile_upgrade_not_required");
      const roots=await tx.$queryRaw<Array<{candidateRevisionId:string;cohortId:string}>>`SELECT DISTINCT "candidateRevisionId","cohortId"
        FROM "CustomerAgentRolloutAssignment" WHERE "lane"='CORE' LIMIT 101`;
      if(roots.length>100) fail(409,"revision_advance_unbounded");
      for(const root of roots) if(!await customerAgentRevisionReachable(tx,root,before.data.candidateRevisionId,before.data.cohortId)) fail(409,"revision_advance_unrelated_subject");
      await tx.$executeRaw`INSERT INTO "CustomerAgentRevisionAdvance" ("id","fromRevisionId","fromCohortId","toRevisionId","toCohortId","policyRevision","approvedAt")
        VALUES (${randomUUID()},${before.data.candidateRevisionId},${before.data.cohortId},${body.rollout.candidateRevisionId},${body.rollout.cohortId},${current.policyRevision+1n},now())`;
      // Check the proposed complete lineage before committing the publication,
      // not only roots→OLD candidate. Failure rolls this tentative edge back.
      for(const root of roots) if(!await customerAgentRevisionReachable(tx,root,body.rollout.candidateRevisionId,body.rollout.cohortId))
        fail(409,"revision_advance_target_unreachable");
    }
    if(!routine&&!settingsStepUpSatisfied(actor)) fail(428,"step_up_required");
    const [updated]=await tx.$queryRaw<Array<{policyRevision:bigint}>>`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"='ACTIVE',
      "activeAgentRevisionId"=${body.rollout.candidateRevisionId},"rolloutConfig"=${JSON.stringify(body.rollout)}::jsonb,"policyRevision"="policyRevision"+1,
      "capabilities"=${JSON.stringify(body.capabilities)}::jsonb,"updatedAt"=now() WHERE "id"='singleton' AND "policyRevision"=${BigInt(body.expectedPolicyRevision)} RETURNING "policyRevision"`;
    if(!updated) fail(409,"policy_changed");
    await auditTx(tx,actor,'CUSTOMER_AGENT_PUBLISH','singleton',{oldRevision:current.policyRevision.toString(),newRevision:updated.policyRevision.toString(),
      candidate:body.rollout.candidateRevisionId,cohort:body.rollout.cohortId,percentBasisPoints:body.rollout.percentBasisPoints,
      scopes:scopeIds,configId:factory.configRevision,paidConfirmed:routine?null:true,noDailyCapAcknowledged:routine?null:true,
      authority,routineRefresh:routine,retainedPaidAuthority:routine,idleRevisionAdvanced:body.advanceIdleRevision===true,
      catalogFactsUpgrade:body.confirmCatalogFactsUpgrade===true,
      recruitmentProtocolUpgrade,
      recruitmentResumeUpgradeVersion:recruitmentResumeUpgrade?'v2':null,
      mediaProfileUpgrade:body.confirmMediaProfileUpgrade===true,reason:body.reason});
    if(!routine&&!settingsStepUpSatisfied(actor)) fail(428,"step_up_required");
    return {policyRevision:updated.policyRevision.toString(),rolloutMode:'ACTIVE',existingPromotion:'not_implemented'};
  });
}
export async function killCustomerAgentForOwner(actorId:string,raw:unknown) {
  const body=customerAgentKillRequestSchema.parse(raw);
  return prisma.$transaction(async tx=>{
    const actor=await actorTx(tx,actorId);
    const [row]=await tx.$queryRaw<Array<{policyRevision:bigint;rolloutMode:string}>>`
      SELECT "policyRevision","rolloutMode" FROM "CustomerRuntimePolicy" WHERE "id"='singleton' FOR UPDATE`;
    if(!row || row.policyRevision.toString()!==body.expectedPolicyRevision) fail(409,"policy_changed");
    if(!settingsStepUpSatisfied(actor)) fail(428,"step_up_required");
    const [updated]=await tx.$queryRaw<Array<{policyRevision:bigint}>>`UPDATE "CustomerRuntimePolicy" SET "rolloutMode"='OFF',
      "policyRevision"="policyRevision"+1,"updatedAt"=now() WHERE "id"='singleton' RETURNING "policyRevision"`;
    await auditTx(tx,actor,'CUSTOMER_AGENT_KILL','singleton',{oldRevision:row.policyRevision.toString(),newRevision:updated.policyRevision.toString(),reason:body.reason});
    if(!settingsStepUpSatisfied(actor)) fail(428,"step_up_required");
    return {policyRevision:updated.policyRevision.toString(),rolloutMode:'OFF'};
  });
}
