import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { api, ApiError } from "../lib/api";
import { formatMoney } from "../lib/format";
import { lightboxItemsFromShared, openIndexForCell, SHARE_GALLERY_CELLS } from "../lib/sharedGallery";
import { PhotoLightbox } from "../components/PhotoLightbox";
import {
  PROPERTY_CONDITION_LABELS,
  PROPERTY_TYPE_LABELS,
  propertyFieldShown,
  propertyHasCondition,
  type Currency,
  type PropertyCondition,
  type PropertyType,
} from "@royal-home/shared";

interface SharedPhoto {
  url: string;
  thumbUrl: string;
}

interface SharedProperty {
  title: string;
  type: PropertyType;
  rooms: number | null;
  areaSqm: string | number;
  price: string | number;
  currency: Currency;
  district: string | null;
  city: string | null;
  condition: PropertyCondition;
  amenities: string[];
  description: string | null;
  photos: SharedPhoto[];
  clipVideoUrl: string | null;
  sold: boolean;
  /** Необязательно: старый сервер его не присылал — тогда судим по `sold`. */
  saleStatus?: "AVAILABLE" | "SOON" | "RESERVED" | "SOLD" | "UNAVAILABLE";
}

const SALE_CHIPS: Record<NonNullable<SharedProperty["saleStatus"]>, { label: string; tone: string }> = {
  AVAILABLE: { label: "В продаже", tone: "ok" },
  // Объект ещё готовится — проверка, фото, монтаж (владелец 02.10.2026, D16).
  SOON: { label: "Скоро в продаже", tone: "" },
  RESERVED: { label: "Забронировано", tone: "warn" },
  SOLD: { label: "Продано", tone: "mute" },
  UNAVAILABLE: { label: "Снят с продажи", tone: "mute" },
};

interface SharedAgent {
  fullName: string;
  phone: string;
}

interface ShareResponse {
  property: SharedProperty;
  agent: SharedAgent | null;
}

/**
 * Публичная страница приватной ссылки на объект (docs/plan-18-08-private-listings-and-video.md
 * §4) — открывается клиентом БЕЗ входа в CRM, вне AppLayout: ни сайдбара, ни топбара,
 * ни навигации по остальным объектам/сайту. Ровно то, что показано в ссылке — фото,
 * короткое видео, цена/площадь и контакт агента, — и ничего похожего на общий список
 * (это и есть требование владельца: offSite-объект не должен «выводить» на другие
 * объекты ни в каком виде).
 */
export function PublicPropertyShare() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<ShareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Просмотрщик со ВСЕМИ фото: ячеек в галерее пять, а «Ещё N» без него вело в никуда.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<ShareResponse>(`/l/${token}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Не удалось открыть ссылку");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="card">
            <div className="quiet">
              <span className="dot" />
              <span className="txt">Загружаем объект…</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="card">
            <div className="empty">
              <span className="ic">
                <svg className="i" viewBox="0 0 24 24">
                  <path d="M3 11 12 3l9 8v10H3z" />
                  <path d="M9 21v-6h6v6" />
                </svg>
              </span>
              <p>{error ?? "Ссылка не найдена или больше не действует"}</p>
              <p className="sub">Попросите агента прислать новую ссылку на объект.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { property, agent } = data;
  const sale = property.saleStatus ?? (property.sold ? "SOLD" : "AVAILABLE");
  // «Скоро в продаже» — не «недоступен»: агент звонит и рассказывает об объекте,
  // похожие варианты здесь не к месту.
  const offMarket = sale !== "AVAILABLE" && sale !== "SOON";
  // Знаки места галереи: пять ячеек эталона, первая крупная. Больше пяти
  // снимков — надпись «Ещё N» поверх последней, как в property-detail.html.
  const cells = property.photos.slice(0, SHARE_GALLERY_CELLS);
  const rest = property.photos.length - cells.length;

  return (
    /* Публичная страница живёт вне AppLayout, поэтому область эталона `.rh2`
       и раскладку `.scr` она открывает сама. Ширина ограничена самим `.scr`
       (max-width 1240), внутри — те же карточки, что и в карточке объекта. */
    <div className="rh2 screens" style={{ minHeight: "100dvh" }}>
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>{property.title}</h1>
            {/* Точный адрес сюда не попадает (ночная проверка 24.09.2026, №9) —
                только район и город, как на сайте агентства. */}
            <p className="sub">{[property.district, property.city].filter(Boolean).join(", ")}</p>
            <div className="wrap" style={{ marginTop: 10 }}>
              <span className={`chip ${SALE_CHIPS[sale].tone}`}>{SALE_CHIPS[sale].label}</span>
              <span className="chip mute">{PROPERTY_TYPE_LABELS[property.type]}</span>
            </div>
          </div>
          <div className="acts">
            <div style={{ textAlign: "right" }}>
              <span className="money big">{formatMoney(property.price, property.currency)}</span>
            </div>
          </div>
        </div>

        {cells.length > 0 && (
          <div className="gal">
            {cells.map((photo, i) => (
              <a
                key={i}
                className={i === 0 ? "cell big" : "cell"}
                href={photo.url}
                onClick={(e) => {
                  e.preventDefault();
                  setLightboxIndex(openIndexForCell(i, property.photos.length));
                }}
                aria-label={
                  i === cells.length - 1 && rest > 0
                    ? `Открыть остальные фото, ещё ${rest}`
                    : `Открыть фото ${i + 1} из ${property.photos.length}`
                }
              >
                <img
                  src={i === 0 ? photo.url : photo.thumbUrl}
                  alt=""
                  loading={i === 0 ? "eager" : "lazy"}
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                />
                {i === cells.length - 1 && rest > 0 && <span className="more">Ещё {rest}</span>}
              </a>
            ))}
          </div>
        )}
        {lightboxIndex !== null && (
          <PhotoLightbox
            items={lightboxItemsFromShared(property.photos)}
            index={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
            onIndexChange={setLightboxIndex}
          />
        )}

        <div className="card">
          <div className="sec-h stack">
            <h2>Параметры</h2>
          </div>
          <div className="fgrid" style={{ gap: "var(--s3)" }}>
            <ShareField label="Тип" value={PROPERTY_TYPE_LABELS[property.type]} />
            {/* У участка нет состояния ремонта и комнат (propertyTypeFields.ts). */}
            {propertyHasCondition(property.type) && (
              <ShareField label="Состояние" value={PROPERTY_CONDITION_LABELS[property.condition]} />
            )}
            <ShareField label="Площадь" value={`${property.areaSqm} м²`} />
            {property.rooms != null && propertyFieldShown(property.type, "rooms") && (
              <ShareField label="Комнаты" value={String(property.rooms)} />
            )}
          </div>
          {property.amenities.length > 0 && (
            <>
              <h3 className="sec-t">Что есть в объекте</h3>
              <div className="wrap">
                {property.amenities.map((a) => (
                  <span className="chip" key={a}>
                    {a}
                  </span>
                ))}
              </div>
            </>
          )}
          {property.description && (
            <>
              <h3 className="sec-t">Описание</h3>
              <p style={{ whiteSpace: "pre-line" }}>{property.description}</p>
            </>
          )}
        </div>

        {property.clipVideoUrl && (
          <div className="card">
            <div className="sec-h stack">
              <h2>Видео объекта</h2>
            </div>
            <video
              controls
              preload="metadata"
              src={property.clipVideoUrl}
              style={{ width: "100%", borderRadius: "var(--r-md)", background: "var(--track)" }}
            >
              Браузер не умеет проигрывать видео.
            </video>
          </div>
        )}

        {agent && (
          <div className="card">
            <div className="mod solve">
              <div className="t">
                <b>{agent.fullName || "Агент Royal Home"}</b>
                <span>
                  {sale === "SOLD"
                    ? "Объект продан. Агент подберёт похожие варианты."
                    : sale === "SOON"
                      ? "Объект готовится к продаже. Агент расскажет подробности и покажет его."
                      : offMarket
                        ? "Объект сейчас недоступен. Агент подберёт похожие варианты."
                        : "Ответит на вопросы и покажет объект."}
                </span>
              </div>
              <div className="acts">
                <a className="pill" href={`tel:${agent.phone}`}>
                  {offMarket ? "Уточнить похожие" : "Позвонить агенту"}
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Пара «подпись — значение» эталона: `.fld` с `.lab` сверху. */
function ShareField({ label, value }: { label: string; value: string }) {
  return (
    <div className="fld">
      <span className="lab">{label}</span>
      <b style={{ fontFamily: "var(--ff-head)", fontSize: "var(--fs-15)", color: "var(--ink)" }}>{value}</b>
    </div>
  );
}
