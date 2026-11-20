import { useState, type ReactNode } from "react";
import { formatMoney } from "../../../lib/format";
import type { Deal } from "../../../types";
import { RhCircle, type RhTone } from "../ui";
import { RoyalIcon } from "../RoyalIcon";
import type { RoyalIconName } from "../royalIconData";

/**
 * Строки раздела «Сделки» в новом виде (18.11.2026): слева фото объекта 48 (или
 * круг со значком, если фото нет), имя клиента 17, объект и деньги подписью,
 * справа действия. Деньги — тем же formatMoney и в той же валюте сделки, что в
 * прежнем виде; ничего не сокращается и не уходит в подсказку — длинная строка
 * переносится.
 */
export function RoyalDealThumb({ deal, icon, tone }: { deal: Deal; icon: RoyalIconName; tone: RhTone }) {
  const photo = deal.property.photos?.[0];
  const src = photo?.thumbUrl || photo?.url;
  const [broken, setBroken] = useState<string | null>(null);
  if (src && broken !== src) {
    return (
      <span className="ry-deal-thumb" aria-hidden="true">
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(src)} />
      </span>
    );
  }
  return <RhCircle icon={icon} tone={tone} />;
}

/** «Цена X, комиссия Y» — как в прежней полосе решений: «не указана», если суммы ещё нет. */
export function DealMoneyLine({ deal }: { deal: Deal }) {
  return (
    <span className="ry-deal-money">
      Цена <b className="ry-num">{deal.soldPrice ? formatMoney(deal.soldPrice, deal.currency) : "не указана"}</b>
      <span aria-hidden="true"> · </span>
      комиссия <b className="ry-num">{deal.commissionAmount ? formatMoney(deal.commissionAmount, deal.currency) : "не указана"}</b>
    </span>
  );
}

/**
 * Сделка на согласовании: одно главное действие на строку («Одобрить» — через то
 * же окно подтверждения), «Изменить» и «Вернуть» — тихими ссылками. Без права
 * решать — та же метка «ждёт руководителя».
 */
export function RoyalApprovalRow({ deal, showMoney, canDecide, canEdit, busy, onOpen, onApprove, onEdit, onReturn }: {
  deal: Deal; showMoney: boolean; canDecide: boolean; canEdit: boolean; busy: boolean;
  onOpen: () => void; onApprove: () => void; onEdit: () => void; onReturn: () => void;
}) {
  return (
    <div className="ry-deal-row" data-kind="approval">
      <RoyalDealThumb deal={deal} icon="hourglass" tone="warn" />
      <div className="ry-deal-row-text">
        <button type="button" className="ry-deal-name" onClick={onOpen}>{deal.client.fullName}</button>
        <span className="ry-deal-obj">{deal.property.title}</span>
        {showMoney && <DealMoneyLine deal={deal} />}
      </div>
      <div className="ry-deal-row-acts">
        {canDecide ? (
          <>
            <button type="button" className="ry-btn" data-variant="secondary" disabled={busy} onClick={onApprove}>Одобрить</button>
            {canEdit && <button type="button" className="ry-deal-link" title="Поправить цифры, не отправляя на доработку" onClick={onEdit}>Изменить</button>}
            <button type="button" className="ry-deal-link" title="Отправить на доработку" onClick={onReturn}>Вернуть</button>
          </>
        ) : (
          <span className="ry-deal-tag" data-tone="warn">ждёт руководителя</span>
        )}
      </div>
    </div>
  );
}

/**
 * Строка архива: завершённая (галочка, комиссия зелёным, «Документы», «Аннулировать»)
 * или отменённая (крестик, «аннулирована» с причиной текстом — причина раньше
 * жила только во всплывающей подсказке).
 */
export function RoyalArchiveRow({ deal, kind, onOpen, actions }: {
  deal: Deal; kind: "completed" | "cancelled"; onOpen: () => void; actions?: ReactNode;
}) {
  const done = kind === "completed";
  return (
    <div className="ry-deal-row" data-kind={kind}>
      <RoyalDealThumb deal={deal} icon={done ? "list-checks" : "x-circle"} tone={done ? "ok" : "a0"} />
      <div className="ry-deal-row-text">
        <button type="button" className="ry-deal-name" onClick={onOpen}>{deal.client.fullName}</button>
        <span className="ry-deal-obj">{deal.property.title}</span>
        <span className="ry-deal-figs">
          <span className="ry-deal-price ry-num">{formatMoney(deal.property.price, deal.property.currency)}</span>
          {done && deal.commissionAmount ? <span className="ry-deal-tag ry-num" data-tone="ok">+{formatMoney(deal.commissionAmount, deal.currency)}</span> : null}
          {!done && deal.annulledAt && <span className="ry-deal-tag" data-tone="warn">аннулирована</span>}
        </span>
        {/* Отказной лид: агентская часть комиссии делится 70/30 — условие обычной строкой со значком, не подсказкой и не таблеткой. */}
        {done && deal.refusedLeadSplit && (
          <span className="ry-deal-note"><RoyalIcon name="users" size={18} />Отказной лид: 70% продавшему, 30% приведшему</span>
        )}
        {!done && deal.annulledAt && deal.annulReason && <span className="ry-deal-reason">Причина: {deal.annulReason}</span>}
      </div>
      {actions && <div className="ry-deal-row-acts">{actions}</div>}
    </div>
  );
}
