import { dushanbeDateTime } from "../lib/date";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { summarizeComparableListings } from "@royal-home/shared";
import { api } from "../lib/api";

type Comparables = ReturnType<typeof summarizeComparableListings> & { unavailableReason: string | null; criteria: { areaMin: number; areaMax: number; radiusApplied: boolean } | null };
const number = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value);
export function PropertyComparables({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isFetching, error } = useQuery({ queryKey: ["property-comparables", propertyId], queryFn: () => api<Comparables>(`/properties/${propertyId}/comparables`), enabled: open, retry: false });
  return <section className="card" aria-label="Похожие предложения в CRM">
    <button type="button" className="pill sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>Сравнить с предложениями в CRM</button>
    {open && <div className="p-4 space-y-3">
      {isFetching && <p role="status">Сравниваем предложения…</p>}
      {error && <p role="alert">Сравнение недоступно. Повторите позже.</p>}
      {data && <>
        <p>{data.limitation}</p>
        {data.criteria && <p>Тот же тип, район, число комнат и валюта. Площадь {number(data.criteria.areaMin)}–{number(data.criteria.areaMax)} м² (±20%). Радиус не применён.</p>}
        <p>Использовано {data.usableCount} из {data.totalCandidates} предложений{data.truncated ? "; выборка ограничена 100 последними изменёнными карточками" : ""}.</p>
        {data.unavailableReason && <p>{data.unavailableReason}</p>}
        {data.usableCount < 3 ? <p>Мало сопоставимых предложений для устойчивого сравнения.</p> : data.medianPricePerSqm !== null && <p>Медиана запрашиваемых цен: <strong>{number(data.medianPricePerSqm)} {data.currency}/м²</strong>.{data.subjectPricePerSqm !== null && <> Этот объект: {number(data.subjectPricePerSqm)} {data.currency}/м².</>}</p>}
        <p>Подтверждение актуальности цены продавцом: неизвестно. Время сравнения: {dushanbeDateTime(data.comparedAt)}.</p>
        <ul>{data.listings.slice(0, 10).map(item => <li key={item.id}><Link to={`/properties/${item.shortId}`}>Объект №{item.shortId}</Link> · {number(item.price)} {item.currency} · {number(item.areaSqm)} м² · карточка изменена {item.ageDays} дн. назад</li>)}</ul>
        {data.listings.length > 10 && <p>Показаны первые 10; сводка учитывает {data.usableCount}.</p>}
      </>}
    </div>}
  </section>;
}
