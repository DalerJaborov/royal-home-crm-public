import { useState } from "react";
import { Link } from "react-router-dom";
import { Image as ImageIcon } from "lucide-react";
import type { AdBoardProperty } from "@royal-home/shared";
import { formatMoneyExact, pluralizeRu } from "../../lib/format";
import { formatLeadCount, formatPct } from "../../lib/adsView";

/**
 * ОБЪЕКТЫ ОБЪЯВЛЕНИЯ — ряд чипов в строке рекламы (03.10.2026).
 *
 * Чип: миниатюра, `№107 · Сино · 25 %` и деньги на этот объект. Больше двух
 * объектов — остальные за «+N» с раскрытием: строка списка не должна вырастать в
 * простыню из-за объявления на десять квартир. Раскрытие — настоящая кнопка с
 * `aria-expanded`, а не «ховер».
 *
 * Сумма по объектам равна расходу объявления (сервер считает до дирама), а итог
 * самой строки остаётся справа — он должен сходиться с кабинетом Meta.
 */
const VISIBLE = 2;

export function AdPropertyChips({ properties }: { properties: AdBoardProperty[] }) {
  const [open, setOpen] = useState(false);
  if (properties.length === 0) return null;

  const shown = open ? properties : properties.slice(0, VISIBLE);
  const hidden = properties.length - VISIBLE;

  return (
    <div className="wrap" style={{ gap: 6, marginTop: 6 }} role="group" aria-label="Объекты объявления">
      {shown.map((p) => (
        <Link
          key={p.id}
          className="chip"
          to={`/properties/${p.shortId}`}
          title={`${p.title ?? `Объект №${p.shortId}`}: доля ${formatPct(p.share * 100)}, ${formatMoneyExact(p.spendTjs, "TJS")}${
            p.leadStats
              ? p.leadStats.leads > 0
                ? `, клиентов в CRM ${formatLeadCount(p.leadStats.leads)}${
                    p.leadStats.costPerLeadTjs != null ? `, цена клиента ${formatMoneyExact(p.leadStats.costPerLeadTjs, "TJS")}` : ""
                  }`
                : p.spendTjs > 0
                  ? ", клиентов в CRM нет"
                  : ""
              : ""
          }`}
          style={{ gap: 6, maxWidth: "100%" }}
        >
          {p.thumbUrl ? (
            <img
              src={p.thumbUrl}
              alt=""
              loading="lazy"
              width={20}
              height={20}
              style={{ borderRadius: 4, objectFit: "cover", flex: "none" }}
            />
          ) : (
            <ImageIcon className="i" aria-hidden style={{ width: 16, height: 16, flex: "none" }} />
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            №{p.shortId}
            {p.title ? ` · ${p.title}` : ""} · {formatPct(p.share * 100)}
          </span>
          <span style={{ color: "var(--muted)", flex: "none" }}>{formatMoneyExact(p.spendTjs, "TJS")}</span>
          {/* Клиенты объекта из этого объявления (волна 1): доля по тем же весам, что и деньги. */}
          {p.leadStats && p.leadStats.leads > 0 && (
            <span style={{ color: "var(--muted)", flex: "none" }}>· {formatLeadCount(p.leadStats.leads)} кл.</span>
          )}
        </Link>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className="chip"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={
            open
              ? "Свернуть список объектов"
              : `Показать ещё ${hidden} ${pluralizeRu(hidden, ["объект", "объекта", "объектов"])}`
          }
        >
          {open ? "свернуть" : `+${hidden}`}
        </button>
      )}
    </div>
  );
}

/**
 * Метка «в объявлении N материалов, привязано M» и красный бейдж «не все
 * объекты привязаны». Бейдж горит, когда сервер просит проверить (`needsReview`)
 * или материалов больше, чем привязанных объектов. Реклама самого агентства
 * (`brand`) объекта не ждёт — для неё второе условие не считается.
 */
export function AdMaterialsNote({
  assetCount,
  linked,
  needsReview,
  brand,
}: {
  assetCount: number;
  linked: number;
  needsReview: boolean;
  brand: boolean;
}) {
  const notAll = needsReview || (!brand && assetCount > linked);
  const showCounts = assetCount > 1 || linked > 1;
  if (!showCounts && !notAll) return null;

  return (
    <span className="wrap" style={{ gap: 6, marginTop: 6 }}>
      {showCounts && (
        <span style={{ color: "var(--muted)", fontSize: "var(--fs-13)" }}>
          в объявлении {assetCount} {pluralizeRu(assetCount, ["материал", "материала", "материалов"])}, привязано{" "}
          {linked}
        </span>
      )}
      {notAll && (
        <span className="chip crit" role="status">
          <span className="dot crit" aria-hidden />
          не все объекты привязаны
        </span>
      )}
    </span>
  );
}
