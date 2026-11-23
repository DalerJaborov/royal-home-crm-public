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
  compact = false,
}: {
  sourceUrl: string;
  source: string;
  clientId?: string;
  onDone?: () => void;
  /** Маленькая иконка в строке объявления (22.11.2026); подпись уходит в aria-label и подсказку. */
  compact?: boolean;
}) {
  const btn = compact ? "mk-ico" : "pill ghost tap-target shrink-0 gap-1.5! px-3! text-[14px]!";
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (source !== "somon.tj") {
    return (
      <a className={btn} href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label="Номер на сайте" title="Номер на сайте">
        <Phone className="w-3.5 h-3.5" aria-hidden />
        {!compact && "Номер на сайте"}
      </a>
    );
  }

  if (phone) {
    return (
      <a className={compact ? "mk-phone" : btn} href={`tel:${phone}`} aria-label={`Позвонить продавцу ${phone}`}>
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
      title={compact ? "Показать номер" : undefined}
      className={compact ? btn : `${btn} disabled:opacity-50`}
    >
      <Phone className="w-3.5 h-3.5" aria-hidden />
      {!compact && (busy ? "Получаем…" : "Показать номер")}
    </button>
  );
}
