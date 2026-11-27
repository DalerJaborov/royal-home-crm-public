import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { isMessagingWindowClosed } from "../../lib/messagingWindow";

vi.mock("../CallClientButton", () => ({ CallClientButton: ({ label }: { label?: string }) => <button>{label}</button> }));
vi.mock("../WhatsAppFirstContact", () => ({ WhatsAppFirstContact: () => <div>first-contact</div> }));

import { MessagingWindowBanner } from "../MessagingWindowBanner";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);

describe("окно 24 часа: расчёт для плашки", () => {
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
  it("WhatsApp/Instagram/Messenger: закрыто после суток, открыто раньше", () => {
    for (const channel of ["WHATSAPP", "INSTAGRAM", "FACEBOOK"]) {
      expect(isMessagingWindowClosed(channel, at(25), new Date(NOW))).toBe(true);
      expect(isMessagingWindowClosed(channel, at(23), new Date(NOW))).toBe(false);
    }
  });
  it("Telegram окна не знает", () => {
    expect(isMessagingWindowClosed("TELEGRAM", at(500), new Date(NOW))).toBe(false);
  });
  it("нет отметки времени — не блокируем", () => {
    expect(isMessagingWindowClosed("WHATSAPP", null, new Date(NOW))).toBe(false);
  });
});

describe("MessagingWindowBanner", () => {
  it("заголовок и пояснение", () => {
    const html = renderToStaticMarkup(<MessagingWindowBanner isWhatsApp={false} />);
    expect(html).toContain("Окно 24 часа закрыто");
    expect(html).toContain("Клиент не писал больше суток");
    expect(html).not.toContain("Шаблон");
  });
  it("кнопка «Шаблон» только у WhatsApp с карточкой клиента", () => {
    expect(renderToStaticMarkup(<MessagingWindowBanner isWhatsApp clientId="c1" />)).toContain("Шаблон");
    expect(renderToStaticMarkup(<MessagingWindowBanner isWhatsApp />)).not.toContain("Шаблон");
    expect(renderToStaticMarkup(<MessagingWindowBanner isWhatsApp={false} clientId="c1" />)).not.toContain("Шаблон");
  });
  it("звонок через CRM — когда есть карточка и номер", () => {
    expect(renderToStaticMarkup(<MessagingWindowBanner isWhatsApp={false} clientId="c1" clientPhone="+992930001001" />)).toContain("Позвонить через CRM");
    expect(renderToStaticMarkup(<MessagingWindowBanner isWhatsApp={false} clientPhone="+992930001001" />)).not.toContain("Позвонить");
  });
});
