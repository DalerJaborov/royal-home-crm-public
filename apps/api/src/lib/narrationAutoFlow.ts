import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  hasVideoHistory, narrationDraftText, narrationLimits, narrationMixByCrm, narrationModelSupportsTajik, narrationWizardChoiceSchema, pickNarrationTemplate, pickNarrationVoice,
  type NarrationConfig, type NarrationFacts, type NarrationWizardChoice,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { videoHandoffDir } from "../upload.js";
import { legacyHandoffCoverPath } from "./diskCleanup.js";
import { mixFromStoredMaster } from "./narrationMaster.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { EDITOR_HOLDER_WHERE, isHandoffPublishRunning, schedulePublishAfterAccept, withPropertyLock } from "./videoHandoff.js";
import { mediaExecutionMode } from "./mediaExecution.js";
import { logAgentAudit } from "./audit.js";
import { sendBackToMontajer } from "./publishedVideoFix.js";
import { prepareNarrationDeliveryPlan } from "./narrationDelivery.js";
import { generateNarrationVersion, loadNarrationConfiguration, narrationProviderReady, narrationQuotaExceededSince, NARRATION_QUOTA_PAUSE_MS } from "./narrationGeneration.js";
import { NARRATION_QUOTA_EXCEEDED } from "./propertyNarration.js";
import { narrationFacts, narrationFactsCurrent, narrationHash, narrationScriptError } from "./propertyNarration.js";
import { logSystemError } from "./systemError.js";
import { NARRATION_CLOSED_STATUSES as CLOSED_STATUSES, retireNarrationsOfClosedProperties, setPropertyNarrationOff } from "./narrationOptOut.js";
import { narrationLastChoiceFor, rememberNarrationChoice } from "./narrationLastChoice.js";
import { VOICELESS_COPY_HINT } from "./narrationMontajerNote.js";
import { sendToMontajer } from "./montageObservers.js";
import { ELEVENLABS_QUOTA_ALARM_TAG, raiseCriticalAlarm } from "./channelKeyAlarm.js";

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
 * 4. Поменялись факты озвучки (вид, комнаты, площадь, этаж, район, цена) любым путём —
 *    CRM, Шабнам, импорт — обход замечает расхождение хэша и готовит новую версию.
 *    Несколько правок подряд сливаются в одну версию: пауза `debounceMinutes`
 *    сдвигается с каждой правкой. Шаблон и голос те же, что агент уже одобрял, —
 *    версия одобряется сама (autoApproveSameChoice), иначе ждёт агента.
 * 5. Ролик уже вышел (11.11.2026, владелец: «где просто меняется звук и описание нам
 *    монтажёр не нужен»): есть ролик без голоса (мастер) — CRM сама перемикширует и
 *    заменит вышедший ролик (remixFromMaster); голос вклеен монтажёром — прежний возврат
 *    NARRATION_CHANGED, монтажёр присылает тот же ролик без голоса, дальше без него.
 *
 * Всё платное — под рубильником `autoGenerate` в настройках озвучки (по умолчанию
 * выключен) и дневным потолком; отправка монтажёру — под CRM_NARRATION_EXECUTION_MODE.
 */

/** BACKFILL (12.11.2026) — разовый проход по очереди монтажа: одобряет владелец, не агент. */
export type AutoNarrationSource = "WIZARD" | "AUTO" | "AGENT" | "BACKFILL";
export type AutoNarrationOutcome =
  | { status: "QUEUED"; versionId: string; revision: number; coalesced: boolean }
  /** DISABLED — у объекта выбрано «Без озвучки» (12.11.2026). */
  | { status: "UNCHANGED" | "BUSY" | "CONFLICT" | "OFF" | "GONE" | "DISABLED" }
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
  const outcome = await prisma.$transaction(async (tx): Promise<AutoNarrationOutcome> => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${input.propertyId} FOR UPDATE`;
    const property = await tx.property.findUnique({ where: { id: input.propertyId }, include: { district: true } });
    if (!property || property.deletedAt) return { status: "GONE" };
    // «Без озвучки» — ни черновика, ни денег; включают обратно из карточки (lib/narrationOptOut.ts).
    if (property.narrationOff) return { status: "DISABLED" };
    // Проданный или снятый объект сам новую озвучку не получает (агент может попросить явно).
    if (input.source !== "AGENT" && (CLOSED_STATUSES as readonly string[]).includes(property.status)) return { status: "GONE" };
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
    if (input.source === "AUTO" && latest && narrationFactsCurrent(latest, property) && latest.source !== "MANUAL") return { status: "UNCHANGED" };
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
  // Сотрудник сам выбрал голос или шаблон — запоминаем на нём (lib/narrationLastChoice.ts).
  if (outcome.status === "QUEUED" && (input.source === "WIZARD" || input.source === "AGENT") && (input.voiceId || input.templateId)) {
    await rememberNarrationChoice(input.actorId, { voiceId: input.voiceId, templateId: input.templateId }).catch(() => {});
  }
  return outcome;
}

/** Конец мастера CRM и Шабнам (через createProperty). Никогда не роняет создание объекта. */
export async function startNarrationForNewProperty(propertyId: string, actorId: string, rawChoice?: unknown): Promise<AutoNarrationOutcome | null> {
  try {
    const parsed = narrationWizardChoiceSchema.safeParse(rawChoice ?? {});
    const choice: NarrationWizardChoice = parsed.success ? parsed.data : {};
    // «Без озвучки» в мастере (12.11.2026): флаг на объекте, генерации нет вовсе.
    if (choice.none) {
      await setPropertyNarrationOff(propertyId, true, actorId);
      return { status: "DISABLED" };
    }
    // Не выбрал голос или шаблон — ставим его последний выбор (если он ещё в настройках).
    const { config } = await loadNarrationConfiguration();
    const last = await narrationLastChoiceFor(actorId, config);
    const filled = { ...choice, voiceId: choice.voiceId ?? last.voiceId, templateId: choice.templateId ?? (choice.script ? undefined : last.templateId) };
    let outcome = await requestAutoNarration({ propertyId, actorId, source: "WIZARD", ...filled, debounceMs: 0, config });
    // Текст агента не прошёл проверку (например, вписал цену) — озвучка всё равно готовится по шаблону.
    if (outcome.status === "INVALID" && choice.script) outcome = await requestAutoNarration({ propertyId, actorId, source: "WIZARD", templateId: filled.templateId ?? last.templateId, voiceId: filled.voiceId, debounceMs: 0, config });
    return outcome;
  } catch (err) {
    void logSystemError("api", `Автоозвучка после создания объекта не поставлена: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-start-failed" });
    return null;
  }
}

export type NarrationApproval = "FORBIDDEN" | "CONFLICT" | "TEXT_APPROVED" | "AUDIO_APPROVED";
/** Кто одобряет озвучку разового прохода по очереди монтажа (решение владельца 12.11.2026). */
export const NARRATION_OWNER_ROLES = ["DIRECTOR", "ADMIN"] as const;
export function isNarrationOwnerRole(role: string | null | undefined): boolean {
  return (NARRATION_OWNER_ROLES as readonly string[]).includes(role ?? "");
}

/** ОДНА функция одобрения: маршрут approve и кнопка Шабнам. Права на объект проверяет вызывающий.
 *  Озвучку разового прохода (BACKFILL) одобряет только владелец (директор или администратор). */
export async function approveNarrationVersion(input: { propertyId: string; versionId: string; expectedRevision: number; actorId: string; isManager: boolean; actorRole?: string }): Promise<NarrationApproval> {
  return prisma.$transaction(async (tx): Promise<NarrationApproval> => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${input.propertyId} FOR UPDATE`;
    const current = await tx.property.findUniqueOrThrow({ where: { id: input.propertyId }, include: { district: true } });
    const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: input.propertyId }, orderBy: { revision: "desc" } });
    if (current.deletedAt || !latest || latest.id !== input.versionId || latest.revision !== input.expectedRevision || !narrationFactsCurrent(latest, current)) return "CONFLICT";
    if (latest.status === "DRAFT") {
      if (!input.isManager) return "FORBIDDEN";
      return (await tx.propertyNarrationVersion.updateMany({ where: { id: latest.id, status: "DRAFT" }, data: { approvedAt: new Date(), approvedById: input.actorId } })).count ? "TEXT_APPROVED" : "CONFLICT";
    }
    if (latest.status !== "READY" || (latest.source ?? "MANUAL") === "MANUAL") return input.isManager ? "CONFLICT" : "FORBIDDEN";
    if (latest.source === "BACKFILL" && !isNarrationOwnerRole(input.actorRole)) return "FORBIDDEN";
    if (latest.approvedAt) return "AUDIO_APPROVED";
    return (await tx.propertyNarrationVersion.updateMany({ where: { id: latest.id, status: "READY", approvedAt: null }, data: { approvedAt: new Date(), approvedById: input.actorId } })).count ? "AUDIO_APPROVED" : "CONFLICT";
  });
}

/** ADD_VOICE (12.11.2026) — ролик сдан раньше, чем одобрили озвучку, и ещё не вышел: он
 *  возвращается монтажёру «вклейте голос», музыку и монтаж не трогать. */
export type NarrationDeliveryStart = "QUEUED" | "PREVIEW" | "WAITING_FOR_MONTAGE" | "BUSY" | "ALREADY" | "NOT_READY" | "SOUND_REMAKE" | "CRM_REMIX" | "ADD_VOICE" | "DISABLED";
/**
 * Одобренное аудио — монтажёру существующим путём. Объект ещё не в очереди монтажа —
 * обход повторит, когда он туда попадёт. Ключ запроса постоянный: повтор не плодит передач.
 */
export async function afterNarrationApproved(propertyId: string, versionId: string): Promise<NarrationDeliveryStart> {
  if ((await prisma.property.findUnique({ where: { id: propertyId }, select: { narrationOff: true } }))?.narrationOff) return "DISABLED";
  let prepared: Awaited<ReturnType<typeof prepareNarrationDeliveryPlan>>;
  try { prepared = await prepareNarrationDeliveryPlan(propertyId, versionId, "AUDIO_ONLY"); }
  catch {
    // Объект не у монтажёра. Есть ролик без голоса — CRM сама наложит новую озвучку и заменит
    // вышедший ролик (обход remixFromMasters, в течение минуты); монтажёр не нужен.
    if (await crmRemixApplies(propertyId)) return "CRM_REMIX";
    // Голос вклеен монтажёром: ролик вышел со старой озвучкой — заменить только голос.
    const remake = await requestNarrationSoundRemake(propertyId, versionId);
    if (remake === "QUEUED") return "SOUND_REMAKE";
    // Ролик сдан без голоса раньше одобрения и ещё не вышел — вернуть «вклейте голос».
    if (remake === "NO_OLD_NARRATION" && (await requestNarrationAddVoice(propertyId, versionId)) === "QUEUED") return "ADD_VOICE";
    return "WAITING_FOR_MONTAGE";
  }
  // PREVIEW (ревью 12.11.2026): строку «передано» не заводим — иначе после включения LIVE обход
  // счёл бы версию отправленной и mp3 до монтажёра не дошёл бы. Одобренная версия ждёт LIVE.
  if (mediaExecutionMode("NARRATION") !== "LIVE") return "PREVIEW";
  const requestKey = `auto:${versionId}:${prepared.editorId}`;
  return prisma.$transaction(async (tx): Promise<NarrationDeliveryStart> => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${propertyId} FOR UPDATE`;
    const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" } });
    if (!latest || latest.id !== versionId || latest.status !== "READY" || !latest.approvedAt) return "NOT_READY";
    if (await tx.propertyNarrationDelivery.count({ where: { propertyId, versionId, editorId: prepared.editorId, mode: "AUDIO_ONLY", status: { in: ["SENT", "CANCELLED"] } } })) return "ALREADY";
    if (await tx.propertyNarrationDelivery.count({ where: { propertyId, status: { in: ["QUEUED", "SENDING", "UNKNOWN"] } } })) return "BUSY";
    const existing = await tx.propertyNarrationDelivery.findUnique({ where: { requestKey } });
    // Строка, заведённая в PREVIEW до этой правки, — досылаем ею же, а не считаем «уже отправлено».
    if (existing?.status === "PREVIEW") {
      await tx.propertyNarrationDelivery.update({ where: { id: existing.id }, data: { plan: prepared.plan, status: "QUEUED", executionMode: "LIVE", lastError: null } });
      return "QUEUED";
    }
    if (existing) return "ALREADY";
    await tx.propertyNarrationDelivery.create({ data: { propertyId, versionId, editorId: prepared.editorId, mode: "AUDIO_ONLY", requestKey,
      createdById: latest.approvedById ?? "system", plan: prepared.plan, status: "QUEUED", executionMode: "LIVE" } });
    return "QUEUED";
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
export async function requestNarrationSoundRemake(propertyId: string, versionId: string, opts: { voiceLonger?: boolean } = {}): Promise<NarrationSoundRemake> {
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
  // С 11.11.2026 голос накладывает CRM: монтажёр присылает тот же ролик без голоса — дальше смена
  // цены обходится без него (remixFromMaster). Рубильник выключен — по-старому, звук меняет он.
  const mixByCrm = narrationMixByCrm((await loadNarrationConfiguration()).config);
  const longer = opts.voiceLonger ? " Новая озвучка длиннее ролика: удлините ролик под голос." : "";
  const sent = await sendBackToMontajer(propertyId, version.approvedById, "NARRATION_CHANGED", mixByCrm
    ? `Новая озвучка, версия ${version.revision}: монтаж и кадры прежние.${longer} Пришлите тот же ролик БЕЗ голоса (музыка и звуки можно) — голос CRM наложит сама. Аудио придёт следом, для длины.`
    : `Новая озвучка, версия ${version.revision}: замените в ролике только голос, музыку и монтаж не трогайте.${longer} Новый mp3 придёт следом. При сдаче пришлите и тот же ролик без голоса — дальше смену цены CRM сделает сама.`, null, { removeFromSocial: "on-new-video" });
  if (!sent.ok) {
    void logSystemError("api", `Озвучка: замена звука в ролике не поставлена: ${sent.error}`, { dedupKey: `narration-sound-remake:${versionId}` });
    return "REFUSED";
  }
  logAgentAudit(version.approvedById, "PROPERTY_SENT_BACK_TO_MONTAJER", "Property", propertyId, { reason: "NARRATION_CHANGED", narrationVersionId: versionId, queued: sent.queued, source: "narration-approval" });
  return "QUEUED";
}

/**
 * «ВКЛЕЙТЕ ГОЛОС» (12.11.2026): монтажёр сдал ролик раньше, чем агент (или владелец) одобрил
 * озвучку, и ролик ещё не вышел — без этого он ушёл бы в сети без голоса навсегда. Тот же
 * возврат монтажёру, что у замены звука (NARRATION_CHANGED, не брак), без снятия постов (их нет).
 * Вышедший ролик без голоса сам не возвращается: это решение владельца (волна перемонтажа).
 */
export async function requestNarrationAddVoice(propertyId: string, versionId: string): Promise<"QUEUED" | "SKIPPED" | "REFUSED"> {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return "SKIPPED";
  const [p, version, everSent] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, select: { shortId: true, deletedAt: true, status: true, narrationOff: true, videoHandoffStatus: true, publishedChannels: true, instagramUrl: true } }),
    prisma.propertyNarrationVersion.findUnique({ where: { id: versionId }, select: { status: true, approvedAt: true, approvedById: true, revision: true } }),
    prisma.propertyNarrationDelivery.count({ where: { propertyId, status: "SENT" } }),
  ]);
  if (!p || p.deletedAt || p.narrationOff || (CLOSED_STATUSES as readonly string[]).includes(p.status) || p.videoHandoffStatus !== "RECEIVED") return "SKIPPED";
  if ((p.publishedChannels?.length ?? 0) > 0 || p.instagramUrl || everSent > 0) return "SKIPPED";
  if (!version || version.status !== "READY" || !version.approvedAt || !version.approvedById) return "SKIPPED";
  const sent = await sendBackToMontajer(propertyId, version.approvedById, "NARRATION_CHANGED",
    `Озвучка к ролику №${p.shortId} пришла после сдачи: вклейте голос в этот ролик, музыку и монтаж не трогайте. mp3 придёт следом. ${VOICELESS_COPY_HINT}`, null, {});
  if (!sent.ok) {
    void logSystemError("api", `Озвучка: возврат «вклейте голос» не поставлен: ${sent.error}`, { dedupKey: `narration-add-voice:${versionId}` });
    return "REFUSED";
  }
  logAgentAudit(version.approvedById, "PROPERTY_SENT_BACK_TO_MONTAJER", "Property", propertyId, { reason: "NARRATION_CHANGED", narrationVersionId: versionId, source: "narration-add-voice" });
  return "QUEUED";
}

/** Перемикс из мастера возможен: отправка включена, у объекта есть ролик без голоса, он не у монтажёра. */
async function crmRemixApplies(propertyId: string): Promise<boolean> {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return false;
  const p = await prisma.property.findUnique({ where: { id: propertyId }, select: { videoMasterStorageKey: true, videoHandoffStatus: true, deletedAt: true, narrationOff: true } });
  return !!p && !p.deletedAt && !p.narrationOff && !!p.videoMasterStorageKey && p.videoHandoffStatus === "RECEIVED";
}

/**
 * САМООДОБРЕНИЕ НОВОЙ ВЕРСИИ (11.11.2026, решение владельца). Поменялись факты (цена и т.п.),
 * а шаблон, голос и модель — те же, что у последней одобренной версии, и агент тогда не правил
 * текст руками: этот шаблон и голос он уже одобрял, а цену поменял сам. Тогда версия одобряется
 * на имя того же агента, без сообщения ему. Иначе — как раньше, на одобрение агенту.
 * Признак «руками не правил»: текст прошлой версии совпадает с её шаблоном по её фактам.
 * Владелец поправил сам шаблон — тоже расхождение и, значит, одобрение человеком.
 */
export async function autoApproveSameChoice(versionId: string, config: NarrationConfig): Promise<{ approvedById: string } | null> {
  return prisma.$transaction(async (tx) => {
    const v = await tx.propertyNarrationVersion.findUnique({ where: { id: versionId } });
    if (!v || v.source !== "AUTO" || v.status !== "READY" || v.approvedAt || !v.templateId) return null;
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${v.propertyId} FOR UPDATE`;
    const property = await tx.property.findUnique({ where: { id: v.propertyId }, include: { district: true } });
    const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: v.propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
    if (!property || property.deletedAt || latest?.id !== v.id) return null;
    const facts = narrationFacts(property);
    if (v.factsHash !== narrationHash(facts) || narrationDraftText(config, facts, v.templateId).text !== v.script) return null;
    const prev = await tx.propertyNarrationVersion.findFirst({
      where: { propertyId: v.propertyId, revision: { lt: v.revision }, status: "READY", approvedAt: { not: null } }, orderBy: { revision: "desc" },
    });
    if (!prev?.approvedById || prev.templateId !== v.templateId || prev.voiceId !== v.voiceId || prev.modelId !== v.modelId) return null;
    if (narrationDraftText(config, prev.factsSnapshot as NarrationFacts, prev.templateId).text !== prev.script) return null;
    const now = new Date();
    const done = await tx.propertyNarrationVersion.updateMany({ where: { id: v.id, status: "READY", approvedAt: null },
      data: { approvedAt: now, approvedById: prev.approvedById, approvalNotifiedAt: now } });
    return done.count ? { approvedById: prev.approvedById } : null;
  });
}

export type NarrationRemixOutcome = "REMIXED" | "SKIPPED" | "FAILED";
/**
 * ПЕРЕМИКС ИЗ РОЛИКА БЕЗ ГОЛОСА (11.11.2026). Новая одобренная озвучка, а у объекта есть мастер
 * и готовый ролик (RECEIVED): CRM сама сводит новый ролик (lib/narrationMix.ts) и ставит его на
 * обычную публикацию. Уже вышедшие посты меняются тем же механизмом, что у перемонтажа по цене
 * (VideoRemakeRequest NARRATION_CHANGED с replaceOldPostsOnPublish → replaceOldPostsBeforeRemakePublish
 * в задании публикации); подпись там же строится заново из текущих фактов. Монтажёру ничего.
 *
 * Идемпотентно: наложенная версия пишется в Property.videoMasterNarrationVersionId той же записью,
 * что и новый файл, под замком объекта и с условием «мастер и наложенная версия всё те же».
 * Повтор тика видит её и ничего не делает. Отказ ffmpeg — videoMasterMixError на эту версию и
 * одна строка logSystemError; вышедший ролик остаётся, повтор — только новой версией озвучки.
 */
/** Метка «CRM смешивает этот ролик» старше этого — брошена (процесс упал), можно снова. */
export const NARRATION_MIX_CLAIM_STALE_MS = 15 * 60_000;
export async function remixFromMaster(propertyId: string, now: Date = new Date()): Promise<NarrationRemixOutcome> {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return "SKIPPED";
  // Метку ставим, только когда сведение и правда нужно (повторное ревью): иначе каждый тик
  // трогал бы updatedAt всех объектов с роликом без голоса.
  if (!(await remixWanted(propertyId))) return "SKIPPED";
  // Замок на сам ролик (ревью 12.11.2026): ffmpeg идёт до 9 минут, а задача — раз в минуту с
  // пределом 170 с; следующий тик не запускает вторую копию сведения того же ролика.
  const claimedAt = now;
  const claim = await prisma.property.updateMany({
    where: { id: propertyId, OR: [{ videoMasterMixingAt: null }, { videoMasterMixingAt: { lt: new Date(now.getTime() - NARRATION_MIX_CLAIM_STALE_MS) } }] },
    data: { videoMasterMixingAt: claimedAt },
  });
  if (!claim.count) return "SKIPPED";
  try {
    return await remixFromMasterClaimed(propertyId);
  } finally {
    await prisma.property.updateMany({ where: { id: propertyId, videoMasterMixingAt: claimedAt }, data: { videoMasterMixingAt: null } }).catch(() => {});
  }
}

/** Нужно ли сводить ролик заново: одни условия и до метки, и после неё (там — свежим чтением). */
async function remixWanted(propertyId: string) {
  const p = await prisma.property.findUnique({ where: { id: propertyId }, include: { district: true } });
  if (!p || p.deletedAt || p.narrationOff || !p.videoMasterStorageKey || p.videoHandoffStatus !== "RECEIVED" || CLOSED_STATUSES.some((s) => s === p.status)) return null;
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" } });
  if (!latest || latest.status !== "READY" || !latest.approvedAt || !latest.storageKey || !narrationFactsCurrent(latest, p)) return null;
  if (latest.id === p.videoMasterNarrationVersionId || latest.id === p.videoMasterMixErrorVersionId) return null;
  if (await isHandoffPublishRunning(propertyId)) return null;
  return { p: { ...p, videoMasterStorageKey: p.videoMasterStorageKey }, latest: { ...latest, storageKey: latest.storageKey } };
}

async function remixFromMasterClaimed(propertyId: string): Promise<NarrationRemixOutcome> {
  const wanted = await remixWanted(propertyId);
  if (!wanted) return "SKIPPED";
  const { p, latest } = wanted;
  const requestedById = latest.approvedById ?? propertyOwnerAgentId(p);
  const masterKey = p.videoMasterStorageKey;
  const seenVersionId = p.videoMasterNarrationVersionId;
  const fail = async (error: string): Promise<NarrationRemixOutcome> => {
    await prisma.property.updateMany({ where: { id: propertyId, videoMasterStorageKey: masterKey, videoMasterNarrationVersionId: seenVersionId },
      data: { videoMasterMixError: error.slice(0, 500), videoMasterMixErrorVersionId: latest.id } });
    void logSystemError("video-handoff", `Объект №${p.shortId}: новая озвучка (версия ${latest.revision}) не наложена на ролик — ${error} Вышедший ролик остался прежним.`, { dedupKey: `narration-remix:${latest.id}` });
    return "FAILED";
  };
  if (!requestedById) return fail("у объекта нет ответственного агента.");
  const outName = `${propertyId}-${Date.now()}.mp4`;
  const outPath = path.join(videoHandoffDir, outName);
  const mixed = await mixFromStoredMaster({ masterKey, voiceKey: latest.storageKey, outPath });
  if (!mixed.ok && mixed.code === "VOICE_LONGER") {
    // Озвучка длиннее ролика без голоса (12.11.2026): обрезать голос нельзя — монтажёр удлинит
    // ролик и заменит голос. Отметка ошибки на версии не даёт тику повторять перемикс.
    const outcome = await fail(mixed.error);
    await requestNarrationSoundRemake(propertyId, latest.id, { voiceLonger: true }).catch((err) =>
      logSystemError("video-handoff", `Объект №${p.shortId}: возврат монтажёру «озвучка длиннее ролика» не поставлен: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-remix-longer:${latest.id}` }));
    return outcome;
  }
  if (!mixed.ok) return fail(mixed.error);
  const publicPath = `/uploads/handoff/${outName}`;
  let replaced: { oldFinal: string | null; reviewPending: boolean } | null;
  try {
    replaced = await withPropertyLock(propertyId, async (tx) => {
      const cur = await tx.property.findUnique({ where: { id: propertyId }, select: { deletedAt: true, videoHandoffStatus: true, videoHandoffFinalPath: true,
        videoMasterStorageKey: true, videoMasterNarrationVersionId: true, publishedChannels: true, instagramUrl: true, clipReviewStatus: true } });
      const stillLatest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
      if (!cur || cur.deletedAt || cur.videoHandoffStatus !== "RECEIVED" || cur.videoMasterStorageKey !== masterKey
        || cur.videoMasterNarrationVersionId !== seenVersionId || stillLatest?.id !== latest.id) return null;
      if (await isHandoffPublishRunning(propertyId, tx)) return null;
      const published = (cur.publishedChannels?.length ?? 0) > 0 || !!cur.instagramUrl;
      await tx.property.update({ where: { id: propertyId }, data: {
        videoHandoffFinalPath: publicPath, videoHandoffReceivedAt: new Date(), videoMasterNarrationVersionId: latest.id,
        videoMasterMixError: null, videoMasterMixErrorVersionId: null, scheduledPublishAt: null, scheduledPublishReason: null,
      } });
      // Недоделанный Reels прежнего ролика вышел бы рядом с новым (тот же шаг, что при приёме ролика).
      await tx.pendingInstagramContainer.updateMany({ where: { propertyId, status: "PENDING", kind: "REEL" },
        data: { status: "CANCELLED", resolvedAt: new Date(), error: "CRM наложила новую озвучку — Reels прежнего ролика отменён" } });
      if (published && !await tx.videoRemakeRequest.findFirst({ where: { propertyId, replaceOldPostsOnPublish: true, oldPostsReplacedAt: null }, select: { id: true } })) {
        await tx.videoRemakeRequest.create({ data: { propertyId, reason: "NARRATION_CHANGED", requestedById, replaceOldPostsOnPublish: true,
          comment: `Новая озвучка, версия ${latest.revision}: CRM наложила её сама, монтажёр не нужен.` } });
      }
      return { oldFinal: cur.videoHandoffFinalPath, reviewPending: cur.clipReviewStatus === "PENDING" };
    });
  } catch (err) {
    await fs.promises.unlink(outPath).catch(() => {});
    throw err;
  }
  if (!replaced) {
    await fs.promises.unlink(outPath).catch(() => {});
    return "SKIPPED";
  }
  if (replaced.oldFinal && replaced.oldFinal !== publicPath) {
    await fs.promises.unlink(path.join(videoHandoffDir, path.basename(replaced.oldFinal))).catch(() => {});
    await fs.promises.unlink(legacyHandoffCoverPath(replaced.oldFinal)).catch(() => {});
  }
  // Ролик на проверке модератора встанет на публикацию после «Одобрить», как обычно.
  const scheduled = replaced.reviewPending ? null : await schedulePublishAfterAccept(propertyId);
  logAgentAudit(requestedById, "PROPERTY_NARRATION_REMIXED", "Property", propertyId, { narrationVersionId: latest.id, revision: latest.revision,
    scheduledPublishAt: scheduled?.scheduledPublishAt?.toISOString() ?? null, notPublishingReason: scheduled?.notPublishingReason ?? null });
  return "REMIXED";
}

/**
 * КУРСОРЫ ОБХОДОВ (ревью 12.11.2026). Обход берёт порцию по id после курсора и сдвигает его;
 * короткая порция — круг пройден, со следующего тика сначала. Без этого объекты за первыми
 * 50/200 (отсортированными по одному и тому же признаку) не проверялись бы никогда. Курсор живёт
 * в памяти процесса задачи: после перезапуска круг начинается заново — лишь лишняя проверка.
 */
const sweepCursor: Record<"remix" | "facts", string | null> = { remix: null, facts: null };
export function resetNarrationSweepCursorsForTests(): void { sweepCursor.remix = null; sweepCursor.facts = null; }
let REMIX_BATCH = 50;
let FACTS_BATCH = 200;
export function setNarrationSweepBatchForTests(size: { remix?: number; facts?: number }): void {
  REMIX_BATCH = size.remix ?? 50; FACTS_BATCH = size.facts ?? 200;
}

async function remixFromMasters(): Promise<number> {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return 0;
  const rows = await prisma.property.findMany({ where: { deletedAt: null, narrationOff: false, videoMasterStorageKey: { not: null }, videoHandoffStatus: "RECEIVED",
    ...(sweepCursor.remix ? { id: { gt: sweepCursor.remix } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: REMIX_BATCH });
  let remixed = 0;
  const started = Date.now();
  let last: string | null = null;
  let stoppedEarly = false;
  for (const row of rows) {
    // Перекодирование ролика бывает долгим: остаток — следующему тику, а не за пределом крона (170 с).
    if (Date.now() - started > 90_000) { stoppedEarly = true; break; }
    try { if ((await remixFromMaster(row.id)) === "REMIXED") remixed++; }
    catch (err) { void logSystemError("video-handoff", `Озвучка: перемикс ролика упал: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-remix-crash" }); }
    last = row.id;
  }
  sweepCursor.remix = stoppedEarly || rows.length === REMIX_BATCH ? last ?? sweepCursor.remix : null;
  return remixed;
}

const DAY_MS = 86_400_000;
const GENERATION_WINDOW_MS = 60_000;
const RETRY_429_LIMIT = 3;

export type NarrationApprovalNotifier = (versionId: string) => Promise<void>;
/** Напоминания о неодобренной озвучке (telegram/assistantNarration.ts): число отправленных. */
export type NarrationApprovalReminder = (now: Date) => Promise<number>;

/** Задача `narration-auto-flow`: факты → черновик → генерация → одно сообщение агенту → монтажёру. */
export async function runNarrationAutoFlow(options: { notifyAgent?: NarrationApprovalNotifier; remindApprovals?: NarrationApprovalReminder; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const { config, key } = await loadNarrationConfiguration();
  const report = { retired: 0, backfilled: 0, drafted: 0, generated: 0, notified: 0, reminded: 0, delivered: 0, remixed: 0, editorDelay: 0 };
  // Проданный, снятый или удалённый объект: ждущая озвучка и передача гаснут (спутник не сиротеет).
  report.retired = await retireNarrationsOfClosedProperties();
  // В PREVIEW (отправка монтажёру выключена на сервере) автоозвучка не платит вовсе: аудио некуда
  // отдать, а кредиты списались бы (ревью 12.11.2026). Черновики ждут и уйдут, когда включат LIVE.
  if (narrationAutoEnabled(config) && key && narrationProviderReady(config, key) && mediaExecutionMode("NARRATION") === "LIVE") {
    // Разовый проход по очереди монтажа — только своим рубильником (по умолчанию выключен).
    if (config.backfillMontageQueue === true) report.backfilled = await backfillMontageQueue(config, now);
    report.drafted = await refreshNarrationDrafts(config, now);
    report.generated = await generateDueNarrations(config, key, now);
  }
  if (options.notifyAgent) report.notified = await notifyReadyNarrations(options.notifyAgent);
  if (options.remindApprovals) report.reminded = await options.remindApprovals(now).catch((err) => {
    void logSystemError("telegram", `Озвучка: напоминания об одобрении не ушли: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-approval-remind" });
    return 0;
  });
  report.delivered = await deliverApprovedNarrations();
  report.remixed = await remixFromMasters();
  report.editorDelay = await notifyEditorNarrationDelayed(now);
  return report;
}

/**
 * ОЗВУЧКА К РОЛИКАМ, КОТОРЫЕ УЖЕ В МОНТАЖЕ (12.11.2026, решение владельца). Объекты в очереди
 * монтажа и у монтажёра сейчас, у которых озвучки нет вовсе: CRM готовит её по шаблону и голосу
 * по умолчанию и шлёт на одобрение ВЛАДЕЛЬЦУ (поправка владельца: не агентам), после одобрения
 * mp3 уходит монтажёру обычной передачей. Проход идёт только при рубильнике
 * backfillMontageQueue (по умолчанию выключен, решение владельца 12.11) и
 * идемпотентен: условие «ни одной версии» — повтор ничего не задвоит. «Без озвучки» пропускает.
 * Бюджет и пауза при нулевых кредитах — общие (generateDueNarrations).
 */
export async function backfillMontageQueue(config: NarrationConfig, now: Date): Promise<number> {
  const rows = await prisma.property.findMany({
    where: { deletedAt: null, narrationOff: false, status: { notIn: [...CLOSED_STATUSES] }, videoHandoffStatus: { in: ["QUEUED", "SENT_TO_EDITOR"] }, videoHandoffManualSince: null, narrationVersions: { none: {} } },
    select: { id: true }, orderBy: [{ videoHandoffQueueOrder: "asc" }, { videoHandoffSentAt: "asc" }], take: 20,
  });
  let queued = 0;
  for (const row of rows) {
    const outcome = await requestAutoNarration({ propertyId: row.id, actorId: "system", source: "BACKFILL", config, now, debounceMs: 0 });
    if (outcome.status === "QUEUED") queued++;
  }
  return queued;
}

/**
 * «ОЗВУЧКА ЗАДЕРЖИВАЕТСЯ» МОНТАЖЁРУ (12.11.2026). Кредиты ElevenLabs кончились, а объект уже
 * у монтажёра без готовой озвучки: одна строка, один раз на версию — монтажёр не ждёт молча.
 */
async function notifyEditorNarrationDelayed(now: Date): Promise<number> {
  const since = await narrationQuotaExceededSince();
  if (!since || now.getTime() - since.getTime() > NARRATION_QUOTA_PAUSE_MS * 24) return 0;
  const holder = await prisma.property.findFirst({ where: { ...EDITOR_HOLDER_WHERE, narrationOff: false }, orderBy: { videoHandoffSentAt: "asc" }, select: { id: true, shortId: true } });
  if (!holder) return 0;
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: holder.id }, orderBy: { revision: "desc" }, select: { id: true, status: true, editorDelayNotifiedAt: true } });
  if (!latest || !["DRAFT", "GENERATING"].includes(latest.status) || latest.editorDelayNotifiedAt) return 0;
  const claimed = await prisma.propertyNarrationVersion.updateMany({ where: { id: latest.id, editorDelayNotifiedAt: null }, data: { editorDelayNotifiedAt: now } });
  if (!claimed.count) return 0;
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  const editor = settings?.videoMontajerAgentId ? await prisma.agent.findUnique({ where: { id: settings.videoMontajerAgentId }, select: { telegramChatId: true, isActive: true } }) : null;
  if (!editor?.isActive || !editor.telegramChatId) return 0;
  await sendToMontajer(editor.telegramChatId, `Объект №${holder.shortId}: озвучка задерживается, сервис озвучки на паузе. Монтируйте как обычно, mp3 придёт сюда отдельным файлом.`, { copy: false })
    .catch((err) => logSystemError("video-handoff", `Монтажёру «озвучка задерживается» не ушло: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-editor-delay" }));
  return 1;
}

export async function refreshNarrationDrafts(config: NarrationConfig, now: Date): Promise<number> {
  let drafted = 0;
  const owner = (p: { assignedAgentId: string | null; intakeAgentId: string | null; createdById: string | null }) => p.assignedAgentId ?? p.intakeAgentId ?? p.createdById ?? "system";
  // Правки за трое суток любым путём (CRM, Шабнам, импорт): хэш фактов разошёлся — новая версия.
  const changed = await prisma.property.findMany({
    where: { deletedAt: null, narrationOff: false, status: { notIn: [...CLOSED_STATUSES] }, updatedAt: { gte: new Date(now.getTime() - 3 * DAY_MS) }, narrationVersions: { some: {} },
      ...(sweepCursor.facts ? { id: { gt: sweepCursor.facts } } : {}) },
    include: { district: true, narrationVersions: { orderBy: { revision: "desc" }, take: 1 } }, orderBy: { id: "asc" }, take: FACTS_BATCH,
  });
  sweepCursor.facts = changed.length === FACTS_BATCH ? changed[changed.length - 1]!.id : null;
  for (const p of changed) {
    const latest = p.narrationVersions[0];
    if (!latest || narrationFactsCurrent(latest, p)) continue;
    const outcome = await requestAutoNarration({ propertyId: p.id, actorId: owner(p), source: "AUTO", config, now });
    if (outcome.status === "QUEUED") drafted++;
  }
  // Подстраховка: объект заведён мастером CRM или Шабнам за сутки, но озвучка не поставлена (сбой).
  // Заявки с сайта на модерации сюда не попадают (ревью 12.11.2026): только мастер и очередь монтажа.
  const fresh = await prisma.property.findMany({
    where: { deletedAt: null, narrationOff: false, status: { notIn: [...CLOSED_STATUSES] }, createdAt: { gte: new Date(now.getTime() - DAY_MS) }, narrationVersions: { none: {} },
      OR: [{ createdInCrmWizard: true }, { videoHandoffStatus: { in: ["QUEUED", "SENT_TO_EDITOR"] } }] },
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
    // Продан, снят, удалён или «Без озвучки» с момента черновика — не платим (12.11.2026).
    const owner = await prisma.property.findUnique({ where: { id: row.propertyId }, select: { deletedAt: true, status: true, narrationOff: true } });
    if (!owner || owner.deletedAt || owner.narrationOff || (CLOSED_STATUSES as readonly string[]).includes(owner.status)) {
      await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, status: "DRAFT" }, data: { generateAfter: null } });
      continue;
    }
    // Владелец сменил модель после черновика: берём текущую, иначе версия застряла бы навсегда.
    if (row.modelId !== config.modelId) await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, status: "DRAFT" }, data: { modelId: config.modelId } });
    const outcome = await generateNarrationVersion({ propertyId: row.propertyId, versionId: row.id, expectedRevision: row.revision, requireApproval: false, config, key, now });
    if (outcome.status === "READY") {
      generated++;
      // Шаблон и голос те же, что агент уже одобрял: одобряется сама, звук в ролике меняет CRM.
      const auto = await autoApproveSameChoice(row.id, config).catch(() => null);
      if (auto) {
        logAgentAudit(auto.approvedById, "PROPERTY_NARRATION_AUTO_APPROVED", "Property", row.propertyId, { narrationVersionId: row.id, revision: row.revision, source: "same-template-and-voice" });
        await afterNarrationApproved(row.propertyId, row.id).catch((err) =>
          logSystemError("api", `Озвучка: после самоодобрения передача не подготовлена: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-auto-approve-after" }));
      }
      continue;
    }
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
      // Срочная тревога директору (пуш «новая проблема» отключён с 02.10): без неё узнают по жалобе агента.
      void raiseCriticalAlarm({
        tag: ELEVENLABS_QUOTA_ALARM_TAG,
        title: "Кончились кредиты ElevenLabs",
        body: "Озвучка роликов остановлена: кредиты ElevenLabs закончились. Пополните баланс в кабинете ElevenLabs.",
      });
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
  const ready = await prisma.propertyNarrationVersion.findMany({ where: { status: "READY", approvedAt: null, approvalNotifiedAt: null, source: { not: "MANUAL" }, property: { deletedAt: null, narrationOff: false, status: { notIn: [...CLOSED_STATUSES] } } }, orderBy: { createdAt: "asc" }, take: 20, select: { id: true, propertyId: true } });
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
    // Строки PREVIEW (до LIVE) не считаются передачей: после включения LIVE mp3 досылается.
    where: { status: "READY", approvedAt: { not: null }, source: { not: "MANUAL" }, deliveries: { none: { status: { not: "PREVIEW" } } }, property: { deletedAt: null, narrationOff: false, status: { notIn: [...CLOSED_STATUSES] }, videoHandoffStatus: "SENT_TO_EDITOR" } },
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
