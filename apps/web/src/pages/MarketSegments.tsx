import { useMemo, useState } from "react";
import { TrendingUp } from "lucide-react";
import type { MarketSegmentStat, MarketSegmentsResponse } from "@royal-home/shared";
import { MARKET_REPAIR_LABEL, MARKET_SEGMENT_REPAIRS } from "@royal-home/shared";
import { useDistricts } from "../hooks/useDistricts";
import { useMarketSegments } from "../hooks/useMarket";
import { dushanbeDate } from "../lib/date";
import { formatMoney } from "../lib/format";
import { marketSourceName } from "../lib/marketSource";
import { Filters } from "../components/rh2/Filters";
import { PageHeader } from "../components/rh2/PageHeader";
import { Rh2EmptyState } from "../components/rh2/Rh2EmptyState";
import { Rh2ErrorState } from "../components/rh2/Rh2ErrorState";
import { Rh2Screen } from "../components/rh2/Rh2Screen";

/**
 * «Рынок — цены по сегментам» (10.11.2026): типичная и средняя цена за м² и за объект по сегментам
 * район × комнаты × ремонт, по активным объявлениям Somon и Paydo. Один адаптивный экран на ПК и
 * телефон (раскладку ≤820 px даёт тема). Все числа считает сервер (GET /market/segments);
 * сегмент меньше порога (число приходит с сервера как minSample) показывается без цифр, с пометкой
 * «Данных мало» — как блок «Рынок» в карточке объекта.
 */

/** Сколько сегментов видно до нажатия «Показать ещё»: список не растёт без предела. */
const PAGE = 30;
const ROOM_FILTERS = [
  { id: "all", label: "Все" },
  { id: "1", label: "1 комн." },
  { id: "2", label: "2 комн." },
  { id: "3", label: "3 комн." },
  { id: "4", label: "4 комн." },
] as const;
const BUILDING_FILTERS = [
  { id: "all", label: "Любой дом" },
  { id: "new", label: "Новостройка" },
  { id: "secondary", label: "Вторичка" },
] as const;

function repairText(repair: MarketSegmentStat["repair"]): string {
  return repair ? MARKET_REPAIR_LABEL[repair] : "ремонт не указан";
}

function SegmentRow({ s, minSample }: { s: MarketSegmentStat; minSample: number }) {
  return (
    <div className="row wrapt" data-testid="market-segment-row">
      <div className="t">
        <b>
          {s.districtName} · {s.rooms} комн. · {repairText(s.repair)}
        </b>
        <span>
          {s.count} объявл.
          {s.enough ? ` · видели ${dushanbeDate(s.freshestSeenAt)}` : ""}
          {s.newLast7Days > 0 ? ` · новых за неделю: ${s.newLast7Days}` : ""}
        </span>
      </div>
      {s.enough ? (
        <>
          <span className="meta">
            {s.medianPerSqmTjs != null ? (
              <>
                <b>{formatMoney(s.medianPerSqmTjs, "TJS")}/м²</b>
                <small>
                  {" "}· средняя {s.averagePerSqmTjs != null ? `${formatMoney(s.averagePerSqmTjs, "TJS")}/м²` : "—"}
                </small>
              </>
            ) : (
              <small>цена за м² в объявлениях не везде указана</small>
            )}
          </span>
          <span className="meta">
            <b>{s.medianPriceTjs != null ? formatMoney(s.medianPriceTjs, "TJS") : "—"}</b>
            <small> · средняя {s.averagePriceTjs != null ? formatMoney(s.averagePriceTjs, "TJS") : "—"}</small>
          </span>
        </>
      ) : (
        <>
          <span className="chip">Данных мало</span>
          <span className="meta">
            <small>нужно от {minSample}</small>
          </span>
        </>
      )}
    </div>
  );
}

export function MarketSegmentsView({ data, shown, onMore }: { data: MarketSegmentsResponse; shown: number; onMore: () => void }) {
  const visible = data.segments.slice(0, shown);
  const sourcesLine = data.sources.map((x) => `${marketSourceName(x.source)} ${x.count}`).join(" · ");
  return (
    <>
      <section className="card" aria-label="Сегменты рынка" data-testid="market-segments">
        {data.segments.length === 0 ? (
          <Rh2EmptyState icon={TrendingUp} title="По этим условиям активных объявлений нет" hint="Попробуйте убрать часть фильтров." />
        ) : (
          <>
            <div className="list">
              {visible.map((s) => (
                <SegmentRow key={s.key} s={s} minSample={data.minSample} />
              ))}
            </div>
            {visible.length < data.segments.length && (
              <button type="button" className="pill ghost" onClick={onMore}>
                Показать ещё · {data.segments.length - visible.length}
              </button>
            )}
          </>
        )}
      </section>
      <p className="sub">
        Основание: активные объявления за {data.windowDays} дней{sourcesLine ? ` (${sourcesLine})` : ""}; один объект на двух площадках
        считается один раз. Типичная цена — медиана: половина объявлений дешевле, половина дороже, единичные дорогие объекты её не
        сдвигают. Сегмент меньше {data.minSample} объявлений числа не получает. Цены в объявлениях — не цены сделок.
        {data.truncated ? " Выборка упёрлась в предел: цифры по самым свежим объявлениям." : ""}
      </p>
    </>
  );
}

export function MarketSegments() {
  const [district, setDistrict] = useState("");
  const [rooms, setRooms] = useState<(typeof ROOM_FILTERS)[number]["id"]>("all");
  const [repair, setRepair] = useState("");
  const [building, setBuilding] = useState<(typeof BUILDING_FILTERS)[number]["id"]>("all");
  const [shown, setShown] = useState(PAGE);
  const districts = useDistricts();

  const filters = useMemo(
    () => ({
      ...(district ? { districtName: district } : {}),
      ...(rooms !== "all" ? { rooms: Number(rooms) } : {}),
      ...(repair ? { repair: repair as (typeof MARKET_SEGMENT_REPAIRS)[number] } : {}),
      ...(building !== "all" ? { building } : {}),
    }),
    [district, rooms, repair, building]
  );
  const { data, isLoading, isError, refetch, isFetching } = useMarketSegments(filters);
  const reset = () => setShown(PAGE);

  return (
    <Rh2Screen title="Цены рынка">
      <PageHeader
        title="Рынок — цены по сегментам"
        sub="Сколько стоят квартиры по районам, комнатам и ремонту — по объявлениям Somon и Paydo."
        actions={
          <label className="field">
            <span className="vh">Район</span>
            <select
              className="inp"
              value={district}
              onChange={(e) => {
                setDistrict(e.target.value);
                reset();
              }}
            >
              <option value="">Все районы</option>
              {(districts.data ?? []).map((d) => (
                <option key={d.id} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        }
      />
      <div className="card tight">
        <Filters
          aria-label="Комнаты"
          scroll
          options={ROOM_FILTERS}
          value={rooms}
          onChange={(v) => {
            setRooms(v);
            reset();
          }}
        />
        <Filters
          aria-label="Тип дома"
          scroll
          options={BUILDING_FILTERS}
          value={building}
          onChange={(v) => {
            setBuilding(v);
            reset();
          }}
        />
        <label className="field">
          <span className="vh">Ремонт</span>
          <select
            className="inp"
            value={repair}
            onChange={(e) => {
              setRepair(e.target.value);
              reset();
            }}
          >
            <option value="">Любой ремонт</option>
            {MARKET_SEGMENT_REPAIRS.map((r) => (
              <option key={r} value={r}>
                {MARKET_REPAIR_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {isLoading ? (
        <div className="card tight">
          <p role="status" className="sub">Считаем цены по объявлениям…</p>
        </div>
      ) : isError || !data ? (
        <div className="card tight">
          <Rh2ErrorState message="Не удалось загрузить цены рынка." onRetry={() => void refetch()} retrying={isFetching} />
        </div>
      ) : (
        <MarketSegmentsView data={data} shown={shown} onMore={() => setShown((n) => n + PAGE)} />
      )}
    </Rh2Screen>
  );
}
