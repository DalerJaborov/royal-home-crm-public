import { NO_CONTACT_TEXT, noContactTileTone } from "@royal-home/shared";

const num = (n: number) => n.toLocaleString("ru-RU");

/**
 * Плитка «не связывались» на экране «Клиенты» (телефон). Правило и подписи —
 * packages/shared/src/clientNoContact.ts, число — `/clients/summary.neverContacted`.
 * Красная только когда есть кого показать (жалоба Нозы 17.11.2026: красные «50 без
 * контакта» висели над клиентами, которым звонили каждый день).
 */
export function NoContactTile({ count, onClick }: { count: number; onClick: () => void }) {
  const crit = noContactTileTone(count) === "crit";
  return (
    <button type="button" className="tile" onClick={onClick} title={`Срез «${NO_CONTACT_TEXT.title}»`} data-tone={crit ? "crit" : "calm"}>
      <div className={crit ? "v crit" : "v"}>{num(count)}</div>
      <div className={crit ? "l crit" : "l"}>{count > 0 ? NO_CONTACT_TEXT.tile : NO_CONTACT_TEXT.zero}</div>
    </button>
  );
}
