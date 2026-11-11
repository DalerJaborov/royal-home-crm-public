import { randomUUID } from "node:crypto";
import {
  hasVideoHistory, narrationDraftText, narrationLimits, narrationModelSupportsTajik, narrationWizardChoiceSchema, pickNarrationTemplate, pickNarrationVoice,
  type NarrationConfig, type NarrationWizardChoice,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { mediaExecutionMode } from "./mediaExecution.js";
import { logAgentAudit } from "./audit.js";
import { sendBackToMontajer } from "./publishedVideoFix.js";
import { prepareNarrationDeliveryPlan } from "./narrationDelivery.js";
import { generateNarrationVersion, loadNarrationConfiguration, narrationProviderReady, narrationQuotaExceededSince, NARRATION_QUOTA_PAUSE_MS } from "./narrationGeneration.js";
import { NARRATION_QUOTA_EXCEEDED } from "./propertyNarration.js";
import { narrationFacts, narrationHash, narrationScriptError } from "./propertyNarration.js";
import { logSystemError } from "./systemError.js";

/**
 * АВТООЗВУЧКА РОЛИКА ОБЪЕКТА (схема владельца 10.11.2026, сделано 11.11).
 *
 * 1. Конец мастера (CRM и Шабнам): агент видит текст из шаблона, может поправить,
 *    выбрать шаблон и голос; выбор приходит полем `narration` запроса создания.
 * 2. Сразу после создания — версия WIZARD с generateAfter = сейчас; задача
 *    `narration-auto-flow` (cron.ts) генерирует её через ту же дверь, что и кнопка
 *    маркетинга (lib/narrationGeneration.ts), и присылает агенту ОДНО сообщение
 *    на одобрение (CRM + Шабнам, telegram/assistantNarration.ts).
 * 3. Одобрение — существующий маршрут approve (или кнопка Шабнам, та же функция
 *    approveNarrationVersion); затем аудио уходит монтажёру существующим путём
 *    lib/narrationDelivery.ts (только озвучка: исходники монтажёр уже получил
 *    обычной очередью монтажа).
 * 4. Поменялись факты озвучки (вид, комнаты, площадь, этаж, район) любым путём —
 *    CRM, Шабнам, импорт — обход замечает расхождение хэша и готовит новую версию.
 *    Несколько правок подряд сливаются в одну версию: пауза `debounceMinutes`
 *    сдвигается с каждой правкой. Цены в озвучке нет, поэтому смена цены
 *    озвучку не трогает вовсе.
 * 5. Перемонтаж здесь не запускается никогда: он необратим и остаётся решением
 *    человека через существующую «Вернуть монтажёру» (lib/propertySendBack.ts).
 *    Если ролик уже смонтирован, агент получает об этом одну строку в сообщении.
 *
 * Всё платное — под рубильником `autoGenerate` в настройках озвучки (по умолчанию
 * выключен) и дневным потолком; отправка монтажёру — под CRM_NARRATION_EXECUTION_MODE.
 */

export type AutoNarrationSource = "WIZARD" | "AUTO" | "AGENT";
export type AutoNarrationOutcome =
  | { status: "QUEUED"; versionId: string; revision: number; coalesced: boolean }
  | { status: "UNCHANGED" | "BUSY" | "CONFLICT" | "OFF" | "GONE" }
  | { status: "INVALID"; error: string };

export function narrationAutoEnabled(config: NarrationConfig): boolean {
  return config.autoGenerate === true && !!config.modelId && config.voices.length > 0;
}

export async function requestAutoNarration(input: {
  propertyId: string; actorId: string; source: AutoNarrationSource;
  script?: string; templateId?: string; voiceId?: string;
  expectedRevision?: number; requestKey?: string; debounceMs?: number;
  config?: NarrationConfig; now?: Date;
}): Promise<AutoNarrationOutcome> {
  const config = input.config ?? (await loadNarrationConfiguration()).config;
  if (!narrationAutoEnabled(config)) return { status: "OFF" };
  if (input.voiceId && !config.voices.some((v) => v.id === input.voiceId)) return { status: "INVALID", error: "Выберите голос из настроек" };
  const now = input.now ?? new Date();
  const generateAfter = new Date(now.getTime() + (input.debounceMs ?? narrationLimits(config).debounceMs));
  return prisma.$transaction(async (tx): Promise<AutoNarrationOutcome> => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${input.propertyId} FOR UPDATE`;
    const property = await tx.property.findUnique({ where: { id: input.propertyId }, include: { district: true } });
    if (!property || property.deletedAt) return { status: "GONE" };
    if (input.requestKey) {
      const existing = await tx.propertyNarrationVersion.findUnique({ where: { requestKey: input.requestKey } });
      if (existing) return existing.propertyId === property.id && existing.createdById === input.actorId
        ? { status: "QUEUED", versionId: existing.id, revision: existing.revision, coalesced: true } : { status: "CONFLICT" };
    }
    const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: property.id }, orderBy: { revision: "desc" } });
    if (input.expectedRevision !== undefined && (latest?.revision ?? 0) !== input.expectedRevision) return { status: "CONFLICT" };
    if (latest && ["GENERATING", "UNKNOWN"].includes(latest.status)) return { status: "BUSY" };
    const facts = narrationFacts(property);
    const factsHash = narrationHash(facts);
    if (input.source === "AUTO" && latest && latest.factsHash === factsHash && latest.source !== "MANUAL") return { status: "UNCHANGED" };
    // Шаблон и голос переходят из прошлой версии: агент выбрал их один раз в мастере.
    const template = pickNarrationTemplate(config, input.templateId ?? latest?.templateId);
    const drafted = narrationDraftText(config, facts, template?.id);
    const script = input.script ?? drafted.text;
    const error = narrationScriptError(script);
    if (error) return { status: "INVALID", error };
    // Подстраховка к проверке настроек: таджикский текст не уходит в модель без таджикского.
    if (drafted.lang === "tg" && !narrationModelSupportsTajik(config.modelId)) return { status: "INVALID", error: "Модель озвучки не знает таджикского. Руководству: выберите eleven_v4 или eleven_v4_turbo в настройках." };
    const voiceId = pickNarrationVoice(config, input.voiceId ?? latest?.voiceId);
    if (!voiceId) return { status: "INVALID", error: "Голоса озвучки не настроены" };
    const data = { script, factsSnapshot: facts, factsHash, voiceId, modelId: config.modelId, templateId: drafted.templateId, language: drafted.lang, generateAfter };
    // Дребезг: несколько правок подряд правят одну ожидающую версию, пауза сдвигается.
    if (input.source === "AUTO" && latest && latest.status === "DRAFT" && !latest.approvedAt && latest.source !== "MANUAL" && latest.generateAfter) {
      await tx.propertyNarrationVersion.update({ where: { id: latest.id }, data });
      return { status: "QUEUED", versionId: latest.id, revision: latest.revision, coalesced: true };
    }
    await tx.propertyNarrationVersion.updateMany({ where: { propertyId: property.id, status: "DRAFT", generateAfter: { not: null } }, data: { generateAfter: null } });
    const created = await tx.propertyNarrationVersion.create({ data: { ...data, propertyId: property.id, revision: (latest?.revision ?? 0) + 1,
      createdById: input.actorId, requestKey: input.requestKey ?? randomUUID(), source: input.source } });
    return { status: "QUEUED", versionId: created.id, revision: created.revision, coalesced: false };
  });
}

/** Конец мастера CRM и Шабнам (через createProperty). Никогда не роняет создание объекта. */
export async function startNarrationForNewProperty(propertyId: string, actorId: string, rawChoice?: unknown): Promise<AutoNarrationOutcome | null> {
  try {
    const parsed = narrationWizardChoiceSchema.safeParse(rawChoice ?? {});
    const choice: NarrationWizardChoice = parsed.success ? parsed.data : {};
    let outcome = await requestAutoNarration({ propertyId, actorId, source: "WIZARD", ...choice, debounceMs: 0 });
    // Текст агента не прошёл проверку (например, вписал цену) — озвучка всё равно готовится по шаблону.
    if (outcome.status === "INVALID" && choice.script) outcome = await requestAutoNarration({ propertyId, actorId, source: "WIZARD", templateId: choice.templateId, voiceId: choice.voiceId, debounceMs: 0 });
    return outcome;
  } catch (err) {
    void logSystemError("api", `Автоозвучка после создания объекта не поставлена: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-start-failed" });
    return null;
  }
}

export type NarrationApproval = "FORBIDDEN" | "CONFLICT" | "TEXT_APPROVED" | "AUDIO_APPROVED";
/** ОДНА функция одобрения: маршрут approve и кнопка Шабнам. Права на объект проверяет вызывающий. */
export async function approveNarrationVersion(input: { propertyId: string; versionId: string; expectedRevision: number; actorId: string; isManager: boolean }): Promise<NarrationApproval> {
  return prisma.$transaction(async (tx): Promise<NarrationApproval> => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${input.propertyId} FOR UPDATE`;
    const current = await tx.property.findUniqueOrThrow({ where: { id: input.propertyId }, include: { district: true } });
    const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: input.propertyId }, orderBy: { revision: "desc" } });
    if (current.deletedAt || !latest || latest.id !== input.versionId || latest.revision !== input.expectedRevision || latest.factsHash !== narrationHash(narrationFacts(current))) return "CONFLICT";
    if (latest.status === "DRAFT") {
      if (!input.isManager) return "FORBIDDEN";
      return (await tx.propertyNarrationVersion.updateMany({ where: { id: latest.id, status: "DRAFT" }, data: { approvedAt: new Date(), approvedById: input.actorId } })).count ? "TEXT_APPROVED" : "CONFLICT";
    }
    if (latest.status !== "READY" || (latest.source ?? "MANUAL") === "MANUAL") return input.isManager ? "CONFLICT" : "FORBIDDEN";
    if (latest.approvedAt) return "AUDIO_APPROVED";
    return (await tx.propertyNarrationVersion.updateMany({ where: { id: latest.id, status: "READY", approvedAt: null }, data: { approvedAt: new Date(), approvedById: input.actorId } })).count ? "AUDIO_APPROVED" : "CONFLICT";
  });
}

export type NarrationDeliveryStart = "QUEUED" | "PREVIEW" | "WAITING_FOR_MONTAGE" | "BUSY" | "ALREADY" | "NOT_READY" | "SOUND_REMAKE";
/**
 * Одобренное аудио — монтажёру существующим путём. Объект ещё не в очереди монтажа —
 * обход повторит, когда он туда попадёт. Ключ запроса постоянный: повтор не плодит передач.
 */
export async function afterNarrationApproved(propertyId: string, versionId: string): Promise<NarrationDeliveryStart> {
  let prepared: Awaited<ReturnType<typeof prepareNarrationDeliveryPlan>>;
  try { prepared = await prepareNarrationDeliveryPlan(propertyId, versionId, "AUDIO_ONLY"); }
  catch {
    // Объект не у монтажёра. Если ролик уже вышел со старой озвучкой — заменить только звук.
    return (await requestNarrationSoundRemake(propertyId, versionId)) === "QUEUED" ? "SOUND_REMAKE" : "WAITING_FOR_MONTAGE";
  }
  const live = mediaExecutionMode("NARRATION") === "LIVE";
  const requestKey = `auto:${versionId}:${prepared.editorId}`;
  return prisma.$transaction(async (tx): Promise<NarrationDeliveryStart> => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${propertyId} FOR UPDATE`;
    const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" } });
    if (!latest || latest.id !== versionId || latest.status !== "READY" || !latest.approvedAt) return "NOT_READY";
    if (await tx.propertyNarrationDelivery.findUnique({ where: { requestKey } })) return "ALREADY";
    if (await tx.propertyNarrationDelivery.count({ where: { propertyId, versionId, editorId: prepared.editorId, mode: "AUDIO_ONLY", status: { in: ["PREVIEW", "SENT", "CANCELLED"] } } })) return "ALREADY";
    if (await tx.propertyNarrationDelivery.count({ where: { propertyId, status: { in: ["QUEUED", "SENDING", "UNKNOWN"] } } })) return "BUSY";
    await tx.propertyNarrationDelivery.create({ data: { propertyId, versionId, editorId: prepared.editorId, mode: "AUDIO_ONLY", requestKey,
      createdById: latest.approvedById ?? "system", plan: prepared.plan, status: live ? "QUEUED" : "PREVIEW", executionMode: live ? "LIVE" : "PREVIEW" } });
    return live ? "QUEUED" : "PREVIEW";
  });
}

export type NarrationSoundRemake = "QUEUED" | "OFF" | "IN_MONTAGE" | "NO_PUBLISHED_VIDEO" | "NO_OLD_NARRATION" | "NOT_APPROVED" | "REFUSED";
/**
 * «ЗАМЕНИТЬ ТОЛЬКО ЗВУК» (решение владельца 11.11.2026). Новая озвучка одобрена агентом, а
 * ролик со СТАРОЙ озвучкой уже вышел: объект уходит монтажёру существующим возвратом
 * `sendBackToMontajer` (lib/publishedVideoFix.ts) с причиной NARRATION_CHANGED — не брак монтажёра,
 * монтаж прежний. Старые посты снимаются, КОГДА ВЫЙДЕТ НОВЫЙ ролик (`removeFromSocial: "on-new-video"`,
 * тот же путь, что у перемонтажа по смене цены). Аудио монтажёр получит обычной передачей,
 * как только объект встанет у него (обход deliverApprovedNarrations).
 *
 * Права: одобрение агентом и есть согласие — так решил владелец. Поэтому зовём сам возврат, а не
 * обёртку кнопки (там после публикации — только руководство), и только с этой узкой причиной.
 * Без отправки по-настоящему (CRM_NARRATION_EXECUTION_MODE ≠ LIVE) ничего не делается: «старая
 * озвучка в ролике» значит, что прошлая версия была реально отправлена монтажёру (SENT).
 */
export async function requestNarrationSoundRemake(propertyId: string, versionId: string): Promise<NarrationSoundRemake> {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return "OFF";
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
  // Только самая новая версия: устаревшее одобрение звук не меняет.
  if (latest?.id !== versionId) return "NOT_APPROVED";
  const [property, version, oldSent] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, select: { videoHandoffStatus: true, videoHandoffFinalPath: true, publishedChannels: true, instagramUrl: true, status: true, deletedAt: true } }),
    prisma.propertyNarrationVersion.findUnique({ where: { id: versionId }, select: { status: true, approvedAt: true, approvedById: true, revision: true } }),
    prisma.propertyNarrationDelivery.count({ where: { propertyId, status: "SENT", versionId: { not: versionId } } }),
  ]);
  if (!property || property.deletedAt || !version || version.status !== "READY" || !version.approvedAt || !version.approvedById) return "NOT_APPROVED";
  if (property.videoHandoffStatus === "QUEUED" || property.videoHandoffStatus === "SENT_TO_EDITOR") return "IN_MONTAGE";
  if (!hasVideoHistory(property)) return "NO_PUBLISHED_VIDEO";
  if (!oldSent) return "NO_OLD_NARRATION";
  const sent = await sendBackToMontajer(propertyId, version.approvedById, "NARRATION_CHANGED",
    `Новая озвучка, версия ${version.revision}: замените только звук, монтаж и кадры прежние. Аудио придёт следом.`, null, { removeFromSocial: "on-new-video" });
  if (!sent.ok) {
    void logSystemError("api", `Озвучка: замена звука в ролике не поставлена: ${sent.error}`, { dedupKey: `narration-sound-remake:${versionId}` });
    return "REFUSED";
  }
  logAgentAudit(version.approvedById, "PROPERTY_SENT_BACK_TO_MONTAJER", "Property", propertyId, { reason: "NARRATION_CHANGED", narrationVersionId: versionId, queued: sent.queued, source: "narration-approval" });
  return "QUEUED";
}

const DAY_MS = 86_400_000;
const CLOSED_STATUSES = ["SOLD", "WITHDRAWN"] as const;
const GENERATION_WINDOW_MS = 60_000;
const RETRY_429_LIMIT = 3;

export type NarrationApprovalNotifier = (versionId: string) => Promise<void>;

/** Задача `narration-auto-flow`: факты → черновик → генерация → одно сообщение агенту → монтажёру. */
export async function runNarrationAutoFlow(options: { notifyAgent?: NarrationApprovalNotifier; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const { config, key } = await loadNarrationConfiguration();
  const report = { drafted: 0, generated: 0, notified: 0, delivered: 0 };
  if (narrationAutoEnabled(config) && key && narrationProviderReady(config, key)) {
    report.drafted = await refreshNarrationDrafts(config, now);
    report.generated = await generateDueNarrations(config, key, now);
  }
  if (options.notifyAgent) report.notified = await notifyReadyNarrations(options.notifyAgent);
  report.delivered = await deliverApprovedNarrations();
  return report;
}

async function refreshNarrationDrafts(config: NarrationConfig, now: Date): Promise<number> {
  let drafted = 0;
  const owner = (p: { assignedAgentId: string | null; intakeAgentId: string | null; createdById: string | null }) => p.assignedAgentId ?? p.intakeAgentId ?? p.createdById ?? "system";
  // Правки за трое суток любым путём (CRM, Шабнам, импорт): хэш фактов разошёлся — новая версия.
  const changed = await prisma.property.findMany({
    where: { deletedAt: null, status: { notIn: [...CLOSED_STATUSES] }, updatedAt: { gte: new Date(now.getTime() - 3 * DAY_MS) }, narrationVersions: { some: {} } },
    include: { district: true, narrationVersions: { orderBy: { revision: "desc" }, take: 1 } }, orderBy: { updatedAt: "asc" }, take: 200,
  });
  for (const p of changed) {
    const latest = p.narrationVersions[0];
    if (!latest || latest.factsHash === narrationHash(narrationFacts(p))) continue;
    const outcome = await requestAutoNarration({ propertyId: p.id, actorId: owner(p), source: "AUTO", config, now });
    if (outcome.status === "QUEUED") drafted++;
  }
  // Подстраховка: объект появился за сутки, но озвучка не поставлена (сбой или другой путь создания).
  const fresh = await prisma.property.findMany({
    where: { deletedAt: null, status: { notIn: [...CLOSED_STATUSES] }, createdAt: { gte: new Date(now.getTime() - DAY_MS) }, narrationVersions: { none: {} } },
    select: { id: true, assignedAgentId: true, intakeAgentId: true, createdById: true }, take: 50,
  });
  for (const p of fresh) {
    const outcome = await requestAutoNarration({ propertyId: p.id, actorId: owner(p), source: "AUTO", config, now, debounceMs: 0 });
    if (outcome.status === "QUEUED") drafted++;
  }
  return drafted;
}

async function generateDueNarrations(config: NarrationConfig, key: string, now: Date): Promise<number> {
  const started = Date.now();
  let generated = 0;
  // Кредиты кончились меньше часа назад — платный сервис не трогаем вовсе.
  const quotaSince = await narrationQuotaExceededSince();
  if (quotaSince && now.getTime() - quotaSince.getTime() < NARRATION_QUOTA_PAUSE_MS) return 0;
  const due = await prisma.propertyNarrationVersion.findMany({ where: { status: "DRAFT", generateAfter: { lte: now }, source: { not: "MANUAL" } }, orderBy: { generateAfter: "asc" }, take: 5 });
  for (const row of due) {
    if (Date.now() - started > GENERATION_WINDOW_MS) break;
    const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: row.propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
    if (latest?.id !== row.id) { await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, status: "DRAFT" }, data: { generateAfter: null } }); continue; }
    // Владелец сменил модель после черновика: берём текущую, иначе версия застряла бы навсегда.
    if (row.modelId !== config.modelId) await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, status: "DRAFT" }, data: { modelId: config.modelId } });
    const outcome = await generateNarrationVersion({ propertyId: row.propertyId, versionId: row.id, expectedRevision: row.revision, requireApproval: false, config, key, now });
    if (outcome.status === "READY") { generated++; continue; }
    if (outcome.status === "BUDGET") {
      void logSystemError("ai", "Озвучка роликов: дневной предел ElevenLabs исчерпан, остальные ждут следующих суток", { dedupKey: "narration-daily-budget" });
      break;
    }
    if (outcome.status === "REJECTED") {
      // Занято другой генерацией или голос убран из настроек: тихий повтор через 10 минут, не дольше трёх суток.
      const stale = now.getTime() - row.createdAt.getTime() > 3 * DAY_MS;
      await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, status: "DRAFT" }, data: { generateAfter: stale ? null : new Date(now.getTime() + 10 * 60_000) } });
      continue;
    }
    if (outcome.status === "FAILED" && outcome.errorCode === NARRATION_QUOTA_EXCEEDED) {
      void logSystemError("ai", "Озвучка роликов: кредиты ElevenLabs закончились. Озвучки ждут пополнения, проверка раз в час; агентам ничего не отправлено", { dedupKey: "narration-quota-exceeded" });
      break;
    }
    if (outcome.status === "FAILED" && outcome.errorCode === "PROVIDER_HTTP_429" && row.generationAttempts + 1 < RETRY_429_LIMIT) {
      // Сервис просит подождать: деньги не списаны, повтор без сообщений агенту.
      await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, status: "FAILED", errorCode: "PROVIDER_HTTP_429" },
        data: { status: "DRAFT", errorCode: null, generateAfter: new Date(now.getTime() + 15 * 60_000 * (row.generationAttempts + 1)) } });
      continue;
    }
    if (outcome.status === "FAILED" || outcome.status === "UNKNOWN" || outcome.status === "PERSIST_FAILED") {
      const code = "errorCode" in outcome ? outcome.errorCode : "AUDIO_PERSISTENCE_FAILED";
      void logSystemError("ai", `Озвучка объекта не получена (${code}). Автоповтора нет: ${outcome.status === "FAILED" ? "проверьте ключ, модель и голос" : "сверьте историю ElevenLabs в карточке объекта"}`, { dedupKey: `narration-failed:${row.id}` });
    }
  }
  return generated;
}

async function notifyReadyNarrations(notify: NarrationApprovalNotifier): Promise<number> {
  let notified = 0;
  const ready = await prisma.propertyNarrationVersion.findMany({ where: { status: "READY", approvedAt: null, approvalNotifiedAt: null, source: { not: "MANUAL" }, property: { deletedAt: null } }, orderBy: { createdAt: "asc" }, take: 20, select: { id: true, propertyId: true } });
  for (const row of ready) {
    // Отметка ДО отправки: два обхода подряд не пришлют агенту второе сообщение.
    const claimed = await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, approvalNotifiedAt: null }, data: { approvalNotifiedAt: new Date() } });
    if (!claimed.count) continue;
    const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: row.propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
    if (latest?.id !== row.id) continue;
    try { await notify(row.id); notified++; }
    catch (err) { void logSystemError("telegram", `Озвучка: запрос одобрения агенту не ушёл: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-approval-notify" }); }
  }
  return notified;
}

async function deliverApprovedNarrations(): Promise<number> {
  let delivered = 0;
  const approved = await prisma.propertyNarrationVersion.findMany({
    where: { status: "READY", approvedAt: { not: null }, source: { not: "MANUAL" }, deliveries: { none: {} }, property: { deletedAt: null, videoHandoffStatus: "SENT_TO_EDITOR" } },
    orderBy: { approvedAt: "asc" }, take: 20, select: { id: true, propertyId: true },
  });
  for (const row of approved) {
    try {
      const result = await afterNarrationApproved(row.propertyId, row.id);
      if (result === "QUEUED" || result === "PREVIEW") delivered++;
    } catch (err) {
      void logSystemError("api", `Озвучка: передача монтажёру не подготовлена: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-auto-delivery" });
    }
  }
  return delivered;
}
