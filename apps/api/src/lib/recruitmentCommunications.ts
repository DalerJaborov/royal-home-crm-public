import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { assessRecruitmentResume, customerFenceSchema, isDialableTajikNumber, isReadOnlyRole,
  parsePermissionOverrides, resolvePermissions, recruitmentContactPreviewSchema, recruitmentResumeSchema,
  type RecruitmentCommunicationChannel, type RecruitmentCommunicationDelivery,
  type RecruitmentContactOptions, type RecruitmentContactPreviewInput, type RecruitmentContactConfirmInput } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { lockCustomerStateSnapshot, loadCustomerStateSnapshot } from "./customerState.js";
import { lockCustomerNative } from "./customerNativeLock.js";
import { readRecruitmentPositions } from "./recruitmentPositions.js";
import { readCustomerCompanyInformation } from "./customerCompanyInformation.js";
import { loadSmsConfig, payomWebhookUrl, toSmsPhone } from "./sms/index.js";
import { payomSend, PAYOM_NOT_DELIVERED } from "./sms/payom.js";
import { originateLiveVoiceScenarioCall, type LiveVoiceScenarioResult } from "./telephony/liveVoiceBridge.js";
import { INTERVIEW_INVITE_CALL_TOOLS } from "../ai/interviewInviteCallPersona.js";
import { parseInterviewInviteCall } from "../ai/interviewInviteCallParse.js";
import { isWithinPostShowingCallHours } from "./postShowingCall.js";
import { loadCompanyDaysOff } from "./daysOffCalendar.js";
import { vacancyOfficeMapUrl } from "../ai/vacancyFacts.js";
import { RecruitmentCommunicationError, held, assertSmsLength, smsSegments, bridgeRefusalStatus, isUnresolvedDelivery,
  hasCallWindowBefore, UNKNOWN_SOFT_MINUTES, UNKNOWN_HARD_HOURS } from "./recruitmentCommunicationRules.js";
import { buildRecruitmentCommunicationContent, recruitmentCommunicationDigest as digest } from "./recruitmentCommunicationContent.js";

export { RecruitmentCommunicationError };
/** SQL-двойник isUnresolvedDelivery (recruitmentCommunicationRules.ts): держать в паре. */
const unresolvedDeliverySql = () => Prisma.sql`("status" IN ('QUEUED','IN_FLIGHT') OR ("channel"='ASSISTANT_CALL' AND "status"='ACCEPTED')
  OR ("status"='UNKNOWN' AND "updatedAt" > now() - make_interval(hours => ${UNKNOWN_HARD_HOURS}::int)
    AND ("providerReceipt" IS NOT NULL OR "updatedAt" > now() - make_interval(mins => ${UNKNOWN_SOFT_MINUTES}::int))))`;
const sourceSchema = z.object({ version: z.literal(1), applicationId: z.string(), materialHash: z.string(),
  originalUpdatedAt: z.string(), originalStatus: z.string(), originalInterviewAt: z.string().nullable(),
  phone: z.string(), positionKey: z.string(), positionRevision: z.number(), companyHash: z.string(), fence: customerFenceSchema.nullable(),
  sourceKind: z.enum(["CORE", "LEGACY_HR"]), legacyBindingHash: z.string().nullable(),
  request: recruitmentContactPreviewSchema, text: z.string(), callSummary: z.string(), callPrompt: z.string(),
  validUntil: z.string() }).strict();
type Snapshot = z.infer<typeof sourceSchema>;
type Row = { id: string; previewId: string; jobApplicationId: string; actorId: string; channel: RecruitmentCommunicationChannel;
  purpose: string; status: RecruitmentCommunicationDelivery["status"]; previewHash: string; snapshotJson: unknown;
  expiresAt: Date; idempotencyKey: string | null; effectKey: string | null; providerReceipt: string | null; reason: string | null; resultJson?: unknown; updatedAt?: Date };
type App = { id: string; name: string | null; contactName: string | null; phone: string | null; status: string;
  interviewAt: Date | null; updatedAt: Date; customerInquiryId: string | null; customerPositionKey: string | null;
  hrPositionKey: string | null; conversationId: string | null; clientId: string | null; contactProfileId: string | null; channel: string;
  customerApplicationRevision: string | null; recruitmentResume: unknown; customerPortfolio: unknown; rawText: string;
  legacyFactsJson: Record<string, unknown> };
const voiceResultSchema = z.object({ purpose: z.enum(["INVITE", "CLARIFY"]), transcript: z.array(z.string()).max(2000),
  candidateSpoke: z.boolean(), summary: z.string().optional(), applicable: z.boolean().optional(), parsed: z.object({ summary: z.string().nullable() }).nullable() });
const asDelivery = (row: Row): RecruitmentCommunicationDelivery => {
  const result = voiceResultSchema.safeParse(row.resultJson);
  return { id: row.id, channel: row.channel, status: row.status, ...(row.reason ? { reason: row.reason } : {}),
    ...(result.success ? { result: { purpose: result.data.purpose, transcript: result.data.transcript,
      candidateSpoke: result.data.candidateSpoke, summary: result.data.applicable === false ? "Ответ относится к прежней версии анкеты или собеседования. Требуется проверка HR." : result.data.summary ?? result.data.parsed?.summary ??
        (result.data.candidateSpoke ? "Ответы кандидата собраны. Проверьте их перед заполнением анкеты." : "Ответ кандидата не получен.") } } : {}) };
};
let testTransport: { sms: typeof payomSend; call: typeof originateLiveVoiceScenarioCall } | null = null;
/** Only an explicitly injected fake can bypass Vitest's automatic dry run. */
export function __setRecruitmentCommunicationTransportsForTests(value: typeof testTransport) {
  if (!process.env.VITEST) throw Error("Test transport requires Vitest");
  testTransport = value;
}

async function staffAllowed(tx: TxClient, actorId: string) {
  const agent = await tx.agent.findUnique({ where: { id: actorId }, select: { isActive: true, role: true, permissions: true, fullName: true } });
  if (!agent?.isActive || isReadOnlyRole(agent.role) ||
      !resolvePermissions(agent.role, parsePermissionOverrides(agent.permissions)).has("vacancies.view")) {
    throw new RecruitmentCommunicationError(403, "Нет права связываться с кандидатами");
  }
  return agent;
}
async function applicationBinding(tx: TxClient, application: { channel: string; conversationId: string | null; clientId: string | null; contactProfileId: string | null },
  actor: Awaited<ReturnType<typeof staffAllowed>>, actorId: string, lock = true) {
  let binding: Record<string, string | null> | null = null;
  if (application.conversationId) {
    const kind = application.channel === "TELEGRAM" ? "telegram" : application.channel === "TELEGRAM_DIRECT" ? "telegram_direct" : "bot";
    if (lock && !await lockCustomerNative(tx, { kind, id: application.conversationId })) held("Исходная переписка старой анкеты недоступна");
    const table = kind === "bot" ? Prisma.sql`"BotConversation"` : kind === "telegram" ? Prisma.sql`"TelegramConversation"` : Prisma.sql`"TelegramDirectConversation"`;
    const [native] = await tx.$queryRaw<Array<{ binding: Record<string, string | null> }>>(Prisma.sql`SELECT jsonb_build_object(
      'id',n."id",'channel',to_jsonb(n)->>'channel','peer',COALESCE(to_jsonb(n)->>'subscriberId',to_jsonb(n)->>'chatId'),
      'topic',to_jsonb(n)->>'topicId','accountId',to_jsonb(n)->>'accountId','endpointScopeId',to_jsonb(n)->>'endpointScopeId',
      'clientId',to_jsonb(n)->>'clientId','contactProfileId',to_jsonb(n)->>'contactProfileId',
      'handler',to_jsonb(n)->>'propertyChatAgentId','optedOutAt',to_jsonb(n)->>'optedOutAt','pausedUntil',to_jsonb(n)->>'pausedUntil') AS binding
      FROM ${table} n WHERE n."id"=${application.conversationId}`);
    binding = native?.binding ?? null;
    if (!binding || kind === "bot" && binding.channel !== application.channel || binding.optedOutAt ||
        binding.pausedUntil && new Date(binding.pausedUntil).getTime() > Date.now()) held("Связь в исходной переписке приостановлена");
    if (application.clientId && binding.clientId && application.clientId !== binding.clientId ||
        application.contactProfileId && binding.contactProfileId && application.contactProfileId !== binding.contactProfileId) held("Связь анкеты с перепиской изменилась");
  }
  const profileId = application.contactProfileId ?? binding?.contactProfileId;
  const profile = profileId ? await tx.contactProfile.findUnique({ where: { id: profileId }, select: { mergedIntoId: true, clientId: true, language: true } }) : null;
  if (profileId && (!profile || profile.mergedIntoId)) held("Досье кандидата изменилось — проверьте анкету");
  const clientId = application.clientId ?? binding?.clientId ?? profile?.clientId;
  const client = clientId ? await tx.client.findUnique({ where: { id: clientId }, select: { id: true, deletedAt: true, assignedAgentId: true } }) : null;
  const permissions = resolvePermissions(actor.role, parsePermissionOverrides(actor.permissions));
  if (clientId && (!client || client.deletedAt || !permissions.has("clients.viewAll") && client.assignedAgentId !== actorId)) {
    throw new RecruitmentCommunicationError(403, "Нет доступа к связанной карточке кандидата");
  }
  return { hash: digest({ application, native: binding, profile: profileId ? { id: profileId, clientId: profile?.clientId } : null,
    client: client ? { id: client.id, assignedAgentId: client.assignedAgentId } : null }),
    language: profile?.language === "tg" ? "tg" as const : profile?.language === "ru" ? "ru" as const : null };
}
/** Core applications retain exact native/scope/policy locks. Historical HR
 * applications use their own staff-maintained job/native witness instead;
 * neither staff purpose issues a BOT grant, creates an Inquiry or advances IN. */
/** lock=false — чтение без блокировок (contact-options): только для показа, не для отправки. */
async function currentSource(tx: TxClient, applicationId: string, actorId: string, lock = true) {
  const actor = await staffAllowed(tx, actorId);
  const anchor = await tx.jobApplication.findUnique({ where: { id: applicationId }, select: { customerInquiryId: true,
    conversationId: true, clientId: true, contactProfileId: true, channel: true } });
  if (!anchor) throw new RecruitmentCommunicationError(404, "Анкета не найдена");
  const state = anchor.customerInquiryId ? (lock ? await lockCustomerStateSnapshot(tx, { inquiryId: anchor.customerInquiryId }) : await loadCustomerStateSnapshot({ inquiryId: anchor.customerInquiryId }, tx)) : null;
  let legacy: Awaited<ReturnType<typeof applicationBinding>> | null = null;
  if (anchor.customerInquiryId) {
    if (!state || state.closedAt || state.publicState.topic !== "job" || !state.fence.nativeId) held("Актуальное обращение кандидата недоступно");
    if (state.ownerMode === "HUMAN" && state.ownerAgentId !== actorId) held("С кандидатом работает другой сотрудник");
    if (state.ownerMode === "OFF" || state.ownerMode === "HOLD") held("Обращение кандидата приостановлено");
    const native = await tx.botConversation.findUnique({ where: { id: state.fence.nativeId }, select: { optedOutAt: true, pausedUntil: true } });
    if (!native || native.optedOutAt || native.pausedUntil && native.pausedUntil.getTime() > Date.now()) held("Автоматическая связь с кандидатом приостановлена");
    await applicationBinding(tx, { ...anchor, conversationId: state.fence.nativeId }, actor, actorId, lock);
  } else legacy = await applicationBinding(tx, anchor, actor, actorId, lock);
  const [app] = await tx.$queryRaw<App[]>(Prisma.sql`SELECT "id","name","contactName","phone","status","interviewAt","updatedAt",
    "customerInquiryId","customerPositionKey","hrPositionKey","conversationId","clientId","contactProfileId","channel",
    "customerApplicationRevision"::text,"recruitmentResume","customerPortfolio","rawText",
    jsonb_build_object('age',"age",'city',"city",'studyingNow',CASE WHEN "studyingNow" IS TRUE OR "studyingUniversity" IS TRUE THEN true ELSE COALESCE("studyingNow","studyingUniversity") END,
      'employedNow',"employedNow",'education',"education",'experience',"experience",'languages',"languages",'startWhen',"startWhen",
      'about',COALESCE(NULLIF("rawText",''),NULLIF("cvFile",''))) AS "legacyFactsJson"
    FROM "JobApplication" WHERE "id"=${applicationId}${lock ? Prisma.sql` FOR UPDATE` : Prisma.empty}`);
  if (!app || ["NOT_CANDIDATE", "REJECTED", "HIRED"].includes(app.status) || app.customerInquiryId !== anchor.customerInquiryId ||
      app.conversationId !== anchor.conversationId || app.clientId !== anchor.clientId || app.contactProfileId !== anchor.contactProfileId || app.channel !== anchor.channel ||
      state && (app.customerInquiryId !== state.fence.inquiryId || app.customerPositionKey !== state.publicState.jobPositionKey)) held("Анкета или выбранная вакансия изменились");
  const positionKey = state ? app.customerPositionKey : app.hrPositionKey;
  if (!positionKey) held("Выберите вакансию для этой старой анкеты перед обращением к кандидату");
  if (lock) await tx.$queryRaw`SELECT "key" FROM "RecruitmentPosition" WHERE "key"=${positionKey} FOR SHARE`;
  const position = (await readRecruitmentPositions(tx)).find(row => row.key === positionKey);
  if (!position?.isOpen) held("Набор по этой вакансии закрыт");
  const company = await readCustomerCompanyInformation();
  const office = await tx.settings.findUnique({ where: { id: "singleton" }, select: { interviewInviteAddress: true } });
  const officeAddress = office?.interviewInviteAddress?.trim() || company.information.office;
  const officeAddressTg = office?.interviewInviteAddress?.trim() || company.information.officeTg;
  const officeMapUrl = office?.interviewInviteAddress?.trim() ? null : vacancyOfficeMapUrl();
  const companyHash = digest({ company: company.sourceHash, configuredOfficeAddress: office?.interviewInviteAddress?.trim() || null });
  const resume = recruitmentResumeSchema.safeParse(app.recruitmentResume);
  const assessment = assessRecruitmentResume({ rules: position!.screeningRules, facts: resume.success ? resume.data.facts : {},
    name: app.name ?? app.contactName, phone: app.phone, portfolioCount: Array.isArray(app.customerPortfolio) ? app.customerPortfolio.length : 0 });
  if (!state) {
    // Existing legacy fields can make a question unnecessary; they are not
    // relabelled as new canonical facts or assigned invented source events.
    assessment.missing = assessment.missing.filter(key => app.legacyFactsJson[key] === null || app.legacyFactsJson[key] === undefined || app.legacyFactsJson[key] === "");
    assessment.readyForReview = assessment.missing.length === 0;
  }
  const materialHash = digest({ id: app.id, name: app.name, contactName: app.contactName, phone: app.phone,
    revision: app.customerApplicationRevision, resume: app.recruitmentResume, portfolio: app.customerPortfolio, rawText: app.rawText,
    inquiry: app.customerInquiryId, position: app.customerPositionKey, hrPositionKey: app.hrPositionKey,
    conversationId: app.conversationId, clientId: app.clientId, contactProfileId: app.contactProfileId, channel: app.channel,
    legacyFacts: !state ? app.legacyFactsJson : null });
  return { app, position: position!, company, companyHash, officeAddress, officeAddressTg, officeMapUrl, state, assessment, materialHash, actor, legacy };
}
function sameSource(snapshot: Snapshot, source: Awaited<ReturnType<typeof currentSource>>, beforeConfirm: boolean) {
  return source.app.id === snapshot.applicationId && source.materialHash === snapshot.materialHash &&
    source.position.key === snapshot.positionKey && source.position.revision === snapshot.positionRevision &&
    source.companyHash === snapshot.companyHash && isDeepStrictEqual(source.state?.fence ?? null, snapshot.fence) &&
    (source.state ? "CORE" : "LEGACY_HR") === snapshot.sourceKind && (source.legacy?.hash ?? null) === snapshot.legacyBindingHash &&
    (beforeConfirm ? source.app.updatedAt.toISOString() === snapshot.originalUpdatedAt :
      snapshot.request.purpose === "INVITE" ? source.app.status === "INTERVIEW" &&
        source.app.interviewAt?.toISOString() === snapshot.request.interviewAt : source.app.status === snapshot.originalStatus &&
        (source.app.interviewAt?.toISOString() ?? null) === snapshot.originalInterviewAt);
}
async function readGroup(tx: TxClient, previewId: string, actorId: string, lock = false) {
  return tx.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM "RecruitmentCommunication"
    WHERE "previewId"=${previewId} AND "actorId"=${actorId} ORDER BY "channel" ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`);
}
export async function recruitmentContactOptions(applicationId: string, actorId: string): Promise<RecruitmentContactOptions> {
  const recent = await prisma.$queryRaw<Row[]>`SELECT * FROM "RecruitmentCommunication" WHERE "jobApplicationId"=${applicationId}
    AND "status"<>'PREVIEW' ORDER BY "createdAt" DESC LIMIT 12`;
  let reason: string | undefined, source: Awaited<ReturnType<typeof currentSource>> | undefined;
  try { source = await prisma.$transaction(tx => currentSource(tx, applicationId, actorId, false)); }
  catch (error) { if (!(error instanceof RecruitmentCommunicationError)) throw error; if (error.status !== 409) throw error; reason = error.message; }
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { liveVoiceEnabled: true, interviewInviteAddress: true } });
  if (!reason && !isDialableTajikNumber(source!.app.phone ?? "")) reason = "Нужен корректный таджикский номер кандидата";
  const unresolved = recent.some(row => isUnresolvedDelivery(row));
  if (!reason && unresolved) reason = "Предыдущее обращение ещё не завершено. Проверьте его результат перед новой отправкой.";
  const smsReady = !!await loadSmsConfig(), voiceReady = !!settings?.liveVoiceEnabled;
  const available = !reason;
  const language = source?.state?.fence.nativeId ? await prisma.botConversation.findUnique({ where: { id: source.state.fence.nativeId },
    select: { contactProfile: { select: { language: true } } } }) : null;
  const office = { address: source?.officeAddress ?? settings?.interviewInviteAddress?.trim() ?? null,
    addressTg: source?.officeAddressTg ?? settings?.interviewInviteAddress?.trim() ?? null,
    mapUrl: source ? source.officeMapUrl : settings?.interviewInviteAddress?.trim() ? null : vacancyOfficeMapUrl(), preparation: null };
  return { ...(source ? { sourceKind: source.state ? "CORE" as const : "LEGACY_HR" as const } : {}),
    sms: { available: available && smsReady, ...(!available || !smsReady ? { reason: reason ?? "СМС не подключены" } : {}) },
    assistantCall: { available: available && voiceReady, ...(!available || !voiceReady ? { reason: reason ?? "Звонки ассистента выключены" } : {}) },
    clarification: { available: available && !!source?.assessment.missing.length && (smsReady || voiceReady),
      ...(!available || !source?.assessment.missing.length || !smsReady && !voiceReady ? { reason: reason ?? "Нет недостающих сведений или доступного канала" } : {}) },
    office,
    language: source?.state?.publicState.language === "ru" || source?.state?.publicState.language === "tg" ? source.state.publicState.language :
      source?.legacy?.language ?? (language?.contactProfile?.language === "tg" ? "tg" : language?.contactProfile?.language === "ru" ? "ru" : null),
    recentDeliveries: recent.map(asDelivery) };
}
export async function previewRecruitmentContact(applicationId: string, actorId: string, raw: RecruitmentContactPreviewInput) {
  const parsedRequest = recruitmentContactPreviewSchema.parse(raw);
  const request = { ...parsedRequest, ...(parsedRequest.interviewAt ? { interviewAt: new Date(parsedRequest.interviewAt).toISOString() } : {}) };
  const now = new Date(), expiresAt = new Date(now.getTime() + 10 * 60_000);
  if (request.interviewAt && new Date(request.interviewAt).getTime() <= now.getTime()) held("Собеседование должно быть в будущем");
  if (request.channels.includes("SMS") && !await loadSmsConfig()) held("СМС не подключены");
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { liveVoiceEnabled: true, interviewInviteAddress: true } });
  if (request.channels.includes("ASSISTANT_CALL") && !settings?.liveVoiceEnabled) held("Звонки ассистента выключены");
  return prisma.$transaction(async tx => {
    const source = await currentSource(tx, applicationId, actorId);
    if (!isDialableTajikNumber(source.app.phone ?? "")) held("Укажите корректный таджикский номер кандидата");
    if (request.purpose === "CLARIFY" && !source.assessment.missing.length) held("Обязательные сведения уже заполнены — уточнение не требуется");
    const unresolved = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM "RecruitmentCommunication" WHERE "jobApplicationId"=${applicationId}
      AND ${unresolvedDeliverySql()} LIMIT 1`);
    if (unresolved.length) held("Предыдущее обращение не завершено — проверьте его результат");
    const content = buildRecruitmentCommunicationContent(request, { name: source.app.name ?? source.app.contactName,
      ...source.position, address: source.officeAddress, addressTg: source.officeAddressTg, mapUrl: source.officeMapUrl, missing: source.assessment.missing });
    const sms = request.channels.includes("SMS");
    if (sms) assertSmsLength(content.text);
    if (request.channels.includes("ASSISTANT_CALL") && request.interviewAt) {
      const daysOff = await loadCompanyDaysOff();
      if (!hasCallWindowBefore(now, new Date(request.interviewAt), at => isWithinPostShowingCallHours(at, daysOff)))
        held("Звонок не успеет до собеседования — выберите SMS");
    }
    const snapshot: Snapshot = { version: 1, applicationId, materialHash: source.materialHash,
      originalUpdatedAt: source.app.updatedAt.toISOString(), originalStatus: source.app.status,
      originalInterviewAt: source.app.interviewAt?.toISOString() ?? null, phone: source.app.phone!,
      positionKey: source.position.key, positionRevision: source.position.revision, companyHash: source.companyHash,
      fence: source.state?.fence ?? null, sourceKind: source.state ? "CORE" : "LEGACY_HR", legacyBindingHash: source.legacy?.hash ?? null, request, ...content,
      validUntil: request.interviewAt ?? new Date(now.getTime() + 24 * 60 * 60_000).toISOString() };
    const previewId = randomUUID(), previewHash = digest(snapshot);
    for (const channel of request.channels) await tx.$executeRaw`INSERT INTO "RecruitmentCommunication"
      ("id","previewId","jobApplicationId","actorId","purpose","channel","status","previewHash","snapshotJson","expiresAt","createdAt","updatedAt")
      VALUES (${randomUUID()},${previewId},${applicationId},${actorId},${request.purpose},${channel},'PREVIEW',${previewHash},${JSON.stringify(snapshot)}::jsonb,${expiresAt},${now},${now})`;
    return { previewId, text: content.text, ...(sms ? { smsSegments: smsSegments(content.text) } : {}), ...(request.channels.includes("ASSISTANT_CALL") ? { callSummary: content.callSummary } : {}), expiresAt: expiresAt.toISOString() };
  });
}
export async function confirmRecruitmentContact(applicationId: string, actorId: string, command: RecruitmentContactConfirmInput) {
  return prisma.$transaction(async tx => {
    const source = await currentSource(tx, applicationId, actorId), rows = await readGroup(tx, command.previewId, actorId, true);
    if (!rows.length || rows.some(row => row.jobApplicationId !== applicationId)) held("Предпросмотр не найден");
    const snapshot = sourceSchema.parse(rows[0].snapshotJson);
    if (rows.every(row => row.idempotencyKey === command.idempotencyKey)) {
      return { interviewSaved: snapshot.request.purpose === "INVITE", deliveries: rows.map(asDelivery) };
    }
    if (rows.some(row => row.status !== "PREVIEW" || row.expiresAt.getTime() <= Date.now()) ||
      rows.some(row => row.previewHash !== digest(snapshot)) || !sameSource(snapshot, source, true)) held("Предпросмотр устарел — проверьте анкету заново");
    if (new Date(snapshot.validUntil).getTime() <= Date.now()) held("Время приглашения истекло");
    const prior = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM "RecruitmentCommunication" WHERE "jobApplicationId"=${applicationId}
      AND ${unresolvedDeliverySql()} LIMIT 1`);
    if (prior.length) held("Предыдущее обращение ещё не завершено");
    for (const row of rows) {
      const effectKey = digest({ applicationId, material: snapshot.materialHash, position: snapshot.positionRevision,
        purpose: snapshot.request.purpose, channel: row.channel, text: snapshot.text, prompt: snapshot.callPrompt });
      const existing = await tx.$queryRaw<Row[]>`SELECT * FROM "RecruitmentCommunication" WHERE "effectKey"=${effectKey}
        OR ("actorId"=${actorId} AND "idempotencyKey"=${command.idempotencyKey} AND "channel"=${row.channel}) LIMIT 1`;
      if (existing.length) held("Такое обращение уже создано. Проверьте историю отправок.");
      await tx.$executeRaw`UPDATE "RecruitmentCommunication" SET "status"='QUEUED',"idempotencyKey"=${command.idempotencyKey},
        "effectKey"=${effectKey},"updatedAt"=now() WHERE "id"=${row.id} AND "status"='PREVIEW'`;
    }
    if (snapshot.request.purpose === "INVITE") {
      await tx.jobApplication.update({ where: { id: applicationId }, data: { status: "INTERVIEW", interviewAt: new Date(snapshot.request.interviewAt!), reviewedById: actorId } });
      // An explicit new invitation replaces only legacy jobs which have not dialled.
      await tx.interviewInviteCall.updateMany({ where: { jobApplicationId: applicationId, status: { in: ["PENDING", "NO_ANSWER"] } }, data: { status: "CANCELLED" } });
    }
    await tx.auditLog.create({ data: { agentId: actorId, agentName: source.actor.fullName, action: "RECRUITMENT_CONTACT_QUEUED", entityType: "JobApplication", entityId: applicationId,
      meta: { previewId: command.previewId, purpose: snapshot.request.purpose, channels: snapshot.request.channels } } });
    return { interviewSaved: snapshot.request.purpose === "INVITE", deliveries: (await readGroup(tx, command.previewId, actorId)).map(asDelivery) };
  });
}

async function settle(id: string, status: Row["status"], reason: string | null, receipt?: string, result: unknown = {}) {
  await prisma.$executeRaw`UPDATE "RecruitmentCommunication" SET "status"=${status},"reason"=${reason},
    "providerReceipt"=COALESCE(${receipt ?? null},"providerReceipt"),"resultJson"=${JSON.stringify(result)}::jsonb,
    "effectKey"=CASE WHEN ${["REJECTED", "CANCELLED"].includes(status)} THEN NULL ELSE "effectKey" END,
    "completedAt"=CASE WHEN ${["QUEUED", "IN_FLIGHT", "ACCEPTED"].includes(status)} THEN NULL ELSE now() END,"updatedAt"=now()
    WHERE "id"=${id} AND "status" IN ('IN_FLIGHT','ACCEPTED','UNKNOWN')`;
}
export async function finishRecruitmentAssistantCall(id: string, result: LiveVoiceScenarioResult) {
  const [row] = await prisma.$queryRaw<Row[]>`SELECT * FROM "RecruitmentCommunication" WHERE "id"=${id}`;
  if (!row || !["IN_FLIGHT", "ACCEPTED", "UNKNOWN"].includes(row.status)) return;
  if (result.channelId !== (row.providerReceipt ?? row.id)) return;
  const snapshot = sourceSchema.parse(row.snapshotJson);
  const noContact = ["wrong_person", "voicemail", "call_back_later", "refused", "no_answer"].find(reason => result.reason.includes(reason));
  const candidateSpoke = result.clientSpoke && noContact !== "wrong_person" && noContact !== "voicemail" && noContact !== "no_answer";
  const summary = noContact === "wrong_person" ? "Трубку взял другой человек. Приглашение кандидату не подтверждено." :
    noContact === "voicemail" ? "Ответил автоответчик. Ответ кандидата не получен." :
    noContact === "call_back_later" ? "Кандидату неудобно говорить. Новый звонок автоматически не назначен." :
    noContact === "refused" ? "Кандидат отказался от разговора. Повторного звонка не будет." :
    !candidateSpoke ? "Ответ кандидата не получен." : undefined;
  const parsed = snapshot.request.purpose === "INVITE" && candidateSpoke && !noContact ? await parseInterviewInviteCall(result.transcript) : null;
  let applicable = false;
  try { applicable = await prisma.$transaction(async tx => sameSource(snapshot, await currentSource(tx, row.jobApplicationId, row.actorId), false)); }
  catch (error) { if (!(error instanceof RecruitmentCommunicationError)) throw error; }
  // Raw voice testimony stays in the staff ledger. It is not fabricated as a
  // canonical chat IN or a résumé fact with borrowed sourceEventKey.
  const outcome = applicable && snapshot.request.purpose === "INVITE" && parsed?.outcome === "CONFIRMED" ? "CONFIRMED" : "COMPLETED";
  await settle(id, outcome, !applicable ? "Ответ относится к прежней версии анкеты или времени" : summary ?? null, result.channelId,
    { reason: result.reason, parsed, transcript: result.transcript, recordingKey: result.recordingKey ?? null,
      candidateSpoke, summary, purpose: snapshot.request.purpose, applicable });
}
async function assertPhysicalSourceCurrent(row: Row, snapshot: Snapshot) {
  const current = await prisma.$transaction(async tx => sameSource(snapshot, await currentSource(tx, row.jobApplicationId, row.actorId), false));
  if (!current) held("Данные изменились до начала обращения — отправка отменена");
}
/** Exactly one physical attempt per staff operation. No accepted/UNKNOWN row
 * ever returns to QUEUED. A crash after the claim is reconciled as UNKNOWN. */
export async function dispatchRecruitmentCommunication(id: string, now = new Date()): Promise<void> {
  const [initial] = await prisma.$queryRaw<Row[]>`SELECT * FROM "RecruitmentCommunication" WHERE "id"=${id}`;
  if (!initial || initial.status !== "QUEUED") return;
  const snapshot = sourceSchema.parse(initial.snapshotJson);
  if (new Date(snapshot.validUntil).getTime() <= now.getTime()) {
    await prisma.$executeRaw`UPDATE "RecruitmentCommunication" SET "status"='CANCELLED',"effectKey"=NULL,"reason"='Время обращения истекло',"updatedAt"=now()
      WHERE "id"=${id} AND "status"='QUEUED'`; return;
  }
  if (initial.channel === "ASSISTANT_CALL") {
    await loadCompanyDaysOff();
    if (!isWithinPostShowingCallHours(now)) return;
  }
  let claimed = false;
  try {
    claimed = await prisma.$transaction(async tx => {
      const source = await currentSource(tx, initial.jobApplicationId, initial.actorId);
      if (!sameSource(snapshot, source, false) || new Date(snapshot.validUntil).getTime() <= now.getTime()) {
        await tx.$executeRaw`UPDATE "RecruitmentCommunication" SET "status"='CANCELLED',"effectKey"=NULL,"reason"='Анкета, вакансия или время изменились',"updatedAt"=now()
          WHERE "id"=${id} AND "status"='QUEUED'`; return false;
      }
      return await tx.$executeRaw`UPDATE "RecruitmentCommunication" SET "status"='IN_FLIGHT',"attemptStartedAt"=${now},"updatedAt"=now()
        WHERE "id"=${id} AND "status"='QUEUED'` === 1;
    });
  } catch (error) {
    if (!(error instanceof RecruitmentCommunicationError)) throw error;
    await prisma.$executeRaw`UPDATE "RecruitmentCommunication" SET "status"='CANCELLED',"effectKey"=NULL,"reason"=${error.message},"updatedAt"=now()
      WHERE "id"=${id} AND "status"='QUEUED'`; return;
  }
  if (!claimed) return;
  try {
    if (initial.channel === "SMS") {
      const config = await loadSmsConfig();
      if (!config) { await settle(id, "REJECTED", "СМС не подключены"); return; }
      if (process.env.SMS_DRY_RUN === "1" || process.env.VITEST && !testTransport) { await settle(id, "DRY_RUN", "Проверка без отправки"); return; }
      const phone = toSmsPhone(snapshot.phone);
      if (!phone) { await settle(id, "REJECTED", "Номер кандидата не подходит для СМС (нужен таджикский номер)"); return; }
      await assertPhysicalSourceCurrent(initial, snapshot);
      const result = await (testTransport?.sms ?? payomSend)(config, phone, snapshot.text, { webhookUrl: payomWebhookUrl() });
      if (result.ok && result.messageId) {
        // Receipt settlement remains valid even if the source changed during HTTP.
        const notDelivered = PAYOM_NOT_DELIVERED.some(status => status === result.deliveryStatus);
        await settle(id, result.deliveryStatus === "DELIVERED" ? "DELIVERED" : notDelivered ? "REJECTED" : "ACCEPTED",
          notDelivered ? "Провайдер сообщил, что СМС не доставлено" : null, result.messageId, { deliveryStatus: result.deliveryStatus });
        await reconcileRecruitmentSmsReceipt(result.messageId);
      } else await settle(id, result.ok || result.failureOutcome !== "refused" ? "UNKNOWN" : "REJECTED",
        result.ok ? "Провайдер не вернул идентификатор — не повторяйте отправку" : result.error);
    } else {
      if (process.env.VITEST && !testTransport || process.env.RECRUITMENT_CONTACT_DRY_RUN === "1") { await settle(id, "DRY_RUN", "Проверка без звонка"); return; }
      const voice = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { liveVoiceVoiceName: true, liveVoiceVoiceNameTajik: true } });
      await assertPhysicalSourceCurrent(initial, snapshot);
      const result = await (testTransport?.call ?? originateLiveVoiceScenarioCall)(snapshot.phone, { systemInstruction: snapshot.callPrompt,
        greetingTrigger: "(Кандидат снял трубку. Представься голосовым помощником Royal Home и спроси, удобно ли говорить.)",
        tools: INTERVIEW_INVITE_CALL_TOOLS, language: snapshot.request.language, forceRussianOnly: false,
        voiceName: (snapshot.request.language === "tg" ? voice?.liveVoiceVoiceNameTajik || voice?.liveVoiceVoiceName : voice?.liveVoiceVoiceName) || undefined,
        onFinished: result => finishRecruitmentAssistantCall(id, result) }, { callerId: "Royal Home", channelId: id,
          beforeOriginate: () => assertPhysicalSourceCurrent(initial, snapshot) });
      if (result.busy) {
        // The bridge explicitly proves this branch occurs before any originate.
        await settle(id, "QUEUED", "Линия ассистента занята; ожидаем свободную линию");
      } else if (result.ok && result.channelId) await settle(id, "ACCEPTED", null, result.channelId);
      else await settle(id, bridgeRefusalStatus(result), result.error ?? "Начало звонка не подтверждено — повтор запрещён");
    }
  } catch (error) {
    await settle(id, error instanceof RecruitmentCommunicationError ? "CANCELLED" : "UNKNOWN",
      error instanceof RecruitmentCommunicationError ? error.message : "Результат обращения неизвестен — повторная отправка запрещена");
  }
}
export async function runRecruitmentCommunicationTick(now = new Date()): Promise<void> {
  const interruptedCalls = await prisma.$queryRaw<Array<{ id: string; providerReceipt: string | null }>>`SELECT "id","providerReceipt"
    FROM "RecruitmentCommunication" WHERE "channel"='ASSISTANT_CALL' AND "status" IN ('IN_FLIGHT','ACCEPTED')
      AND "attemptStartedAt"<${new Date(now.getTime() - 20 * 60_000)} ORDER BY "attemptStartedAt" LIMIT 10`;
  for (const call of interruptedCalls) {
    const session = await prisma.liveVoiceSession.findFirst({ where: { channelId: call.providerReceipt ?? call.id }, orderBy: { startedAt: "desc" },
      select: { endedAt: true, endedReason: true, startedAt: true, transcript: true, recordingUrl: true } });
    if (session?.endedAt) await finishRecruitmentAssistantCall(call.id, { channelId: call.providerReceipt ?? call.id,
      reason: session.endedReason ?? "listener_stopped", transcript: session.transcript?.split("\n") ?? [],
      clientSpoke: !!session.transcript?.split("\n").some(line => line.startsWith("Клиент:")), recordingKey: session.recordingUrl,
      startedAt: session.startedAt, endedAt: session.endedAt });
    else await settle(call.id, "UNKNOWN", "Итог звонка не получен. Повторный звонок запрещён до проверки.");
  }
  await prisma.$executeRaw`UPDATE "RecruitmentCommunication" SET "status"='UNKNOWN',"reason"='Процесс прервался; проверьте результат у провайдера',"updatedAt"=now()
    WHERE "status"='IN_FLIGHT' AND "attemptStartedAt"<${new Date(now.getTime() - 20 * 60_000)}`;
  // СМС уходят всегда; звонки, ждущие окна, выбираются только в окне — иначе они заслоняют СМС.
  await loadCompanyDaysOff();
  const callsNow = isWithinPostShowingCallHours(now);
  const due = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "RecruitmentCommunication" WHERE "status"='QUEUED'
    ${callsNow ? Prisma.empty : Prisma.sql`AND "channel"<>'ASSISTANT_CALL'`} ORDER BY ("channel"='SMS') DESC,"createdAt" LIMIT 10`);
  for (const row of due) await dispatchRecruitmentCommunication(row.id, now);
}
export async function recordRecruitmentSmsReceipt(providerId: string, status: string, at: Date) {
  await prisma.$executeRaw`INSERT INTO "RecruitmentSmsReceipt" ("providerId","status","occurredAt") VALUES (${providerId},${status},${at})
    ON CONFLICT ("providerId") DO UPDATE SET "status"=EXCLUDED."status","occurredAt"=EXCLUDED."occurredAt"
    WHERE "RecruitmentSmsReceipt"."occurredAt"<EXCLUDED."occurredAt"`;
  await reconcileRecruitmentSmsReceipt(providerId);
}
export async function reconcileRecruitmentSmsReceipt(providerId: string) {
  const [receipt] = await prisma.$queryRaw<Array<{ status: string; occurredAt: Date }>>`SELECT "status","occurredAt" FROM "RecruitmentSmsReceipt" WHERE "providerId"=${providerId}`;
  if (!receipt) return;
  const status = receipt.status, at = receipt.occurredAt;
  // The provider webhook is authoritative only for a known accepted receipt.
  // Its monotonic timestamp is stored alongside the last delivery status.
  await prisma.$executeRaw`UPDATE "RecruitmentCommunication" SET "providerStatus"=${status},
    "status"=CASE WHEN ${status}='DELIVERED' THEN 'DELIVERED' WHEN ${status} IN ('UNDELIVERABLE','EXPIRED','REVOKED','DELETED','REJECTED') THEN 'REJECTED' ELSE "status" END,
    "effectKey"=CASE WHEN ${status} IN ('UNDELIVERABLE','EXPIRED','REVOKED','DELETED','REJECTED') THEN NULL ELSE "effectKey" END,
    "resultJson"=jsonb_set(COALESCE("resultJson",'{}'::jsonb),'{deliveryStatusAt}',to_jsonb(${at.toISOString()}::text)),"updatedAt"=now()
    WHERE "channel"='SMS' AND "providerReceipt"=${providerId} AND "status" IN ('ACCEPTED','DELIVERED','REJECTED')
      AND COALESCE("resultJson"->>'deliveryStatusAt','')<${at.toISOString()}`;
}
