import { useState } from "react";
import { Phone } from "lucide-react";
import { toast } from "../store/toast";
import { requestListingContact } from "./MarketWhatsAppButton";

/**
 * «Показать номер» продавца чужого объявления (17.11.2026). Тот же путь, что у кнопки WhatsApp:
 * POST /market/listing-contact — общий темп запросов к Somon, закрытый номер владельца нашего объекта
 * не отдаётся (403), а сервер ставит отметку «номер брал такой-то», которую видят другие агенты.
 * У Paydo номер сервер не достаёт (он открывается на сайте) — вместо кнопки ссылка на объявление.
 * Полученный номер показывается ссылкой tel:.
 */
export function MarketShowPhoneButton({
  sourceUrl,
  source,
  clientId,
  onDone,
}: {
  sourceUrl: string;
  source: string;
  clientId?: string;
  onDone?: () => void;
}) {
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (source !== "somon.tj") {
    return (
      <a className="pill ghost tap-target shrink-0 gap-1.5! px-3! text-[14px]!" href={sourceUrl} target="_blank" rel="noopener noreferrer">
        <Phone className="w-3.5 h-3.5" aria-hidden />
        Номер на сайте
      </a>
    );
  }

  if (phone) {
    return (
      <a className="pill ghost tap-target shrink-0 gap-1.5! px-3! text-[14px]!" href={`tel:${phone}`} aria-label={`Позвонить продавцу ${phone}`}>
        <Phone className="w-3.5 h-3.5" aria-hidden />
        {phone}
      </a>
    );
  }

  async function reveal() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await requestListingContact(sourceUrl, { clientId, action: "PHONE" });
      if (res.phone) {
        setPhone(res.phone);
      } else {
        toast.error("Продавец не оставил номер — откройте объявление на сайте");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось получить номер");
    } finally {
      setBusy(false);
      onDone?.();
    }
  }

  return (
    <button
      type="button"
      onClick={reveal}
      disabled={busy}
      aria-label="Показать номер продавца"
      className="pill ghost tap-target shrink-0 gap-1.5! px-3! text-[14px]! disabled:opacity-50"
    >
      <Phone className="w-3.5 h-3.5" aria-hidden />
      {busy ? "Получаем…" : "Показать номер"}
    </button>
  );
}
