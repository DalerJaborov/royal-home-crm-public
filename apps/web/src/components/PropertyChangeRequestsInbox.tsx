import { Link } from "react-router-dom";
import { ClipboardEdit } from "lucide-react";
import { PROPERTY_CHANGE_KIND_LABELS } from "@royal-home/shared";
import { usePendingPropertyChangeRequests } from "../hooks/usePropertyChangeRequests";
import { useCan } from "../lib/permissions";
import { relativeTime } from "../lib/format";
import { formatPropertyCode } from "../lib/clientFormat";
import { initials } from "../lib/theme2026Person";
import { Rh2EmptyState } from "./rh2/Rh2EmptyState";
import { Rh2ErrorState } from "./rh2/Rh2ErrorState";

/**
 * «Заявки на изменение объектов (N)» — входящие директору и админу (07.10.2026).
 * Лежит рядом с заявками на удаление объектов (раздел «Архив»): тот же вид, тот же
 * зритель. Решение принимается на карточке объекта — там видно, что именно изменится,
 * поэтому здесь только список и ссылки на заявки (`?changeRequest=<id>`).
 */
export function PropertyChangeRequestsInbox() {
  const can = useCan();
  const allowed = can("archive.view") && can("properties.delete");
  const { data, isLoading, isError, refetch } = usePendingPropertyChangeRequests(allowed);
  if (!allowed) return null;

  const items = data?.items ?? [];
  const more = data?.nextCursor ? "+" : "";

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>
          Заявки на изменение объектов ({items.length}
          {more})
        </h2>
        <span className="note">Цена, данные, ролик — решение на карточке объекта</span>
      </div>

      {isLoading && (
        <div className="state">
          <span className="sk av" />
          <span className="sk w28" />
          <span className="sk w22" /> Загружаем заявки
        </div>
      )}
      {isError && (
        <Rh2ErrorState
          message="Не удалось загрузить заявки на изменение. Это не значит, что заявок нет — попробуйте ещё раз."
          onRetry={() => refetch()}
        />
      )}
      {!isLoading && !isError && items.length === 0 && (
        <Rh2EmptyState icon={ClipboardEdit} title="Заявок на изменение объектов нет." />
      )}

      {items.length > 0 && (
        <div className="list">
          {items.map((r) => (
            <div className="row" key={r.id}>
              <span className="av" style={{ background: "var(--lime)", color: "var(--lime-ink)" }}>
                {initials(r.author.fullName)}
              </span>
              <div className="t">
                <b>
                  <Link className="lk" to={`/properties/${r.propertyShortId}?changeRequest=${r.id}`}>
                    {PROPERTY_CHANGE_KIND_LABELS[r.kind]}, {formatPropertyCode(r.propertyShortId)}
                  </Link>
                </b>
                <span>
                  Просит {r.author.fullName}, {relativeTime(r.createdAt)}
                  {r.comment ? `. «${r.comment}»` : ""}
                </span>
              </div>
              <div className="act">
                <Link className="pill sm" to={`/properties/${r.propertyShortId}?changeRequest=${r.id}`}>
                  Разобрать
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
