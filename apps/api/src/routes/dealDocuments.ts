import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { dealDocumentUploadSchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, foreignDealWriteDenied, requireAuth, requirePermission, scopeDealsToOwnAgent } from "../auth/middleware.js";
import { dealDocumentUpload } from "../upload.js";
import { deleteDealDocumentFile, dealDocumentFilePath, dealDocumentMimeType, saveDealDocumentFile } from "../lib/dealDocumentFiles.js";
import { createDealDocument, deleteDealDocument, getDealDocument, listDealDocuments } from "../lib/dealDocumentsDb.js";
import { logAudit } from "../lib/audit.js";
import { anyParams } from "../lib/routeParams.js";

/**
 * Документы сделки (Пачка 14, 11.09.2026): список, загрузка, удаление, выдача
 * файла. Хранилище — lib/dealDocumentFiles.ts (закрытая папка вне `uploads`,
 * своя, не lib/privateFiles.ts — см. докстринг там про ночную уборку). Таблица
 * `DealDocument` — через lib/dealDocumentsDb.ts ($queryRaw/$executeRaw, см.
 * докстринг там: prisma generate запрещён в этом worktree).
 *
 * Право на роутер — `deals.manageDocuments` (даёт AGENT/MANAGER/ADMIN/DIRECTOR).
 * Сверх права — владение: своя сделка либо `deals.viewAll` (тот же принцип, что
 * у остальных роутов сделок, см. scopeDealsToOwnAgent в auth/middleware.ts).
 */
export const dealDocumentsRouter = Router();

/**
 * Право — НА КАЖДОМ ПУТИ, а не `.use` на весь роутер (глубокая проверка
 * 02.10.2026, A8). Роутер смонтирован на /api/v1/deals раньше dealPayoutRouter
 * (app.ts), и мидлвар `.use` срабатывал на ЛЮБОЙ дошедший до него путь — в том
 * числе на /:id/payout: выплата по сделке оказывалась закрыта правом на
 * документы, а не своими правами (deals.viewAll на чтение, finance.manage /
 * deals.setCommission на отметку).
 */
const documentsGuard = requirePermission("deals.manageDocuments");

async function loadOwnedDeal(req: import("express").Request, dealId: string, write = false) {
  const ownAgentId = scopeDealsToOwnAgent(req);
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { id: true, agentId: true, stage: true } });
  if (!deal) return { deal: null, forbidden: false };
  if (ownAgentId && deal.agentId !== ownAgentId) return { deal: null, forbidden: true };
  // Видеть все сделки — не значит менять документы в чужой (A3, см.
  // foreignDealWriteDenied в auth/middleware.ts).
  if (write && foreignDealWriteDenied(req, deal, ownAgentId)) return { deal: null, forbidden: true };
  return { deal, forbidden: false };
}

dealDocumentsRouter.get("/:id/documents", requireAuth, documentsGuard, async (req, res) => {
  const { deal, forbidden } = await loadOwnedDeal(req, req.params.id);
  if (forbidden) return res.status(403).json({ error: "Недостаточно прав" });
  if (!deal) return res.status(404).json({ error: "Сделка не найдена" });

  const documents = await listDealDocuments(deal.id);
  res.json(
    documents.map((d) => ({
      id: d.id,
      kind: d.kind,
      originalName: d.originalName,
      mimeType: d.mimeType,
      uploadedAt: d.uploadedAt,
      uploadedByName: d.uploadedByName,
    }))
  );
});

dealDocumentsRouter.post("/:id/documents", requireAuth, documentsGuard, anyParams(dealDocumentUpload.single("file")), async (req, res) => {
  const { deal, forbidden } = await loadOwnedDeal(req, req.params.id, true);
  if (forbidden) return res.status(403).json({ error: "Недостаточно прав" });
  if (!deal) return res.status(404).json({ error: "Сделка не найдена" });

  if (!req.file) return res.status(400).json({ error: "Файл не получен" });

  const parsed = dealDocumentUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Не указан вид документа", details: parsed.error.flatten() });
  }

  const fileName = saveDealDocumentFile(req.file.buffer, req.file.mimetype);
  if (!fileName) {
    return res.status(400).json({ error: "Недопустимый формат файла" });
  }

  const doc = await createDealDocument({
    dealId: deal.id,
    kind: parsed.data.kind,
    fileName,
    originalName: req.file.originalname.slice(0, 200),
    mimeType: req.file.mimetype,
    uploadedById: req.agent!.id,
  });
  logAudit(req, "DEAL_DOCUMENT_UPLOAD", "Deal", deal.id, { documentId: doc.id, kind: doc.kind });
  res.status(201).json({ id: doc.id, kind: doc.kind, originalName: doc.originalName, mimeType: doc.mimeType, uploadedAt: doc.uploadedAt });
});

const documentParamsSchema = z.object({ id: z.guid(), docId: z.guid() });

dealDocumentsRouter.delete("/:id/documents/:docId", requireAuth, documentsGuard, async (req, res) => {
  const parsedParams = documentParamsSchema.safeParse(req.params);
  if (!parsedParams.success) return res.status(400).json({ error: "Неверные параметры" });

  const { deal, forbidden } = await loadOwnedDeal(req, req.params.id, true);
  if (forbidden) return res.status(403).json({ error: "Недостаточно прав" });
  if (!deal) return res.status(404).json({ error: "Сделка не найдена" });

  // ОТПРАВЛЕННАЯ ИЛИ ЗАКРЫТАЯ СДЕЛКА — ДОКУМЕНТЫ УДАЛЯЕТ ТОЛЬКО РУКОВОДИТЕЛЬ
  // (глубокая проверка 02.10.2026, C5). Сдал договор и свидетельство, отправил на
  // закрытие — и стёр оба: директор одобрял сделку, у которой в CRM нет ни одного
  // подтверждения, а файл уничтожен без следа, кроме строки аудита.
  if ((deal.stage === "PENDING_APPROVAL" || deal.stage === "COMPLETED") && !can(req, "deals.complete")) {
    return res.status(409).json({
      error:
        deal.stage === "COMPLETED"
          ? "Сделка закрыта — удалить её документ может только руководитель"
          : "Сделка отправлена на закрытие — удалить документ может только руководитель. Попросите вернуть её на доработку",
    });
  }

  const doc = await getDealDocument(parsedParams.data.docId);
  if (!doc || doc.dealId !== deal.id) return res.status(404).json({ error: "Документ не найден" });

  await deleteDealDocument(doc.id);
  deleteDealDocumentFile(doc.fileName);
  logAudit(req, "DEAL_DOCUMENT_DELETE", "Deal", deal.id, { documentId: doc.id, kind: doc.kind });
  res.status(204).end();
});

dealDocumentsRouter.get("/:id/documents/:docId/file", requireAuth, documentsGuard, async (req, res) => {
  const parsedParams = documentParamsSchema.safeParse(req.params);
  if (!parsedParams.success) return res.status(400).json({ error: "Неверные параметры" });

  const { deal, forbidden } = await loadOwnedDeal(req, req.params.id);
  if (forbidden) return res.status(403).json({ error: "Недостаточно прав" });
  if (!deal) return res.status(404).json({ error: "Сделка не найдена" });

  const doc = await getDealDocument(parsedParams.data.docId);
  if (!doc || doc.dealId !== deal.id) return res.status(404).json({ error: "Документ не найден" });

  const fullPath = dealDocumentFilePath(doc.fileName);
  if (!fullPath) return res.status(404).json({ error: "Файл не найден" });

  res.setHeader("Content-Type", dealDocumentMimeType(doc.fileName));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.originalName)}"`);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  // root + относительное имя — тот же приём, что в routes/attachments.ts: пакет
  // send проверяет на «скрытый файл» каждый сегмент пути, включая родительские
  // каталоги, абсолютный путь мог бы неожиданно споткнуться об это.
  res.sendFile(path.basename(fullPath), { root: path.dirname(fullPath), cacheControl: false, dotfiles: "deny" }, (err) => {
    if (!err) return;
    console.error("[dealDocuments] не удалось отдать файл:", err instanceof Error ? err.message : err);
    if (res.headersSent) res.end();
    else res.status(500).json({ error: "Не удалось прочитать файл" });
  });
});
