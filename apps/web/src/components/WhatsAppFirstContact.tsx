import { useState } from "react";
import { Send } from "lucide-react";
import { WA_FIRST_CONTACT_BUTTON, renderWaFirstContactText, type WaFirstContactStatus } from "@royal-home/shared";
import { useSendWaFirstContact, useWaFirstContactStatus } from "../hooks/useWhatsAppFirstContact";
import { relativeTime } from "../lib/format";

/**
 * «НАПИСАТЬ В WHATSAPP» ПЕРВЫМИ (24.09.2026, просьба владельца).
 *
 * Клиент разрешил написать ему в WhatsApp, но сам не пишет. Meta пускает к нему
 * только заранее одобренный текст — его и шлёт эта кнопка, с кнопкой «Да,
 * присылайте» под ним. Ответил клиент — дальше обычная переписка: видео, фото,
 * ссылки.
 *
 * Один компонент на оба размера экрана: живёт в разделе «Переписка» карточки
 * клиента, который рисуется и на компьютере (вкладка), и на телефоне (лента).
 *
 * Кнопка никогда не «мёртвая без слов»: пока Meta текст не одобрила, пока ждём
 * ответа, пока номер не годится — под ней написано, почему.
 */

const STATUS_LABEL: Record<NonNullable<WaFirstContactStatus["last"]>["status"], string> = {
  SENT: "отправлено",
  DELIVERED: "доставлено",
  READ: "прочитано",
  FAILED: "не дошло",
  REPLIED: "клиент ответил",
};

/** Состояния, в которых блок не нужен вовсе: WhatsApp не подключён или клиент и так пишет сам. */
const HIDDEN: WaFirstContactStatus["state"][] = ["not_connected", "window_open"];

export function WhatsAppFirstContact({ clientId }: { clientId: string }) {
  const { data } = useWaFirstContactStatus(clientId);
  const sendMutation = useSendWaFirstContact(clientId);
  const [open, setOpen] = useState(false);
  const [objectNo, setObjectNo] = useState("");

  if (!data || HIDDEN.includes(data.state)) return null;

  const shortId = /^\d+$/.test(objectNo.trim()) ? Number(objectNo.trim()) : null;
  // С номером объекта уходит текст «про объект» — если Meta его уже одобрила;
  // иначе общий, и предпросмотр обязан показать именно его.
  const preview =
    shortId && data.propertyTextReady
      ? renderWaFirstContactText("property", [data.agentName, String(shortId)])
      : renderWaFirstContactText("general", [data.agentName]);
  const last = data.last;
  const ready = data.state === "ready";

  return (
    <div style={{ marginTop: 12 }}>
      <div className="list">
        <div className="row">
          <div className="t">
            <b>Написать в WhatsApp первыми</b>
            <span>{data.hint}</span>
          </div>
          {last && (
            <span className={`chip ${last.status === "FAILED" ? "crit" : last.status === "REPLIED" ? "ok" : "mute"}`}>
              {STATUS_LABEL[last.status]}
            </span>
          )}
        </div>
      </div>

      {last && (
        <p className={last.status === "FAILED" ? "state err" : "state"}>
          {`Последнее — ${relativeTime(last.sentAt)}${last.agentName ? `, ${last.agentName}` : ""}`}
          {last.propertyShortId ? `, про объект №${last.propertyShortId}` : ""}
          {last.status === "FAILED" && last.failReason ? `. Не дошло: ${last.failReason}` : ""}
        </p>
      )}

      {ready && !open && (
        <div className="state">
          <button className="pill sm" type="button" onClick={() => setOpen(true)}>
            <Send className="i" /> Написать в WhatsApp
          </button>
        </div>
      )}

      {ready && open && (
        <div className="card" style={{ marginTop: 8, padding: 14 }}>
          <label className="state" htmlFor={`wa-first-object-${clientId}`} style={{ display: "block", marginBottom: 6 }}>
            Номер объекта, если клиент просил про конкретный (можно пусто)
          </label>
          <input
            id={`wa-first-object-${clientId}`}
            className="inp"
            inputMode="numeric"
            placeholder="например 475"
            style={{ maxWidth: 200 }}
            value={objectNo}
            onChange={(e) => setObjectNo(e.target.value.replace(/\D/g, ""))}
          />
          <p className="state" style={{ marginTop: 10 }}>Клиент получит:</p>
          <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{preview}</p>
          <p className="state" style={{ marginTop: 4 }}>
            Кнопка под сообщением: «{WA_FIRST_CONTACT_BUTTON}».
            {shortId ? " Когда клиент ответит, ссылка на объект уйдёт ему сама." : ""}
          </p>
          {sendMutation.error && <p className="state err">{sendMutation.error.message}</p>}
          <div className="acts" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <button
              className="pill sm"
              type="button"
              disabled={sendMutation.isPending}
              onClick={() =>
                sendMutation.mutate(shortId, {
                  onSuccess: () => {
                    setOpen(false);
                    setObjectNo("");
                  },
                })
              }
            >
              <Send className="i" /> {sendMutation.isPending ? "Отправляю…" : "Отправить"}
            </button>
            <button className="pill ghost sm" type="button" disabled={sendMutation.isPending} onClick={() => setOpen(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
