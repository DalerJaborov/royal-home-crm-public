import { daysSince, formatMoney } from "../../../lib/format";
import type { Deal } from "../../../types";
import { DealIcon } from "./DealIcon";
import { RoyalDealThumb } from "./RoyalDealRows";

/**
 * Содержимое карточки сделки на доске — «Новый вид» (18.11.2026). Сама карточка
 * (`<article>` с перетаскиванием, открытием клиента и окнами снаружи) остаётся в
 * pages/Deals.tsx: здесь только разметка внутри, с теми же действиями — шаг
 * назад, отменить, шаг вперёд или «закрыть / на закрытие», документы. Подписи у
 * кнопок теперь видны словами («Закрыть сделку» вместо одного значка
 * самолётика), смысл и права прежние. Каждая кнопка гасит всплытие, чтобы клик
 * не открывал клиента.
 */
export type DealStep = { key: string; label: string } | null;

export function RoyalDealTileBody({ deal, showAgent, canWrite, prev, next, closeLabel, onDocs, onPrev, onCancel, onNext, onClose }: {
  deal: Deal; showAgent: boolean; canWrite: boolean; prev: DealStep; next: DealStep;
  /** «Закрыть сделку» (закрывает сам) или «Отправить на закрытие» — решает Deals.tsx по правам. */
  closeLabel: string;
  onDocs: () => void; onPrev: () => void; onCancel: () => void; onNext: () => void; onClose: () => void;
}) {
  const stop = (run: () => void) => (event: { stopPropagation: () => void }) => { event.stopPropagation(); run(); };
  const days = daysSince(deal.startedAt);
  return (
    <>
      <span className="ry-deal-tile-head">
        <RoyalDealThumb deal={deal} icon="handshake" tone="a0" />
        <span className="ry-deal-row-text">
          <span className="ry-deal-name">{deal.client.fullName}</span>
          <span className="ry-deal-obj">{deal.property.title}</span>
        </span>
      </span>
      <span className="ry-deal-figs">
        <span className="ry-deal-price ry-num">{formatMoney(deal.property.price, deal.property.currency)}</span>
        <span className="ry-deal-tag" title="Дней с начала сделки"><DealIcon name="clock" size={16} />{days} дн</span>
      </span>
      {deal.commissionAmount ? (
        <span className="ry-deal-comm">комиссия <b className="ry-num">{formatMoney(deal.commissionAmount, deal.currency)}</b></span>
      ) : null}
      {showAgent && deal.agent?.fullName && <span className="ry-deal-agent">Ведёт: {deal.agent.fullName}</span>}
      <span className="ry-deal-tile-acts">
        <button type="button" className="ry-deal-link" onClick={stop(onDocs)}>
          <DealIcon name="file" size={18} />Документы
        </button>
        {canWrite && <button type="button" className="ry-deal-link" data-tone="crit" title="Отменить сделку" onClick={stop(onCancel)}>Отменить</button>}
      </span>
      {/* Без права записи в эту сделку (A3) подвала с шагами нет вовсе — как в прежнем виде. */}
      {canWrite && (
        <span className="ry-deal-steps">
          {prev && (
            <button type="button" className="ry-deal-step" aria-label={`Вернуть на «${prev.label}»`} title={`Вернуть на «${prev.label}»`} onClick={stop(onPrev)}>
              <DealIcon name="chev-left" size={22} />
            </button>
          )}
          {next ? (
            <button type="button" className="ry-deal-step" data-wide="true" aria-label={`Продвинуть на «${next.label}»`} title={`Продвинуть на «${next.label}»`} onClick={stop(onNext)}>
              {next.label}<DealIcon name="chev-right" size={22} />
            </button>
          ) : (
            <button type="button" className="ry-btn ry-deal-close" data-variant="soft" aria-label={closeLabel} onClick={stop(onClose)}>
              <DealIcon name="send" size={20} />{closeLabel}
            </button>
          )}
        </span>
      )}
    </>
  );
}

/** Шапка колонки: этап, число и сумма комиссий колонки в сомони (только когда она больше нуля). */
export function RoyalDealColumnHead({ label, count, commissionTjs }: { label: string; count: number; commissionTjs: number }) {
  return (
    <header className="ry-deal-col-head">
      <h3>{label}<span className="ry-deal-col-n ry-num">{count}</span></h3>
      {commissionTjs > 0 && <p className="ry-deal-col-sum">комиссии <b className="ry-num">{formatMoney(commissionTjs, "TJS")}</b></p>}
    </header>
  );
}
