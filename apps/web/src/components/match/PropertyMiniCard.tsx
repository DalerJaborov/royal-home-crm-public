import { Link } from "react-router-dom";
import { House } from "lucide-react";
import { formatMoney } from "../../lib/format";
import type { Interaction } from "../../types";

/**
 * Мини-карточка объекта в хронологии клиента (задание D, 17.09.2026,
 * `docs/match-policy-plan-17-09.md` §6, строка «Хронология клиента»).
 *
 * ДО ЭТОГО запись «Автоподбор: объект №X» / «Ссылка отправлена» была голым
 * текстом — владелец искал объект глазами по номеру, отдельно открывая раздел
 * «Объекты». Теперь фото и цена стоят тут же, кликабельны, и вести агента
 * никуда не нужно: «сразу отправлять в переписку… карточками везде и
 * кликабельные, чтобы три часа не искать рекомендуемый объект».
 *
 * Рисуется, ТОЛЬКО когда сервер прислал фото у записи (i.property.photos):
 * старые записи хронологии и сервер, который это поле ещё не шлёт, оставляют
 * прежний текст записи как есть — второго источника правды не заводим, это не
 * замена тексту, а надстройка над ним.
 */
export function PropertyMiniCard({ property }: { property: NonNullable<Interaction["property"]> }) {
  const thumb = property.photos?.[0]?.thumbUrl;
  const href = property.shortId ? `/properties/${property.shortId}` : null;
  const body = (
    <>
      <span className="ph" style={{ width: 48, height: 48, flexShrink: 0 }}>
        {thumb ? <img src={thumb} alt="" /> : <House className="i" strokeWidth={1.5} />}
      </span>
      <span className="t" style={{ minWidth: 0 }}>
        <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {property.shortId ? `№${property.shortId} — ` : ""}
          {property.title}
        </b>
        {property.price != null && <span>{formatMoney(property.price, property.currency ?? "TJS")}</span>}
      </span>
    </>
  );
  return (
    <div className="prow" style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
      {href ? (
        <Link to={href} className="t" style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          {body}
        </Link>
      ) : (
        <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>{body}</span>
      )}
    </div>
  );
}
