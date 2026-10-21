import { useEffect, useRef, useState } from "react";
import type { SendTargetInfo as TargetInfo } from "@royal-home/shared";
import { Copy, MessageSquareText, Share2 } from "lucide-react";
import type { SendPropertiesFallback, SendTargetInfo } from "@royal-home/shared";
import { api } from "../../lib/api";
import { ApiError } from "../../lib/apiError";
import { toast } from "../../store/toast";
import { useIsReadOnly } from "../../lib/permissions";
import { ConfirmDialog } from "../ConfirmDialog";
import { useQueryClient } from "@tanstack/react-query";

/** Preview and manual handoff use prepared links without pretending a message
 * was delivered. SMS is confirmed separately because every message may cost money. */

/** Запасной путь из ошибки отправки, если сервер его приложил. */
export function sendFallbackOf(err: unknown): SendPropertiesFallback | null {
  if (!(err instanceof ApiError)) return null;
  const data = err.data as { fallback?: SendPropertiesFallback } | undefined;
  return data?.fallback && Array.isArray(data.fallback.links) ? data.fallback : null;
}

/** Уйдёт ли в мессенджер: канал есть, включён, окно Meta открыто. Неизвестный статус не разрешает отправку. */
export function targetReady(info: TargetInfo | undefined): boolean {
  return !!info && info.channel !== null && info.channelEnabled && info.windowOpen;
}

/** Точка и цвет строки «куда уйдёт»: зелёная — уйдёт, жёлтая — не уйдёт, но есть обход. */
export function SendTargetNote({ info, isLoading, failed, retry }: { info: SendTargetInfo | undefined; isLoading?: boolean; failed?: boolean; retry?: () => unknown }) {
  if (failed) return <div className="quiet warn" role="alert"><span className="dot warn" /><span className="txt">Не удалось проверить канал отправки. Обновите статус перед отправкой.</span>{retry && <button className="lnk" type="button" onClick={() => void retry()}>Повторить</button>}</div>;
  if (isLoading) {
    return (
      <div className="quiet">
        <span className="dot" />
        <span className="txt">Проверяю, куда уйдёт сообщение…</span>
      </div>
    );
  }
  if (!info) return null;
  const ready = targetReady(info);
  return (
    <div className={`quiet${ready ? "" : " warn"}`} role="status">
      <span className={`dot ${ready ? "ok" : "warn"}`} />
      <span className="txt">{info.hint}</span>
    </div>
  );
}

export function SendFallback({
  clientId, message, fallback, smsAvailable, onDone, tone = "crit", disabled = false, onBusyChange, layer,
}: {
  clientId: string; message: string; tone?: "crit" | "warn"; fallback: SendPropertiesFallback;
  smsAvailable: boolean; onDone?: (propertyIds: string[]) => void;
  disabled?: boolean; onBusyChange?: (busy: boolean) => void; layer?: "above-chat";
}) {
  const qc = useQueryClient();
  const accountReadOnly = useIsReadOnly();
  const readOnlyRef = useRef(accountReadOnly);
  readOnlyRef.current = accountReadOnly;
  const busyRef = useRef(false);
  const [smsSending, setSmsSending] = useState(false);
  const [smsConfirmOpen, setSmsConfirmOpen] = useState(false);
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());
  const [smsResult, setSmsResult] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const remainingLinks = fallback.links.filter(link => !sentIds.has(link.propertyId));
  const blocked = accountReadOnly || disabled || smsSending;

  useEffect(() => {
    cardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [fallback]);

  function copyText() {
    if (readOnlyRef.current || disabled || busyRef.current) return;
    if (!navigator.clipboard?.writeText) {
      toast.error("Буфер обмена недоступен — выделите текст ниже и скопируйте вручную");
      return;
    }
    void navigator.clipboard.writeText(fallback.text)
      .then(() => toast.success("Скопировано. Отправьте текст клиенту в выбранном приложении."))
      .catch(() => toast.error("Буфер обмена недоступен — выделите текст ниже и скопируйте вручную"));
  }

  function share() {
    if (readOnlyRef.current || disabled || busyRef.current) return;
    // navigator.share must run in the original user gesture, without an awaited API.
    if (typeof navigator.share === "function") {
      void navigator.share({ text: fallback.text }).then(() => toast.success("Текст передан в выбранное приложение. Доставка клиенту пока не подтверждена.")).catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        toast.error("Не удалось открыть меню. Скопируйте текст и отправьте вручную.");
      });
    } else copyText();
  }

  async function sendSms() {
    if (readOnlyRef.current || disabled || busyRef.current || remainingLinks.length === 0) return;
    busyRef.current = true;
    setSmsSending(true);
    onBusyChange?.(true);
    setSmsConfirmOpen(false);
    setSmsResult(null);
    const accepted: string[] = [];
    const problems: string[] = [];
    try {
      for (const link of remainingLinks) {
        if (readOnlyRef.current) break;
        try {
          const res = await api<{ sent: number; items: { status: string; reason?: string }[] }>(
            `/properties/${link.propertyId}/sms-share`, { method: "POST", body: { clientIds: [clientId] } });
          if (res.sent > 0 && res.items.some(item => item.status === "sent")) accepted.push(link.propertyId);
          else problems.push(`№${link.shortId}: ${res.items[0]?.reason ?? "не отправлено"}`);
        } catch (err) {
          problems.push(`№${link.shortId}: ${err instanceof Error ? err.message : "не отправлено"}`);
          break;
        }
      }
      setSentIds(prev => new Set([...prev, ...accepted]));
      setSmsResult(`Принято SMS-шлюзом: ${accepted.length} из ${remainingLinks.length}. Это не подтверждение получения.${problems.length ? ` ${problems.join("; ")}` : ""}`);
      if (accepted.length > 0) {
        void qc.invalidateQueries({ queryKey: ["client"] });
        void qc.invalidateQueries({ queryKey: ["client-match", clientId] });
        onDone?.(accepted);
      }
    } finally {
      busyRef.current = false;
      setSmsSending(false);
      onBusyChange?.(false);
    }
  }

  if (accountReadOnly) return null;
  return <div ref={cardRef} className="client-match-send-options" style={{ scrollMarginBottom: 96 }}>
    <p className={`quiet ${tone}`} role="status">{message}</p>
    <label className="client-match-preview-text">Сообщение клиенту
      <textarea className="inp" rows={Math.min(12, 3 + fallback.links.length * 3)} value={fallback.text} readOnly aria-label="Предпросмотр сообщения клиенту" />
    </label>
    <div className="filters" aria-label="Способы отправки подборки">
      <button type="button" className="pill ghost" onClick={copyText} disabled={blocked}><Copy className="i" strokeWidth={1.6} />Скопировать текст</button>
      {typeof navigator !== "undefined" && typeof navigator.share === "function" && <button type="button" className="pill ghost" onClick={share} disabled={blocked}><Share2 className="i" strokeWidth={1.6} />Поделиться</button>}
      {smsAvailable && <button type="button" className="pill ghost" disabled={blocked || remainingLinks.length === 0} onClick={() => setSmsConfirmOpen(true)}>
        <MessageSquareText className="i" strokeWidth={1.6} />{smsSending ? "Отправляем СМС…" : remainingLinks.length > 0 ? `По СМС · ${remainingLinks.length}` : "СМС уже отправлены"}
      </button>}
    </div>
    {smsAvailable && <p className="state">Для СМС сервер подготовит отдельное короткое сообщение по каждому объекту: номер, площадь, цена, личная ссылка и контакт агента.</p>}
    {smsResult && <p className="state" role="status">{smsResult}</p>}
    {!disabled && smsConfirmOpen && <ConfirmDialog title="Отправить подборку по СМС"
      description={`Будет отправлено до ${remainingLinks.length} отдельных СМС. Отправка платная; повтор одного объекта клиенту возможен через 7 дней. Недоступные объекты и номера сервер пропустит.`}
      confirmLabel="Отправить по СМС" danger={false} layer={layer} onConfirm={() => void sendSms()} onCancel={() => setSmsConfirmOpen(false)} />}
  </div>;
}
