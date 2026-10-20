/**
 * РЕШЕНИЕ ПО ОБЪЕКТУ НА ПРОВЕРКЕ — ОДИН ПУТЬ ДЛЯ CRM И TELEGRAM (22.09.2026).
 *
 * Раньше логика «Одобрить фото/видео» и «Вернуть на доработку» жила прямо в
 * роутах routes/properties/moderation.ts. Модерация из Telegram
 * (lib/telegramModeration) обязана идти ровно тем же путём — баллы агенту, пуши,
 * передача монтажёру, аудит, — поэтому тело вынесено сюда, а роут и бот оба
 * зовут эти функции.
 *
 * ПЕРЕХОДЫ АТОМАРНЫЕ. Прежний код читал объект и писал `update` по id: два
 * модератора (CRM + Telegram или два админа в Telegram), нажавшие почти
 * одновременно, оба проходили проверку «статус = на проверке», и объект
 * получал два решения. Теперь каждая запись — `updateMany` с условием на
 * текущее состояние; проигравший получает `count: 0` и честный ответ «уже решил
 * такой-то в такое-то время» (whoDecided).
 */
import { prisma } from "../db.js";
import type { Property } from "../generated/prisma/client.js";
import {
  closePendingReviewPush,
  isRawReviewRequired,
  MIN_PROPERTY_PHOTOS,
  notifyEditingStarted,
  onRawReviewBypass,
} from "./propertyPipeline.js";
import { logAgentAudit, logSystemAudit } from "./audit.js";
import { queueVideoHandoff } from "./videoHandoff.js";
import { loadEventPoints, recordScoreEvent, type ScoreEventKind } from "./scoreJournal.js";
import { sendPushToAgent } from "../push.js";
import { publishPropertyUpdated } from "./livePublish.js";
import { runAsActor, runAsSystem } from "./requestActor.js";

export type ReviewMaterial = "photos" | "video";
/** Откуда пришло решение — пишется в аудит и в строку «Одобрено (кто, когда, где)».
 *  "auto" — одобрила сама CRM: проверка исходников выключена (25.09.2026). */
export type ReviewSource = "crm" | "telegram" | "auto";

export interface ReviewActor {
  /** null — только у source "auto": решение приняла CRM, не человек. */
  agentId: string | null;
  source: ReviewSource;
}

/** Пометка в журнале автоодобрения — по ней в хронологии видно, что фото и
 *  видео никто не смотрел (25.09.2026). */
export const AUTO_APPROVE_NOTE = "автоматически: проверка исходников выключена";

/** Выполнить от имени решившего: человек — его контекст, CRM — без контекста,
 *  даже если автоодобрение пришло изнутри запроса агента, загрузившего видео. */
function asActor<T>(actor: ReviewActor, fn: () => Promise<T>): Promise<T> {
  return actor.agentId ? runAsActor(actor.agentId, fn) : runAsSystem(fn);
}

export type ReviewFailure = { ok: false; status: 404 | 409; code: "not_found" | "not_pending" | "already" | "no_material"; error: string };
export type ReviewResult = { ok: true; property: Property; movedToEditing: boolean } | ReviewFailure;

export const REVIEW_AUDIT_ACTIONS = [
  "PROPERTY_PHOTOS_APPROVED",
  "PROPERTY_VIDEO_APPROVED",
  "PROPERTY_PHOTOS_REJECTED",
  "PROPERTY_VIDEO_REJECTED",
] as const;

/** Слушатели решения — сюда подписывается Telegram, чтобы погасить кнопки у всех.
 *  Подписка, а не прямой импорт: сервис не знает о Telegram и не тянет бота в тесты. */
export type ReviewDecisionEvent = {
  propertyId: string;
  outcome: "approved" | "rejected" | "partial";
  material: ReviewMaterial | "all";
  actor: ReviewActor;
  at: Date;
  reason?: string;
};
const decisionListeners: Array<(e: ReviewDecisionEvent) => Promise<void>> = [];
export function onReviewDecision(fn: (e: ReviewDecisionEvent) => Promise<void>): void {
  decisionListeners.push(fn);
}
export function emitReviewDecision(e: ReviewDecisionEvent): void {
  for (const fn of decisionListeners) void fn(e).catch((err) => console.error("[review] слушатель решения:", err));
}

const fail = (status: 404 | 409, code: ReviewFailure["code"], error: string): ReviewFailure => ({ ok: false, status, code, error });

/** Одобрить один материал. Когда одобрены оба — объект уходит в монтаж. */
export async function approveReviewMaterial(
  propertyId: string,
  material: ReviewMaterial,
  actor: ReviewActor,
  opts: { silentEvent?: boolean } = {}
): Promise<ReviewResult> {
  return asActor(actor, async () => {
    const property = await prisma.property.findUnique({ where: { id: propertyId } });
    if (!property || property.deletedAt) return fail(404, "not_found", "Объект не найден");
    if (property.status !== "PENDING_REVIEW") return fail(409, "not_pending", "Объект сейчас не на проверке");
    if (material === "photos" && property.photosApprovedAt) return fail(409, "already", "Фото уже одобрены");
    if (material === "video" && property.videoApprovedAt) return fail(409, "already", "Видео уже одобрено");

    if (material === "photos") {
      const photoCount = await prisma.propertyPhoto.count({ where: { propertyId } });
      if (photoCount < MIN_PROPERTY_PHOTOS) {
        return fail(409, "no_material", `Фото меньше минимума (${photoCount} из ${MIN_PROPERTY_PHOTOS}) — одобрять нечего`);
      }
    } else {
      // На проверке смотрят СЫРЫЕ ролики агента (владелец 17.08.2026), а не готовый
      // Reels — ссылка на Instagram обязательна только на выходе из монтажа.
      const videoCount = await prisma.propertyVideo.count({ where: { propertyId } });
      if (videoCount === 0) return fail(409, "no_material", "Агент ещё не загрузил видео объекта — одобрять нечего");
    }

    const now = new Date();
    const claimed = await prisma.property.updateMany({
      where: {
        id: propertyId,
        status: "PENDING_REVIEW",
        deletedAt: null,
        ...(material === "photos" ? { photosApprovedAt: null } : { videoApprovedAt: null }),
      },
      data: material === "photos" ? { photosApprovedAt: now } : { videoApprovedAt: now },
    });
    if (claimed.count === 0) {
      return fail(409, "already", material === "photos" ? "Фото уже одобрены" : "Видео уже одобрено");
    }
    // Второй материал уже одобрен — сдвигаем в монтаж тем же условным переходом:
    // из двух параллельных одобрений разных материалов в монтаж переведёт ровно одно.
    const moved = await prisma.property.updateMany({
      where: { id: propertyId, status: "PENDING_REVIEW", photosApprovedAt: { not: null }, videoApprovedAt: { not: null } },
      data: { status: "EDITING", stageEnteredAt: now },
    });
    const movedToEditing = moved.count === 1;
    const updated = (await prisma.property.findUnique({ where: { id: propertyId } }))!;

    await afterApproval(property, [material], updated, movedToEditing, actor);
    if (!opts.silentEvent) {
      emitReviewDecision({ propertyId, outcome: movedToEditing ? "approved" : "partial", material, actor, at: now });
    }
    return { ok: true, property: updated, movedToEditing };
  });
}

/** Последствия одобрения — общие для «одного материала» (CRM) и «целиком» (Telegram). */
async function afterApproval(
  before: Property,
  materials: ReviewMaterial[],
  updated: Property,
  movedToEditing: boolean,
  actor: ReviewActor
): Promise<void> {
  const responsibleId = before.intakeAgentId ?? before.assignedAgentId ?? before.createdById;
  const points = responsibleId ? await loadEventPoints() : null;
  for (const material of materials) {
    const rejectedBefore = material === "photos" ? before.photosRejectionCount > 0 : before.videoRejectionCount > 0;
    if (!rejectedBefore && responsibleId && points) {
      const kind: ScoreEventKind = material === "photos" ? "photos_approved_first_try" : "video_approved_first_try";
      recordScoreEvent({
        agentId: responsibleId,
        kind,
        delta: points[kind],
        reason: material === "photos" ? "Фотографии одобрены с первого раза" : "Видео одобрено с первого раза",
        sourceId: `${before.id}-${material}-approved`,
      });
    }
    const action = material === "photos" ? "PROPERTY_PHOTOS_APPROVED" : "PROPERTY_VIDEO_APPROVED";
    if (actor.agentId) logAgentAudit(actor.agentId, action, "Property", before.id, { source: actor.source });
    else logSystemAudit(action, "Property", before.id, { source: actor.source, note: AUTO_APPROVE_NOTE });
  }
  if (movedToEditing) {
    void notifyEditingStarted(updated.id, updated.shortId, updated.title).catch((err) =>
      console.error("[push] объект передан в монтаж:", err)
    );
    // Объект покинул PENDING_REVIEW — пуш «ждёт проверки» у остальных гасим.
    void closePendingReviewPush(before.id).catch((err) => console.error("[push] закрытие «на проверке»:", err));
    // Передача монтажёру — единственный путь подготовки ролика с 04.09.2026.
    void queueVideoHandoff(updated.id).catch((err) => console.error("[video-handoff] постановка в очередь монтажёру:", err));
  }
  publishPropertyUpdated({ propertyId: updated.id, agentId: updated.assignedAgentId, stage: updated.status, actorId: actor.agentId });
}

/**
 * «Одобрить» целиком (кнопка в Telegram): одобряет то, что ещё не одобрено.
 * Материал, которого нет (агент не залил видео), — ошибка целиком: одобрить
 * половину и промолчать хуже, чем честно сказать, чего не хватает.
 */
export async function approveReviewAll(propertyId: string, actor: ReviewActor): Promise<ReviewResult> {
  return asActor(actor, async () => {
    const property = await prisma.property.findUnique({ where: { id: propertyId } });
    if (!property || property.deletedAt) return fail(404, "not_found", "Объект не найден");
    if (property.status !== "PENDING_REVIEW") return fail(409, "not_pending", "Объект сейчас не на проверке");
    const materials: ReviewMaterial[] = [];
    if (!property.photosApprovedAt) materials.push("photos");
    if (!property.videoApprovedAt) materials.push("video");
    const [photoCount, videoCount] = await Promise.all([
      prisma.propertyPhoto.count({ where: { propertyId } }),
      prisma.propertyVideo.count({ where: { propertyId } }),
    ]);
    if (materials.includes("photos") && photoCount < MIN_PROPERTY_PHOTOS) {
      return fail(409, "no_material", `Фото меньше минимума (${photoCount} из ${MIN_PROPERTY_PHOTOS}) — одобрять нечего`);
    }
    if (materials.includes("video") && videoCount === 0) {
      return fail(409, "no_material", "Агент ещё не загрузил видео объекта — одобрять нечего");
    }
    const now = new Date();
    // Сравнить-и-записать по снимку: объект переводится в монтаж одной записью,
    // только если с момента чтения никто не решил ни по одному материалу.
    const claimed = await prisma.property.updateMany({
      where: {
        id: propertyId,
        status: "PENDING_REVIEW",
        deletedAt: null,
        photosApprovedAt: property.photosApprovedAt,
        videoApprovedAt: property.videoApprovedAt,
      },
      data: {
        photosApprovedAt: property.photosApprovedAt ?? now,
        videoApprovedAt: property.videoApprovedAt ?? now,
        status: "EDITING",
        stageEnteredAt: now,
      },
    });
    if (claimed.count === 0) return fail(409, "already", "По объекту уже решили");
    const updated = (await prisma.property.findUnique({ where: { id: propertyId } }))!;
    await afterApproval(property, materials, updated, true, actor);
    emitReviewDecision({ propertyId, outcome: "approved", material: "all", actor, at: now });
    return { ok: true, property: updated, movedToEditing: true };
  });
}

export interface RejectInput {
  material: ReviewMaterial;
  reason: string;
  reasonVoiceUrl?: string | null;
  reasonVoiceTranscript?: string | null;
}

/** Вернуть на доработку: объект уходит в «Ждём фото/видео», причина обязательна. */
export async function rejectReview(propertyId: string, input: RejectInput, actor: ReviewActor): Promise<ReviewResult> {
  return asActor(actor, async () => {
    const property = await prisma.property.findUnique({ where: { id: propertyId } });
    if (!property || property.deletedAt) return fail(404, "not_found", "Объект не найден");
    if (property.status !== "PENDING_REVIEW") return fail(409, "not_pending", "Объект сейчас не на проверке");

    const { material, reason } = input;
    const now = new Date();
    const claimed = await prisma.property.updateMany({
      where: { id: propertyId, status: "PENDING_REVIEW", deletedAt: null },
      data: {
        status: material === "photos" ? "AWAITING_PHOTOS" : "AWAITING_VIDEO",
        stageEnteredAt: now,
        reviewRejectionReason: reason,
        reviewRejectionVoiceUrl: input.reasonVoiceUrl ?? null,
        reviewRejectionVoiceTranscript: input.reasonVoiceTranscript ?? null,
        ...(material === "photos"
          ? { photosRejectionCount: { increment: 1 }, photosApprovedAt: null }
          : { videoRejectionCount: { increment: 1 }, videoApprovedAt: null }),
      },
    });
    if (claimed.count === 0) return fail(409, "not_pending", "Объект сейчас не на проверке");
    const updated = (await prisma.property.findUnique({ where: { id: propertyId } }))!;
    const newCount = material === "photos" ? updated.photosRejectionCount : updated.videoRejectionCount;

    const responsibleId = property.intakeAgentId ?? property.assignedAgentId ?? property.createdById;
    if (responsibleId) {
      const points = await loadEventPoints();
      recordScoreEvent({
        agentId: responsibleId,
        kind: "property_reworked",
        delta: points.property_reworked,
        reason: `Возврат на доработку (${material === "photos" ? "фото" : "видео"}): ${reason}`,
        sourceId: `reject-${property.id}-${material}-${newCount}`,
      });
      sendPushToAgent(responsibleId, {
        title: material === "photos" ? "🏠 Нужны новые фото" : "🏠 Нужно новое видео",
        body: `${property.title}: ${reason}`,
        url: `/properties/${property.shortId}`,
        tag: `property-review-${property.id}`,
      }).catch((err) => console.error("[push] возврат объекта на доработку:", err));
    }

    logAgentAudit(actor.agentId, material === "photos" ? "PROPERTY_PHOTOS_REJECTED" : "PROPERTY_VIDEO_REJECTED", "Property", property.id, {
      reason,
      source: actor.source,
    });
    void closePendingReviewPush(property.id).catch((err) => console.error("[push] закрытие «на проверке»:", err));
    publishPropertyUpdated({ propertyId: updated.id, agentId: updated.assignedAgentId, stage: updated.status, actorId: actor.agentId });
    emitReviewDecision({ propertyId, outcome: "rejected", material, actor, at: now, reason });
    return { ok: true, property: updated, movedToEditing: false };
  });
}

/** Кто и когда последним решил по объекту — для ответа проигравшему в гонке. */
export async function whoDecided(propertyId: string): Promise<{ name: string; at: Date; source: string | null } | null> {
  const last = await prisma.auditLog.findFirst({
    where: { entityType: "Property", entityId: propertyId, action: { in: [...REVIEW_AUDIT_ACTIONS] } },
    orderBy: { createdAt: "desc" },
    select: { agentName: true, createdAt: true, meta: true },
  });
  if (!last) return null;
  const meta = (last.meta ?? {}) as { source?: string };
  return { name: last.agentName, at: last.createdAt, source: meta.source ?? null };
}

/**
 * АВТООДОБРЕНИЕ ПРИ ВЫКЛЮЧЕННОЙ ПРОВЕРКЕ ИСХОДНИКОВ (25.09.2026, владелец:
 * «выключи временно одобрение роликов от агентов — пусть сразу идут
 * монтажёру»). Settings.rawReviewRequired = false: объект на проверке, у
 * которого уже есть фото (не меньше MIN_PROPERTY_PHOTOS) и хотя бы одно видео,
 * одобряется ТЕМ ЖЕ путём, что кнопка «Одобрить» (approveReviewAll): баллы,
 * журнал, перевод в EDITING, постановка монтажёру — без второй копии.
 *
 * Зовут: вход объекта на проверку (notifyPendingReview через onRawReviewBypass —
 * создание, мастер, смена статуса, дозагрузка фото после возврата) и каждая
 * новая загрузка видео или фото (routes/properties/videos.ts, photos.ts): у
 * заведённого с фото объекта видео обычно приходит позже. Гонка двух вызовов
 * безопасна — approveReviewAll атомарен, проигравший получает «already».
 *
 * «waiting» — проверка выключена, но материалов пока мало: объект молча ждёт
 * следующей загрузки, модераторов не зовут.
 */
export type AutoApproveOutcome = "review_on" | "approved" | "waiting";
export async function autoApproveIfRawReviewOff(propertyId: string): Promise<AutoApproveOutcome> {
  if (await isRawReviewRequired()) return "review_on";
  const result = await approveReviewAll(propertyId, { agentId: null, source: "auto" });
  return result.ok ? "approved" : "waiting";
}
onRawReviewBypass(autoApproveIfRawReviewOff);
