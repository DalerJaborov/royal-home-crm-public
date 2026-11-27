import { REPORT_PDF_TITLES, type ReportPdfKind } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { logAgentAudit } from "../audit.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import { sendDocumentFile } from "../../telegram/api.js";
import { buildReportPdf, ReportPdfInputError, type ReportPdfViewer } from "./build.js";
import { ReportPdfBusyError, ReportPdfTimeoutError } from "./render.js";

/**
 * ОДНА ДВЕРЬ: «PDF-ОТЧЁТ СЕБЕ В TELEGRAM» (27.11.2026).
 *
 * Два входа — кнопка «В Telegram» на экране отчётов (POST /report-pdf/:kind/telegram) и
 * просьба Шабнам («пришли финансовый отчёт PDF»). Раньше путь жил только в маршруте, и
 * Шабнам честно отвечала владельцу «я не могу сама формировать PDF, он приходит в конце
 * месяца» (скриншот 27.11). Теперь оба входа зовут эту функцию: тот же файл, что месячная
 * рассылка (buildReportPdf), та же проверка права, тот же журнал.
 *
 * Получатель — ТОЛЬКО свой привязанный чат сотрудника из базы (Agent.telegramChatId):
 * адреса во входе нет вовсе, отчёт нельзя отправить ни клиенту, ни чужому.
 * Чтение, а не запись: акционеру (режим просмотра) путь открыт.
 *
 * Частота — не чаще раза в минуту на человека (сборка PDF — тяжёлая работа на сервере,
 * а модель или двойное нажатие могли бы просить подряд). Счётчик в памяти процесса:
 * просьбы из Telegram и с экрана идут в процесс API.
 */
export const OWN_TELEGRAM_PDF_COOLDOWN_MS = 60_000;
const lastSentAt = new Map<string, number>();

export type OwnTelegramPdfOutcome =
  | { ok: true; periodLabel: string; periodKey: string; filename: string }
  | { ok: false; status: number; error: string; code: "NO_TELEGRAM" | "TOO_OFTEN" | "INPUT" | "BUSY" | "TIMEOUT" | "TELEGRAM" | "FAILED" | "ABORTED"; retryAfterSec?: number };

export interface OwnTelegramPdfOptions {
  /** Откуда просьба — в журнал действий. */
  source: "screen" | "assistant";
  now?: Date;
  /**
   * Срок ответа помощницы. Истёк, пока собирался файл, — НЕ отправляем: человек уже
   * получил «не успела», и файл, пришедший молча следом, выглядел бы как сбой (ревью #506).
   */
  signal?: AbortSignal;
}

/** Для тестов: сбросить счётчик частоты. */
export function resetOwnTelegramPdfCooldown(): void {
  lastSentAt.clear();
}

export async function sendReportPdfToOwnTelegram(
  viewer: ReportPdfViewer,
  kind: ReportPdfKind,
  rawQuery: unknown,
  opts: OwnTelegramPdfOptions,
): Promise<OwnTelegramPdfOutcome> {
  const me = await prisma.agent.findUnique({ where: { id: viewer.agentId }, select: { telegramChatId: true } });
  const chatId = me?.telegramChatId ? String(me.telegramChatId) : null;
  if (!chatId) return { ok: false, status: 409, code: "NO_TELEGRAM", error: "Привяжите свой Telegram в профиле — туда придёт отчёт" };

  const nowMs = (opts.now ?? new Date()).getTime();
  const last = lastSentAt.get(viewer.agentId);
  if (last !== undefined && nowMs - last < OWN_TELEGRAM_PDF_COOLDOWN_MS) {
    const retryAfterSec = Math.ceil((OWN_TELEGRAM_PDF_COOLDOWN_MS - (nowMs - last)) / 1000);
    return { ok: false, status: 429, code: "TOO_OFTEN", retryAfterSec, error: `Отчёт только что отправлен. Повторить можно через ${retryAfterSec} с` };
  }
  // Место занимается до сборки: две просьбы подряд не соберут два файла.
  lastSentAt.set(viewer.agentId, nowMs);

  let pdf;
  try {
    pdf = await buildReportPdf(kind, rawQuery, viewer, opts.now);
  } catch (err) {
    lastSentAt.delete(viewer.agentId);
    if (err instanceof ReportPdfInputError) return { ok: false, status: err.status, code: "INPUT", error: err.message };
    if (err instanceof ReportPdfBusyError) return { ok: false, status: 429, code: "BUSY", retryAfterSec: 20, error: err.message };
    const timeout = err instanceof ReportPdfTimeoutError;
    void logSystemError("api", `PDF «${REPORT_PDF_TITLES[kind]}» не собран (${opts.source}): ${describeError(err)}`);
    return timeout
      ? { ok: false, status: 504, code: "TIMEOUT", error: "Отчёт собирается слишком долго. Попробуйте позже или сократите период" }
      : { ok: false, status: 500, code: "FAILED", error: "Не удалось собрать PDF. Попробуйте позже" };
  }
  if (opts.signal?.aborted) {
    lastSentAt.delete(viewer.agentId);
    return { ok: false, status: 504, code: "ABORTED", error: "Не успела собрать отчёт вовремя, файл не отправлен. Попросите ещё раз" };
  }
  try {
    await sendDocumentFile(chatId, pdf.buffer, pdf.filename, `${REPORT_PDF_TITLES[kind]} · ${pdf.periodLabel}`);
  } catch (err) {
    lastSentAt.delete(viewer.agentId);
    void logSystemError("telegram", `PDF «${REPORT_PDF_TITLES[kind]}» не отправлен в Telegram (${opts.source}): ${describeError(err)}`);
    return { ok: false, status: 503, code: "TELEGRAM", error: "Telegram не принял файл. Повторите позже или скачайте PDF" };
  }
  logAgentAudit(viewer.agentId, "REPORT_PDF_EXPORT", "Report", kind, {
    destination: "ownTelegram",
    period: pdf.periodKey,
    bytes: pdf.buffer.length,
    source: opts.source,
  });
  return { ok: true, periodLabel: pdf.periodLabel, periodKey: pdf.periodKey, filename: pdf.filename };
}
