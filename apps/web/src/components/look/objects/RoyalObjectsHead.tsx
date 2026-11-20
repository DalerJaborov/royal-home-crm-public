import { PropertyDraftShortcut } from "../../PropertyDraftShortcut";
import { ObjIcon } from "./ObjIcon";

/**
 * Шапка каталога объектов — «Новый вид» (18.11.2026): заголовок 32, одна строка
 * под ним и одна синяя кнопка. Те же сведения и действия, что у прежней шапки
 * чистой оболочки: сколько найдено, «Ждут вашей проверки» (только модератору,
 * нажатие ставит тот же фильтр), черновик нового объекта и создание объекта.
 */
export function RoyalObjectsHead({ total, pendingReview, onShowPending, overdue, onShowOverdue, canCreate, onCreate }: {
  total?: number; pendingReview?: number; onShowPending: () => void;
  /** Объекты с задержкой подготовки — строкой в подзаголовке, а не отдельной карточкой над списком (пачка D1). */
  overdue?: number; onShowOverdue?: () => void;
  canCreate: boolean; onCreate: () => void;
}) {
  return (
    <header className="ry-objects-head">
      <div className="ry-objects-head-text">
        <h1>Объекты</h1>
        <p>
          {total !== undefined ? <>Найдено: <b className="ry-num">{total}</b></> : "Каталог агентства"}
          {!!pendingReview && (
            <button type="button" className="ry-objects-pending" onClick={onShowPending}>
              <ObjIcon name="circle-alert" size={18} />Ждут вашей проверки: {pendingReview}
            </button>
          )}
          {!!overdue && onShowOverdue && (
            <button type="button" className="ry-objects-pending" data-tone="crit" onClick={onShowOverdue}>
              <ObjIcon name="flame" size={18} />Задержка подготовки: {overdue}
            </button>
          )}
        </p>
      </div>
      {canCreate && (
        <div className="ry-objects-head-acts">
          <PropertyDraftShortcut />
          <button type="button" className="ry-btn" data-variant="primary" aria-label="Добавить объект" onClick={onCreate}>
            <ObjIcon name="plus" />Объект
          </button>
        </div>
      )}
    </header>
  );
}
