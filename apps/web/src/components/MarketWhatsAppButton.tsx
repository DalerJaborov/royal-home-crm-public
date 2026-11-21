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
 *
 * Вид кнопки — `.pill` темы, а не `glass-btn`: общий сброс `.rh2 button` (без слоя)
 * бьёт утилиты Tailwind, и кнопка на утилитах теряла фон, рамку и отступы.
 * Поправки размера — с трейлинг-`!` (бьют тот же сброс).
 */

/** Окно, открытое сразу по клику (до ожидания ответа сервера). */
export interface PendingWindow {
  location: { href: string };
  opener: unknown;
  close: () => void;
}

/** Всё, что логика берёт снаружи: окно, переход, запрос номера, показ ошибки. */
export interface MarketWhatsAppDeps {
  openWindow: () => PendingWindow | null;
  assign: (url: string) => void;
  requestPhone: (sourceUrl: string, context?: ListingContactContext) => Promise<string | null>;
  fail: (message: string) => void;
}

/** С чем брать номер (17.11.2026): по чьему запросу и какой кнопкой — сервер ставит отметку «уже связывались». */
export interface ListingContactContext {
  clientId?: string;
  action?: "PHONE" | "WHATSAPP";
}

/** Номер продавца через одну дверь сервера (POST /market/listing-contact): учёт и права там. */
export async function requestListingContact(
  sourceUrl: string,
  context: ListingContactContext = {}
): Promise<{ phone: string | null; reason?: string }> {
  return api<{ phone: string | null; reason?: string }>("/market/listing-contact", { method: "POST", body: { sourceUrl, ...context } });
}

export interface MarketWhatsAppTarget {
  sourceUrl: string;
  source: string;
  title: string;
  /** Номер, если он уже известен из каталога. */
  phone?: string | null;
  /** Карточка клиента, из которой пишут (для отметки «уже связывались»). */
  clientId?: string;
}

/**
 * Что происходит по клику. Окно открываем СРАЗУ, иначе браузер заблокирует его после
 * ожидания ответа. Номера нет или он не годится для wa.me — ведём на само объявление
 * (номер там) и говорим об этом. Любая ошибка запроса (в том числе 429 «сайт занят») —
 * окно закрываем и показываем текст ошибки, на объявление не уводим.
 */
export async function openMarketWhatsApp(target: MarketWhatsAppTarget, deps: MarketWhatsAppDeps): Promise<void> {
  const text = marketWhatsAppText(target.source, target.title, target.sourceUrl);
  const win = deps.openWindow();
  if (win) win.opener = null;
  const go = (url: string) => {
    if (win) win.location.href = url;
    else deps.assign(url);
  };
  try {
    const number = target.phone ?? (await deps.requestPhone(target.sourceUrl, { clientId: target.clientId, action: "WHATSAPP" }));
    const url = number ? marketWhatsAppUrl(number, text) : null;
    if (url) {
      go(url);
    } else {
      go(target.sourceUrl);
      deps.fail("Номер не получен — открыл объявление, номер там");
    }
  } catch (err) {
    win?.close();
    deps.fail(err instanceof Error ? err.message : "Не удалось получить номер");
  }
}

const realDeps: MarketWhatsAppDeps = {
  openWindow: () => window.open("", "_blank"),
  assign: (url) => window.location.assign(url),
  requestPhone: async (sourceUrl, context) => (await requestListingContact(sourceUrl, context)).phone,
  fail: (message) => toast.error(message),
};

export function MarketWhatsAppButton({
  sourceUrl,
  source,
  title,
  phone,
  clientId,
  className = "",
  onDone,
}: MarketWhatsAppTarget & { className?: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);

  async function open() {
    if (busy) return;
    setBusy(true);
    try {
      await openMarketWhatsApp({ sourceUrl, source, title, phone, clientId }, realDeps);
    } finally {
      setBusy(false);
      onDone?.();
    }
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      aria-label="Написать продавцу в WhatsApp"
      className={`pill ghost tap-target shrink-0 gap-1.5! px-3! text-[14px]! disabled:opacity-50 ${className}`}
    >
      <MessageCircle className="w-3.5 h-3.5" aria-hidden />
      <span className="hidden sm:inline">WhatsApp</span>
    </button>
  );
}
