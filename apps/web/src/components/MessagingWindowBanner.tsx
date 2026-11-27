import { useState } from "react";
import { Clock } from "lucide-react";
import { CallClientButton } from "./CallClientButton";
import { WhatsAppFirstContact } from "./WhatsAppFirstContact";
import "./messagingWindowBanner.css";

/**
 * Тёплая жёлтая плашка над строкой ввода: окно 24 часа закрыто (макет 02-chat-composer, вариант C,
 * 27.11.2026). Одна на компьютер и телефон: Messages.tsx и MobileChatView.tsx показывают её вместо
 * прежней серой строки. Правило «закрыто» — одно с сервером (lib/messagingWindow.ts → packages/shared),
 * Telegram окна не знает и плашку не получает.
 *
 * «Шаблон» — только для WhatsApp и только когда у переписки есть карточка клиента: заранее одобренное
 * Meta первое сообщение шлёт тот же блок, что в карточке клиента (WhatsAppFirstContact); он сам
 * прячется, если WhatsApp не подключён или окно на самом деле открыто.
 */
export function MessagingWindowBanner({
  isWhatsApp,
  clientId,
  clientPhone,
}: {
  isWhatsApp: boolean;
  clientId?: string | null;
  clientPhone?: string | null;
}) {
  const [templateOpen, setTemplateOpen] = useState(false);
  const canTemplate = isWhatsApp && !!clientId;
  return (
    <div className="mwb" role="note" data-testid="messaging-window-banner">
      <div className="mwb-main">
        <span className="mwb-ico" aria-hidden="true">
          <Clock />
        </span>
        <div className="mwb-body">
          <b className="mwb-title">Окно 24 часа закрыто</b>
          <span className="mwb-text">
            Клиент не писал больше суток, свободный текст не дойдёт. Позвоните или дождитесь его сообщения.
          </span>
        </div>
      </div>
      {(canTemplate || (clientPhone && clientId)) && (
        <div className="mwb-acts">
          {clientPhone && clientId && (
            <CallClientButton clientId={clientId} phone={clientPhone} variant="full" label="Позвонить через CRM" className="mwb-btn mwb-btn-ghost" />
          )}
          {canTemplate && (
            <button type="button" className="mwb-btn" aria-expanded={templateOpen} onClick={() => setTemplateOpen((v) => !v)}>
              {templateOpen ? "Скрыть шаблон" : "Шаблон"}
            </button>
          )}
        </div>
      )}
      {canTemplate && templateOpen && clientId && (
        <div className="mwb-template">
          <WhatsAppFirstContact clientId={clientId} />
        </div>
      )}
    </div>
  );
}
