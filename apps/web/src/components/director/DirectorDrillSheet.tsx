import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DirectorDrillItem, DirectorDrillKey } from "@royal-home/shared";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { RhBlockState, RhButton, RhGroup, RhRow } from "../look/ui";
import { loadView } from "../rh2/Rh2ErrorState";
import { dushanbeDate } from "../../lib/date";
import { DRILL_PAGE, useDirectorDrill, type DirectorFilters } from "../../hooks/useDirectorDashboard";
import { moneyTjs, nums } from "./DirectorBlocks";

/**
 * ШТОРКА «ЧТО СОСТАВЛЯЕТ ЦИФРУ» (ТЗ №11): список записей за плиткой с теми же периодом и
 * фильтрами. Строка ведёт в карточку клиента; сумма (комиссия сделки) — только при праве на деньги.
 * Страницы по 50 копятся в списке: «Показать ещё» дописывает, а не заменяет.
 */
export function DirectorDrillSheet({ filters, drill, onClose }: {
  filters: DirectorFilters; drill: { key: DirectorDrillKey; label: string } | null; onClose: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<DirectorDrillItem[]>([]);
  const key = drill?.key ?? null;
  const query = useDirectorDrill(filters, key, offset);

  // Новая цифра — список с нуля.
  useEffect(() => { setOffset(0); setItems([]); }, [key]);
  useEffect(() => {
    const page = query.data;
    if (!page || page.key !== key) return;
    setItems((cur) => (page.offset === 0 ? page.items : cur.length === page.offset ? [...cur, ...page.items] : cur));
  }, [query.data, key]);

  if (!drill) return null;
  const view = loadView(query);
  const total = query.data?.total ?? 0;
  return (
    <Rh2Sheet wide onClose={onClose} title={drill.label} className="dd-sheet">
      <div className="dd-drill" data-testid="director-drill">
        {view !== "ready" && items.length === 0 ? <RhBlockState kind={view} onRetry={() => void query.refetch()} /> : items.length === 0 ? (
          <p className="dd-quiet">Записей нет.</p>
        ) : (
          <>
            <p className="dd-quiet" role="status">Показано {nums(items.length)} из {nums(total)}</p>
            <RhGroup label={drill.label}>
              {items.map((it) => (
                <RhRow key={`${it.entity}-${it.id}`} to={`/clients/${it.clientId}`} title={it.clientName || "Без имени"}
                  sub={[dushanbeDate(it.date, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }), it.agentName ?? "без ответственного", it.sourceLabel, it.statusLabel].filter(Boolean).join(" · ")}
                  right={it.amount !== null ? <b className="ry-num">{moneyTjs(it.amount)}</b> : undefined} />
              ))}
            </RhGroup>
            {query.data?.hasMore && (
              <RhButton variant="secondary" disabled={query.isFetching} onClick={() => setOffset(items.length)}>
                {query.isFetching ? "Загружаем…" : `Показать ещё ${Math.min(DRILL_PAGE, total - items.length)}`}
              </RhButton>
            )}
            {(query.data?.hiddenInTrash ?? 0) > 0 && <p className="dd-quiet" role="status">Ещё {nums(query.data?.hiddenInTrash ?? 0)} в Корзине: они входят в цифру плитки, но их видят только те, у кого есть доступ к архиву.</p>}
            <p className="dd-quiet"><Link to="/clients">Все клиенты</Link></p>
          </>
        )}
      </div>
    </Rh2Sheet>
  );
}
