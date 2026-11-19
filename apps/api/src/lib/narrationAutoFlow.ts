import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { narrationFitsType, narrationLengthCheck, narrationLengthLine, narrationTextOverlay,
  chooseNarration, hasVideoHistory, narrationDraftText, narrationLimits, narrationMixByCrm, narrationModelSupportsTajik, narrationWizardChoiceSchema, pickNarrationVoice,
  type NarrationConfig, type NarrationFacts, type NarrationWizardChoice,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { videoHandoffDir } from "../upload.js";
import { legacyHandoffCoverPath } from "./diskCleanup.js";
import { mixFromStoredMaster } from "./narrationMaster.js";
import { buildMusicBed, buildPictureBase, chooseMusicTrack, MUSIC_BASE_SOURCE, ownMusicReady } from "./narrationMusic.js";
import { dropNarrationMaster, storeNarrationMaster } from "./narrationMaster.js";
import { localVideoFilePath } from "./localVideoStorage.js";
import { loadMoneyContext } from "./money.js";
import { priceInTjsOnly } from "./reelsCaptionTemplate.js";
import os from "node:os";
import { mixNarrationOntoMaster, narrationFitNote, planNarrationFit, type NarrationMixResult } from "./narrationMix.js";
import { dropReplacedClipFiles, placeMixedClip, type PlacedMix } from "./narrationPreview.js";
import { clipCountsAsPublished } from "./publishedClip.js";
import { measuredNarrationCharsPerSec, narrationClipSec, narrationLengthCheckFor } from "./narrationLengthCalibration.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { EDITOR_HOLDER_WHERE, isHandoffPublishRunning, schedulePublishAfterAccept, withPropertyLock } from "./videoHandoff.js";
import { mediaExecutionMode } from "./mediaExecution.js";
import { logAgentAudit } from "./audit.js";
import { sendBackToMontajer } from "./publishedVideoFix.js";
import { NarrationDeliveryRefused, narrationDeliveryAttemptBudgetMs, narrationDeliveryRefusalIsExpected, narrationDeliveryStalled, prepareNarrationDeliveryPlan, type NarrationDeliveryRefusalCode } from "./narrationDelivery.js";
import { generateNarrationVersion, loadNarrationConfiguration, narrationProviderReady, narrationQuotaExceededSince, NARRATION_QUOTA_PAUSE_MS, speechChars } from "./narrationGeneration.js";
import { NARRATION_QUOTA_EXCEEDED } from "./propertyNarration.js";
import { narrationFacts, narrationFactsCurrent, narrationHash, narrationScriptError } from "./propertyNarration.js";
import { logSystemError } from "./systemError.js";
import { NARRATION_CLOSED_STATUSES as CLOSED_STATUSES, retireNarrationsOfClosedProperties, setPropertyNarrationOff } from "./narrationOptOut.js";
import { narrationLastChoiceFor, rememberNarrationChoice } from "./narrationLastChoice.js";
import { voicelessCopyHint } from "./narrationMontajerNote.js";
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
 *    Машинное отделение старого голоса (16.11.2026, сервис voice-separator) убрано 18.11.2026
 *    решением владельца: на проде ни разу не убрало голос. Ролика без голоса нет — СВОЯ МУЗЫКА
 *    (18.11.2026, lib/narrationMusic.ts): рубильник «Своя музыка при перемонтаже» включён и в библиотеке
 *    есть треки — со старого ролика снимается весь звук, кладётся случайный трек и новый голос
 *    (remixFromMaster, режим MUSIC). Рубильник выключен или треков нет — монтажёру, как раньше.
 * 6. Голос длиннее ролика (16.11.2026): ускорить до 15 % → другой, более короткий шаблон (одна
 *    перегенерация на версию) → стоп-кадр до 3 с → монтажёру (remixFromMasterClaimed).
 * 7. ОДНО УТВЕРЖДЕНИЕ (18.11.2026, владелец: «поменял, послушал, утвердил — и ролик сразу уходит»). Ролик уже
 *    вышел — новая озвучка без человека не утверждается (autoApproveSameChoice), а утверждённая сразу ложится
 *    на ролик и выходит: без «прослушать перед выпуском» и «оставить старый», мимо обычной сетки расписания
 *    (короткий промежуток своей очереди, ночью — утром, lib/publishSchedule.ts::nextNarrationSlot). Старые
 *    посты снимаются в каждой сети только после нового там же (lib/remakeOldPosts.ts).
 * 8. Длина до оплаты (18.11.2026): текст длиннее ролика не уходит в ElevenLabs вовсе — ни по кнопке агента
 *    (400 с понятной строкой), ни из обхода (версия «не получилась: длиннее ролика»), packages/shared/narrationLength.ts.
 *
 * Всё платное — под рубильником `autoGenerate` в настройках озвучки (по умолчанию
 * выключен) и дневным потолком; отправка монтажёру — под CRM_NARRATION_EXECUTION_MODE.
 */

/** BACKFILL (12.11.2026) — разовый проход по очереди монтажа: одобряет владелец, не агент. */
export type AutoNarrationSource = "WIZARD" | "AUTO" | "AGENT" | "BACKFILL";
export type AutoNarrationOutcome =
  | { status: "QUEUED"; versionId: string; revision: number; coalesced: boolean; templateId?: string | null; endingId?: string | null }
  /** DISABLED — у объекта выбрано «Без озвучки» (12.11.2026). */
  | { status: "UNCHANGED" | "BUSY" | "CONFLICT" | "OFF" | "GONE" | "DISABLED" }
  | { status: "INVALID"; error: string };

export function narrationAutoEnabled(config: NarrationConfig): boolean {
  return config.autoGenerate === true && !!config.modelId && config.voices.length > 0;
}

export async function requestAutoNarration(input: {
  propertyId: string; actorId: string; source: AutoNarrationSource;
  script?: string; templateId?: string; endingId?: string | null; voiceId?: string;
  /** Шаблон и концовка предвыбраны случайно и агентом не тронуты: в «последний выбор» не записываются. */
  templateAuto?: boolean;
  /** «Другой шаблон» (кнопка Шабнам): шаблон и концовка новые случайные, не равные прошлым. */
  reroll?: boolean;
  /** Прошлый выбор сотрудника: у нового объекта (прошлой версии нет) повторять его не надо. */
  avoid?: { templateId?: string | null; endingId?: string | null };
  expectedRevision?: number; requestKey?: string; debounceMs?: number;
  config?: NarrationConfig; now?: Date;
}): Promise<AutoNarrationOutcome> {
  const config = input.config ?? (await loadNarrationConfiguration()).config;
  if (!narrationAutoEnabled(config)) return { status: "OFF" };
  if (input.voiceId && !config.voices.some((v) => v.id === input.voiceId)) return { status: "INVALID", error: "Выберите голос из настроек" };
  const now = input.now ?? new Date();
  const generateAfter = new Date(now.getTime() + (input.debounceMs ?? narrationLimits(config).debounceMs));
  // Длина ролика и скорость речи — до замка (ffprobe не держит строку объекта): текст человека длиннее ролика
  // отказывается здесь, до первой оплаты (18.11.2026).
  const clipOf = input.source === "AGENT" || input.source === "WIZARD"
    ? await prisma.property.findUnique({ where: { id: input.propertyId }, select: { videoMasterStorageKey: true, videoHandoffFinalPath: true } }) : null;
  const clipSec = clipOf ? await narrationClipSec(clipOf) : null;
  const cps = clipSec ? await measuredNarrationCharsPerSec() : null;
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
        ? { status: "QUEUED", versionId: existing.id, revision: existing.revision, coalesced: true, templateId: existing.templateId, endingId: existing.endingId } : { status: "CONFLICT" };
    }
    const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: property.id }, orderBy: { revision: "desc" } });
    if (input.expectedRevision !== undefined && (latest?.revision ?? 0) !== input.expectedRevision) return { status: "CONFLICT" };
    if (latest && ["GENERATING", "UNKNOWN"].includes(latest.status)) return { status: "BUSY" };
    const facts = narrationFacts(property);
    const factsHash = narrationHash(facts);
    if (input.source === "AUTO" && latest && narrationFactsCurrent(latest, property) && latest.source !== "MANUAL") return { status: "UNCHANGED" };
    // Шаблон и концовку выбирает одно ядро (shared chooseNarration, 16.11.2026): выбор человека уважается; иначе
    // шаблон и концовка прошлой версии остаются (смена цены даёт тот же текст), а у нового объекта и при «Другой
    // шаблон» они случайные и не равны прошлым. Дальше всё хранится кодами в версии, случайности больше нет.
    // Концовка не подставляется, если клиент выбрал «без концовки» (null) или прислал готовый текст, не назвав её.
    const noEnding = input.endingId === null || (input.script !== undefined && input.endingId === undefined);
    const chosen = chooseNarration(config, facts.type, { templateId: input.templateId, endingId: input.endingId ?? undefined, noEnding, reroll: input.reroll,
      previous: latest ? { templateId: latest.templateId, endingId: latest.endingId } : null, avoid: latest ? null : input.avoid });
    const drafted = narrationDraftText(config, facts, chosen.templateId, chosen.endingId);
    const script = input.script ?? drafted.text;
    const error = narrationScriptError(script);
    if (error) return { status: "INVALID", error };
    const length = clipSec ? narrationLengthCheck(script, drafted.lang, clipSec, cps) : null;
    if (length && !length.fits) return { status: "INVALID", error: narrationLengthLine(length) };
    // «Другой шаблон» при единственном варианте: тот же шаблон, концовка, голос и текст — платной копии не делаем.
    if (input.source === "AGENT" && input.script === undefined && latest && latest.status !== "FAILED" && narrationFactsCurrent(latest, property)
      && latest.templateId === drafted.templateId && (latest.endingId ?? null) === drafted.endingId
      && latest.voiceId === pickNarrationVoice(config, input.voiceId ?? latest.voiceId) && latest.script === script) return { status: "UNCHANGED" };
    // Подстраховка к проверке настроек: таджикский текст не уходит в модель без таджикского.
    if (drafted.lang === "tg" && !narrationModelSupportsTajik(config.modelId)) return { status: "INVALID", error: "Модель озвучки не знает таджикского. Руководству: выберите eleven_v4 или eleven_v4_turbo в настройках." };
    const voiceId = pickNarrationVoice(config, input.voiceId ?? latest?.voiceId);
    if (!voiceId) return { status: "INVALID", error: "Голоса озвучки не настроены" };
    const data = { script, factsSnapshot: facts, factsHash, voiceId, modelId: config.modelId, templateId: drafted.templateId, endingId: drafted.endingId, language: drafted.lang, generateAfter };
    // Дребезг: несколько правок подряд правят одну ожидающую версию, пауза сдвигается.
    if (input.source === "AUTO" && latest && latest.status === "DRAFT" && !latest.approvedAt && latest.source !== "MANUAL" && latest.generateAfter) {
      await tx.propertyNarrationVersion.update({ where: { id: latest.id }, data });
      return { status: "QUEUED", versionId: latest.id, revision: latest.revision, coalesced: true, templateId: drafted.templateId, endingId: drafted.endingId };
    }
    await tx.propertyNarrationVersion.updateMany({ where: { propertyId: property.id, status: "DRAFT", generateAfter: { not: null } }, data: { generateAfter: null } });
    const created = await tx.propertyNarrationVersion.create({ data: { ...data, propertyId: property.id, revision: (latest?.revision ?? 0) + 1,
      createdById: input.actorId, requestKey: input.requestKey ?? randomUUID(), source: input.source } });
    return { status: "QUEUED", versionId: created.id, revision: created.revision, coalesced: false, templateId: drafted.templateId, endingId: drafted.endingId };
  });
  // Выбор сотрудника запоминаем на нём (lib/narrationLastChoice.ts): голос и тот шаблон с концовкой, что реально встали, —
  // следующий новый объект этого сотрудника не повторит их (16.11.2026).
  if (outcome.status === "QUEUED" && (input.source === "WIZARD" || input.source === "AGENT") && (input.voiceId || input.templateId || outcome.templateId)) {
    // «Последний выбор» — только то, что человек выбрал сам; случайно выпавшее записывается отдельно, чтобы не повторяться.
    await rememberNarrationChoice(input.actorId, { voiceId: input.voiceId,
      ...(input.templateAuto || input.reroll ? {} : { templateId: input.templateId, endingId: input.endingId ?? undefined }),
      usedTemplateId: outcome.templateId ?? undefined, usedEndingId: outcome.endingId ?? undefined }).catch(() => {});
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
    // Не выбрал голос — его последний голос. Не выбрал шаблон — случайный подходящий типу объекта, не равный
    // прошлому выбору этого сотрудника (16.11.2026, владелец: «в случайном порядке»); мастер CRM предвыбирает
    // случайный сам и присылает его кодом, Шабнам отдаёт выбор серверу.
    const { config } = await loadNarrationConfiguration();
    const last = await narrationLastChoiceFor(actorId, config);
    const filled = { ...choice, voiceId: choice.voiceId ?? last.voiceId };
    const avoid = { templateId: last.usedTemplateId ?? last.templateId, endingId: last.usedEndingId ?? last.endingId };
    const { autoPicked, ...forRequest } = filled;
    let outcome = await requestAutoNarration({ propertyId, actorId, source: "WIZARD", ...forRequest, templateAuto: autoPicked === true, avoid, debounceMs: 0, config });
    // Текст агента не прошёл проверку (например, вписал цену) — озвучка всё равно готовится по шаблону.
    if (outcome.status === "INVALID" && choice.script) outcome = await requestAutoNarration({ propertyId, actorId, source: "WIZARD", templateId: choice.templateId, endingId: choice.endingId, voiceId: filled.voiceId, avoid, debounceMs: 0, config });
    return outcome;
  } catch (err) {
    void logSystemError("api", `Автоозвучка после создания объекта не поставлена: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-start-failed" });
    return null;
  }
}

export type NarrationApproval = "FORBIDDEN" | "CONFLICT" | "TEXT_APPROVED" | "AUDIO_APPROVED";
/** Утверждение поставила сама CRM (самоодобрение пишет approvalNotifiedAt = approvedAt одной отметкой), а не человек. */
export function autoApprovedOnly(v: { approvedAt: Date | null; approvalNotifiedAt?: Date | null }): boolean {
  return !!v.approvedAt && !!v.approvalNotifiedAt && v.approvedAt.getTime() === v.approvalNotifiedAt.getTime();
}
/**
 * То же правило для неутверждённых версий прямо в запросе (четвёртое ревью 18.11): очереди сообщений и напоминаний не
 * должны брать строки, которые потом пропустят без отметки, — иначе двадцать таких строк навсегда занимают голову очереди.
 * Аудио маркетинга (MANUAL) — только на вышедшем ролике (пометки, идущая замена со снимком или перенесёнными постами).
 */
export const UNAPPROVED_AWAITS_HUMAN_WHERE = {
  storageKey: { not: null },
  OR: [
    { source: { not: "MANUAL" } },
    { property: { OR: [
      { publishedChannels: { isEmpty: false } }, { instagramUrl: { not: null } },
      { videoRemakeRequests: { some: { replaceOldPostsOnPublish: true, oldPostsReplacedAt: null } } },
    ] } },
  ],
} satisfies Prisma.PropertyNarrationVersionWhereInput;

/**
 * Ждёт ли версия человека (18.11.2026): готова и не утверждена, или утверждена только самой CRM, а ролик уже вышел.
 * Одно правило для карточки, Шабнам и перемикса.
 */
export async function narrationAwaitsHuman(propertyId: string, p: { publishedChannels?: readonly string[] | null; instagramUrl?: string | null },
  v: { status: string; storageKey?: string | null; approvedAt: Date | null; approvalNotifiedAt?: Date | null; source?: string | null }): Promise<boolean> {
  if (v.status !== "READY" || !v.storageKey) return false;
  // Аудио по тексту маркетинга ждёт человека только на вышедшем ролике (там утверждение снимается после синтеза).
  if (!v.approvedAt) return (v.source ?? "MANUAL") !== "MANUAL" || await clipCountsAsPublished(propertyId, p);
  return autoApprovedOnly(v) && await clipCountsAsPublished(propertyId, p);
}
/** Кто одобряет озвучку разового прохода по очереди монтажа (решение владельца 12.11.2026). */
export const NARRATION_OWNER_ROLES = ["DIRECTOR", "ADMIN"] as const;
export function isNarrationOwnerRole(role: string | null | undefined): boolean {
  return (NARRATION_OWNER_ROLES as readonly string[]).includes(role ?? "");
}

/** ОДНА функция одобрения: маршрут approve, кнопка Шабнам и помощник. Права на объект проверяет вызывающий.
 *  Озвучку разового прохода (BACKFILL) одобряет только владелец (директор или администратор).
 *  Ролик уже вышел (18.11.2026): это утверждение и есть выпуск — afterNarrationApproved накладывает голос
 *  и ставит ролик в сети сразу, второго вопроса «выпустить?» нет. */
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
    if (latest.status !== "READY") return input.isManager ? "CONFLICT" : "FORBIDDEN";
    // Аудио по тексту маркетинга (MANUAL) на вышедшем ролике ждёт утверждения после прослушивания (ревью 18.11):
    // те же права, что у любой озвучки объекта (вызывающий проверил narrationAccessForAgent); сообщение — агенту.
    if (latest.source === "BACKFILL" && !isNarrationOwnerRole(input.actorRole)) return "FORBIDDEN";
    if ((latest.source ?? "MANUAL") === "MANUAL" && !input.isManager && !(await clipCountsAsPublished(input.propertyId, current, tx))) return "FORBIDDEN";
    // Человек утверждает версию — отметка отказа «Оставить старый» больше её не держит. ПЕРВЫМ делом (ревью 18.11):
    // иначе уже утверждённая версия с отметкой застревала навсегда.
    await tx.property.updateMany({ where: { id: input.propertyId, narrationPreviewDeclinedVersionId: latest.id }, data: { narrationPreviewDeclinedVersionId: null } });
    // Утверждена автоматически, а ролик уже вышел (старый обход или окно выката): утверждение человека ставится заново —
    // перемикс выпускает только версию, утверждённую человеком (remixWanted).
    if (latest.approvedAt && autoApprovedOnly(latest) && await clipCountsAsPublished(input.propertyId, current, tx)) {
      return (await tx.propertyNarrationVersion.updateMany({ where: { id: latest.id, status: "READY", approvedAt: latest.approvedAt }, data: { approvedAt: new Date(), approvedById: input.actorId } })).count ? "AUDIO_APPROVED" : "CONFLICT";
    }
    if (latest.approvedAt) return "AUDIO_APPROVED";
    const done = (await tx.propertyNarrationVersion.updateMany({ where: { id: latest.id, status: "READY", approvedAt: null }, data: { approvedAt: new Date(), approvedById: input.actorId } })).count;
    return done ? "AUDIO_APPROVED" : "CONFLICT";
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
  const { status, refusal } = await startNarrationDelivery(propertyId, versionId);
  // Не штатное «объект ещё не у монтажёра» — журнал ошибок, а не тишина (19.11.2026: на проде голос не ушёл
  // монтажёру ни разу, а этот путь молчал). Ключ — объект+причина, окно шесть часов: обход зовёт каждую минуту.
  if (refusal && !refusalIsExpected(refusal)) {
    void logSystemError("api", `Озвучка объекта №${refusal.shortId ?? "?"}: голос монтажёру не передан — ${refusal.message}`,
      { dedupKey: `narration-delivery-refused:${propertyId}:${refusal.code}`, dedupWindowMs: NARRATION_DELIVERY_ALARM_WINDOW_MS });
  }
  return status;
}

/** Окно повторной записи тревог о непереданном голосе: обход идёт раз в минуту, журнал — не чаще раза в шесть часов. */
const NARRATION_DELIVERY_ALARM_WINDOW_MS = 6 * 60 * 60_000;
type NarrationDeliveryRefusal = { code: NarrationDeliveryRefusalCode | "UNEXPECTED"; message: string; shortId: number | null };
const refusalIsExpected = (r: NarrationDeliveryRefusal) => r.code !== "UNEXPECTED" && narrationDeliveryRefusalIsExpected(r.code);

/** Итог передачи вместе с причиной отказа подготовки (если была) — для журнала и сторожа обхода. */
async function startNarrationDelivery(propertyId: string, versionId: string): Promise<{ status: NarrationDeliveryStart; refusal?: NarrationDeliveryRefusal }> {
  const owner = await prisma.property.findUnique({ where: { id: propertyId }, select: { narrationOff: true, shortId: true } });
  if (owner?.narrationOff) return { status: "DISABLED" };
  let prepared: Awaited<ReturnType<typeof prepareNarrationDeliveryPlan>>;
  try { prepared = await prepareNarrationDeliveryPlan(propertyId, versionId, "AUDIO_ONLY"); }
  catch (err) {
    const refusal: NarrationDeliveryRefusal = err instanceof NarrationDeliveryRefused
      ? { code: err.code, message: err.message, shortId: owner?.shortId ?? null }
      : { code: "UNEXPECTED", message: `сбой подготовки: ${err instanceof Error ? err.message : String(err)}`, shortId: owner?.shortId ?? null };
    // Объект не у монтажёра. Есть ролик без голоса — CRM сама наложит новую озвучку и заменит
    // вышедший ролик (обход remixFromMasters, в течение минуты); монтажёр не нужен.
    // Ролика без голоса нет, но включена своя музыка и треки есть — то же «CRM сама», режим MUSIC (18.11.2026).
    // Остальные причины (монтажёр отключён, без Telegram, не назначен, озвучка устарела) идут тем же запасным
    // путём, но вызывающий пишет их в журнал ошибок.
    if (await crmRemixApplies(propertyId) || await ownMusicRemixApplies(propertyId)) return { status: "CRM_REMIX", refusal };
    return { status: await sendNarrationToMontajer(propertyId, versionId), refusal };
  }
  return { status: await queueNarrationDelivery(propertyId, versionId, prepared) };
}

async function queueNarrationDelivery(propertyId: string, versionId: string, prepared: Awaited<ReturnType<typeof prepareNarrationDeliveryPlan>>): Promise<NarrationDeliveryStart> {
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
    // Ждущие возврата объекта передачи (WAITING, 19.11.2026) другим ключом — гасим: голос уйдёт одной передачей.
    await tx.propertyNarrationDelivery.updateMany({
      where: { propertyId, status: "WAITING", ...(existing ? { id: { not: existing.id } } : {}) },
      data: { status: "CANCELLED", lastError: "Голос передан новой передачей, когда объект вернулся к монтажёру" },
    });
    // Строка, заведённая в PREVIEW до этой правки, — досылаем ею же, а не считаем «уже отправлено».
    // Ждущая возврата объекта (WAITING) — тоже ею же, со свежим планом: объект снова у монтажёра.
    if (existing?.status === "PREVIEW" || existing?.status === "WAITING") {
      await tx.propertyNarrationDelivery.update({ where: { id: existing.id }, data: { plan: prepared.plan, status: "QUEUED", executionMode: "LIVE", lastError: null } });
      return "QUEUED";
    }
    if (existing) return "ALREADY";
    await tx.propertyNarrationDelivery.create({ data: { propertyId, versionId, editorId: prepared.editorId, mode: "AUDIO_ONLY", requestKey,
      createdById: latest.approvedById ?? "system", plan: prepared.plan, status: "QUEUED", executionMode: "LIVE" } });
    return "QUEUED";
  });
}

/** Монтажёру по-старому: голос вклеен им — заменить только голос; ролик сдан без голоса и не вышел —
 *  «вклейте голос». Зовёт одобрение, когда пути без монтажёра нет, и перемикс «голос длиннее ролика». */
export async function sendNarrationToMontajer(propertyId: string, versionId: string, opts: { voiceLonger?: boolean } = {}): Promise<NarrationDeliveryStart> {
  const remake = await requestNarrationSoundRemake(propertyId, versionId, opts);
  if (remake === "QUEUED") return "SOUND_REMAKE";
  // Ролик сдан без голоса раньше одобрения и ещё не вышел — вернуть «вклейте голос».
  if (remake === "NO_OLD_NARRATION" && (await requestNarrationAddVoice(propertyId, versionId)) === "QUEUED") return "ADD_VOICE";
  return "WAITING_FOR_MONTAGE";
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
  const { config } = await loadNarrationConfiguration();
  const mixByCrm = narrationMixByCrm(config);
  const longer = opts.voiceLonger ? " Новая озвучка длиннее ролика: удлините ролик под голос." : "";
  const sent = await sendBackToMontajer(propertyId, version.approvedById, "NARRATION_CHANGED", mixByCrm
    ? `Новая озвучка, версия ${version.revision}: монтаж и кадры прежние.${longer} Пришлите тот же ролик БЕЗ голоса (музыка и звуки можно) — голос CRM наложит сама. Аудио придёт следом, для длины.`
    : `Новая озвучка, версия ${version.revision}: замените в ролике только голос, музыку и монтаж не трогайте.${longer} Новый mp3 придёт следом.${voicelessCopyHint() ? " При сдаче пришлите и тот же ролик без голоса — дальше смену цены CRM сделает сама." : ""}`, null, { removeFromSocial: "on-new-video" });
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
  const result = await returnClipForNarrationVoice(propertyId, { versionId, includePublished: false, apply: true, source: "narration-add-voice" });
  if (result.outcome === "REFUSED") {
    void logSystemError("api", `Озвучка: возврат «вклейте голос» не поставлен: ${result.reason}`, { dedupKey: `narration-add-voice:${versionId}` });
    return "REFUSED";
  }
  return result.outcome === "RETURNED" ? "QUEUED" : "SKIPPED";
}

export type NarrationAddVoiceResult =
  | { outcome: "RETURNED" | "WOULD_RETURN"; shortId: number; published: boolean; revision: number }
  | { outcome: "SKIPPED" | "REFUSED"; shortId: number | null; reason: string };
/**
 * ВОЗВРАТ «ВКЛЕЙТЕ ГОЛОС» — ОДНИ УСЛОВИЯ ДЛЯ ОБХОДА И ДЛЯ РАЗОВОГО ПРОХОДА (19.11.2026).
 * Обход (requestNarrationAddVoice): ролик сдан без голоса и ещё не вышел. Разовый проход
 * (src/scripts/return-clips-for-voice.ts, решение владельца 19.11.2026: «Ролик который сдан отправить
 * монтажеру») — includePublished: вышедший тоже возвращается, старые посты снимаются, КОГДА ВЫЙДЕТ
 * НОВЫЙ ролик (removeFromSocial: "on-new-video"). Вышедший ролик возвращается только по самой новой
 * версии, одобренной ЧЕЛОВЕКОМ: самоодобрение CRM на вышедшем ролике не считается (правило 18.11).
 * Голос монтажёру уже уходил (передача SENT) — не возвращаем: значит, ролик сделан с голосом.
 * apply: false — ничего не пишет: sendBackToMontajer({ dryRun }) проверяет те же отказы под тем же замком.
 * Повтор ничего не задвоит: после возврата ролик уже не RECEIVED, а sendBackToMontajer под замком
 * отказывает объекту, который уже у монтажёра или в очереди.
 */
export async function returnClipForNarrationVoice(propertyId: string, opts: { versionId?: string; includePublished: boolean; apply: boolean; source: string }): Promise<NarrationAddVoiceResult> {
  const [p, version, everSent] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, select: { shortId: true, deletedAt: true, status: true, narrationOff: true, videoHandoffStatus: true, publishedChannels: true, instagramUrl: true } }),
    opts.versionId
      ? prisma.propertyNarrationVersion.findUnique({ where: { id: opts.versionId } })
      : prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" } }),
    prisma.propertyNarrationDelivery.count({ where: { propertyId, status: "SENT" } }),
  ]);
  const shortId = p?.shortId ?? null;
  const skip = (reason: string): NarrationAddVoiceResult => ({ outcome: "SKIPPED", shortId, reason });
  if (mediaExecutionMode("NARRATION") !== "LIVE") return skip("отправка озвучки монтажёру выключена на сервере (CRM_NARRATION_EXECUTION_MODE не LIVE)");
  if (!p || p.deletedAt) return skip("объект удалён");
  if ((CLOSED_STATUSES as readonly string[]).includes(p.status)) return skip("объект продан или снят с продажи");
  if (p.narrationOff) return skip("у объекта выбрано «Без озвучки»");
  if (p.videoHandoffStatus !== "RECEIVED") return skip(`ролик не сдан или уже у монтажёра (передача: ${p.videoHandoffStatus ?? "нет"})`);
  const published = await clipCountsAsPublished(propertyId, p);
  if (published && !opts.includePublished) return skip("ролик уже вышел");
  if (everSent > 0) return skip("голос монтажёру уже уходил");
  if (!version || version.propertyId !== propertyId) return skip("озвучки нет");
  if (version.status !== "READY") return skip(`озвучка не готова (${version.status})`);
  if (!version.approvedAt || !version.approvedById) return skip("озвучка не одобрена");
  if (published) {
    const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
    if (latest?.id !== version.id) return skip("есть более новая версия озвучки");
    if (autoApprovedOnly(version)) return skip("озвучка одобрена только автоматически, нужен человек");
  }
  const comment = `Озвучка к ролику №${p.shortId} пришла после сдачи: вклейте голос в этот ролик, музыку и монтаж не трогайте. mp3 придёт следом.${voicelessCopyHint()}`;
  const options = published ? { removeFromSocial: "on-new-video" as const } : {};
  const sent = await sendBackToMontajer(propertyId, version.approvedById, "NARRATION_CHANGED", comment, null, opts.apply ? options : { ...options, dryRun: true });
  if (!sent.ok) return { outcome: "REFUSED", shortId, reason: sent.error };
  if (!opts.apply) return { outcome: "WOULD_RETURN", shortId: p.shortId, published, revision: version.revision };
  logAgentAudit(version.approvedById, "PROPERTY_SENT_BACK_TO_MONTAJER", "Property", propertyId, {
    reason: "NARRATION_CHANGED", narrationVersionId: version.id, source: opts.source, published, ...(published ? { removeOldPosts: "on-new-video" } : {}) });
  return { outcome: "RETURNED", shortId: p.shortId, published, revision: version.revision };
}

/** Своя музыка (18.11.2026): перемонтаж вышедшего ролика без ролика без голоса — те же условия, что у обхода. */
export async function ownMusicRemixApplies(propertyId: string): Promise<boolean> {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return false;
  return (await remixWanted(propertyId))?.mode === "MUSIC";
}

/** Перемикс из мастера возможен: отправка включена, у объекта есть ролик без голоса, он не у монтажёра. */
async function crmRemixApplies(propertyId: string): Promise<boolean> {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return false;
  const p = await prisma.property.findUnique({ where: { id: propertyId }, select: { videoMasterStorageKey: true, videoMasterSource: true, videoHandoffStatus: true, deletedAt: true, narrationOff: true } });
  return !!p && !p.deletedAt && !p.narrationOff && editorMaster(p) && p.videoHandoffStatus === "RECEIVED";
}

/**
 * Ролик без голоса от монтажёра — основа перемикса MASTER. Мастер машины (MACHINE, в нём мог остаться старый
 * голос) не используется вовсе; MUSIC_BASE — чистая картинка для своей музыки, звука в ней нет (ревью 18.11).
 */
function editorMaster(p: { videoMasterStorageKey: string | null; videoMasterSource: string | null }): boolean {
  return !!p.videoMasterStorageKey && p.videoMasterSource !== "MACHINE" && p.videoMasterSource !== MUSIC_BASE_SOURCE;
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
    // Ролик уже вышел (18.11.2026, владелец): утверждение = выпуск в соцсети, поэтому только человек.
    if (await clipCountsAsPublished(property.id, property, tx)) return null;
    const facts = narrationFacts(property);
    if (v.factsHash !== narrationHash(facts) || narrationDraftText(config, facts, v.templateId, v.endingId).text !== v.script) return null;
    // Укороченная под длину ролика версия (16.11.2026): другой шаблон, но заказала её CRM вместо уже
    // одобренной — одобряется на того же человека, иначе ролик ждал бы агента.
    if (v.shortenedFromId) {
      const from = await tx.propertyNarrationVersion.findUnique({ where: { id: v.shortenedFromId } });
      if (!from?.approvedById || !from.approvedAt || from.voiceId !== v.voiceId || from.factsHash !== v.factsHash) return null;
      const at = new Date();
      const ok = await tx.propertyNarrationVersion.updateMany({ where: { id: v.id, status: "READY", approvedAt: null }, data: { approvedAt: at, approvedById: from.approvedById, approvalNotifiedAt: at } });
      return ok.count ? { approvedById: from.approvedById } : null;
    }
    const prev = await tx.propertyNarrationVersion.findFirst({
      where: { propertyId: v.propertyId, revision: { lt: v.revision }, status: "READY", approvedAt: { not: null } }, orderBy: { revision: "desc" },
    });
    if (!prev?.approvedById || prev.templateId !== v.templateId || (prev.endingId ?? null) !== (v.endingId ?? null) || prev.voiceId !== v.voiceId || prev.modelId !== v.modelId) return null;
    if (narrationDraftText(config, prev.factsSnapshot as NarrationFacts, prev.templateId, prev.endingId).text !== prev.script) return null;
    const now = new Date();
    const done = await tx.propertyNarrationVersion.updateMany({ where: { id: v.id, status: "READY", approvedAt: null },
      data: { approvedAt: now, approvedById: prev.approvedById, approvalNotifiedAt: now } });
    return done.count ? { approvedById: prev.approvedById } : null;
  });
}

export type NarrationRemixOutcome = "REMIXED" | "SKIPPED" | "FAILED" | "SHORTENING";
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

/**
 * Нужно ли сводить ролик заново: одни условия и до метки, и после неё (там — свежим чтением).
 * MASTER — из ролика без голоса от монтажёра; MUSIC (18.11.2026) — ролика без голоса нет, своя музыка
 * включена и треки есть, ролик вышел и голос в нём от CRM-озвучки (монтажёр вклеивал переданный mp3 или
 * CRM уже клала голос сама). Ролик, вышедший вовсе без озвучки CRM, сам не перевыпускается (решение 12.11).
 */
async function remixWanted(propertyId: string) {
  const p = await prisma.property.findUnique({ where: { id: propertyId }, include: { district: true } });
  if (!p || p.deletedAt || p.narrationOff || p.videoHandoffStatus !== "RECEIVED" || CLOSED_STATUSES.some((s) => s === p.status)) return null;
  let mode: "MASTER" | "MUSIC" = "MASTER";
  let musicSince: string | undefined;
  if (!editorMaster(p)) {
    if (!p.videoHandoffFinalPath || !(await clipCountsAsPublished(p.id, p))) return null;
    const { config } = await loadNarrationConfiguration();
    if (!(await ownMusicReady(config))) return null;
    musicSince = config.ownMusicRemixSince;
    // Без момента включения сама CRM не перемонтирует ничего (ревью 18.11: без волны старых роликов).
    if (!musicSince) return null;
    const voiced = p.videoMasterNarrationVersionId
      ?? (await prisma.propertyNarrationDelivery.findFirst({ where: { propertyId, status: "SENT" }, select: { id: true } }))?.id ?? null;
    if (!voiced) return null;
    mode = "MUSIC";
  }
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" } });
  if (!latest || latest.status !== "READY" || !latest.approvedAt || !latest.storageKey || !narrationFactsCurrent(latest, p)) return null;
  // Своя музыка — только озвучки, одобренные после включения (ревью 18.11); прежние — по-старому, руками.
  if (mode === "MUSIC" && musicSince && latest.approvedAt.getTime() < new Date(musicSince).getTime()) return null;
  if (latest.id === p.videoMasterNarrationVersionId || latest.id === p.videoMasterMixErrorVersionId) return null;
  // Своя музыка: озвучка, которую монтажёр уже вклеил по передаче, в ролике есть — менять нечего.
  if (mode === "MUSIC" && await prisma.propertyNarrationDelivery.findFirst({ where: { propertyId, versionId: latest.id, status: "SENT" }, select: { id: true } })) return null;
  // «Прослушать перед выпуском» и «Оставить старый» убраны 18.11.2026: утверждённая версия сводится и выходит.
  // Отказ «Оставить старый», нажатый до выката, держится ещё один выпуск (ревью 18.11): снять его может только
  // новое утверждение человеком этой версии (approveNarrationVersion очищает отметку). Убрать после следующего выката.
  if (latest.id === p.narrationPreviewDeclinedVersionId) return null;
  // ПОСТОЯННЫЙ СТОРОЖ (ревью 18.11): выкат гонит миграцию, пока старые api/worker ещё работают, — они успевают завести
  // кандидата «прослушать» или самоодобрить версию уже после SQL. Кандидат и самоодобрение на вышедшем ролике в сеть не
  // выходят: такую версию выпускает только утверждение человеком (approveNarrationVersion ставит его заново).
  if (latest.id === p.narrationPreviewVersionId) return null;
  if (autoApprovedOnly(latest) && await clipCountsAsPublished(p.id, p)) return null;
  if (await isHandoffPublishRunning(propertyId)) return null;
  return { mode, p, latest: { ...latest, storageKey: latest.storageKey } };
}

async function remixFromMasterClaimed(propertyId: string): Promise<NarrationRemixOutcome> {
  const wanted = await remixWanted(propertyId);
  if (!wanted) return "SKIPPED";
  const { mode, p, latest } = wanted;
  const requestedById = latest.approvedById ?? propertyOwnerAgentId(p);
  let masterKey = p.videoMasterStorageKey;
  const sourceFinalPath = p.videoHandoffFinalPath;
  const seenVersionId = p.videoMasterNarrationVersionId;
  const fail = async (error: string, opts: { toMontajer?: boolean } = {}): Promise<NarrationRemixOutcome> => {
    await prisma.property.updateMany({ where: { id: propertyId, videoMasterStorageKey: masterKey, videoMasterNarrationVersionId: seenVersionId },
      data: { videoMasterMixError: error.slice(0, 500), videoMasterMixErrorVersionId: latest.id } });
    // Своя музыка не справилась (ревью 18.11): новая цена всё равно должна дойти до ролика — монтажёру прежним возвратом.
    const toMontajer = opts.toMontajer ?? mode === "MUSIC";
    void logSystemError("video-handoff", `Объект №${p.shortId}: новая озвучка (версия ${latest.revision}) не наложена на ролик — ${error} ${toMontajer ? "Ролик ушёл монтажёру заменить звук." : "Вышедший ролик остался прежним."}`, { dedupKey: `narration-remix:${latest.id}` });
    if (toMontajer) {
      await sendNarrationToMontajer(propertyId, latest.id).catch((err) =>
        logSystemError("video-handoff", `Объект №${p.shortId}: возврат монтажёру после отказа своей музыки не поставлен: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-remix-music-fallback:${latest.id}` }));
    }
    return "FAILED";
  };
  if (!requestedById) return fail("у объекта нет ответственного агента.");
  const actorId: string = requestedById;
  const outName = `${propertyId}-${Date.now()}.mp4`;
  const outPath = path.join(videoHandoffDir, outName);
  // СВОЯ МУЗЫКА (18.11.2026): «ролик без голоса» собирается здесь же из вышедшего ролика — картинка без
  // его звука + случайный трек библиотеки (не тот же, что в прошлый раз); дальше то же сведение, что у мастера.
  let musicBed: { dir: string; path: string; trackId: string } | null = null;
  if (mode === "MUSIC") {
    const track = await chooseMusicTrack(p.narrationMusicTrackId);
    if (!track) return fail("в библиотеке музыки нет ни одного файла трека на диске.");
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rh-music-"));
    // Основа — чистая картинка ролика монтажёра (MUSIC_BASE); её нет — первый перемонтаж сохраняет её сейчас.
    let basePath = p.videoMasterSource === MUSIC_BASE_SOURCE && masterKey ? localVideoFilePath(masterKey) : null;
    if (!basePath || !fs.existsSync(basePath)) {
      const clipPath = sourceFinalPath ? path.join(videoHandoffDir, path.basename(sourceFinalPath)) : null;
      if (!clipPath || !fs.existsSync(clipPath)) { await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); return fail("файл вышедшего ролика не найден на сервере."); }
      const picture = path.join(dir, "picture.mp4");
      const made = await buildPictureBase({ clipPath, outPath: picture });
      if (!made.ok) { await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); return fail(made.error); }
      const key = await storeNarrationMaster(propertyId, picture);
      const written = await prisma.property.updateMany({ where: { id: propertyId, videoMasterStorageKey: masterKey, videoHandoffFinalPath: sourceFinalPath, videoHandoffStatus: "RECEIVED" },
        data: { videoMasterStorageKey: key, videoMasterSource: MUSIC_BASE_SOURCE } });
      if (!written.count) {
        await dropNarrationMaster(key);
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        return "SKIPPED";
      }
      // Прежний мастер машины (MACHINE) больше не нужен.
      if (masterKey && masterKey !== key) await dropNarrationMaster(masterKey);
      masterKey = key;
      basePath = localVideoFilePath(key);
    }
    const bedPath = path.join(dir, "bed.mp4");
    const bed = await buildMusicBed({ clipPath: basePath!, trackPath: track.path, outPath: bedPath });
    if (!bed.ok) { await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); return fail(bed.error); }
    musicBed = { dir, path: bedPath, trackId: track.id };
  }
  // ЦЕНА И СУБТИТРЫ НА РОЛИКЕ (18.11.2026, рубильник textOverlay): цена — из карточки сейчас, в сомони (как монтажёру),
  // субтитры — текст этой версии озвучки. Сменилась цена — новый ролик несёт новую плашку.
  const textOverlay = narrationTextOverlay((await loadNarrationConfiguration()).config)
    ? { price: priceInTjsOnly(p.price, p.currency, await loadMoneyContext()), script: latest.script } : undefined;
  try {
    return await mixAndPlace();
  } finally {
    if (musicBed) await fs.promises.rm(musicBed.dir, { recursive: true, force: true }).catch(() => {});
  }

  async function mixOnto(fit: { allowFreeze: boolean }): Promise<NarrationMixResult> {
    if (musicBed) {
      const voicePath = localVideoFilePath(latest.storageKey);
      if (!voicePath || !fs.existsSync(voicePath)) return { ok: false, code: "FFMPEG", error: "Файл озвучки не найден на сервере." };
      return mixNarrationOntoMaster({ masterPath: musicBed.path, voicePath, outPath, fit, textOverlay });
    }
    return mixFromStoredMaster({ masterKey: masterKey!, voiceKey: latest.storageKey, outPath, fit, textOverlay });
  }

  async function mixAndPlace(): Promise<NarrationRemixOutcome> {
    // Длина (16.11.2026): (а) ускорение до 15 % → (б) короче шаблон → (в) + стоп-кадр до 3 с → (г) монтажёр.
    let mixed = await mixOnto({ allowFreeze: false });
    if (!mixed.ok && mixed.code === "VOICE_LONGER" && mixed.voiceSec && mixed.masterSec) {
      const shorter = await requestShorterNarration(propertyId, latest.id, mixed.voiceSec, mixed.masterSec).catch((err) => {
        void logSystemError("video-handoff", `Объект №${p.shortId}: короткий текст озвучки не заказан — ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-shorter:${latest.id}` });
        return null;
      });
      if (shorter) {
        // Отметка на этой версии: тик её больше не сводит; ролик сведётся из укороченной.
        await prisma.property.updateMany({ where: { id: propertyId, videoMasterStorageKey: masterKey },
          data: { videoMasterMixError: `Озвучка длиннее ролика — CRM готовит текст короче (версия ${shorter.revision}).`, videoMasterMixErrorVersionId: latest.id } });
        return "SHORTENING";
      }
      mixed = await mixOnto({ allowFreeze: true });
    }
    if (!mixed.ok && mixed.code === "VOICE_LONGER") {
      // Не помогли ни ускорение, ни короткий текст, ни стоп-кадр: монтажёр удлинит ролик и заменит
      // голос. Отметка ошибки на версии не даёт тику повторять перемикс.
      const outcome = await fail(mixed.error, { toMontajer: false });
      await sendNarrationToMontajer(propertyId, latest.id, { voiceLonger: true }).catch((err) =>
        logSystemError("video-handoff", `Объект №${p.shortId}: возврат монтажёру «озвучка длиннее ролика» не поставлен: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-remix-longer:${latest.id}` }));
      return outcome;
    }
    if (!mixed.ok) return fail(mixed.error);
    const mixNote = narrationFitNote(mixed.fit);
    const publicPath = `/uploads/handoff/${outName}`;
    // Замер длины голоса (18.11.2026) — основа оценки «укладывается ли текст» до следующей оплаты.
    await prisma.propertyNarrationVersion.updateMany({ where: { id: latest.id }, data: { mixNote, audioSec: mixed.voiceSec } }).catch(() => {});
    // Утверждённая озвучка на вышедшем ролике выходит сразу (18.11.2026): подмена под замком по свежей записи.
    let placed: PlacedMix;
    try {
      placed = await placeMixedClip({ propertyId, publicPath, masterKey, seenVersionId, versionId: latest.id, revision: latest.revision, requestedById: actorId,
        ...(musicBed ? { music: { sourceFinalPath: sourceFinalPath!, trackId: musicBed.trackId } } : {}) });
    } catch (err) {
      await fs.promises.unlink(outPath).catch(() => {});
      throw err;
    }
    if (placed.kind === "SKIPPED") {
      await fs.promises.unlink(outPath).catch(() => {});
      return "SKIPPED";
    }
    await dropReplacedClipFiles(placed, publicPath);
    const auditFit = { narrationVersionId: latest.id, revision: latest.revision, fit: mixed.fit.tier, tempo: mixed.fit.tempo, freezeSec: mixed.fit.freezeSec,
      ...(musicBed ? { musicTrackId: musicBed.trackId } : {}) };
    // Ролик на проверке модератора встанет на публикацию после «Одобрить», как обычно. Время — своей очередью
    // новой озвучки (короткий промежуток, ночью — утром): schedulePublishAfterAccept узнаёт её по заявке NARRATION_CHANGED.
    const scheduled = placed.reviewPending ? null : await schedulePublishAfterAccept(propertyId);
    logAgentAudit(actorId, "PROPERTY_NARRATION_REMIXED", "Property", propertyId, { ...auditFit,
      scheduledPublishAt: scheduled?.scheduledPublishAt?.toISOString() ?? null, notPublishingReason: scheduled?.notPublishingReason ?? null });
    return "REMIXED";
  }
}

/** Строка агенту в карточке объекта (16.11.2026): что CRM сделала со звуком вышедшего ролика. */
export function narrationMixNoteFor(
  p: { videoMasterNarrationVersionId: string | null },
  latest: { id: string; status: string; approvedAt: Date | null; shortenedFromId: string | null; mixNote: string | null } | null,
  opts: { ownMusicPending?: boolean } = {},
): string | null {
  if (!latest || latest.status !== "READY" || !latest.approvedAt) return null;
  if (latest.id === p.videoMasterNarrationVersionId) return latest.mixNote;
  if (latest.shortenedFromId) return "Голос был длиннее ролика: CRM озвучила тот же текст короче, ролик обновится сам.";
  if (opts.ownMusicPending) return "CRM заменит в ролике звук: своя музыка и новая озвучка. Обычно пара минут.";
  return null;
}

/**
 * КОРОЧЕ ТЕКСТ, ЧТОБЫ ГОЛОС ВЛЕЗ В РОЛИК (16.11.2026). Ускорения на 15 % не хватает — другой шаблон
 * того же языка, у которого текст короче, ровно ОДНА платная перегенерация на версию (укороченную
 * ещё раз не укорачивают). Только если: текст версии — шаблон без ручной правки (текст агента CRM
 * не переписывает), автоозвучка включена (тот же дневной потолок ElevenLabs), и по оценке длины
 * (секунды пропорциональны символам речи) новый текст встаёт в ролик лучше нынешнего. Иначе null —
 * дальше стоп-кадр или монтажёр. Новая версия одобряется сама (autoApproveSameChoice).
 */
const FIT_RANK = { PLAIN: 0, SPEED: 1, FREEZE: 2, TOO_LONG: 3 } as const;
export async function requestShorterNarration(propertyId: string, versionId: string, voiceSec: number, masterSec: number): Promise<{ versionId: string; revision: number } | null> {
  const { config } = await loadNarrationConfiguration();
  if (!narrationAutoEnabled(config)) return null;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${propertyId} FOR UPDATE`;
    const property = await tx.property.findUnique({ where: { id: propertyId }, include: { district: true } });
    const v = await tx.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" } });
    if (!property || property.deletedAt || property.narrationOff || !v || v.id !== versionId || v.shortenedFromId || !v.templateId || !v.voiceId) return null;
    const facts = narrationFacts(property);
    if (v.factsHash !== narrationHash(facts) || narrationDraftText(config, facts, v.templateId, v.endingId).text !== v.script) return null;
    const lang = v.language === "tg" || v.language === "ru" ? v.language : null;
    const nowRank = FIT_RANK[planNarrationFit(voiceSec, masterSec).tier];
    const chars = Math.max(1, speechChars(v.script, lang));
    let best: { templateId: string; text: string; estSec: number } | null = null;
    for (const t of config.templates ?? []) {
      // Те же правила, что у случайного выбора (17.11.2026, #216): язык и тип объекта подходят,
      // «только вручную» сам CRM не берёт; концовка прежней версии остаётся.
      if (t.id === v.templateId || t.lang !== lang || t.manualOnly || !narrationFitsType(t, property.type)) continue;
      const text = narrationDraftText(config, facts, t.id, v.endingId).text;
      if (narrationScriptError(text)) continue;
      const estSec = voiceSec * speechChars(text, lang) / chars;
      if (FIT_RANK[planNarrationFit(estSec, masterSec).tier] >= nowRank) continue;
      if (!best || estSec < best.estSec) best = { templateId: t.id, text, estSec };
    }
    if (!best) return null;
    await tx.propertyNarrationVersion.updateMany({ where: { propertyId, status: "DRAFT", generateAfter: { not: null } }, data: { generateAfter: null } });
    const created = await tx.propertyNarrationVersion.create({ data: { propertyId, revision: v.revision + 1, script: best.text, factsSnapshot: facts, factsHash: v.factsHash,
      voiceId: v.voiceId, modelId: config.modelId, templateId: best.templateId, endingId: v.endingId, language: v.language, generateAfter: new Date(), source: "AUTO",
      createdById: v.approvedById ?? v.createdById, requestKey: randomUUID(), shortenedFromId: v.id } });
    return { versionId: created.id, revision: created.revision };
  });
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

export async function remixFromMasters(): Promise<number> {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return 0;
  // Своя музыка (18.11.2026): в обход попадают и вышедшие ролики без ролика без голоса; остальное решает remixWanted.
  const { config } = await loadNarrationConfiguration();
  const music = await ownMusicReady(config);
  // Своя музыка или текст на ролике — это перекодирование картинки, минуты на объект: ОДИН такой объект за тик,
  // иначе задача narration-auto-flow выходит за свой предел 170 с (ревью 18.11).
  const heavy = music || narrationTextOverlay(config);
  // ПО ПОРЯДКУ УТВЕРЖДЕНИЯ (18.11.2026): утвердили пять роликов за минуту — сводятся и встают в очередь выпуска в
  // том порядке, в каком их утвердили. Сначала свежие утверждения (трое суток), потом обычный круг по курсору.
  const approvedFirst = await approvedNotMixedPropertyIds();
  const rowsByCursor = await prisma.property.findMany({ where: { deletedAt: null, narrationOff: false, videoHandoffStatus: "RECEIVED",
    OR: [{ videoMasterStorageKey: { not: null } }, ...(music ? [{ videoMasterStorageKey: null, videoHandoffFinalPath: { not: null },
      narrationVersions: { some: { status: "READY", approvedAt: { not: null } } }, OR: [{ publishedChannels: { isEmpty: false } }, { instagramUrl: { not: null } }] }] : [])],
    ...(sweepCursor.remix ? { id: { gt: sweepCursor.remix } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: REMIX_BATCH });
  const firstIds = new Set(approvedFirst);
  const rows = [...approvedFirst.map((id) => ({ id, first: true })), ...rowsByCursor.filter((r) => !firstIds.has(r.id)).map((r) => ({ id: r.id, first: false }))];
  let remixed = 0;
  const started = Date.now();
  let last: string | null = null;
  let stoppedEarly = false;
  for (const row of rows) {
    // Перекодирование ролика бывает долгим: остаток — следующему тику, а не за пределом крона (170 с).
    if (Date.now() - started > 90_000) { stoppedEarly = true; break; }
    let worked = false;
    try { const r = await remixFromMaster(row.id); worked = r !== "SKIPPED"; if (r === "REMIXED") remixed++; }
    catch (err) { worked = true; void logSystemError("video-handoff", `Озвучка: перемикс ролика упал: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-remix-crash" }); }
    if (!row.first) last = row.id;
    if (heavy && worked) { stoppedEarly = true; break; }
  }
  // Курсор двигают только строки обычного круга; первые по утверждению его не трогают.
  sweepCursor.remix = stoppedEarly ? last ?? sweepCursor.remix : rowsByCursor.length === REMIX_BATCH ? last ?? sweepCursor.remix : null;
  return remixed;
}

/** Объекты со свежей утверждённой озвучкой, ещё не наложенной на ролик, — по времени утверждения. */
async function approvedNotMixedPropertyIds(now = new Date()): Promise<string[]> {
  const rows = (await prisma.propertyNarrationVersion.findMany({
    where: { status: "READY", approvedAt: { gte: new Date(now.getTime() - 3 * DAY_MS) }, storageKey: { not: null },
      property: { deletedAt: null, narrationOff: false, videoHandoffStatus: "RECEIVED" } },
    orderBy: { approvedAt: "asc" }, take: 200,
    select: { id: true, propertyId: true, property: { select: { videoMasterNarrationVersionId: true, videoMasterMixErrorVersionId: true } } },
  })) ?? [];
  const ids: string[] = [];
  for (const r of rows) {
    if (!r.property || r.id === r.property.videoMasterNarrationVersionId || r.id === r.property.videoMasterMixErrorVersionId || ids.includes(r.propertyId)) continue;
    ids.push(r.propertyId);
  }
  return ids;
}

const DAY_MS = 86_400_000;
/** Код версии «текст длиннее ролика, озвучка не заказана» (18.11.2026): денег не потрачено. */
export const NARRATION_TEXT_TOO_LONG = "TEXT_LONGER_THAN_CLIP";
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

/** Пауза после правки карточки (18.11.2026): короче обычного дребезга обхода — несколько правок подряд всё ещё
 *  сливаются в одну версию, но агент не ждёт минуты. Больше настройки «пауза» не бывает. */
export const NARRATION_AFTER_EDIT_DEBOUNCE_MS = 30_000;
/** Правка карточки (lib/propertyUpdateEffects.ts): факты озвучки разошлись — новый черновик сейчас. Те же условия,
 *  что у обхода refreshNarrationDrafts (платить — только при включённой автоозвучке и отправке LIVE). */
export async function requestNarrationAfterEdit(propertyId: string, now: Date = new Date()): Promise<AutoNarrationOutcome | null> {
  const { config, key } = await loadNarrationConfiguration();
  if (!narrationAutoEnabled(config) || !key || !narrationProviderReady(config, key) || mediaExecutionMode("NARRATION") !== "LIVE") return null;
  const p = await prisma.property.findUnique({ where: { id: propertyId }, include: { district: true, narrationVersions: { orderBy: { revision: "desc" }, take: 1 } } });
  const latest = p?.narrationVersions[0];
  if (!p || p.deletedAt || p.narrationOff || !latest || narrationFactsCurrent(latest, p)) return null;
  const owner = p.assignedAgentId ?? p.intakeAgentId ?? p.createdById ?? "system";
  return requestAutoNarration({ propertyId, actorId: owner, source: "AUTO", config, now, debounceMs: Math.min(NARRATION_AFTER_EDIT_DEBOUNCE_MS, narrationLimits(config).debounceMs) });
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
    // ДЛИНА ДО ОПЛАТЫ (18.11.2026): текст длиннее ролика в ElevenLabs не уходит — версия «не получилась», агент
    // видит в карточке «Длиннее ролика на N с. Сократите текст». Ролика ещё нет — проверять не с чем.
    const clipRow = await prisma.property.findUnique({ where: { id: row.propertyId }, select: { videoMasterStorageKey: true, videoHandoffFinalPath: true } });
    const length = clipRow ? await narrationLengthCheckFor(clipRow, row.script, row.language) : null;
    if (length && !length.fits) {
      await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, status: "DRAFT" }, data: { status: "FAILED", errorCode: NARRATION_TEXT_TOO_LONG, generateAfter: null } });
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
  // MANUAL тоже (ревью 18.11): аудио по утверждённому тексту маркетинга на вышедшем ролике ждёт человека — одно
  // обычное сообщение агенту «готово, послушайте». Неутверждённым READY оно бывает только так.
  // Только то, что агент правда может утвердить — фильтром в самом запросе (четвёртое ревью 18.11).
  const ready = await prisma.propertyNarrationVersion.findMany({ where: { status: "READY", approvedAt: null, approvalNotifiedAt: null, ...UNAPPROVED_AWAITS_HUMAN_WHERE,
    property: { deletedAt: null, narrationOff: false, status: { notIn: [...CLOSED_STATUSES] } } },
    orderBy: { createdAt: "asc" }, take: 20, select: { id: true, propertyId: true } });
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

/**
 * ЖДУЩИЕ ПЕРЕДАЧИ ГОЛОСА (WAITING, второй круг ревью 19.11.2026). Передача ждёт, пока объект не
 * у монтажёра (он нажал «Сделаю позже» или взял другой). Обход берёт ВСЕ такие передачи —
 * и автоматические, и ручные, и версии MANUAL: объект снова у монтажёра — та же строка со свежим
 * планом встаёт в отправку (если голос этой версии уже не ушёл и не идёт другая передача).
 * Объект сняли с монтажа («Уже сделан», «Не нужен», руководство), продали, сняли с продажи или
 * удалили — передача гаснет (CANCELLED) с понятной причиной, а не висит вечно.
 */
async function resumeWaitingNarrationDeliveries(): Promise<number> {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return 0;
  const rows = await prisma.propertyNarrationDelivery.findMany({
    where: { status: "WAITING" },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: {
      id: true, propertyId: true, versionId: true, mode: true,
      property: { select: { deletedAt: true, status: true, narrationOff: true, videoHandoffStatus: true, videoHandoffManualSince: true } },
    },
  });
  const cancel = (id: string, lastError: string) =>
    prisma.propertyNarrationDelivery.updateMany({ where: { id, status: "WAITING" }, data: { status: "CANCELLED", lastError } });
  let resumed = 0;
  for (const row of rows) {
    const p = row.property;
    if (!p || p.deletedAt || (CLOSED_STATUSES as readonly string[]).includes(p.status)) {
      await cancel(row.id, "Объект продан, снят с продажи или удалён — голос монтажёру не отправлен");
      continue;
    }
    if (p.narrationOff) {
      await cancel(row.id, "Выбрано «Без озвучки» — голос монтажёру не отправлен");
      continue;
    }
    if (p.videoHandoffStatus !== "QUEUED" && p.videoHandoffStatus !== "SENT_TO_EDITOR") {
      await cancel(row.id, "Объект снят с монтажа — голос монтажёру не отправлен");
      continue;
    }
    // Ещё в очереди или открыт под ручной приём готового ролика — ждём дальше.
    if (p.videoHandoffStatus !== "SENT_TO_EDITOR" || p.videoHandoffManualSince) continue;
    let prepared: Awaited<ReturnType<typeof prepareNarrationDeliveryPlan>>;
    try {
      prepared = await prepareNarrationDeliveryPlan(row.propertyId, row.versionId, row.mode);
    } catch (err) {
      // Версию сменила новая или факты поменялись — эту не шлём (новую отправит обход сам).
      if (err instanceof NarrationDeliveryRefused && (err.code === "VERSION_STALE" || err.code === "PROPERTY_GONE" || err.code === "NARRATION_OFF")) {
        await cancel(row.id, "Озвучка этой версии устарела — голос монтажёру не отправлен");
      }
      // Остальное (монтажёр без Telegram, отключён) — ждём; сторож ниже скажет, если затянется.
      continue;
    }
    const ok = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${row.propertyId} FOR UPDATE`;
      if (await tx.propertyNarrationDelivery.count({ where: { propertyId: row.propertyId, versionId: row.versionId, status: "SENT" } })) {
        await tx.propertyNarrationDelivery.updateMany({ where: { id: row.id, status: "WAITING" }, data: { status: "CANCELLED", lastError: "Голос этой версии уже у монтажёра — второй раз не отправляю" } });
        return false;
      }
      if (await tx.propertyNarrationDelivery.count({ where: { propertyId: row.propertyId, status: { in: ["QUEUED", "SENDING", "UNKNOWN"] } } })) return false;
      const done = await tx.propertyNarrationDelivery.updateMany({
        where: { id: row.id, status: "WAITING" },
        data: { status: "QUEUED", plan: prepared.plan, editorId: prepared.editorId, executionMode: "LIVE", lastError: null },
      });
      return done.count === 1;
    });
    if (ok) resumed++;
  }
  return resumed;
}

async function deliverApprovedNarrations(): Promise<number> {
  let delivered = await resumeWaitingNarrationDeliveries().catch((err) => {
    void logSystemError("api", `Озвучка: ждущие передачи не возобновлены: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-waiting-resume" });
    return 0;
  });
  const approved = await prisma.propertyNarrationVersion.findMany({
    // Строки PREVIEW (до LIVE) не считаются передачей: после включения LIVE mp3 досылается.
    // WAITING (19.11.2026) — передача ждёт возврата объекта к монтажёру: тоже ещё не передача, её строку возьмёт queueNarrationDelivery.
    where: { status: "READY", approvedAt: { not: null }, source: { not: "MANUAL" }, deliveries: { none: { status: { notIn: ["PREVIEW", "WAITING"] } } }, property: { deletedAt: null, narrationOff: false, status: { notIn: [...CLOSED_STATUSES] }, videoHandoffStatus: "SENT_TO_EDITOR" } },
    orderBy: { approvedAt: "asc" }, take: 20, select: { id: true, propertyId: true },
  });
  for (const row of approved) {
    try {
      const { status, refusal } = await startNarrationDelivery(row.propertyId, row.id);
      if (status === "QUEUED" || status === "PREVIEW") delivered++;
      await watchUndeliveredVoice(row, status, refusal);
    } catch (err) {
      void logSystemError("api", `Озвучка: передача монтажёру не подготовлена: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-auto-delivery" });
    }
  }
  await watchStuckVoiceDeliveries().catch((err) =>
    logSystemError("api", `Озвучка: сторож зависших передач не отработал: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-stuck-watch" }));
  return delivered;
}

/** Итоги обхода, при которых голос ушёл, уходит или уже у монтажёра — сторожу молчать (BUSY — только если не зависла). */
const VOICE_ON_ITS_WAY: readonly NarrationDeliveryStart[] = ["QUEUED", "ALREADY", "BUSY", "PREVIEW"];
/**
 * СТОРОЖ «ГОЛОС НЕ УШЁЛ» (19.11.2026). Обход берёт только объекты у монтажёра (SENT_TO_EDITOR) с одобренной
 * озвучкой без передачи — значит, если итог не «поставлено / уже / занято / ждёт LIVE», монтажёр монтирует без
 * голоса прямо сейчас. Раньше это было видно только по жалобе. Молчит, когда версию уже сменила более новая
 * (уйдёт она) и когда причина штатная (у объекта «Без озвучки», ручной монтаж мимо очереди).
 * «Занято» (BUSY) — в пути, только пока мешающая передача живая: UNKNOWN или SENDING дольше бюджета попытки
 * сама не завершится никогда и держит голос и всех следующих версий (ревью 19.11).
 */
async function watchUndeliveredVoice(row: { id: string; propertyId: string }, status: NarrationDeliveryStart, refusal?: NarrationDeliveryRefusal) {
  if (status === "DISABLED" || (refusal && refusalIsExpected(refusal))) return;
  let reason = refusal?.message ?? `передача не поставлена (итог ${status})`;
  let key: string = refusal?.code ?? status;
  if (VOICE_ON_ITS_WAY.includes(status)) {
    if (status !== "BUSY") return;
    const blockers = await prisma.propertyNarrationDelivery.findMany({ where: { propertyId: row.propertyId, status: { in: ["SENDING", "UNKNOWN"] } }, select: { id: true, status: true, claimStartedAt: true, plan: true }, take: 10 });
    const stalled = blockers.find((d) => narrationDeliveryStalled(d));
    if (!stalled) return;
    reason = stalledDeliveryReason(stalled.status);
    key = `stalled:${stalled.id}`;
  }
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: row.propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
  if (latest?.id !== row.id) return;
  const shortId = refusal?.shortId ?? (await prisma.property.findUnique({ where: { id: row.propertyId }, select: { shortId: true } }))?.shortId ?? "?";
  logVoiceNotSent(row.propertyId, shortId, reason, key);
}

function logVoiceNotSent(propertyId: string, shortId: number | string, reason: string, key: string) {
  void logSystemError("api", `Озвучка объекта №${shortId} одобрена, объект у монтажёра, а голос ему не ушёл: ${reason}`,
    { dedupKey: `narration-voice-not-sent:${propertyId}:${key}`, dedupWindowMs: NARRATION_DELIVERY_ALARM_WINDOW_MS });
}

function stalledDeliveryReason(status: string): string {
  return status === "UNKNOWN"
    ? "передача зависла с неизвестным результатом. Сверьте в карточке («Сверка неопределённой доставки»), затем при необходимости передайте вручную"
    : "передача идёт дольше положенного. Сверьте в карточке («Сверка неопределённой доставки»), затем при необходимости передайте вручную";
}

/**
 * СТОРОЖ ЗАВИСШИХ И УПАВШИХ ПЕРЕДАЧ (ревью 19.11.2026). Обход берёт версии только без передач, поэтому версия,
 * чья передача упала (FAILED) или зависла (UNKNOWN, SENDING дольше бюджета), из него выпадает навсегда, а повторное
 * одобрение отвечает «уже». Автоповтора нет намеренно (lib/narrationDelivery.ts::reportNarrationDeliveryProblem):
 * здесь — напоминание раз в шесть часов, пока объект у монтажёра, версия последняя и голос по ней не ушёл.
 */
async function watchStuckVoiceDeliveries(now: Date = new Date()): Promise<void> {
  const rows = await prisma.propertyNarrationDelivery.findMany({
    where: { status: { in: ["FAILED", "UNKNOWN", "SENDING", "WAITING"] }, version: { status: "READY", approvedAt: { not: null } },
      property: { deletedAt: null, narrationOff: false, status: { notIn: [...CLOSED_STATUSES] }, videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffManualSince: null } },
    orderBy: { createdAt: "desc" }, take: 20,
    select: { id: true, propertyId: true, versionId: true, status: true, claimStartedAt: true, plan: true, lastError: true, property: { select: { shortId: true, videoHandoffSentAt: true } } },
  });
  const seen = new Set<string>();
  for (const d of rows) {
    // Ждущая передача (WAITING, второй круг ревью): объект уже у монтажёра дольше бюджета попытки,
    // а голос так и не ушёл (его держит другая передача или монтажёр без Telegram) — напоминание.
    if (d.status === "WAITING") {
      const since = d.property.videoHandoffSentAt;
      if (!since || now.getTime() - since.getTime() <= narrationDeliveryAttemptBudgetMs(d.plan)) continue;
      if (await prisma.propertyNarrationDelivery.count({ where: { versionId: d.versionId, status: { in: ["SENT", "QUEUED"] } } })) continue;
      logVoiceNotSent(d.propertyId, d.property.shortId, "передача голоса ждёт, хотя объект уже у монтажёра. Проверьте Telegram монтажёра и зависшие передачи в карточке, затем при необходимости передайте вручную", `waiting:${d.id}`);
      continue;
    }
    if (seen.has(d.versionId)) continue; // одна (самая свежая) передача на версию
    seen.add(d.versionId);
    if (d.status !== "FAILED" && !narrationDeliveryStalled(d, now)) continue;
    const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: d.propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
    if (latest?.id !== d.versionId) continue;
    // По этой версии голос уже ушёл или уходит другой передачей (ручной повтор) — молчим.
    if (await prisma.propertyNarrationDelivery.count({ where: { versionId: d.versionId, status: { in: ["SENT", "CANCELLED", "QUEUED"] } } })) continue;
    const reason = d.status === "FAILED"
      ? `передача не удалась (${d.lastError ?? "причина не записана"}). Автоповтора нет — передайте вручную: карточка объекта → «Передача монтажёру вручную»`
      : stalledDeliveryReason(d.status);
    logVoiceNotSent(d.propertyId, d.property.shortId, reason, `stalled:${d.id}`);
  }
}
