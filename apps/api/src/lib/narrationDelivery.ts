import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { prisma } from "../db.js";
import { buildMontajerDelivery } from "./videoHandoff.js";
import { narrationFacts, narrationHash } from "./propertyNarration.js";
import { localVideoFilePath } from "./localVideoStorage.js";
import { mediaExecutionMode, mediaRecipientHash } from "./mediaExecution.js";
import { sendDocumentFile, TELEGRAM_BOT_SEND_LIMIT_BYTES } from "../telegram/api.js";

const fileSchema = z.object({ id: z.string(), storageKey: z.string(), filename: z.string(), caption: z.string() });
const planSchema = z.object({ factsHash: z.string(), recipientHash: z.string(), files: z.array(fileSchema).min(1), sourcesHash: z.string() });
type Plan = z.infer<typeof planSchema>;
/** Shared by watchdog and manual reconciliation; a whole batch may exceed 3 minutes. */
export function narrationDeliveryAttemptBudgetMs(plan: unknown): number {
  const parsed = planSchema.safeParse(plan);
  return (parsed.success ? parsed.data.files.length : 1) * 90_000 + 120_000;
}
/** Same immutable source builder as the existing montage pipeline. No queue reassignment. */
export async function prepareNarrationDeliveryPlan(propertyId: string, versionId: string, mode: string, requestedEditorId?: string) {
  const [p, version, settings, sources] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, include: { district: true } }),
    prisma.propertyNarrationVersion.findUnique({ where: { id: versionId } }),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } }),
    buildMontajerDelivery(propertyId),
  ]);
  const editorId = requestedEditorId ?? settings?.videoMontajerAgentId;
  if (!p || p.deletedAt || !sources || !version || version.propertyId !== p.id || !version.storageKey || version.status !== "READY" || version.factsHash !== narrationHash(narrationFacts(p))) throw new Error("Нужна актуальная озвучка");
  if (p.videoHandoffStatus !== "SENT_TO_EDITOR" || p.videoHandoffManualSince) throw new Error("Сначала передайте объект в работу монтажёру через существующую очередь монтажа");
  if (!editorId || editorId !== settings?.videoMontajerAgentId) throw new Error("Сначала назначьте монтажёра в существующих настройках монтажа");
  const editor = await prisma.agent.findFirst({ where: { id: editorId, role: "EDITOR", isActive: true }, select: { telegramChatId: true } });
  if (!editor?.telegramChatId) throw new Error("У назначенного монтажёра не подключён Telegram");
  const files: Plan["files"] = [{ id: version.id, storageKey: version.storageKey, filename: `property-${p.shortId}-voice-v${version.revision}.mp3`, caption: `Объект №${p.shortId}. Озвучка, версия ${version.revision}. Используйте эту версию; цена остаётся в описании.` },
    { id: `${version.id}-script`, storageKey: "SCRIPT", filename: `property-${p.shortId}-voice-v${version.revision}.txt`, caption: version.script }];
  if (mode === "WITH_SOURCES") {
    if (!sources.videos.length) throw new Error("У объекта нет исходников");
    for (const video of sources.videos) files.push({ id: video.id, storageKey: video.storageKey, filename: video.filename, caption: `Объект №${p.shortId}. Исходник. Озвучка v${version.revision}.\n${sources.factsText}` });
  }
  return { editorId, plan: { factsHash: version.factsHash, recipientHash: mediaRecipientHash(editorId, editor.telegramChatId), files,
    sourcesHash: narrationHash(mode === "WITH_SOURCES" ? sources.videos.map(v => [v.id, v.storageKey]) : []) } satisfies Plan };
}

export async function executeNarrationDelivery(id: string) {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return { status: "PREVIEW" };
  const claimStartedAt = new Date();
  const claim = await prisma.propertyNarrationDelivery.updateMany({ where: { id, status: "QUEUED", executionMode: "LIVE" }, data: { status: "SENDING", claimStartedAt } });
  if (!claim.count) return { status: "NOT_CLAIMED" };
  let attempted = false, acknowledged = 0;
  try {
    const row = await prisma.propertyNarrationDelivery.findUniqueOrThrow({ where: { id } });
    const plan = planSchema.parse(row.plan);
    for (const file of plan.files) {
      // Resolve a bounded local handle before the short DB preflight. No network under locks.
      let blob: Blob;
      if (file.storageKey === "SCRIPT") blob = new Blob([file.caption], { type: "text/plain;charset=utf-8" });
      else {
        const path = localVideoFilePath(file.storageKey);
        if (!path) throw new Error("Invalid storage key");
        const size = (await stat(path)).size;
        if (!size || size > TELEGRAM_BOT_SEND_LIMIT_BYTES) throw new Error("File unavailable or exceeds Telegram limit");
        blob = await openAsBlob(path);
      }
      const target = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${row.propertyId} FOR NO KEY UPDATE`;
        await tx.$queryRaw`SELECT id FROM "PropertyNarrationDelivery" WHERE id = ${id} FOR UPDATE`;
        const currentDelivery = await tx.propertyNarrationDelivery.findUnique({ where: { id } });
        if (currentDelivery?.status !== "SENDING" || currentDelivery.claimStartedAt?.getTime() !== claimStartedAt.getTime()) return null;
        const p = await tx.property.findUnique({ where: { id: row.propertyId }, include: { district: true } });
        const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: row.propertyId }, orderBy: { revision: "desc" } });
        const settings = await tx.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
        const editor = await tx.agent.findFirst({ where: { id: row.editorId!, role: "EDITOR", isActive: true } });
        const videos = row.mode === "WITH_SOURCES" ? await tx.propertyVideo.findMany({ where: { propertyId: row.propertyId }, orderBy: [{ uploadedAt: "asc" }, { id: "asc" }] }) : [];
        if (mediaExecutionMode("NARRATION") !== "LIVE" || !p || p.deletedAt || p.videoHandoffStatus !== "SENT_TO_EDITOR" || p.videoHandoffManualSince || latest?.id !== row.versionId || latest.status !== "READY" || narrationHash(narrationFacts(p)) !== plan.factsHash || settings?.videoMontajerAgentId !== row.editorId || !editor?.telegramChatId || mediaRecipientHash(editor.id, editor.telegramChatId) !== plan.recipientHash || narrationHash(videos.map(v => [v.id, v.storageKey])) !== plan.sourcesHash) return null;
        return { chatId: editor.telegramChatId, shortId: p.shortId };
      });
      if (!target) {
        const status = acknowledged ? "CANCELLED" : "FAILED";
        await prisma.propertyNarrationDelivery.updateMany({ where: { id, status: "SENDING", claimStartedAt }, data: { status, lastError: "Назначение, очередь монтажа, факты, файлы или версия изменились. Полученные квитанции сохранены." } });
        return { status };
      }
      attempted = true;
      // An in-flight request may finish after revocation; it cannot authorize a next file.
      const sent = await sendDocumentFile(target.chatId, blob, file.filename, file.storageKey === "SCRIPT" ? `Объект №${target.shortId}. Текст озвучки` : file.caption, 60_000, true);
      if (!sent.message_id) throw new Error("Missing Telegram receipt");
      const stillClaimed = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "PropertyNarrationDelivery" WHERE id = ${id} FOR UPDATE`;
        const current = await tx.propertyNarrationDelivery.findUnique({ where: { id } });
        if (!current || current.claimStartedAt?.getTime() !== claimStartedAt.getTime()) return false;
        const active = current.status === "SENDING";
        const previous = current.receipts && typeof current.receipts === "object" && !Array.isArray(current.receipts) ? current.receipts : {};
        await tx.propertyNarrationDelivery.updateMany({ where: { id, claimStartedAt }, data: { receipts: { ...previous, [file.id]: { messageId: sent.message_id, fileId: sent.document?.file_id ?? null, receivedAt: new Date().toISOString(), late: !active } } } });
        return active;
      });
      acknowledged++;
      if (!stillClaimed) return { status: "UNKNOWN" };
    }
    const completed = await prisma.propertyNarrationDelivery.updateMany({ where: { id, status: "SENDING", claimStartedAt }, data: { status: "SENT", deliveredAt: new Date() } });
    return { status: completed.count ? "SENT" : "UNKNOWN" };
  } catch {
    const status = attempted ? "UNKNOWN" : "FAILED";
    await prisma.propertyNarrationDelivery.updateMany({ where: { id, status: "SENDING", claimStartedAt }, data: { status, lastError: attempted ? "Проверьте Telegram монтажёра. Автоповтор отключён; квитанции успешных частей сохранены." : "Передача не началась: проверьте локальные файлы и настройки" } });
    return { status };
  }
}
export async function executeQueuedNarrationDeliveries(now = new Date()) {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return;
  // A legitimate multi-file batch can exceed three minutes. Each file is one bounded
  // 60s request plus 30s file/preflight/receipt margin; no network under DB locks.
  const pending = await prisma.propertyNarrationDelivery.findMany({ where: { status: "SENDING", claimStartedAt: { lt: new Date(now.getTime() - 180_000) } }, select: { id: true, claimStartedAt: true, plan: true } });
  for (const row of pending) {
    const budget = narrationDeliveryAttemptBudgetMs(row.plan);
    if (row.claimStartedAt && now.getTime() - row.claimStartedAt.getTime() > budget) await prisma.propertyNarrationDelivery.updateMany({ where: { id: row.id, status: "SENDING", claimStartedAt: row.claimStartedAt }, data: { status: "UNKNOWN", lastError: "Прерванная передача; нужна сверка с Telegram монтажёра" } });
  }
  const rows = await prisma.propertyNarrationDelivery.findMany({ where: { status: "QUEUED", executionMode: "LIVE" }, orderBy: { createdAt: "asc" }, take: 20, select: { id: true } });
  for (const row of rows) await executeNarrationDelivery(row.id);
}
