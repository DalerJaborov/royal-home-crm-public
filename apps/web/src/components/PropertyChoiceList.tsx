import { useId, useState } from "react";
import type { Property } from "../types";
import { formatArea, formatMoney } from "../lib/format";
import { formatPropertyCode } from "../lib/clientFormat";
import { statusChipLabel } from "../lib/theme2026";

type Choice = Pick<Property, "id" | "shortId" | "title"> & Partial<Pick<Property, "photos" | "price" | "currency" | "district" | "address" | "rooms" | "areaSqm" | "floor" | "totalFloors" | "status">>;

/** Same permission-filtered results, with enough context to recognize a property before selecting it. */
export function PropertyChoiceList({ items, value, onChange, emptyLabel, disabled, loading, error, onRetry }: {
  items: Choice[]; value: string; onChange: (id: string) => void;
  emptyLabel?: string; disabled?: boolean; loading?: boolean; error?: boolean; onRetry?: () => void;
}) {
  const name = useId();
  return <fieldset disabled={disabled} className="min-w-0 border-0 p-0">
    <legend className="sr-only">Объект</legend>
    {emptyLabel && <label className="mb-2 flex min-h-11 cursor-pointer items-center gap-2">
      <input type="radio" name={name} checked={!value} onChange={() => onChange("")} />{emptyLabel}
    </label>}
    <div className="max-h-[360px] overflow-y-auto overscroll-contain rounded-[14px] p-1" aria-busy={loading || undefined}>
      {items.map((p) => <label key={p.id} className={`mb-2 flex min-w-0 cursor-pointer items-start gap-3 rounded-[14px] border p-3 focus-within:ring-2 focus-within:ring-blue ${value === p.id ? "border-blue bg-row-alt" : "border-line bg-card"}`}>
        <input type="radio" name={name} value={p.id} checked={value === p.id} onChange={() => onChange(p.id)} aria-label={`Выбрать ${formatPropertyCode(p.shortId)}: ${p.title}`} className="mt-1 shrink-0" />
        <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-row-alt">
          <ChoicePhoto key={`${p.photos?.[0]?.thumbUrl}:${p.photos?.[0]?.url}`} photo={p.photos?.[0]} />
        </span>
        <span className="min-w-0 flex-1 break-words text-left text-[14px] leading-snug">
          <span className="block text-gray-500">{formatPropertyCode(p.shortId)}{value === p.id ? " · Выбран" : ""}</span>
          <strong className="mt-1 block text-[16px] text-ink">{p.title}</strong>
          <span className="mt-1 block">{[p.district?.name, p.address].filter(Boolean).join(" · ") || "Адрес не указан"}</span>
          <span className="mt-1 block text-gray-500">{[p.rooms != null ? `${p.rooms} комн.` : null, p.areaSqm != null ? `${formatArea(p.areaSqm)} м²` : null, p.floor != null ? `Этаж ${p.floor}${p.totalFloors ? `/${p.totalFloors}` : ""}` : null].filter(Boolean).join(" · ")}</span>
          <strong className="mt-2 block text-ink">{p.price != null && p.currency ? formatMoney(p.price, p.currency) : "Цена не указана"}</strong>
          {p.status && <span className="mt-1 block text-gray-500">{statusChipLabel(p.status)}</span>}
        </span>
      </label>)}
    </div>
    {loading && <p role="status">Ищу объекты…</p>}
    {error && <p role="alert">Не удалось загрузить объекты. {onRetry && <button type="button" onClick={onRetry}>Повторить</button>}</p>}
    {!loading && !error && !items.length && <p role="status">Объекты не найдены. Измените поиск.</p>}
  </fieldset>;
}

function ChoicePhoto({ photo }: { photo?: Property["photos"][number] }) {
  const [attempt, setAttempt] = useState(0);
  const sources = [...new Set([photo?.thumbUrl, photo?.url].filter((url): url is string => !!url))];
  return sources[attempt]
    ? <img src={sources[attempt]} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => setAttempt((n) => n + 1)} />
    : <span className="px-1 text-center text-[14px] text-gray-500">{sources.length ? "Фото недоступно" : "Нет фото"}</span>;
}

