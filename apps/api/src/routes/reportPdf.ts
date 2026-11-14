import { Router, type Request, type Response } from "express";
import { reportPdfKindSchema, REPORT_PDF_PERMISSION, REPORT_PDF_TITLES, type ReportPdfKind } from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { logAudit } from "../lib/audit.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { sendDocumentFile } from "../telegram/api.js";
import { buildReportPdf, ReportPdfInputError, type ReportPdfViewer } from "../lib/reportPdf/build.js";
import { ReportPdfBusyError, ReportPdfTimeoutError } from "../lib/reportPdf/render.js";

/**
 * PDF-ОТЧЁТЫ (14.11.2026).
 *   GET  /api/v1/report-pdf/:kind?…          — файл в браузер («Скачать PDF»);
 *   POST /api/v1/report-pdf/:kind/telegram?… — тот же файл себе в Telegram.
 *
 * Telegram — только СВОЙ чат сотрудника (Agent.telegramChatId, тот же путь, что
 * у выгрузки расходов): получателя в запросе нет вовсе, поэтому отчёт нельзя
 * отправить ни клиенту, ни чужому человеку. Каждая выгрузка — строка в журнале
 * действий (REPORT_PDF_EXPORT) с видом отчёта, периодом и способом доставки.
 */
export const reportPdfRouter = Router();
reportPdfRouter.use(requireAuth);

/** Кто выгружает: права из запроса, имя и свой Telegram — из карточки сотрудника. */
async function viewerOf(req: Request): Promise<ReportPdfViewer & { telegramChatId: string | null }> {
  const agent = req.agent!;
  const me = await prisma.agent.findUnique({ where: { id: agent.id }, select: { fullName: true, telegramChatId: true } });
  return {
    agentId: agent.id,
    name: me?.fullName ?? "Сотрудник Royal Home",
    role: agent.role,
    can: (p) => agent.permissions.has(p),
    telegramChatId: me?.telegramChatId ? String(me.telegramChatId) : null,
  };
}

function parseKind(req: Request, res: Response): ReportPdfKind | null {
  const kind = reportPdfKindSchema.safeParse(req.params.kind);
  if (!kind.success) {
    res.status(404).json({ error: "Такого отчёта нет" });
    return null;
  }
  // Право проверяется до сборки: отказ не должен стоить запроса в базу.
  if (!req.agent!.permissions.has(REPORT_PDF_PERMISSION[kind.data])) {
    res.status(403).json({ error: "Недостаточно прав" });
    return null;
  }
  return kind.data;
}

/** Ошибки сборки → понятный ответ; неожиданные — в журнал ошибок. */
function failed(res: Response, kind: ReportPdfKind, err: unknown) {
  if (err instanceof ReportPdfInputError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ReportPdfBusyError) {
    res.set("Retry-After", "20");
    return res.status(429).json({ error: err.message });
  }
  const timeout = err instanceof ReportPdfTimeoutError;
  void logSystemError("api", `PDF «${REPORT_PDF_TITLES[kind]}» не собран: ${describeError(err)}`);
  return res.status(timeout ? 504 : 500).json({ error: timeout ? "Отчёт собирается слишком долго — сократите период" : "Не удалось собрать PDF" });
}

reportPdfRouter.get("/:kind", async (req, res) => {
  const kind = parseKind(req, res);
  if (!kind) return;
  try {
    const pdf = await buildReportPdf(kind, req.query, await viewerOf(req));
    logAudit(req, "REPORT_PDF_EXPORT", "Report", kind, { destination: "download", period: pdf.periodKey, bytes: pdf.buffer.length });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${pdf.filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf.buffer);
  } catch (err) {
    failed(res, kind, err);
  }
});

reportPdfRouter.post("/:kind/telegram", async (req, res) => {
  const kind = parseKind(req, res);
  if (!kind) return;
  const viewer = await viewerOf(req);
  if (!viewer.telegramChatId) return res.status(409).json({ error: "Привяжите свой Telegram в профиле — туда придёт отчёт" });
  try {
    const pdf = await buildReportPdf(kind, req.query, viewer);
    try {
      await sendDocumentFile(viewer.telegramChatId, pdf.buffer, pdf.filename, `${REPORT_PDF_TITLES[kind]} · ${pdf.periodLabel}`);
    } catch (err) {
      void logSystemError("telegram", `PDF «${REPORT_PDF_TITLES[kind]}» не отправлен в Telegram: ${describeError(err)}`);
      return res.status(503).json({ error: "Telegram не принял файл. Повторите позже или скачайте PDF" });
    }
    logAudit(req, "REPORT_PDF_EXPORT", "Report", kind, { destination: "ownTelegram", period: pdf.periodKey, bytes: pdf.buffer.length });
    res.json({ ok: true });
  } catch (err) {
    failed(res, kind, err);
  }
});
