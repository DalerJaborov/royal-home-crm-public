import { useEffect, useRef, useState } from "react";
import type { SendTargetInfo as TargetInfo } from "@royal-home/shared";
import { Copy, MessageSquareText, Share2 } from "lucide-react";
import type { SendPropertiesFallback, SendTargetInfo } from "@royal-home/shared";
import { api } from "../../lib/api";
import { ApiError } from "../../lib/apiError";
import { toast } from "../../store/toast";
import { useQueryClient } from "@tanstack/react-query";

/**
 * ОТКАЗ МЕССЕНДЖЕРА — НЕ ТУПИК (28.09.2026, владелец: «агенты не могут
 * отправлять объекты, такая проблема была и не решена»).
 *
 * Раньше отказ (клиент не писал сутки и Meta закрыла окно, канал выключен,
 * клиент вообще не писал в мессенджер) заканчивался красной строкой — и всё.
 * Агент не мог ни повторить, ни отправить иначе, и объект так и не доходил.
 * Теперь сервер вместе с отказом отдаёт тот же текст и те же ссылки, что ушли
 * бы клиенту, а здесь три способа довести их самому: скопировать, поделиться
 * через телефон, отправить СМС (если подключены и номер таджикский).
 */

/** Запасной путь из ошибки отправки, если сервер его приложил. */
export function sendFallbackOf(err: unknown): SendPropertiesFallback | null {
  if (!(err instanceof ApiError)) return null;
  const data = err.data as { fallback?: SendPropertiesFallback } | undefined;
  return data?.fallback && Array.isArray(data.fallback.links) ? data.fallback : null;
}

/** Уйдёт ли в мессенджер: канал есть, включён, окно Meta открыто. Пока не знаем — считаем, что да. */
export function targetReady(info: TargetInfo | undefined): boolean {
  return !info || (info.channel !== null && info.channelEnabled && info.windowOpen);
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
  clientId,
  message,
  fallback,
  smsAvailable,
  onDone,
  tone = "crit",
}: {
  clientId: string;
  /** Что сказал сервер — первой строкой, словами. */
  message: string;
  /** `crit` — мессенджер отказал; `warn` — заранее знали, что не пропустит, и не пытались. */
  tone?: "crit" | "warn";
  fallback: SendPropertiesFallback;
  smsAvailable: boolean;
  /** Ушло по СМС хотя бы что-то — родитель может отметить объекты отправленными. */
  onDone?: (propertyIds: string[]) => void;
}) {
  const qc = useQueryClient();
  const [smsState, setSmsState] = useState<"idle" | "sending" | "done">("idle");
  const [smsResult, setSmsResult] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // На телефоне карточка появляется посреди длинного списка — часто за краем
  // экрана, и нажатие «ничего не делало». Подводим её в поле зрения сами.
  useEffect(() => {
    cardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [fallback]);

  function copyText() {
    void navigator.clipboard
      .writeText(fallback.text)
      .then(() => toast.success("Текст со ссылками скопирован — вставьте его клиенту"))
      .catch(() => toast.error("Буфер обмена недоступен — выделите ссылку ниже и скопируйте вручную"));
  }

  function share() {
    // Без await до вызова: системное меню живёт только пока «жив след» нажатия
    // (lib/share.ts). Меню нет — тот же текст в буфер.
    if (typeof navigator.share === "function") {
      navigator.share({ text: fallback.text }).catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        copyText();
      });
      return;
    }
    copyText();
  }

  async function sendSms() {
    setSmsState("sending");
    setSmsResult(null);
    const sentIds: string[] = [];
    const problems: string[] = [];
    // По одному объекту: у каждого своя личная ссылка и свой счёт «открыл/не открыл».
    for (const link of fallback.links) {
      try {
        const res = await api<{ sent: number; items: { status: string; reason?: string }[] }>(
          `/properties/${link.propertyId}/sms-share`,
          { method: "POST", body: { clientIds: [clientId] } }
        );
        if (res.sent > 0) sentIds.push(link.propertyId);
        else problems.push(`№${link.shortId}: ${res.items[0]?.reason ?? "не ушло"}`);
      } catch (err) {
        problems.push(`№${link.shortId}: ${err instanceof Error ? err.message : "не ушло"}`);
        break;
      }
    }
    setSmsState("done");
    setSmsResult(
      sentIds.length > 0
        ? `По СМС ушло: ${sentIds.length} из ${fallback.links.length}.${problems.length ? ` ${problems.join("; ")}` : ""}`
        : `СМС не ушло. ${problems.join("; ")}`
    );
    if (sentIds.length > 0) {
      qc.invalidateQueries({ queryKey: ["client"] });
      onDone?.(sentIds);
    }
  }

  return (
    <div ref={cardRef} className="card" style={{ marginTop: "var(--s3)", scrollMarginBottom: 96 }} role="alert">
      <div className={`quiet ${tone}`}>
        <span className={`dot ${tone}`} />
        <span className="txt">{message}</span>
      </div>
      <p className="state" style={{ paddingTop: 0 }}>
        Текст и ссылки готовы — отправьте их клиенту сами:
      </p>
      {/* Сетка, а не ряд с переносом: на телефоне три кнопки вставали столбиком
          по одной в строку. Главная — во всю ширину, две тихие — рядом. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s2)" }}>
        {smsAvailable && (
          <button
            type="button"
            className="pill"
            style={{ gridColumn: "1 / -1", justifyContent: "center" }}
            onClick={() => void sendSms()}
            disabled={smsState === "sending"}
          >
            <MessageSquareText className="i" strokeWidth={1.6} />
            {smsState === "sending" ? "Отправляю СМС…" : "Отправить по СМС"}
          </button>
        )}
        <button type="button" className="pill ghost" style={{ justifyContent: "center" }} onClick={share}>
          <Share2 className="i" strokeWidth={1.6} />
          Поделиться
        </button>
        <button type="button" className="pill ghost" style={{ justifyContent: "center" }} onClick={copyText}>
          <Copy className="i" strokeWidth={1.6} />
          Скопировать
        </button>
      </div>
      {smsResult && (
        <div className={`quiet${smsResult.startsWith("СМС не ушло") ? " crit" : ""}`}>
          <span className={`dot ${smsResult.startsWith("СМС не ушло") ? "crit" : "ok"}`} />
          <span className="txt">{smsResult}</span>
        </div>
      )}
      <div className="list">
        {fallback.links.map((l) => (
          <div className="row" key={l.propertyId}>
            <div className="t">
              <b>Объект №{l.shortId}</b>
              <span style={{ userSelect: "all", wordBreak: "break-all" }}>{l.url}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
