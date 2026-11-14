import { useState } from "react";
import { FileDown, Send } from "lucide-react";
import { REPORT_PDF_PERMISSION, type ReportPdfKind } from "@royal-home/shared";
import { api } from "../lib/api";
import { useCan } from "../lib/permissions";

/**
 * «Скачать PDF» и «PDF в Telegram» для больших отчетов (14.11.2026). Одна
 * деталь на все экраны: Финансы (обе оболочки) и Отчёты. Кнопок нет у того,
 * кому сервер всё равно откажет: право то же, что открывает сам отчёт
 * (REPORT_PDF_PERMISSION). В Telegram файл уходит только в свой чат.
 */
export function reportPdfPath(kind: ReportPdfKind, params: Record<string, string | number | undefined>, telegram = false): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const q = qs.toString();
  return `/report-pdf/${kind}${telegram ? "/telegram" : ""}${q ? `?${q}` : ""}`;
}

/** Большой отчёт собирается дольше обычного запроса. */
const PDF_TIMEOUT_MS = 60_000;

export function ReportPdfActions({
  kind,
  params,
  buttonClassName = "pill ghost",
  layout = "row",
  disabled = false,
}: {
  kind: ReportPdfKind;
  params: Record<string, string | number | undefined>;
  buttonClassName?: string;
  layout?: "row" | "contents";
  disabled?: boolean;
}) {
  const can = useCan();
  const [busy, setBusy] = useState<"download" | "telegram" | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  if (!can(REPORT_PDF_PERMISSION[kind])) return null;

  async function download() {
    if (busy) return;
    setBusy("download");
    setStatus(null);
    try {
      const blob = await api<Blob>(reportPdfPath(kind, params), { responseType: "blob", timeoutMs: PDF_TIMEOUT_MS });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `royal-home-${kind}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : "Не удалось собрать PDF" });
    } finally {
      setBusy(null);
    }
  }

  async function telegram() {
    if (busy) return;
    setBusy("telegram");
    setStatus(null);
    try {
      await api(reportPdfPath(kind, params, true), { method: "POST", timeoutMs: PDF_TIMEOUT_MS });
      setStatus({ ok: true, text: "PDF отправлен вам в Telegram" });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : "Не удалось отправить PDF" });
    } finally {
      setBusy(null);
    }
  }

  const buttons = (
    <>
      <button type="button" className={buttonClassName} onClick={download} disabled={disabled || busy !== null} aria-busy={busy === "download"}>
        <FileDown size={18} aria-hidden="true" />
        <span>{busy === "download" ? "Готовим PDF…" : "Скачать PDF"}</span>
      </button>
      <button type="button" className={buttonClassName} onClick={telegram} disabled={disabled || busy !== null} aria-busy={busy === "telegram"}>
        <Send size={18} aria-hidden="true" />
        <span>{busy === "telegram" ? "Отправляем…" : "PDF в Telegram"}</span>
      </button>
      {status && (
        <p role={status.ok ? "status" : "alert"} className={status.ok ? "text-sm text-gray" : "text-sm text-red-600"} style={{ flexBasis: "100%", margin: 0 }}>
          {status.text}
        </p>
      )}
    </>
  );
  if (layout === "contents") return buttons;
  return <div className="flex flex-wrap items-center gap-2">{buttons}</div>;
}
