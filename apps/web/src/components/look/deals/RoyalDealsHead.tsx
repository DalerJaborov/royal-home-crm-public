import { formatMoney } from "../../../lib/format";
import { RhTile } from "../ui";
import { DealIcon } from "./DealIcon";

/**
 * Шапка раздела «Сделки» — «Новый вид» (18.11.2026): заголовок 32, одна строка
 * под ним, «Фильтры» мягкой кнопкой и одна синяя «Сделка». Те же сведения и
 * действия, что у шапки чистой оболочки (CleanDealsHeader): чьи сделки на доске
 * (всей команды, ваши, выбранного агента), шторка фильтра — только тому, кто
 * видит всю команду, новая сделка — только тому, кто вправе её завести.
 */
export function RoyalDealsHead({ scope, filtered, onFilter, onCreate }: {
  scope: string; filtered: boolean; onFilter: (() => void) | null; onCreate: (() => void) | null;
}) {
  return (
    <header className="ry-deals-head">
      <div className="ry-deals-head-text">
        <h1>Сделки</h1>
        <p>{scope}</p>
      </div>
      {(onFilter || onCreate) && (
        <div className="ry-deals-head-acts">
          {onFilter && (
            <button type="button" className="ry-btn" data-variant="gray" aria-pressed={filtered} onClick={onFilter}>
              <DealIcon name="sliders" size={20} />Фильтры{filtered && <span className="ry-deals-dot" aria-label="фильтр включён" role="img" />}
            </button>
          )}
          {onCreate && (
            <button type="button" className="ry-btn" data-variant="primary" aria-label="Новая сделка" onClick={onCreate}>
              <DealIcon name="plus" size={20} />Сделка
            </button>
          )}
        </div>
      )}
    </header>
  );
}

/**
 * Сводка доски плитками — те же четыре числа, что CleanDealsSummary: в работе,
 * на согласовании, закрыто за месяц (по Душанбе) и комиссия за месяц в сомони
 * (только тому, кто видит деньги). Сумма — тем же formatMoney, без сокращений;
 * длинная переносится, а не обрезается. Плитки «в работе» и «на согласовании»
 * ведут к своему блоку на этой же странице.
 */
export function RoyalDealsSummary({ ready, activeCount, approvalCount, closedCount, commissionTjs, seesMoney }: {
  ready: boolean; activeCount: number; approvalCount: number; closedCount: number; commissionTjs: number; seesMoney: boolean;
}) {
  const show = (value: string | number) => (ready ? value : "—");
  return (
    <section className="ry-deals-summary" aria-label="Сводка сделок">
      <div className="ry-deals-tiles" data-count={seesMoney ? 4 : 3}>
        <RhTile variant="plain" icon="handshake" label="В работе" value={show(activeCount)} to="#ry-deals-board" />
        <RhTile variant="plain" icon="hourglass" label="На согласовании" value={show(approvalCount)} to={approvalCount > 0 ? "#ry-deals-approval" : undefined} />
        <RhTile variant="plain" icon="list-checks" label="Закрыто за месяц" value={show(closedCount)} />
        {seesMoney && (
          <div className="ry-tile ry-deals-money-tile" data-variant="ink">
            <span className="ry-tile-label"><DealIcon name="banknote" size={26} />Комиссия за месяц</span>
            <span className="ry-tile-value ry-num">{show(formatMoney(commissionTjs, "TJS"))}</span>
          </div>
        )}
      </div>
      <p className="ry-deals-note">
        {ready ? "По загруженным сделкам текущего фильтра. Месяц — по времени Душанбе." : "Сводка появится после загрузки сделок."}
      </p>
    </section>
  );
}
