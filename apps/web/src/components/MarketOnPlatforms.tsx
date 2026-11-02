import { MarketWhatsAppButton } from "./MarketWhatsAppButton";
import { ExternalLink, Layers, Phone } from "lucide-react";
import { useMarketMatches, useSetMatchStatus } from "../hooks/useMarket";
import { formatArea, formatMoney } from "../lib/format";
import type { OwnMarketMatch, OwnMarketMatchesData } from "../types";
import { marketSourceName } from "./MarketBlock";

/**
 * «Этот объект на площадках»: клиент выставил квартиру ещё и сам на Somon/Paydo.
 * Рядом с блоком «Рынок» на карточке объекта — агент видит, где и по какой цене,
 * и отвечает «Это наш» / «Не наш» (не наш больше не показывается и не пушится).
 *
 * Совпадения находит сервер (lib/market/ownMatch.ts); здесь только показ. Нет
 * совпадений — не рисуем ничего: пустой блок на каждой карточке был бы шумом.
 */

/** «на 4% дороже, чем у нас» — по знаку разницы с нашей ценой. */
export function priceDiffText(diff: number | null): { text: string; tone: "up" | "down" | "same" } | null {
  if (diff == null) return null;
  if (diff === 0) return { text: "цена как у нас", tone: "same" };
  return diff > 0
    ? { text: `на ${diff}% дороже, чем у нас`, tone: "up" }
    : { text: `на ${Math.abs(diff)}% дешевле, чем у нас`, tone: "down" };
}

const TONE_CLS = { up: "text-red", down: "text-green", same: "text-gray-500" } as const;

function details(m: OwnMarketMatch): string {
  const parts: string[] = [];
  if (m.rooms) parts.push(`${m.rooms} к`);
  if (m.areaSqm) {
    const diff =
      m.areaDiffSqm != null && m.areaDiffSqm !== 0
        ? ` (${m.areaDiffSqm > 0 ? "+" : "−"}${formatArea(Math.abs(m.areaDiffSqm))})`
        : "";
    parts.push(`${formatArea(m.areaSqm)} м²${diff}`);
  }
  if (m.floor) parts.push(m.totalFloors ? `${m.floor}/${m.totalFloors} эт.` : `${m.floor} эт.`);
  return parts.join(" · ");
}

function phoneHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

function MatchCard({
  m,
  busy,
  onStatus,
}: {
  m: OwnMarketMatch;
  busy: boolean;
  onStatus: (status: "CONFIRMED" | "DISMISSED") => void;
}) {
  const diff = priceDiffText(m.priceDiffPercent);
  const confirmed = m.status === "CONFIRMED";
  const seller = [m.sellerName, m.isAgency ? "агентство" : "частное лицо"].filter(Boolean).join(" · ");
  return (
    <li className="py-3 border-b border-line-soft last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
            <span className="rounded-badge px-2 py-0.5 font-semibold bg-hover-tint">{marketSourceName(m.source)}</span>
            {confirmed && <span className="rounded-badge px-2 py-0.5 font-semibold text-green bg-green-bg">Подтверждено</span>}
            {!m.isActive && (
              <span className="rounded-badge px-2 py-0.5 font-semibold text-gray-500 bg-hover-tint">Снято с площадки</span>
            )}
          </div>
          <p className="mt-1 text-[14px] truncate">{m.title}</p>
          <p className="text-[13px] text-gray-500">{details(m)}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[16px] sm:text-[18px] font-semibold tabular-nums">
            {m.priceTjs != null ? formatMoney(m.priceTjs, "TJS") : "—"}
          </div>
          {diff && <div className={`text-[13px] ${TONE_CLS[diff.tone]}`}>{diff.text}</div>}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-gray-500">
        {seller && <span>{seller}</span>}
        {m.sellerPhone && (
          <a href={phoneHref(m.sellerPhone)} className="inline-flex items-center gap-1 text-blue">
            <Phone className="w-3 h-3" aria-hidden />
            {m.sellerPhone}
          </a>
        )}
        {m.sellerPhoneHidden && <span>телефон скрыт правами доступа</span>}
        <span>на площадке с {new Date(m.firstSeenAt).toLocaleDateString("ru-RU")}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a
          href={m.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="pill ghost tap-target gap-1.5! px-3! text-[14px]!"
        >
          <ExternalLink className="w-3.5 h-3.5" aria-hidden />
          Открыть объявление
        </a>
        {/* Номер скрыт правами доступа — кнопка тоже: иначе WhatsApp открыл бы тот же номер через сервер. */}
        {!m.sellerPhoneHidden && (
          <MarketWhatsAppButton sourceUrl={m.sourceUrl} source={m.source} title={m.title} phone={m.sellerPhone} />
        )}
        {!confirmed && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onStatus("CONFIRMED")}
            className="pill tap-target px-3! text-[14px]! disabled:opacity-50"
          >
            Это наш
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => onStatus("DISMISSED")}
          className="pill ghost tap-target px-3! text-[14px]! disabled:opacity-50"
        >
          Не наш
        </button>
      </div>
    </li>
  );
}

/** Чистое представление — отдельно от запроса, чтобы проверять без сети. */
export function MarketOnPlatformsView({
  data,
  busyId = null,
  onStatus,
}: {
  data: OwnMarketMatchesData;
  busyId?: string | null;
  onStatus: (matchId: string, status: "CONFIRMED" | "DISMISSED") => void;
}) {
  if (data.matches.length === 0) return null;
  return (
    <section className="bg-card border border-line rounded-card shadow-sm p-3 sm:p-4" aria-label="Этот объект на площадках">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold min-w-0">
          <Layers className="w-3.5 h-3.5 text-blue shrink-0" aria-hidden />
          <span className="truncate">Этот объект на площадках</span>
        </h3>
        <span className="rounded-badge px-2.5 py-1 text-[13px] font-semibold text-blue bg-hover-tint shrink-0">
          {data.matches.length}
        </span>
      </div>
      <p className="mt-1 text-[13px] text-gray-500">
        Похоже, владелец выставил его и сам. Сравните цену и условия
        {data.ourPriceTjs != null ? ` (у нас ${formatMoney(data.ourPriceTjs, "TJS")})` : ""}.
      </p>
      <ul className="mt-1">
        {data.matches.map((m) => (
          <MatchCard key={m.id} m={m} busy={busyId === m.id} onStatus={(status) => onStatus(m.id, status)} />
        ))}
      </ul>
    </section>
  );
}

export function MarketOnPlatforms({ propertyId }: { propertyId: string }) {
  const { data } = useMarketMatches(propertyId);
  const set = useSetMatchStatus(propertyId);
  if (!data) return null;
  return (
    <MarketOnPlatformsView
      data={data}
      busyId={set.isPending ? (set.variables?.matchId ?? null) : null}
      onStatus={(matchId, status) => set.mutate({ matchId, status })}
    />
  );
}
