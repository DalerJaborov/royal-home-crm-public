import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { api } from "../lib/api";
import { marketWhatsAppText, marketWhatsAppUrl } from "../lib/marketWhatsApp";
import { toast } from "../store/toast";

/**
 * «Написать в WhatsApp» продавцу чужого объявления (Somon/Paydo) с готовым текстом.
 * Номер Somon в списке не отдаёт — берётся по клику одним запросом через сервер
 * (общий темп запросов к сайту), дальше лежит в нашем каталоге. У Paydo номер
 * открывается на сайте: кнопка в этом случае ведёт на объявление.
 */
export function MarketWhatsAppButton({
  sourceUrl,
  source,
  title,
  phone,
  className = "",
}: {
  sourceUrl: string;
  source: string;
  title: string;
  /** Номер, если он уже известен из каталога. */
  phone?: string | null;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const text = marketWhatsAppText(source, title, sourceUrl);

  async function open() {
    if (busy) return;
    // Окно открываем сразу по клику, иначе браузер заблокирует его после ожидания ответа.
    const win = window.open("", "_blank");
    if (win) win.opener = null;
    const go = (url: string) => {
      if (win) win.location.href = url;
      else window.location.assign(url);
    };
    setBusy(true);
    try {
      let number = phone ?? null;
      if (!number) {
        const res = await api<{ phone: string | null; reason?: string }>("/market/listing-contact", {
          method: "POST",
          body: { sourceUrl },
        });
        number = res.phone;
      }
      const url = number ? marketWhatsAppUrl(number, text) : null;
      if (url) {
        go(url);
      } else {
        go(sourceUrl);
        toast.error("Номер не получен — открыл объявление, номер там");
      }
    } catch (err) {
      win?.close();
      toast.error(err instanceof Error ? err.message : "Не удалось получить номер");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      aria-label="Написать продавцу в WhatsApp"
      className={`glass-btn glass-btn-ghost tap-target inline-flex shrink-0 items-center gap-1.5 px-3 py-2 text-[14px] disabled:opacity-50 ${className}`}
    >
      <MessageCircle className="w-3.5 h-3.5" aria-hidden />
      <span className="hidden sm:inline">WhatsApp</span>
    </button>
  );
}
