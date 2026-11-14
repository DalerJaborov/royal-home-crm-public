import { formatPropertyCode } from "@royal-home/shared";
import { z } from "zod";
import { prisma } from "../../../db.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { dushanbeDateTimeString } from "../../../lib/dushanbeTime.js";
import { propertyOwnerWhere } from "../../../lib/propertyOwner.js";
import { findPropertiesByRef } from "../../../lib/propertyRefLookup.js";
import { videoHandoffPublishDedupeKey } from "../../../lib/videoHandoff.js";
import { propertyHref } from "./propertyPresenter.js";
import { safeField } from "./safeField.js";
import type { AssistantActor } from "../actor.js";
import type { AssistantReadToolPlugin } from "./types.js";

const argsSchema = z.object({
  ref: z.string().trim().min(1).max(300).optional(),
  scope: z.enum(["mine", "queue"]).optional(),
}).refine(({ ref, scope }) => Boolean(ref) !== Boolean(scope));

// Same visibility as GET /marketing/editor-queue. Other employees can list their own objects.
const queueRoles = new Set(["EDITOR"]);
const listLimit = 8;
const select = {
  id: true,
  shortId: true,
  title: true,
  status: true,
  stageEnteredAt: true,
  videoHandoffStatus: true,
  videoHandoffSentAt: true,
  videoHandoffDeliveredAt: true,
  videoHandoffReceivedAt: true,
  videoHandoffFinalPath: true,
  videoHandoffDispatchStartedAt: true,
  videoHandoffDispatchAttempts: true,
  videoHandoffManualSince: true,
  videoHandoffHeldAt: true,
  videoHandoffRemakeReason: true,
  scheduledPublishAt: true,
  clipReviewStatus: true,
  clipReviewRequestedAt: true,
  clipReviewDecidedAt: true,
  autoMontageStatus: true,
  autoMontageUpdatedAt: true,
} satisfies Prisma.PropertySelect;

type WorkRow = Prisma.PropertyGetPayload<{ select: typeof select }>;
type PublishJobStatus = "PENDING" | "RUNNING" | "GIVEN_UP" | "SKIPPED";

function since(at: Date | null, now: Date) {
  if (!at || at > now) return null;
  const hours = Math.floor((now.getTime() - at.getTime()) / 3_600_000);
  return { sinceDushanbe: dushanbeDateTimeString(at), elapsedDays: Math.floor(hours / 24), elapsedHours: hours };
}

export function summarizePropertyWork(row: WorkRow, now: Date, publishJobStatus?: PublishJobStatus) {
  const manual = row.videoHandoffStatus;
  if (manual === "QUEUED") {
    return {
      phase: row.videoHandoffHeldAt ? "EDITOR_QUEUE_ON_HOLD" : "WAITING_FOR_EDITOR",
      elapsed: since(row.videoHandoffSentAt, now),
      remake: Boolean(row.videoHandoffRemakeReason),
    };
  }
  if (manual === "SENT_TO_EDITOR") {
    if (row.videoHandoffManualSince) return { phase: "WAITING_FOR_MANUAL_UPLOAD", elapsed: since(row.videoHandoffManualSince, now) };
    if (!row.videoHandoffDeliveredAt) {
      const startedAt = row.videoHandoffDispatchStartedAt;
      const sending = startedAt && now.getTime() - startedAt.getTime() < 15 * 60_000;
      return {
        phase: sending ? "SENDING_TO_EDITOR" : "EDITOR_DELIVERY_UNCONFIRMED",
        elapsed: since(row.videoHandoffSentAt, now),
        earlierDeliveryAttempts: row.videoHandoffDispatchAttempts,
      };
    }
    return { phase: "WITH_EDITOR", elapsed: since(row.videoHandoffDeliveredAt, now), remake: Boolean(row.videoHandoffRemakeReason) };
  }
  if (row.status !== "EDITING") return { phase: row.status, elapsed: since(row.stageEnteredAt, now) };
  if (manual === "RECEIVED" && row.videoHandoffReceivedAt && row.videoHandoffFinalPath) {
    const phases = {
      PENDING: "PUBLICATION_PENDING",
      RUNNING: "PUBLISHING",
      GIVEN_UP: "PUBLICATION_FAILED",
      SKIPPED: "PUBLICATION_SKIPPED",
    } as const;
    return {
      phase: publishJobStatus ? phases[publishJobStatus] : "FINAL_VIDEO_RECEIVED",
      elapsed: since(row.videoHandoffReceivedAt, now),
      scheduledAtDushanbe: row.scheduledPublishAt ? dushanbeDateTimeString(row.scheduledPublishAt) : null,
    };
  }
  if (row.clipReviewStatus === "REJECTED") return { phase: "FINAL_VIDEO_REJECTED", elapsed: since(row.clipReviewDecidedAt, now) };
  if (row.clipReviewStatus === "PENDING") return { phase: "FINAL_VIDEO_UNDER_REVIEW", elapsed: since(row.clipReviewRequestedAt, now) };
  if (row.autoMontageStatus !== "NONE") {
    // These fields retain earlier cycles. An old render cannot explain a newly entered stage.
    const at = row.autoMontageUpdatedAt;
    if (at && (!row.stageEnteredAt || at >= row.stageEnteredAt)) {
      return { phase: `AUTO_MONTAGE_${row.autoMontageStatus}`, elapsed: since(at, now) };
    }
  }
  return { phase: "EDITING_PATH_UNCONFIRMED", elapsed: since(row.stageEnteredAt, now) };
}

function identity(row: Pick<WorkRow, "shortId" | "title">) {
  return { code: formatPropertyCode(row.shortId), href: propertyHref(row.shortId), title: safeField(row.title, 100) };
}

export async function getPropertyWorkList(actor: AssistantActor, scope: "mine" | "queue", now = new Date()) {
  const hideOwnPendingDeleteFor = actor.permissions?.has("properties.delete") ? undefined : actor.id;
  const isQueue = scope === "queue";
  const companyQueue = isQueue && (queueRoles.has(actor.role) || !!actor.permissions?.has("marketing.access"));
  const where: Prisma.PropertyWhereInput = {
    deletedAt: null,
    AND: [{
      OR: [
        isQueue ? { status: "EDITING" } : { status: { in: ["PENDING_REVIEW", "AWAITING_PHOTOS", "AWAITING_VIDEO", "EDITING"] } },
        // Published listings can stay AVAILABLE while a remake is queued or with the editor.
        { videoHandoffStatus: { in: ["QUEUED", "SENT_TO_EDITOR"] } },
      ],
    }],
    ...(companyQueue ? {} : propertyOwnerWhere(actor.id)),
    ...(hideOwnPendingDeleteFor ? { deleteRequests: { none: { status: "PENDING", requestedById: hideOwnPendingDeleteFor } } } : {}),
  };
  const baseQueries = [
    prisma.property.count({ where }),
    prisma.property.findMany({
      where,
      select,
      orderBy: isQueue ? [{ stageEnteredAt: "asc" }, { id: "asc" }] : [{ stageEnteredAt: "desc" }, { id: "desc" }],
      take: listLimit,
    }),
  ] as const;
  const snapshot = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead };
  const [total, rows, withEditor, waitingForEditor] = isQueue ? await prisma.$transaction([
    ...baseQueries,
    prisma.property.count({
      where: {
        ...where,
        videoHandoffStatus: "SENT_TO_EDITOR",
        videoHandoffDeliveredAt: { not: null },
        videoHandoffManualSince: null,
      },
    }),
    prisma.property.count({ where: { ...where, videoHandoffStatus: "QUEUED" } }),
  ], snapshot) : await prisma.$transaction([...baseQueries], snapshot);
  return {
    scope: companyQueue ? "COMPANY_QUEUE" : isQueue ? "MY_QUEUE" : "MY_PREPARATION",
    total,
    shown: rows.length,
    ...(isQueue ? { withEditor, waitingForEditor } : {}),
    items: rows.map(row => ({ ...identity(row), ...summarizePropertyWork(row, now) })),
  };
}

export const getPropertyWorkStatusTool: AssistantReadToolPlugin = {
  name: "get_property_work_status",
  level: "A",
  description:
    "Текущий этап объекта и срок в нём: очередь, реально у монтажёра, исходники не доставлены, ручная загрузка, автомонтаж, готовый ролик, публикация. " +
    "Для конкретного объекта передай ref; для «где мой объект/мои объекты» — scope=mine; для «что/сколько на монтаже» — scope=queue. " +
    "Если пользователь не назвал объект, уточни по списку; не выбирай из нескольких совпадений.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Номер, id, адрес или название известного объекта" },
      scope: { type: "string", enum: ["mine", "queue"], description: "Мои объекты или очередь монтажа" },
    },
  },
  statusPhrase: "Проверяю, на каком этапе объект…",
  async run(rawArgs, { actor }) {
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "Укажите объект либо выберите мои объекты или очередь монтажа" };
    const { ref, scope } = parsed.data;
    const hideOwnPendingDeleteFor = actor.permissions?.has("properties.delete") ? undefined : actor.id;
    const now = new Date();
    if (ref) {
      const found = await findPropertiesByRef(ref, { hideOwnPendingDeleteFor, limit: 5 });
      const [row] = found.properties;
      if (!row) return { total: 0, items: [] };
      if (found.properties.length > 1 && found.kind !== "id" && found.kind !== "shortId") {
        return { needsClarification: true, items: found.properties.map(identity) };
      }
      const receivedAt = row.status === "EDITING" && row.videoHandoffStatus === "RECEIVED" && row.videoHandoffFinalPath
        ? row.videoHandoffReceivedAt
        : null;
      const job = receivedAt ? await prisma.backgroundJob.findFirst({
        where: {
          dedupeKey: videoHandoffPublishDedupeKey(row.id),
          status: { in: ["PENDING", "RUNNING", "GIVEN_UP", "SKIPPED"] },
          updatedAt: { gte: receivedAt },
        },
        select: { status: true },
      }) : null;
      return { ...identity(row), ...summarizePropertyWork(row, now, job?.status === "DONE" ? undefined : job?.status) };
    }
    return getPropertyWorkList(actor, scope ?? "mine", now);
  },
};
