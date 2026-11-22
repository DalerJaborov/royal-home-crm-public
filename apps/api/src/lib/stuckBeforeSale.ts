/**
 * «ЗАСТРЯЛИ ДО ПРОДАЖИ» — ОДНА СВОДКА ДЛЯ ШАБНАМ И ДЛЯ ЭКРАНА (17.11.2026, волна 2).
 *
 * Живой случай: 13 объектов не дошли до продажи — на проверке с сентября, ждут фото и видео,
 * ролик получен и не принят, у монтажёра, принят без Instagram (ОБ-000193 стоял на «Монтаже»
 * 11 дней, потому что ключ Instagram мёртв с 12.11). Каждый вид застревания по отдельности где-то
 * виден, а одним списком «что стоит, почему и кто следующий» — нигде, и никто ни о чём не узнавал.
 *
 * Здесь ничего не придумано заново:
 *  - где ролик — `summarizePropertyWork` (ai/assistant/tools/getPropertyWorkStatus.ts), тот же
 *    разбор, что отвечает на «где ролик ОБ-193»;
 *  - почему не выходит в продажу — коды `saleBlockerCodes`/тексты `blockersForSale`
 *    (lib/propertyPipeline.ts) и годность «без Instagram» `saleWithoutInstagramEligibility`
 *    (lib/propertyCompleteEditing.ts) — ровно то, что проверяет кнопка «Готово»;
 *  - кто хозяин объекта — `propertyOwnerAgentId`/`propertyOwnerWhere` (lib/propertyOwner.ts);
 *  - сутки и даты — по Душанбе (lib/dushanbeTime.ts).
 *
 * Только чтение: никому не пишет и ничего не двигает. Предел выборки — `limit` (по умолчанию 50,
 * не больше 200) и честный счётчик `total`.
 */
import { formatPropertyCode, MIN_PROPERTY_PHOTOS, PROPERTY_PIPELINE_STATUSES, type PropertyStatus } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { summarizePropertyWork } from "../ai/assistant/tools/getPropertyWorkStatus.js";
import { getClipOwnerSettings } from "./clipReview.js";
import { dushanbeDateString, dushanbeStartOfToday } from "./dushanbeTime.js";
import { PROPERTY_STATUS_LABEL_RU } from "./propertyAutoStatus.js";
import { saleWithoutInstagramEligibility } from "./propertyCompleteEditing.js";
import { propertyOwnerAgentId, propertyOwnerWhere } from "./propertyOwner.js";
import { blockersForSale, saleBlockerCodes } from "./propertyPipeline.js";
import { videoHandoffPublishDedupeKey } from "./videoHandoff.js";

/** Сколько дней на этапе — уже «застрял» (решение по умолчанию задания волны 2: трое суток). */
export const STUCK_BEFORE_SALE_MIN_DAYS = 3;
export const STUCK_BEFORE_SALE_DEFAULT_LIMIT = 50;
export const STUCK_BEFORE_SALE_MAX_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Вид застревания — для экрана (иконка/группа) и тестов; человеку идёт `reason`. */
export type StuckBeforeSaleKind =
  | "ON_REVIEW"
  | "AWAITING_PHOTOS"
  | "AWAITING_VIDEO"
  | "EDITOR_QUEUE"
  | "EDITOR_QUEUE_PAUSED"
  | "EDITOR_DELIVERY"
  | "WITH_EDITOR"
  | "MANUAL_UPLOAD"
  | "CLIP_NOT_ACCEPTED"
  | "CLIP_REJECTED"
  | "PUBLISH_WAITING"
  | "PUBLISH_FAILED"
  | "PUBLISH_SKIPPED"
  | "NO_INSTAGRAM_CAN_BYPASS"
  | "NOT_PUBLISHED_ANYWHERE"
  | "WRONG_LINK"
  | "PHOTOS_BELOW_MIN"
  | "READY_NOT_PRESSED"
  | "AUTO_MONTAGE"
  | "EDITING_NOT_STARTED";

/** Кто делает следующий шаг — ролью; имя, если это конкретный человек. */
export type StuckBeforeSaleNextBy = "MARKETING" | "AGENT" | "EDITOR" | "CLIP_REVIEWER" | "DIRECTOR" | "SYSTEM";

export interface StuckBeforeSaleItem {
  propertyId: string;
  shortId: number;
  code: string;
  title: string;
  stage: PropertyStatus;
  stageLabel: string;
  /** С какого числа на этапе — «12.09» (год — если не текущий), по Душанбе. */
  since: string;
  /** Сколько суток на этапе — по календарю Душанбе. */
  days: number;
  kind: StuckBeforeSaleKind;
  /** Причина словами: «ждёт фото», «у монтажёра 5 дн.», «ролик принят и вышел в YouTube…; нет Instagram…». */
  reason: string;
  /** Что сделать и кому — одной фразой. */
  nextStep: string;
  nextBy: StuckBeforeSaleNextBy;
  nextByName: string | null;
  ownerAgentId: string | null;
  ownerAgentName: string | null;
  /** Чего не хватает кнопке «Готово» (тексты `blockersForSale`); пусто — для продажи всё есть. */
  blockers: string[];
  /** Директор/админ может вывести без Instagram: ролик принят и вышел в этих сетях. */
  withoutInstagram?: { channels: string[] };
}

export interface StuckBeforeSaleResult {
  /** Сколько всего застряло (может быть больше `items`). */
  total: number;
  items: StuckBeforeSaleItem[];
  minDays: number;
}

const select = {
  id: true,
  shortId: true,
  title: true,
  status: true,
  stageEnteredAt: true,
  instagramUrl: true,
  publishedChannels: true,
  intakeAgentId: true,
  assignedAgentId: true,
  createdById: true,
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
  _count: { select: { photos: true } },
} satisfies Prisma.PropertySelect;

export type StuckBeforeSaleRow = Prisma.PropertyGetPayload<{ select: typeof select }>;

/** Календарные сутки по Душанбе между двумя моментами (0 — тот же день). */
export function dushanbeDaysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((dushanbeStartOfToday(to).getTime() - dushanbeStartOfToday(from).getTime()) / DAY_MS));
}

/** «12.09» по Душанбе; год дописывается, если он не текущий. */
export function shortDushanbeDate(at: Date, now: Date = new Date()): string {
  const [y, m, d] = dushanbeDateString(at).split("-");
  return y === dushanbeDateString(now).slice(0, 4) ? `${d}.${m}` : `${d}.${m}.${y}`;
}

const daysWord = (n: number) => `${n} дн.`;

export interface StuckBeforeSaleContext {
  now: Date;
  names: Map<string, string>;
  montajerId: string | null;
  clipOwnerApprove: boolean;
}

type Verdict = Pick<StuckBeforeSaleItem, "kind" | "reason" | "nextStep" | "nextBy" | "nextByName" | "withoutInstagram">;

/**
 * Причина и следующий шаг одного объекта. Чистая функция: всё нужное (имена, настройки, статус
 * задания публикации) передано снаружи — список из сотни объектов не делает сотню запросов.
 */
export function describeStuckBeforeSale(
  row: StuckBeforeSaleRow,
  ctx: StuckBeforeSaleContext,
  publishJobStatus?: "PENDING" | "RUNNING" | "GIVEN_UP" | "SKIPPED",
): Verdict {
  const ownerId = propertyOwnerAgentId(row);
  const ownerName = ownerId ? (ctx.names.get(ownerId) ?? null) : null;
  const agentWho = ownerName ? `агент ${ownerName}` : "агент объекта";
  const editorName = ctx.montajerId ? (ctx.names.get(ctx.montajerId) ?? null) : null;
  const editorWho = editorName ? `монтажёр ${editorName}` : "монтажёр";
  const since = shortDushanbeDate(row.stageEnteredAt, ctx.now);

  if (row.status === "PENDING_REVIEW") {
    return {
      kind: "ON_REVIEW",
      reason: `на проверке с ${since}, ждёт решения маркетинга`,
      nextStep: "Маркетинг: посмотреть фото и видео и одобрить или вернуть агенту на доработку.",
      nextBy: "MARKETING",
      nextByName: null,
    };
  }
  if (row.status === "AWAITING_PHOTOS") {
    return { kind: "AWAITING_PHOTOS", reason: "ждёт фото", nextStep: `${cap(agentWho)}: снять и загрузить фото объекта.`, nextBy: "AGENT", nextByName: ownerName };
  }
  if (row.status === "AWAITING_VIDEO") {
    return { kind: "AWAITING_VIDEO", reason: "ждёт видео", nextStep: `${cap(agentWho)}: снять и загрузить видео объекта.`, nextBy: "AGENT", nextByName: ownerName };
  }

  // EDITING: сначала где ролик (тот же разбор, что у get_property_work_status), потом — условия «Готово».
  const work = summarizePropertyWork(row, ctx.now, publishJobStatus);
  const elapsedDays = work.elapsed?.elapsedDays ?? null;
  const ago = elapsedDays === null ? "" : ` ${daysWord(elapsedDays)}`;
  switch (work.phase) {
    case "WAITING_FOR_EDITOR":
      return { kind: "EDITOR_QUEUE", reason: `в очереди к монтажёру${ago}`, nextStep: `${cap(editorWho)}: очередь дойдёт сама; ускорить — поднять объект в очереди монтажа.`, nextBy: "EDITOR", nextByName: editorName };
    case "EDITOR_QUEUE_ON_HOLD":
      return { kind: "EDITOR_QUEUE_PAUSED", reason: "отложен в очереди монтажа", nextStep: "Маркетинг: снять объект с паузы в очереди монтажа.", nextBy: "MARKETING", nextByName: null };
    case "SENDING_TO_EDITOR":
    case "EDITOR_DELIVERY_UNCONFIRMED":
      return { kind: "EDITOR_DELIVERY", reason: "исходники не подтверждены у монтажёра", nextStep: "Маркетинг: проверить доставку и переслать исходники монтажёру.", nextBy: "MARKETING", nextByName: null };
    case "WITH_EDITOR":
      return { kind: "WITH_EDITOR", reason: `у монтажёра${ago}`, nextStep: `${cap(editorWho)}: прислать готовый ролик.`, nextBy: "EDITOR", nextByName: editorName };
    case "WAITING_FOR_MANUAL_UPLOAD":
      return { kind: "MANUAL_UPLOAD", reason: `ждём ручной загрузки готового ролика${ago}`, nextStep: `${cap(editorWho)}: загрузить готовый ролик в карточке.`, nextBy: "EDITOR", nextByName: editorName };
    case "FINAL_VIDEO_UNDER_REVIEW": {
      const byOwner = ctx.clipOwnerApprove && ownerName;
      return {
        kind: "CLIP_NOT_ACCEPTED",
        reason: `ролик получен, не принят — ждёт приёмки ${byOwner ? `хозяином объекта (${ownerName})` : "модератором роликов"}${ago}`,
        nextStep: byOwner
          ? `${cap(agentWho)}: посмотреть ролик и принять или вернуть на правку (иначе он выйдет сам по сроку).`
          : "Модератор роликов (право «Одобрять фото и видео»): принять ролик или вернуть монтажёру.",
        nextBy: "CLIP_REVIEWER",
        nextByName: byOwner ? ownerName : null,
      };
    }
    case "FINAL_VIDEO_REJECTED":
      return { kind: "CLIP_REJECTED", reason: "ролик отклонён — ждём новый от монтажёра", nextStep: `${cap(editorWho)}: переделать ролик по замечаниям.`, nextBy: "EDITOR", nextByName: editorName };
    case "PUBLICATION_PENDING":
    case "PUBLISHING":
      return { kind: "PUBLISH_WAITING", reason: "ролик принят, ждёт выхода в сети по расписанию", nextStep: "CRM опубликует сама; ускорить — «Опубликовать сейчас» в карточке.", nextBy: "SYSTEM", nextByName: null };
    case "PUBLICATION_FAILED":
      return { kind: "PUBLISH_FAILED", reason: "ролик принят, но публикация в сети не удалась", nextStep: "Директор или администратор: «Что не доехало» → «Повторить»; если сломан доступ к соцсети — починить его в Настройках → Каналы.", nextBy: "DIRECTOR", nextByName: null };
    case "PUBLICATION_SKIPPED":
      return { kind: "PUBLISH_SKIPPED", reason: "ролик принят, автопубликация пропущена", nextStep: "Маркетинг: опубликовать ролик из карточки объекта.", nextBy: "MARKETING", nextByName: null };
    default:
      break;
  }
  if (work.phase.startsWith("AUTO_MONTAGE_")) {
    return { kind: "AUTO_MONTAGE", reason: "идёт автомонтаж ролика", nextStep: "Маркетинг: проверить автомонтаж.", nextBy: "MARKETING", nextByName: null };
  }
  if (work.phase === "EDITING_PATH_UNCONFIRMED") {
    return { kind: "EDITING_NOT_STARTED", reason: "на монтаже, но исходники монтажёру не отправлены и ролика нет", nextStep: "Маркетинг: отправить исходники монтажёру или загрузить готовый ролик.", nextBy: "MARKETING", nextByName: null };
  }

  // Ролик принят и публикация отработала — дальше решают условия кнопки «Готово».
  const sale = { instagramUrl: row.instagramUrl, photoCount: row._count.photos };
  const codes = saleBlockerCodes(sale);
  if (codes.length === 0) {
    return { kind: "READY_NOT_PRESSED", reason: "для продажи всё есть, но «Готово» не нажали", nextStep: "Тот, кто ведёт объект, или директор: нажать «Готово, в продажу».", nextBy: "DIRECTOR", nextByName: null };
  }
  if (codes.includes("PHOTOS_BELOW_MIN")) {
    return { kind: "PHOTOS_BELOW_MIN", reason: `фото меньше минимума (${sale.photoCount} из ${MIN_PROPERTY_PHOTOS})`, nextStep: `${cap(agentWho)}: добавить фото.`, nextBy: "AGENT", nextByName: ownerName };
  }
  if (codes.includes("LINK_NOT_INSTAGRAM")) {
    return { kind: "WRONG_LINK", reason: "в поле видео-обзора ссылка не на Instagram", nextStep: "Маркетинг: заменить ссылку на ролик в Instagram или очистить поле.", nextBy: "MARKETING", nextByName: null };
  }
  const eligibility = saleWithoutInstagramEligibility(row);
  if (eligibility.eligible) {
    return {
      kind: "NO_INSTAGRAM_CAN_BYPASS",
      reason: `ролик принят и вышел в ${eligibility.channels.join(", ")}; нет Instagram — директор может вывести без него`,
      nextStep: "Директор или администратор: «Вывести в продажу без Instagram» в карточке (или попросить Шабнам); либо починить доступ к Instagram в Настройках → Каналы.",
      nextBy: "DIRECTOR",
      nextByName: null,
      withoutInstagram: { channels: eligibility.channels },
    };
  }
  return {
    kind: "NOT_PUBLISHED_ANYWHERE",
    reason: eligibility.channels.length === 0 ? "ролик принят, но не вышел ни в одну сеть" : eligibility.reason,
    nextStep: "Директор или администратор: проверить публикацию («Что не доехало») и доступы к соцсетям в Настройках → Каналы.",
    nextBy: "DIRECTOR",
    nextByName: null,
  };
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Объекты в конвейере подготовки дольше `minDays` суток на одном этапе — самые давние первыми.
 * `ownerAgentId` — только объекты этого хозяина (для агента: «мои застрявшие»).
 */
export async function listStuckBeforeSale(opts: {
  now?: Date;
  minDays?: number;
  limit?: number;
  ownerAgentId?: string;
} = {}): Promise<StuckBeforeSaleResult> {
  const now = opts.now ?? new Date();
  const minDays = Math.max(1, Math.floor(opts.minDays ?? STUCK_BEFORE_SALE_MIN_DAYS));
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? STUCK_BEFORE_SALE_DEFAULT_LIMIT)), STUCK_BEFORE_SALE_MAX_LIMIT);
  // «N суток на этапе» по календарю Душанбе: этап начался не позже, чем N суток назад от начала сегодняшних.
  const cutoff = new Date(dushanbeStartOfToday(now).getTime() - (minDays - 1) * DAY_MS);
  const where: Prisma.PropertyWhereInput = {
    deletedAt: null,
    status: { in: [...PROPERTY_PIPELINE_STATUSES] },
    stageEnteredAt: { lt: cutoff },
    ...(opts.ownerAgentId ? propertyOwnerWhere(opts.ownerAgentId) : {}),
  };
  const [total, rows, settings, clipOwner] = await Promise.all([
    prisma.property.count({ where }),
    prisma.property.findMany({ where, select, orderBy: [{ stageEnteredAt: "asc" }, { id: "asc" }], take: limit }),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } }),
    getClipOwnerSettings(),
  ]);

  // Статус задания публикации — одним запросом на всю пачку, как у get_property_work_status по одному.
  const received = rows.filter((r) => r.status === "EDITING" && r.videoHandoffStatus === "RECEIVED" && r.videoHandoffFinalPath && r.videoHandoffReceivedAt);
  const jobs = received.length
    ? await prisma.backgroundJob.findMany({
        where: {
          dedupeKey: { in: received.map((r) => videoHandoffPublishDedupeKey(r.id)) },
          status: { in: ["PENDING", "RUNNING", "GIVEN_UP", "SKIPPED"] },
        },
        select: { dedupeKey: true, status: true, updatedAt: true },
      })
    : [];
  const jobByKey = new Map(jobs.map((j) => [j.dedupeKey, j]));

  const montajerId = settings?.videoMontajerAgentId ?? null;
  const nameIds = new Set<string>(montajerId ? [montajerId] : []);
  for (const r of rows) {
    const owner = propertyOwnerAgentId(r);
    if (owner) nameIds.add(owner);
  }
  const people = nameIds.size
    ? await prisma.agent.findMany({ where: { id: { in: [...nameIds] } }, select: { id: true, fullName: true } })
    : [];
  const names = new Map(people.map((p) => [p.id, p.fullName]));
  const ctx: StuckBeforeSaleContext = { now, names, montajerId, clipOwnerApprove: clipOwner.enabled };

  const items = rows.map((row): StuckBeforeSaleItem => {
    const job = row.videoHandoffReceivedAt ? jobByKey.get(videoHandoffPublishDedupeKey(row.id)) : undefined;
    // Задание старше приёма ролика — от прошлого цикла, этот ролик оно не описывает (как в get_property_work_status).
    const jobStatus = job && row.videoHandoffReceivedAt && job.updatedAt >= row.videoHandoffReceivedAt
      ? (job.status as "PENDING" | "RUNNING" | "GIVEN_UP" | "SKIPPED")
      : undefined;
    const verdict = describeStuckBeforeSale(row, ctx, jobStatus);
    const ownerAgentId = propertyOwnerAgentId(row);
    return {
      propertyId: row.id,
      shortId: row.shortId,
      code: formatPropertyCode(row.shortId),
      title: row.title,
      stage: row.status as PropertyStatus,
      stageLabel: PROPERTY_STATUS_LABEL_RU[row.status as PropertyStatus],
      since: shortDushanbeDate(row.stageEnteredAt, now),
      days: dushanbeDaysBetween(row.stageEnteredAt, now),
      ...verdict,
      ownerAgentId,
      ownerAgentName: ownerAgentId ? (names.get(ownerAgentId) ?? null) : null,
      blockers: blockersForSale({ instagramUrl: row.instagramUrl, photoCount: row._count.photos }),
    };
  });
  return { total, items, minDays };
}
