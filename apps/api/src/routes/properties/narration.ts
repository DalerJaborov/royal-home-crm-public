import { Router } from "express";
import { z } from "zod";
import { narrationConfigSchema, narrationConfigPatchSchema, narrationDraftSchema, narrationActionSchema, narrationModeSchema, narrationHandoffSchema, narrationTemplateError, narrationLimits, narrationModelError, renderNarrationTemplate, type NarrationOptionsView } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { requireAuth } from "../../auth/middleware.js";
import { hasMarketingRole } from "../marketing.js";
import { canManageProperty } from "./shared.js";
import { narrationFacts, narrationFactsCurrent, narrationHash, suggestedNarration, narrationScriptError } from "../../lib/propertyNarration.js";
import { localVideoFilePath } from "../../lib/localVideoStorage.js";
import { generateNarrationVersion, generateVoiceSamples, loadNarrationConfiguration, narrationBudgetUsage, narrationProviderReady, narrationQuotaExceededSince, readyVoiceSamples } from "../../lib/narrationGeneration.js";
import { NARRATION_QUOTA_EXCEEDED } from "../../lib/propertyNarration.js";
import { NARRATION_VOICE_LONGER_MARK } from "../../lib/narrationMix.js";
import { afterNarrationApproved, approveNarrationVersion, isNarrationOwnerRole, narrationAutoEnabled, requestAutoNarration } from "../../lib/narrationAutoFlow.js";
import { setPropertyNarrationOff } from "../../lib/narrationOptOut.js";
import { syncPronunciationDictionary } from "../../lib/narrationPronunciation.js";
import { narrationLastChoiceFor } from "../../lib/narrationLastChoice.js";
import { sendToMontajer } from "../../lib/montageObservers.js";
import { setOwnerReportConsent, prepareOwnerReportDelivery } from "../../lib/ownerReport/delivery.js";
import { prepareNarrationDeliveryPlan, narrationDeliveryAttemptBudgetMs } from "../../lib/narrationDelivery.js";
import { mediaExecutionMode } from "../../lib/mediaExecution.js";
import { preparePublicationMetadataPreview } from "../../lib/publicationMetadataSync.js";
import { listPriceCaptionDelivery } from "../../lib/priceCaptionDelivery.js";

export const narrationRouter = Router();
narrationRouter.use(["/narration-settings", "/narration-options", "/narration-voice-samples", "/:id/narration"], requireAuth);
const idSchema = z.string().uuid();
const manager = (role?: string) => hasMarketingRole(role);
const configuration = loadNarrationConfiguration;
/** Образец объекта для проверки шаблона при сохранении: цена и ошибки ловятся до первой оплаты. */
const SAMPLE_FACTS = { type: "APARTMENT", rooms: 3, areaSqm: "86", floor: 5, totalFloors: 9, district: "Сино", price: "85000", currency: "USD" };
// This static path is mounted before /properties/:id.
narrationRouter.get("/narration-settings", async (req, res) => {
  if (!manager(req.agent?.role)) return res.status(403).json({ error: "Настройки доступны маркетингу и руководству" });
  const { config, key } = await configuration();
  // С 14.11.2026 техника озвучки живёт в Настройках CRM, а не в карточке объекта: всё, что раньше
  // раздел брал из ответа карточки (расход, образцы, готовность), приходит здесь.
  const limits = narrationLimits(config);
  res.json({ config, apiKeyConfigured: !!key, sendsEnabled: false, quotaExceeded: !!await narrationQuotaExceededSince(),
    canConfigure: ["ADMIN", "DIRECTOR"].includes(req.agent!.role), configured: !!key && !!config.modelId && config.voices.length > 0,
    autoGenerate: narrationAutoEnabled(config), samplesReady: (await readyVoiceSamples(config)).length,
    budget: { ...await narrationBudgetUsage(), dailyChars: limits.dailyChars, dailyGenerations: limits.dailyGenerations } });
});
/** Мастер объекта (CRM) и карточка: шаблоны и голоса без ключа и модели. Любой сотрудник. */
narrationRouter.get("/narration-options", async (_req, res) => {
  const { config } = await configuration();
  const view: NarrationOptionsView = { templates: config.templates ?? [], voices: config.voices.map((v) => ({ id: v.id, name: v.name, ...(v.gender ? { gender: v.gender } : {}) })),
    defaultTemplateId: config.defaultTemplateId ?? null, defaultVoiceId: config.defaultVoiceId ?? null, autoGenerate: narrationAutoEnabled(config),
    lastChoice: await narrationLastChoiceFor(_req.agent?.id, config),
    samples: (await readyVoiceSamples(config)).map(({ voiceId, lang }) => ({ voiceId, lang })) };
  res.json(view);
});

/**
 * ОБРАЗЦЫ ГОЛОСОВ (11.11.2026). Подготовка — платно, один раз на голос и фразу, только
 * руководство; прослушивание — любой сотрудник, без затрат (файл из кэша).
 */
narrationRouter.post("/narration-voice-samples/prepare", async (req, res) => {
  if (!["ADMIN", "DIRECTOR"].includes(req.agent!.role)) return res.status(403).json({ error: "Образцы голосов готовит руководство" });
  if (!z.object({ confirmed: z.literal(true) }).strict().safeParse(req.body).success) return res.status(400).json({ error: "Подтвердите подготовку образцов" });
  const { config, key } = await configuration();
  if (!key || !narrationProviderReady(config, key)) return res.status(409).json({ error: "ElevenLabs не настроен. Добавьте ключ, модель и голоса в настройках." });
  const report = await generateVoiceSamples({ config, key, actorId: req.agent!.id });
  const parts = [`Новых образцов: ${report.created}`, `уже были: ${report.existing}`];
  if (report.failed) parts.push(`не получилось: ${report.failed}`);
  const tail = report.quota ? " Кредиты ElevenLabs закончились." : report.budget ? " Дневной предел озвучки исчерпан — остальные завтра." : report.remaining ? ` Осталось ${report.remaining} — нажмите ещё раз.` : "";
  res.json({ ...report, message: `${parts.join(", ")}.${tail}` });
});
narrationRouter.get("/narration-voice-samples/:voiceId/:lang", async (req, res) => {
  const params = z.object({ voiceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), lang: z.enum(["tg", "ru"]) }).safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Некорректный голос" });
  const { config } = await configuration();
  const sample = (await readyVoiceSamples(config)).find((s) => s.voiceId === params.data.voiceId && s.lang === params.data.lang);
  const file = sample ? localVideoFilePath(sample.storageKey) : null;
  if (!file) return res.status(404).json({ error: "Образец этого голоса ещё не подготовлен" });
  res.setHeader("Cache-Control", "private, max-age=3600"); res.type("audio/mpeg").sendFile(file);
});
narrationRouter.put("/narration-settings", async (req, res) => {
  if (!["ADMIN", "DIRECTOR"].includes(req.agent!.role)) return res.status(403).json({ error: "Голоса настраивает руководство" });
  const patch = narrationConfigPatchSchema.safeParse(req.body);
  if (!patch.success) return res.status(400).json({ error: "Проверьте модель и список голосов", details: patch.error.flatten() });
  // Поле, которого нет в запросе, остаётся прежним: старый экран не стирает шаблоны и пределы.
  const { config: existing } = await configuration();
  const parsed = narrationConfigSchema.safeParse({ ...existing, ...Object.fromEntries(Object.entries(patch.data).filter(([, v]) => v !== undefined)) });
  if (!parsed.success) return res.status(400).json({ error: "Проверьте модель и список голосов", details: parsed.error.flatten() });
  const modelProblem = narrationModelError(parsed.data);
  if (modelProblem) return res.status(400).json({ error: modelProblem });
  for (const template of parsed.data.templates ?? []) {
    const problem = narrationTemplateError(template.text) ?? narrationScriptError(renderNarrationTemplate(template, SAMPLE_FACTS));
    if (problem) return res.status(400).json({ error: `Шаблон «${template.name}»: ${problem}` });
  }
  // Словарь произношения (12.11.2026): правка правил — синхронизация с ElevenLabs, только для
  // поддержанных моделей (lib/narrationPronunciation.ts); иначе правила просто хранятся.
  let saved = parsed.data;
  let pronunciationNote: string | undefined;
  const spoken = (c: typeof saved) => JSON.stringify((c.pronunciationRules ?? []).map(({ word, alias, phoneme }) => [word, alias ?? "", phoneme ?? ""]));
  // Правила поменялись, или стартовый набор ещё ни разу не ушёл в ElevenLabs (нет id словаря).
  const neverSynced = (saved.pronunciationRules ?? []).length > 0 && !(saved.pronunciationDictionaries ?? []).length;
  if (spoken(existing) !== spoken(saved) || neverSynced) {
    const sync = await syncPronunciationDictionary(saved, (await configuration()).key);
    if (sync.status === "SYNCED") saved = { ...saved, pronunciationDictionaries: sync.dictionaries };
    if (sync.status === "FAILED") pronunciationNote = `Словарь произношения сохранён в CRM, но в ElevenLabs не обновился: ${sync.error}`;
  }
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", propertyNarrationConfig: saved }, update: { propertyNarrationConfig: saved } });
  res.json({ config: saved, sendsEnabled: false, ...(pronunciationNote ? { message: pronunciationNote } : {}) });
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
    approvedAt: v.approvedAt, stale: !narrationFactsCurrent(v, p), hasAudio: v.status === "READY" && !!v.storageKey, errorCode: v.errorCode, createdAt: v.createdAt,
    canReconcile: v.status === "UNKNOWN" || (v.status === "GENERATING" && !!v.generationStartedAt && Date.now() - v.generationStartedAt.getTime() > 120_000),
    source: v.source, templateId: v.templateId, language: v.language, generateAfter: v.generateAfter })),
    suggestedScript: suggestedNarration(facts), facts, config, configured: !!key && !!config.modelId && config.voices.length > 0, canApprove: manager(req.agent?.role), canConfigure: ["ADMIN", "DIRECTOR"].includes(req.agent!.role), sendsEnabled: mediaExecutionMode("NARRATION") === "LIVE",
    deliveries: deliveries.map(d => ({ id: d.id, status: d.status, mode: d.mode, versionId: d.versionId, createdAt: d.createdAt, lastError: d.lastError, planHash: d.plan ? narrationHash(d.plan) : null })),
    ownerReportsEnabled: mediaExecutionMode("OWNER_REPORT") === "LIVE",
    ownerReport: manager(req.agent?.role) ? { active: !!subscription?.active && subscription.sellerClientId === p.sellerClientId, revision: subscription?.revision ?? 0, executionMode: subscription?.executionMode ?? "PREVIEW", deliveries: reportViews } : undefined,
    canDraft: req.agent!.role !== "EDITOR", readiness: { voiceCount: config.voices.length, modelConfigured: !!config.modelId, apiKeyConfigured: !!key },
    // Агент объекта (canManageProperty уже проверен выше) одобряет готовое аудио автоозвучки.
    // Озвучку разового прохода по очереди монтажа одобряет владелец (12.11.2026).
    canApproveAudio: req.agent!.role !== "EDITOR" && (versions[0]?.source !== "BACKFILL" || isNarrationOwnerRole(req.agent!.role)), autoGenerate: narrationAutoEnabled(config),
    off: p.narrationOff,
    lastChoice: await narrationLastChoiceFor(req.agent!.id, config),
    budget: manager(req.agent?.role) ? { ...await narrationBudgetUsage(), dailyChars: narrationLimits(config).dailyChars, dailyGenerations: narrationLimits(config).dailyGenerations } : undefined,
    samples: (await readyVoiceSamples(config)).map(({ voiceId, lang }) => ({ voiceId, lang })),
    mix: { hasMaster: !!p.videoMasterStorageKey, error: manager(req.agent?.role) ? p.videoMasterMixError ?? null : null,
      // 14.11.2026: агент видит, что новая озвучка на вышедший ролик не легла, а не только руководство в журнале.
      problem: p.videoMasterMixError && p.videoMasterMixErrorVersionId && p.videoMasterMixErrorVersionId === versions[0]?.id
        ? (p.videoMasterMixError.includes(NARRATION_VOICE_LONGER_MARK) ? "VOICE_LONGER" as const : "FAILED" as const) : null },
    quotaExceeded: manager(req.agent?.role) ? !!await narrationQuotaExceededSince() : undefined });
});

narrationRouter.post("/:id/narration", async (req, res) => {
  if (req.agent!.role === "EDITOR") return res.status(403).json({ error: "Монтажёр получает подтверждённую озвучку" });
  const parsed = narrationDraftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Некорректный текст или версия", details: parsed.error.flatten() });
  const p = res.locals.narrationProperty;
  const { config } = await configuration();
  if (parsed.data.voiceId && !config.voices.some((v) => v.id === parsed.data.voiceId)) return res.status(400).json({ error: "Выберите голос из настроек" });
  if (parsed.data.generate) {
    // Правка агента при автоозвучке: новая версия сразу в очередь генерации (та же дверь, тот же потолок).
    if (!narrationAutoEnabled(config)) return res.status(409).json({ error: "Автоозвучка выключена в настройках. Сохраните текст без генерации." });
    const outcome = await requestAutoNarration({ propertyId: p.id, actorId: req.agent!.id, source: "AGENT", script: parsed.data.script, templateId: parsed.data.templateId,
      voiceId: parsed.data.voiceId, expectedRevision: parsed.data.expectedRevision, requestKey: parsed.data.requestKey, debounceMs: 0 });
    if (outcome.status === "INVALID") return res.status(400).json({ error: outcome.error });
    if (outcome.status === "DISABLED") return res.status(409).json({ error: "Для объекта выбрано «Без озвучки». Сначала включите озвучку." });
    if (outcome.status !== "QUEUED") return res.status(409).json({ error: outcome.status === "BUSY" ? "Предыдущая озвучка ещё готовится. Попробуйте через минуту." : "Версия изменилась. Обновите карточку." });
    return res.status(201).json({ id: outcome.versionId, revision: outcome.revision, queued: true });
  }
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

/**
 * ОДНА ДВЕРЬ ОДОБРЕНИЯ (11.11.2026), два случая:
 * - черновой текст прежнего пути (DRAFT) подтверждает маркетинг или руководство — перед платной кнопкой;
 * - готовое аудио автоозвучки (READY, source ≠ MANUAL) одобряет агент объекта — после этого
 *   монтажёр получает его существующим путём lib/narrationDelivery.ts. Ту же функцию зовёт Шабнам.
 */
narrationRouter.post("/:id/narration/:versionId/approve", async (req, res) => {
  if (req.agent!.role === "EDITOR") return res.status(403).json({ error: "Озвучку одобряет агент объекта" });
  const parsed = narrationActionSchema.safeParse(req.body), versionId = idSchema.safeParse(req.params.versionId);
  if (!parsed.success || !versionId.success) return res.status(400).json({ error: "Подтвердите текст и номер версии" });
  const p = res.locals.narrationProperty;
  const outcome = await approveNarrationVersion({ propertyId: p.id, versionId: versionId.data, expectedRevision: parsed.data.expectedRevision, actorId: req.agent!.id, isManager: manager(req.agent?.role), actorRole: req.agent!.role });
  if (outcome === "FORBIDDEN") return res.status(403).json({ error: "Эту озвучку одобряет маркетинг, руководство или владелец" });
  if (outcome === "CONFLICT") return res.status(409).json({ error: "Факты или версия изменились. Подготовьте и проверьте новый текст." });
  res.json({ ok: true, ...(outcome === "AUDIO_APPROVED" ? { delivery: await afterNarrationApproved(p.id, versionId.data) } : {}) });
});

/**
 * «БЕЗ ОЗВУЧКИ» / «ВКЛЮЧИТЬ ОЗВУЧКУ» (12.11.2026). Та же дверь, что у мастеров CRM и Шабнам
 * (lib/narrationOptOut.ts). Включили при автоозвучке — новая версия сразу в очередь генерации.
 */
narrationRouter.post("/:id/narration/mode", async (req, res) => {
  if (req.agent!.role === "EDITOR") return res.status(403).json({ error: "Озвучку объекта выбирает агент" });
  const parsed = narrationModeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Укажите, нужна ли озвучка" });
  const p = res.locals.narrationProperty;
  const change = await setPropertyNarrationOff(p.id, parsed.data.off, req.agent!.id);
  if (!change) return res.status(404).json({ error: "Объект не найден" });
  if (parsed.data.off) {
    if (change.changed && change.heldByMontajer) void tellMontajerNarrationOff(change.shortId);
    return res.json({ off: true, message: "Озвучка выключена. Монтажёр получит пометку «без озвучки»." });
  }
  const { config } = await configuration();
  if (!narrationAutoEnabled(config)) return res.json({ off: false, message: "Озвучка включена. Автоозвучка выключена в настройках, подготовить её можно ниже." });
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: p.id }, orderBy: { revision: "desc" }, select: { revision: true, factsHash: true, status: true } });
  if (latest && narrationFactsCurrent(latest, p) && latest.status !== "FAILED") return res.json({ off: false, message: "Озвучка включена." });
  const outcome = await requestAutoNarration({ propertyId: p.id, actorId: req.agent!.id, source: "AGENT", expectedRevision: latest?.revision ?? 0, debounceMs: 0 });
  res.json({ off: false, queued: outcome.status === "QUEUED", message: outcome.status === "QUEUED" ? "Озвучка включена. Придёт вам на прослушивание через минуту-две." : "Озвучка включена." });
});

async function tellMontajerNarrationOff(shortId: number): Promise<void> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  const editor = settings?.videoMontajerAgentId ? await prisma.agent.findUnique({ where: { id: settings.videoMontajerAgentId }, select: { telegramChatId: true, isActive: true } }) : null;
  if (!editor?.isActive || !editor.telegramChatId) return;
  await sendToMontajer(editor.telegramChatId, `Объект №${shortId}: агент выбрал «Без озвучки» — голос в ролик не нужен.`, { copy: true, propertyShortId: shortId }).catch(() => {});
}

narrationRouter.post("/:id/narration/:versionId/generate", async (req, res) => {
  if (!manager(req.agent?.role)) return res.status(403).json({ error: "Генерация доступна маркетингу и руководству" });
  const parsed = narrationActionSchema.safeParse(req.body), versionId = idSchema.safeParse(req.params.versionId);
  if (!parsed.success || !versionId.success) return res.status(400).json({ error: "Подтвердите генерацию выбранной версии" });
  const p = res.locals.narrationProperty, { config, key } = await configuration();
  if (!key || !narrationProviderReady(config, key)) return res.status(409).json({ error: "ElevenLabs не настроен. Добавьте ключ, модель и голоса в настройках." });
  const outcome = await generateNarrationVersion({ propertyId: p.id, versionId: versionId.data, expectedRevision: parsed.data.expectedRevision, requireApproval: true, config, key });
  switch (outcome.status) {
    case "REJECTED": return res.status(409).json({ error: "Проверьте актуальность текста и голоса. Предыдущий запрос с неизвестным результатом требует проверки провайдера." });
    case "BUDGET": return res.status(429).json({ error: "Дневной предел озвучки исчерпан. Его меняет руководство в настройках озвучки." });
    case "ALREADY": return res.status(outcome.current === "READY" ? 200 : 409).json({ status: outcome.current, error: outcome.current === "READY" ? undefined : "Запрос уже выполнялся. Автоматический повтор отключён." });
    case "FAILED": case "UNKNOWN":
      if (!outcome.recorded) return res.status(409).json({ error: "Результат уже проверен руководством. Поздний ответ не изменил решение." });
      if (outcome.errorCode === NARRATION_QUOTA_EXCEEDED) return res.status(402).json({ status: outcome.status, error: "Кредиты ElevenLabs закончились. Деньги не списаны; после пополнения подготовьте новую версию." });
      return res.status(502).json({ status: outcome.status, error: "Озвучка не получена. Повтор не выполнялся; проверьте результат в ElevenLabs." });
    case "LATE": return res.status(409).json({ error: "Пришёл поздний результат генерации. Решение руководства сохранено; новая готовая версия не объявлялась." });
    case "PERSIST_FAILED": return res.status(503).json({ error: "Провайдер создал аудио, но сохранить его не удалось. Повторная генерация заблокирована." });
    case "GONE": return res.status(409).json({ error: "Объект уже удалён. Озвучка недоступна." });
    case "READY": return res.json({ status: "READY", propertyTrashed: outcome.propertyTrashed,
      ...(outcome.propertyTrashed ? { message: "Объект в Корзине. Озвучка сохранена в истории, передача недоступна до восстановления." } : {}) });
  }
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
  if (!row || latest?.id !== row.id || !narrationFactsCurrent(row, p)) return res.status(409).json({ error: "Нужна готовая актуальная озвучка" });
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
  const [rows, deliveryRows] = await Promise.all([
    preparePublicationMetadataPreview(p.id),
    listPriceCaptionDelivery(p.id),
  ]);
  res.json({ rows, deliveryRows, sent: false });
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
