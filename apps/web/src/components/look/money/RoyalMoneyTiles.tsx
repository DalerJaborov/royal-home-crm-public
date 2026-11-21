import { RoyalIcon } from "../RoyalIcon";
import type { RoyalIconName } from "../royalIconData";
import { RoyalAmount } from "./RoyalAmount";
import { pillTone, type PillTone } from "../tileTone";
import { lenBucket } from "../../EmptyValue";

/**
 * «НОВЫЙ ВИД» раздела «Деньги» (пачка money, 18.11.2026): итоги месяца плитками
 * сверху вкладки «Обзор и прогноз».
 *
 * Суммы приходят СТРОКАМИ, уже отформатированными тем же `nums(...)` экрана
 * Финансов, что и прежние четыре карточки (`cef-summary-grid`): компонент ничего
 * не считает, не округляет и не подставляет — только раскладывает. Тест
 * pages/Finance.royal.test.tsx сверяет, что в обоих видах на одних данных стоят
 * одни и те же суммы.
 *
 * Цвет — смысл: комиссия (доход) — синяя плита, как «Комиссия» на главной
 * (pages/TodayRoyal.tsx); доход компании — зелёный круг; расходы — янтарный;
 * прибыль — зелёная, а убыток — красный круг со значком «!» и красной цифрой
 * (различается и цветом, и значком, не только оттенком).
 */
export function RoyalMoneyTiles({ commission, companyRevenue, operatingExpenses, profit, loss }: {
  commission: string;
  companyRevenue: string;
  operatingExpenses: string;
  profit: string;
  /** Прибыль меньше нуля — показать убыток красным. */
  loss: boolean;
}) {
  return (
    <div className="ry-money-tiles">
      <div className="ry-money-hero">
        <span className="ry-money-hero-label"><RoyalIcon name="banknote" size={24} />Валовая комиссия</span>
        <strong className="ry-money-hero-value ry-num" data-len={lenBucket(commission)}><RoyalAmount text={commission} /></strong>
      </div>
      <Tile icon="building-2" tone="ok" label="Доход компании" value={companyRevenue} />
      <Tile icon="stack" tone={pillTone("today")} label="Операционные расходы" value={operatingExpenses} />
      <Tile icon={loss ? "circle-alert" : "trend-up"} tone={loss ? pillTone("overdue") : pillTone("good")} label="Прибыль" value={profit} />
    </div>
  );
}

function Tile({ icon, tone, label, value }: { icon: RoyalIconName; tone: PillTone; label: string; value: string }) {
  return (
    <div className="ry-money-tile" data-tone={tone}>
      <span className="ry-circle" data-tone={tone === "neutral" ? "a0" : tone}><RoyalIcon name={icon} size={24} /></span>
      <span className="ry-money-tile-text">
        <span className="ry-money-tile-label">{label}</span>
        <strong className="ry-money-tile-value ry-num" data-len={lenBucket(value)}><RoyalAmount text={value} /></strong>
      </span>
    </div>
  );
}
