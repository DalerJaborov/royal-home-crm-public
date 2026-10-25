import { Router } from "express";
import { z } from "zod";
import { narrationConfigSchema, narrationDraftSchema, narrationActionSchema, narrationHandoffSchema } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { requireAuth } from "../../auth/middleware.js";
import { hasMarketingRole } from "../marketing.js";
import { canManageProperty } from "./shared.js";
import { narrationFacts, narrationHash, suggestedNarration, narrationScriptError, generateNarrationAudio } from "../../lib/propertyNarration.js";
import { resolveElevenLabsKey } from "../../ai/liveVoiceProvider.js";
import { localVideoUpload, localVideoFilePath, localVideoDelete } from "../../lib/localVideoStorage.js";
import { setOwnerReportConsent, prepareOwnerReportDelivery } from "../../lib/ownerReport/delivery.js";
import { prepareNarrationDeliveryPlan, narrationDeliveryAttemptBudgetMs } from "../../lib/narrationDelivery.js";
import { mediaExecutionMode } from "../../lib/mediaExecution.js";
import { preparePublicationMetadataPreview } from "../../lib/publicationMetadataSync.js";

export const narrationRouter = Router();
narrationRouter.use(["/narration-settings", "/:id/narration"], requireAuth);
const idSchema = z.string().uuid();
const manager = (role?: string) => hasMarketingRole(role);
async function configuration() {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true, elevenLabsApiKey: true } });
  const parsed = narrationConfigSchema.safeParse(settings?.propertyNarrationConfig ?? {});
  return { config: parsed.success ? parsed.data : { modelId: "", voices: [] }, key: resolveElevenLabsKey(settings?.elevenLabsApiKey) };
}
// This static path is mounted before /properties/:id.
narrationRouter.get("/narration-settings", async (req, res) => {
  if (!manager(req.agent?.role)) return res.status(403).json({ error: "Настройки доступны маркетингу и руководству" });
  const { config, key } = await configuration();
  res.json({ config, apiKeyConfigured: !!key, sendsEnabled: false });
});
narrationRouter.put("/narration-settings", async (req, res) => {
  if (!["ADMIN", "DIRECTOR"].includes(req.agent!.role)) return res.status(403).json({ error: "Голоса настраивает руководство" });
  const parsed = narrationConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Проверьте модель и список голосов", details: parsed.error.flatten() });
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", propertyNarrationConfig: parsed.data }, update: { propertyNarrationConfig: parsed.data } });
  res.json({ config: parsed.data, sendsEnabled: false });
});

narrationRouter.use("/:id/narration", async (req, res, next) => {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Некорректный объект" });
  const property = await prisma.property.findUnique({ where: { id: parsed.data }, include: { district: true } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Нет доступа к материалам объекта" });
  if (req.agent!.role === "EDITOR" && !await prisma.propertyNarrationDelivery.findFirst({ where: { propertyId: property.id, editorId: req.agent!.id }, select: { id: true } })) return res.status(403).json({ error: "Озвучка не назначена этому монтажёру" });
  res.locals.narrationProperty = property;
  next();
});

narrationRouter.get("/:id/narration", async (req, res) => {
  const p = res.locals.narrationProperty;
  const facts = narrationFacts(p);
  const { config, key } = await configuration();
  const versions = await prisma.propertyNarrationVersion.findMany({ where: { propertyId: p.id,
    ...(req.agent!.role === "EDITOR" ? { deliveries: { some: { editorId: req.agent!.id } } } : {}) }, orderBy: { revision: "desc" }, take: 50 });
  // An unresolved generation still blocks new paid work even after many later drafts.
  if (["ADMIN", "DIRECTOR"].includes(req.agent!.role)) {
    const unresolved = await prisma.propertyNarrationVersion.findMany({ where: { propertyId: p.id, status: { in: ["GENERATING", "UNKNOWN"] } }, orderBy: { revision: "desc" }, take: 1 });
    for (const row of unresolved) if (!versions.some(v => v.id === row.id)) versions.push(row);
  }
  const deliveries = manager(req.agent?.role) ? await prisma.propertyNarrationDelivery.findMany({ where: { propertyId: p.id }, orderBy: { createdAt: "desc" }, take: 20 }) : [];
  const subscription = manager(req.agent?.role) ? await prisma.ownerReportSubscription.findUnique({ where: { propertyId: p.id } }) : null;
  const reports = manager(req.agent?.role) ? await prisma.ownerReportDelivery.findMany({ where: { propertyId: p.id }, orderBy: { createdAt: "desc" }, take: 12, select: { id: true, status: true, period: true, lastError: true, providerReceipt: true } }) : [];
  const receiptId = (receipt: unknown): string | null => { const parsed = z.object({ smsMessageId: z.string() }).safeParse(receipt); return parsed.success ? parsed.data.smsMessageId : null; };
  const smsIds = reports.flatMap(r => receiptId(r.providerReceipt) ? [receiptId(r.providerReceipt)!] : []);
  const smsReceipts = smsIds.length ? await prisma.smsMessage.findMany({ where: { id: { in: smsIds }, propertyId: p.id, purpose: "OWNER_REPORT" }, select: { id: true, deliveryStatus: true } }) : [];
  const reportViews = reports.map(r => {
    const actual = smsReceipts.find(s => s.id === receiptId(r.providerReceipt))?.deliveryStatus;
    const status = r.status === "SENT" && actual === "DELIVERED" ? "DELIVERED" : r.status === "SENT" && ["UNDELIVERABLE", "EXPIRED", "REVOKED", "DELETED", "REJECTED"].includes(actual ?? "") ? "NOT_DELIVERED" : r.status;
    return { id: r.id, status, period: r.period, lastError: r.lastError };
  });
  res.json({ versions: versions.map((v) => ({ id: v.id, revision: v.revision, script: v.script, voiceId: v.voiceId, status: v.status,
    approvedAt: v.approvedAt, stale: v.factsHash !== narrationHash(facts), hasAudio: v.status === "READY" && !!v.storageKey, errorCode: v.errorCode, createdAt: v.createdAt,
    canReconcile: v.status === "UNKNOWN" || (v.status === "GENERATING" && !!v.generationStartedAt && Date.now() - v.generationStartedAt.getTime() > 120_000) })),
    suggestedScript: suggestedNarration(facts), config, configured: !!key && !!config.modelId && config.voices.length > 0, canApprove: manager(req.agent?.role), canConfigure: ["ADMIN", "DIRECTOR"].includes(req.agent!.role), sendsEnabled: mediaExecutionMode("NARRATION") === "LIVE",
    deliveries: deliveries.map(d => ({ id: d.id, status: d.status, mode: d.mode, versionId: d.versionId, createdAt: d.createdAt, lastError: d.lastError, planHash: d.plan ? narrationHash(d.plan) : null })),
    ownerReportsEnabled: mediaExecutionMode("OWNER_REPORT") === "LIVE",
    ownerReport: manager(req.agent?.role) ? { active: !!subscription?.active && subscription.sellerClientId === p.sellerClientId, revision: subscription?.revision ?? 0, executionMode: subscription?.executionMode ?? "PREVIEW", deliveries: reportViews } : undefined,
    canDraft: req.agent!.role !== "EDITOR", readiness: { voiceCount: config.voices.length, modelConfigured: !!config.modelId, apiKeyConfigured: !!key } });
});

narrationRouter.post("/:id/narration", async (req, res) => {
  if (req.agent!.role === "EDITOR") return res.status(403).json({ error: "Монтажёр получает подтверждённую озвучку" });
  const parsed = narrationDraftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Некорректный текст или версия", details: parsed.error.flatten() });
  const p = res.locals.narrationProperty;
  const { config } = await configuration();
  if (parsed.data.voiceId && !config.voices.some((v) => v.id === parsed.data.voiceId)) return res.status(400).json({ error: "Выберите голос из настроек" });
  const facts = narrationFacts(p);
  const script = parsed.data.script ?? suggestedNarration(facts);
  const error = narrationScriptError(script);
  if (error) return res.status(400).json({ error });
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${p.id} FOR UPDATE`;
    const existing = await tx.propertyNarrationVersion.findUnique({ where: { requestKey: parsed.data.requestKey } });
    if (existing) return existing.propertyId === p.id && existing.createdById === req.agent!.id && existing.script === script && existing.voiceId === (parsed.data.voiceId ?? null) ? existing : null;
    const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: p.id }, orderBy: { revision: "desc" } });
    if ((latest?.revision ?? 0) !== parsed.data.expectedRevision) return null;
    if (latest?.approvedAt && !manager(req.agent?.role)) return null;
    return tx.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: parsed.data.expectedRevision + 1, script, factsSnapshot: facts,
      factsHash: narrationHash(facts), voiceId: parsed.data.voiceId ?? null, modelId: config.modelId || null, createdById: req.agent!.id, requestKey: parsed.data.requestKey } });
  });
  if (!result) return res.status(409).json({ error: "Версия изменилась или требует прав маркетинга. Обновите карточку." });
  res.status(201).json({ id: result.id, revision: result.revision });
});

narrationRouter.post("/:id/narration/:versionId/approve", async (req, res) => {
  if (!manager(req.agent?.role)) return res.status(403).json({ error: "Текст подтверждает маркетинг или руководство" });
  const parsed = narrationActionSchema.safeParse(req.body), versionId = idSchema.safeParse(req.params.versionId);
  if (!parsed.success || !versionId.success) return res.status(400).json({ error: "Подтвердите текст и номер версии" });
  const p = res.locals.narrationProperty;
  const count = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${p.id} FOR UPDATE`;
    const current = await tx.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
    const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: p.id }, orderBy: { revision: "desc" } });
    if (current.deletedAt || !latest || latest.id !== versionId.data || latest.revision !== parsed.data.expectedRevision || latest.factsHash !== narrationHash(narrationFacts(current)) || latest.status !== "DRAFT") return 0;
    return (await tx.propertyNarrationVersion.updateMany({ where: { id: latest.id, status: "DRAFT" }, data: { approvedAt: new Date(), approvedById: req.agent!.id } })).count;
  });
  if (!count) return res.status(409).json({ error: "Факты или версия изменились. Подготовьте и проверьте новый текст." });
  res.json({ ok: true });
});

narrationRouter.post("/:id/narration/:versionId/generate", async (req, res) => {
  if (!manager(req.agent?.role)) return res.status(403).json({ error: "Генерация доступна маркетингу и руководству" });
  const parsed = narrationActionSchema.safeParse(req.body), versionId = idSchema.safeParse(req.params.versionId);
  if (!parsed.success || !versionId.success) return res.status(400).json({ error: "Подтвердите генерацию выбранной версии" });
  const p = res.locals.narrationProperty, { config, key } = await configuration();
  if (!key || !config.modelId || !config.voices.length) return res.status(409).json({ error: "ElevenLabs не настроен. Добавьте ключ, модель и голоса в настройках." });
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${p.id} FOR UPDATE`;
    const current = await tx.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
    const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: p.id }, orderBy: { revision: "desc" } });
    if (current.deletedAt || !latest || latest.id !== versionId.data || latest.revision !== parsed.data.expectedRevision || !latest.approvedAt || latest.factsHash !== narrationHash(narrationFacts(current))) return null;
    if (latest.status !== "DRAFT") return { row: latest, run: false };
    if (!latest.voiceId || !config.voices.some((v) => v.id === latest.voiceId) || latest.modelId !== config.modelId) return null;
    if (await tx.propertyNarrationVersion.count({ where: { propertyId: p.id, status: { in: ["GENERATING", "UNKNOWN"] } } })) return null;
    const generationStartedAt = new Date();
    await tx.propertyNarrationVersion.update({ where: { id: latest.id }, data: { status: "GENERATING", generationStartedAt } });
    return { row: { ...latest, generationStartedAt }, run: true };
  });
  if (!claimed) return res.status(409).json({ error: "Проверьте актуальность текста и голоса. Предыдущий запрос с неизвестным результатом требует проверки провайдера." });
  if (!claimed.run) return res.status(claimed.row.status === "READY" ? 200 : 409).json({ status: claimed.row.status, error: claimed.row.status === "READY" ? undefined : "Запрос уже выполнялся. Автоматический повтор отключён." });
  const result = await generateNarrationAudio({ script: claimed.row.script, voiceId: claimed.row.voiceId!, config, apiKey: key });
  if (result.status !== "READY") {
    const saved = await prisma.propertyNarrationVersion.updateMany({ where: { id: claimed.row.id, status: "GENERATING", generationStartedAt: claimed.row.generationStartedAt }, data: { status: result.status, errorCode: result.errorCode } });
    if (!saved.count) return res.status(409).json({ error: "Результат уже проверен руководством. Поздний ответ не изменил решение." });
    return res.status(502).json({ status: result.status, error: "Озвучка не получена. Повтор не выполнялся; проверьте результат в ElevenLabs." });
  }
  const storageKey = `${p.id}/${claimed.row.id}.mp3`;
  try {
    await localVideoUpload(storageKey, result.audio);
    const saved = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${p.id} FOR UPDATE`;
      const changed = await tx.propertyNarrationVersion.updateMany({ where: { id: claimed.row.id, status: "GENERATING", generationStartedAt: claimed.row.generationStartedAt }, data: { status: "READY", storageKey, providerRequestId: result.requestId } });
      if (changed.count) return "READY";
      const retained = await tx.propertyNarrationVersion.updateMany({ where: { id: claimed.row.id }, data: { storageKey, providerRequestId: result.requestId } });
      return retained.count ? "RECONCILED" : "REMOVED";
    });
    if (saved !== "READY") {
      if (saved === "REMOVED") await localVideoDelete(storageKey);
      return res.status(409).json({ error: "Пришёл поздний результат генерации. Решение руководства сохранено; новая готовая версия не объявлялась." });
    }
  } catch {
    await prisma.propertyNarrationVersion.updateMany({ where: { id: claimed.row.id, status: "GENERATING", generationStartedAt: claimed.row.generationStartedAt }, data: { status: "UNKNOWN", errorCode: "AUDIO_PERSISTENCE_FAILED", providerRequestId: result.requestId } });
    return res.status(503).json({ error: "Провайдер создал аудио, но сохранить его не удалось. Повторная генерация заблокирована." });
  }
  const afterGeneration = await prisma.property.findUnique({ where: { id: p.id }, select: { deletedAt: true } });
  if (!afterGeneration) return res.status(409).json({ error: "Объект уже удалён. Озвучка недоступна." });
  res.json({ status: "READY", propertyTrashed: !!afterGeneration.deletedAt,
    ...(afterGeneration.deletedAt ? { message: "Объект в Корзине. Озвучка сохранена в истории, передача недоступна до восстановления." } : {}) });
});

narrationRouter.get("/:id/narration/:versionId/audio", async (req, res) => {
  const versionId = idSchema.safeParse(req.params.versionId);
  if (!versionId.success) return res.status(400).json({ error: "Некорректная версия" });
  const row = await prisma.propertyNarrationVersion.findFirst({ where: { id: versionId.data, propertyId: res.locals.narrationProperty.id, status: "READY",
    ...(req.agent!.role === "EDITOR" ? { deliveries: { some: { editorId: req.agent!.id } } } : {}) } });
  const file = row?.storageKey ? localVideoFilePath(row.storageKey) : null;
  if (!file) return res.status(404).json({ error: "Аудио недоступно" });
  res.setHeader("Cache-Control", "private, no-store"); res.type("audio/mpeg").sendFile(file);
});

narrationRouter.post("/:id/narration/:versionId/reconcile", async (req, res) => {
  if (!["ADMIN", "DIRECTOR"].includes(req.agent!.role)) return res.status(403).json({ error: "Результат проверяет руководство" });
  const parsed = z.object({ expectedRevision: z.number().int().positive(), checkedProviderHistory: z.literal(true), note: z.string().trim().min(20).max(2000) }).safeParse(req.body);
  const id = idSchema.safeParse(req.params.versionId);
  if (!parsed.success || !id.success) return res.status(400).json({ error: "Подтвердите проверку истории ElevenLabs и опишите результат (не менее 20 символов)" });
  const propertyId = res.locals.narrationProperty.id;
  const changed = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${propertyId} FOR UPDATE`;
    const current = await tx.propertyNarrationVersion.findFirst({ where: { id: id.data, propertyId, revision: parsed.data.expectedRevision } });
    if (!current || (current.status !== "UNKNOWN" && !(current.status === "GENERATING" && current.generationStartedAt && Date.now() - current.generationStartedAt.getTime() > 120_000))) return false;
    const result = await tx.propertyNarrationVersion.updateMany({ where: { id: id.data, propertyId, revision: parsed.data.expectedRevision, status: current.status, generationStartedAt: current.generationStartedAt }, data: { status: "FAILED", errorCode: "MANUALLY_RECONCILED" } });
    if (!result.count) return false;
    await tx.auditLog.create({ data: { agentId: req.agent!.id, agentName: "Руководитель", action: "PROPERTY_NARRATION_RECONCILE", entityType: "Property", entityId: propertyId,
      meta: { versionId: id.data, revision: parsed.data.expectedRevision, note: parsed.data.note, previousStatus: current.status, status: "FAILED", providerCharge: "UNKNOWN" } } });
    return true;
  });
  if (!changed) return res.status(409).json({ error: "Версия уже проверена или её состояние изменилось. Обновите карточку." });
  res.json({ status: "FAILED", message: "Проверка сохранена. Автоповтора нет. Возможное списание ElevenLabs не отменено." });
});

narrationRouter.post("/:id/narration/:versionId/handoff-preview", async (req, res) => {
  if (!manager(req.agent?.role)) return res.status(403).json({ error: "Передачу готовит маркетинг или руководство" });
  const parsed = narrationHandoffSchema.safeParse(req.body), versionId = idSchema.safeParse(req.params.versionId);
  if (!parsed.success || !versionId.success) return res.status(400).json({ error: "Проверьте параметры передачи" });
  const p = res.locals.narrationProperty;
  const row = await prisma.propertyNarrationVersion.findFirst({ where: { id: versionId.data, propertyId: p.id, revision: parsed.data.expectedRevision, status: "READY", approvedAt: { not: null } } });
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: p.id }, orderBy: { revision: "desc" } });
  if (!row || latest?.id !== row.id || row.factsHash !== narrationHash(narrationFacts(p))) return res.status(409).json({ error: "Нужна готовая актуальная озвучка" });
  if (parsed.data.editorId && !await prisma.agent.findFirst({ where: { id: parsed.data.editorId, role: "EDITOR", isActive: true } })) return res.status(400).json({ error: "Монтажёр недоступен" });
  const existing = await prisma.propertyNarrationDelivery.findUnique({ where: { requestKey: parsed.data.requestKey } });
  let prepared: Awaited<ReturnType<typeof prepareNarrationDeliveryPlan>>;
  try { prepared = await prepareNarrationDeliveryPlan(p.id, row.id, parsed.data.mode, parsed.data.editorId); }
  catch (err) { return res.status(409).json({ error: err instanceof Error ? err.message : "Передача недоступна" }); }
  const delivery = existing ?? await prisma.propertyNarrationDelivery.upsert({ where: { requestKey: parsed.data.requestKey }, create: { propertyId: p.id, versionId: row.id, editorId: prepared.editorId,
    mode: parsed.data.mode, requestKey: parsed.data.requestKey, createdById: req.agent!.id, plan: prepared.plan }, update: {} });
  if (delivery.propertyId !== p.id || delivery.versionId !== row.id || delivery.createdById !== req.agent!.id || delivery.mode !== parsed.data.mode || delivery.editorId !== prepared.editorId) return res.status(409).json({ error: "Ключ передачи уже использован" });
  res.json({ delivery, propertyCode: p.shortId, audioVersion: row.revision, sent: false, message: "Передача подготовлена. Отправка отключена до отдельного включения." });
});

narrationRouter.post("/:id/narration/deliveries/:deliveryId/queue", async (req, res) => {
  if (!manager(req.agent?.role)) return res.status(403).json({ error: "Нет доступа" });
  const parsed = z.object({ confirmed: z.literal(true), planHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(req.body);
  const deliveryId = idSchema.safeParse(req.params.deliveryId);
  if (!parsed.success || !deliveryId.success) return res.status(400).json({ error: "Подтвердите актуальный план" });
  if (mediaExecutionMode("NARRATION") !== "LIVE") return res.status(409).json({ error: "Внешняя отправка ещё не включена на сервере" });
  const p = res.locals.narrationProperty;
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${p.id} FOR UPDATE`;
    const row = await tx.propertyNarrationDelivery.findFirst({ where: { id: deliveryId.data, propertyId: p.id } });
    if (!row || row.status !== "PREVIEW" || !row.plan || narrationHash(row.plan) !== parsed.data.planHash) return false;
    if (await tx.propertyNarrationDelivery.count({ where: { propertyId: p.id, status: { in: ["QUEUED", "SENDING", "UNKNOWN"] } } })) return false;
    // One version/mode/recipient dispatch. A new requestKey cannot bypass the receipt.
    if (await tx.propertyNarrationDelivery.count({ where: { propertyId: p.id, versionId: row.versionId, editorId: row.editorId, mode: row.mode, status: { in: ["SENT", "CANCELLED"] } } })) return false;
    const current = await prepareNarrationDeliveryPlan(p.id, row.versionId, row.mode, row.editorId ?? undefined);
    if (narrationHash(current.plan) !== parsed.data.planHash) return false;
    return !!(await tx.propertyNarrationDelivery.updateMany({ where: { id: row.id, status: "PREVIEW" }, data: { status: "QUEUED", executionMode: "LIVE" } })).count;
  });
  if (!result) return res.status(409).json({ error: "План изменился или передача уже выполнена/требует проверки" });
  res.json({ status: "QUEUED", sent: false });
});

narrationRouter.post("/:id/narration/publication-preview", async (req, res) => {
  if (!manager(req.agent?.role)) return res.status(403).json({ error: "Нет доступа" });
  if (!z.object({}).strict().safeParse(req.body).success) return res.status(400).json({ error: "Некорректный запрос предварительного просмотра" });
  const p = res.locals.narrationProperty;
  const rows = await preparePublicationMetadataPreview(p.id);
  res.json({ rows, sent: false });
});

narrationRouter.post("/:id/narration/owner-report-preview", async (req, res) => {
  if (!manager(req.agent?.role)) return res.status(403).json({ error: "Нет доступа" });
  const parsed = z.object({ ownerRequested: z.literal(true) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Подтвердите согласованный с собственником отчёт" });
  const p = res.locals.narrationProperty;
  await setOwnerReportConsent(p.id, req.agent!.id, true);
  const draft = await prepareOwnerReportDelivery(p.id);
  res.json({ draft, sent: false, message: draft ? "Согласие сохранено. Отчёт подготовлен; доставка отражается отдельно в журнале." : "Согласие сохранено. Нужна действующая HTTPS-ссылка отчёта и номер собственника." });
});
narrationRouter.post("/:id/narration/owner-report-revoke", async (req, res) => {
  if (!manager(req.agent?.role)) return res.status(403).json({ error: "Нет доступа" });
  if (!z.object({ confirmed: z.literal(true) }).strict().safeParse(req.body).success) return res.status(400).json({ error: "Подтвердите отзыв" });
  await setOwnerReportConsent(res.locals.narrationProperty.id, req.agent!.id, false);
  res.json({ active: false });
});

narrationRouter.post("/:id/narration/delivery-reconcile", async (req, res) => {
  if (!["ADMIN", "DIRECTOR"].includes(req.agent!.role)) return res.status(403).json({ error: "Сверку сохраняет руководство" });
  const parsed = z.object({ kind: z.enum(["NARRATION", "OWNER_REPORT"]), deliveryId: z.string().uuid(), checkedProviderHistory: z.literal(true), note: z.string().trim().min(20).max(2000) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Проверьте историю доставки у провайдера и опишите результат (от 20 символов)" });
  const { kind, deliveryId, note } = parsed.data;
  const p = res.locals.narrationProperty;
  const changed = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${p.id} FOR UPDATE`;
    const row = kind === "NARRATION" ? await tx.propertyNarrationDelivery.findUnique({ where: { id: deliveryId } }) : await tx.ownerReportDelivery.findUnique({ where: { id: deliveryId } });
    const budget = kind === "NARRATION" ? narrationDeliveryAttemptBudgetMs(row && "plan" in row ? row.plan : null) : 180_000;
    if (!row || row.propertyId !== p.id || !(row.status === "UNKNOWN" || row.status === "SENDING" && row.claimStartedAt && Date.now() - row.claimStartedAt.getTime() > budget)) return false;
    const where = { id: row.id, status: row.status, claimStartedAt: row.claimStartedAt };
    const data = { status: "FAILED", lastError: "Сверка сохранена: пригодный результат не подтверждён. Автоповтора нет." };
    const result = kind === "NARRATION" ? await tx.propertyNarrationDelivery.updateMany({ where, data }) : await tx.ownerReportDelivery.updateMany({ where, data });
    if (!result.count) return false;
    await tx.auditLog.create({ data: { agentId: req.agent!.id, agentName: "Руководитель", action: "MEDIA_DELIVERY_RECONCILED", entityType: kind === "NARRATION" ? "PropertyNarrationDelivery" : "OwnerReportDelivery", entityId: row.id,
      meta: { note, actorId: req.agent!.id, checkedAt: new Date().toISOString(), previousStatus: row.status, claimStartedAt: row.claimStartedAt?.toISOString() ?? null, disposition: "NO_USABLE_RESULT_CONFIRMED", receiptsPreserved: true } } });
    return true;
  });
  if (!changed) return res.status(409).json({ error: "Попытка ещё выполняется или уже сверена. Обновите карточку." });
  res.json({ status: "FAILED", sent: false, message: "Сверка сохранена. Возможное списание не отменено. Автоповтора нет." });
});
