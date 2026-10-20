import { Link } from "react-router-dom";
import {
  DEMAND_SUPPLY_MIN_SAMPLE,
  DEMAND_SUPPLY_ROOM_LABELS,
  DEMAND_SUPPLY_SHORTAGE_RATIO,
  DEMAND_SUPPLY_SURPLUS_MIN_SUPPLY,
  DEMAND_SUPPLY_SURPLUS_RATIO,
  DEMAND_SUPPLY_VERDICT_LABELS,
  type DemandSupplyCell,
  type DemandSupplyResponse,
} from "@royal-home/shared";
import { useDemandSupply } from "../hooks/useReports";
import { pluralizeRu } from "../lib/format";
import { scrollableRegion } from "../lib/a11y";

/**
 * «СПРОС И ПРЕДЛОЖЕНИЕ» на экране отчётов (владелец, 03.10.2026): где искать
 * новые объекты, а где их уже слишком много.
 *
 * Ничего не считает сама — матрицу, вердикты и пороги отдаёт сервер
 * (GET /reports/demand-supply, lib/demandSupply.ts). Здесь только раскраска и
 * подписи. Цвет не единственный носитель смысла: в клетке числа «ищут / в
 * продаже», значок ▲ или ▼ и коэффициент, а у клетки есть aria-label словами.
 * Клетки с малой выборкой (меньше DEMAND_SUPPLY_MIN_SAMPLE ищущих) без цвета и
 * с пометкой «мало данных»: вывода по ним нет — кроме склада (квартир от
 * DEMAND_SUPPLY_SURPLUS_MIN_SUPPLY при малом спросе): это «избыток» с пометкой «спрос мал».
 */

const nf = (v: number) => Math.round(v).toLocaleString("ru-RU");
const ratioText = (r: number) => r.toLocaleString("ru-RU", { maximumFractionDigits: 2 });

/** Сила окраски 0.35..1: чем дальше коэффициент за порог, тем насыщеннее клетка. */
function heat(cell: DemandSupplyCell): number {
  if (cell.verdict === "shortage") {
    if (cell.ratio == null) return 1;
    return Math.min(1, 0.35 + ((cell.ratio - DEMAND_SUPPLY_SHORTAGE_RATIO) / 2.5) * 0.65);
  }
  if (cell.verdict === "surplus" && cell.ratio != null) {
    return Math.min(1, 0.35 + ((DEMAND_SUPPLY_SURPLUS_RATIO - cell.ratio) / DEMAND_SUPPLY_SURPLUS_RATIO) * 0.65);
  }
  return 0.5;
}

function cellWords(cell: DemandSupplyCell): string {
  const base = `${cell.districtName}, ${DEMAND_SUPPLY_ROOM_LABELS[cell.rooms]}: ищут ${cell.demand}, в продаже ${cell.supply}`;
  if (cell.verdict === "low-data") {
    return `${base}. Мало данных: ищущих меньше ${DEMAND_SUPPLY_MIN_SAMPLE}, вывода нет`;
  }
  const k = cell.ratio != null ? `, спрос к предложению ${ratioText(cell.ratio)}` : ", в продаже нет ни одного";
  const weak = cell.lowDemand ? `. Спрос мал: ищущих меньше ${DEMAND_SUPPLY_MIN_SAMPLE}, вывод слабее обычного` : "";
  return `${base}${k}. ${DEMAND_SUPPLY_VERDICT_LABELS[cell.verdict]}${weak}`;
}

function Matrix({ data }: { data: DemandSupplyResponse }) {
  const byKey = new Map(data.cells.map((c) => [`${c.districtId}|${c.rooms}`, c]));
  return (
    <div className="dsm-scroll" {...scrollableRegion("Матрица спроса и предложения: районы по строкам, число комнат по столбцам")}>
      <div className="dsm-grid">
        <span aria-hidden="true" />
        {data.rooms.map((r) => (
          <span className="dsm-h" key={r}>
            {DEMAND_SUPPLY_ROOM_LABELS[r]}
          </span>
        ))}
        {data.districts.map((d) => (
          <Row key={d.districtId} district={d} rooms={data.rooms} byKey={byKey} />
        ))}
      </div>
    </div>
  );
}

function Row({
  district,
  rooms,
  byKey,
}: {
  district: DemandSupplyResponse["districts"][number];
  rooms: DemandSupplyResponse["rooms"];
  byKey: Map<string, DemandSupplyCell>;
}) {
  return (
    <>
      <span className="dsm-d">
        {district.districtName}
        <small>
          ищут {district.demand}, в продаже {district.supply}
        </small>
      </span>
      {rooms.map((r) => {
        const cell = byKey.get(`${district.districtId}|${r}`);
        if (!cell) {
          return (
            <span
              className="dsm-cell is-empty"
              key={r}
              role="img"
              aria-label={`${district.districtName}, ${DEMAND_SUPPLY_ROOM_LABELS[r]}: спроса и предложения нет`}
            >
              —
            </span>
          );
        }
        const note =
          cell.verdict === "low-data"
            ? "мало данных"
            : cell.verdict === "shortage"
              ? cell.ratio == null
                ? "▲ нет в продаже"
                : `▲ ×${ratioText(cell.ratio)}`
              : cell.verdict === "surplus"
                ? `▼ ×${ratioText(cell.ratio ?? 0)}${cell.lowDemand ? " · спрос мал" : ""}`
                : `≈ ×${ratioText(cell.ratio ?? 1)}`;
        return (
          <span
            key={r}
            className={`dsm-cell is-${cell.verdict}`}
            style={{ "--heat": heat(cell) } as React.CSSProperties}
            role="img"
            tabIndex={0}
            aria-label={cellWords(cell)}
            title={cellWords(cell)}
          >
            <b>
              {cell.demand} / {cell.supply}
            </b>
            <span>{note}</span>
          </span>
        );
      })}
    </>
  );
}

function CellRow({ cell }: { cell: DemandSupplyCell }) {
  const money =
    cell.demandMedianBudget != null || cell.supplyMedianPrice != null
      ? ` · бюджет ищущих ${cell.demandMedianBudget != null ? `≈ ${nf(cell.demandMedianBudget)} с.` : "не назван"}, цена в продаже ${
          cell.supplyMedianPrice != null ? `≈ ${nf(cell.supplyMedianPrice)} с.` : "—"
        }`
      : "";
  return (
    <div className="row">
      <span className="t">
        <b>
          {cell.districtName} · {DEMAND_SUPPLY_ROOM_LABELS[cell.rooms]}
        </b>
        <span>
          Ищут {cell.demand}, в продаже {cell.supply}
          {cell.lowDemand ? ` (ищущих меньше ${DEMAND_SUPPLY_MIN_SAMPLE}: вывод слабее обычного)` : ""}
          {money}
        </span>
      </span>
      <span className={`chip ${cell.verdict === "shortage" ? "warn" : "mute"}`}>
        {cell.ratio == null ? "нет в продаже" : `×${ratioText(cell.ratio)}`}
        {cell.lowDemand ? " · спрос мал" : ""}
      </span>
    </div>
  );
}

function CellList({ title, cells, empty }: { title: string; cells: DemandSupplyCell[]; empty: string }) {
  return (
    <div>
      <h3>{title}</h3>
      {cells.length === 0 ? (
        <p className="state">{empty}</p>
      ) : (
        <div className="list">
          {cells.map((c) => (
            <CellRow key={`${c.districtId}|${c.rooms}`} cell={c} />
          ))}
        </div>
      )}
    </div>
  );
}

export function DemandSupplySection() {
  const { data, isLoading, isError, refetch } = useDemandSupply();
  const t = data?.totals;
  const empty = !!data && data.cells.length === 0;

  return (
    <div className="sec" id="demand-supply-section">
      <div className="sec-h">
        <h2>Спрос и предложение</h2>
        <span className="note">квартиры, «на сейчас»</span>
      </div>
      <div className="card tight">
        {isError ? (
          <div className="state err">
            <span className="dot crit" /> Матрица не загрузилась.
            <button className="lk" type="button" style={{ color: "inherit", textDecoration: "underline" }} onClick={() => refetch()}>
              Повторить
            </button>
          </div>
        ) : isLoading || !data ? (
          <p className="state">Считаем спрос и предложение…</p>
        ) : empty ? (
          <p className="state">
            Пока нечего сопоставить: ни у кого из ждущих покупателей не указаны район и число комнат, и нет квартир в
            продаже с районом.
          </p>
        ) : (
          <>
            <Matrix data={data} />
            <p className="dsm-legend" aria-label="Как читать матрицу">
              <span>В клетке: ищут / в продаже</span>
              <span>
                <i className="is-shortage" aria-hidden="true" />▲ не хватает объектов
              </span>
              <span>
                <i className="is-surplus" aria-hidden="true" />▼ много предложения, мало спроса (при малом спросе — от{" "}
                {DEMAND_SUPPLY_SURPLUS_MIN_SUPPLY} квартир, с пометкой)
              </span>
              <span>
                <i aria-hidden="true" />≈ примерно поровну
              </span>
              <span>
                <i className="is-low" aria-hidden="true" />
                мало данных (ищут меньше {DEMAND_SUPPLY_MIN_SAMPLE})
              </span>
            </p>
            <p className="state" style={{ display: "block" }}>
              Считаются ждущие покупатели квартир, назвавшие район и число комнат ({t?.demandPlaced ?? 0}). Не вошли в
              матрицу: {t?.demandUnplaced ?? 0} {pluralizeRu(t?.demandUnplaced ?? 0, ["покупатель", "покупателя", "покупателей"])} без
              района или комнат и {t?.supplyUnplaced ?? 0}{" "}
              {pluralizeRu(t?.supplyUnplaced ?? 0, ["квартира", "квартиры", "квартир"])} в продаже без района или комнат. Вывод
              делается, только если в клетке ищут не меньше {DEMAND_SUPPLY_MIN_SAMPLE} клиентов; исключение — от{" "}
              {DEMAND_SUPPLY_SURPLUS_MIN_SUPPLY} квартир при малом спросе: это «много предложения» с пометкой «спрос мал».
              {data.truncated && " Выборка упёрлась в потолок, цифры могут быть занижены."}
            </p>
            <div className="dsm-cols">
              <CellList
                title="Где искать новые объекты"
                cells={data.shortage}
                empty="Явного дефицита нет: везде, где ищут, предложение не слабее спроса — или данных пока мало."
              />
              <CellList
                title="Где слишком много предложения"
                cells={data.surplus}
                empty="Явного избытка нет: объектов сверх спроса нигде не накопилось — или данных пока мало."
              />
            </div>
          </>
        )}
      </div>

      {data?.unsought && (
        <div className="card tight" style={{ marginTop: "var(--s3)" }}>
          <div className="sec-h">
            <h3 style={{ fontSize: "var(--fs-15)", fontWeight: 600, margin: 0 }}>Объекты, которых никто не ищет</h3>
            <span className="note">
              {data.unsought.total} из {data.unsought.checked} проверенных
            </span>
          </div>
          {data.unsought.items.length === 0 ? (
            <p className="state">Под каждый проверенный объект в продаже есть хотя бы один ждущий покупатель.</p>
          ) : (
            <div className="list">
              {data.unsought.items.map((p) => (
                <Link className="row" key={p.propertyId} to={`/properties/${p.propertyId}`}>
                  <span className="t">
                    <b>
                      №{p.shortId} · {p.title}
                    </b>
                    <span>
                      {p.districtName ?? "Район не указан"}
                      {p.rooms != null ? ` · ${p.rooms} комн.` : ""} · {nf(p.priceTjs)} с.
                    </span>
                  </span>
                  <span className="chip mute">{p.daysOnSale} дн. в продаже</span>
                </Link>
              ))}
            </div>
          )}
          <p className="state" style={{ display: "block" }}>
            Ни один ждущий покупатель не подходит по району, бюджету и параметрам. Проверяются самые давние объекты в
            продаже.
          </p>
        </div>
      )}
    </div>
  );
}
