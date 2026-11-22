import { clientIntents, positiveBudget } from "@royal-home/shared";
import { formatMoney, PROPERTY_TYPE_LABELS } from "../lib/format";
import type { Client } from "../types";

export function ClientCardFacts({ client }: { client: Client }) {
  if (!clientIntents(client).buys) return null;
  if (client.requirementsFieldsKind && client.requirementsFieldsKind !== "BUYER") {
    return <p className="sub" role="status">Параметры покупки нужно уточнить: сохранены сведения из прежнего обращения.</p>;
  }
  const facts = [client.desiredType ? PROPERTY_TYPE_LABELS[client.desiredType] : null,
    client.desiredRooms ? `${client.desiredRooms} комн.` : null, client.desiredDistrict?.name,
    positiveBudget(client.budgetMin) && positiveBudget(client.budgetMax) ? `${formatMoney(client.budgetMin!, client.currency)} — ${formatMoney(client.budgetMax!, client.currency)}` : positiveBudget(client.budgetMax) ? `до ${formatMoney(client.budgetMax!, client.currency)}` : positiveBudget(client.budgetMin) ? `от ${formatMoney(client.budgetMin!, client.currency)}` : null].filter(Boolean);
  return facts.length ? <p className="client-card-facts"><b>Ищет:</b> {facts.join(" · ")}</p> : <p className="sub">Параметры покупки ещё не заполнены.</p>;
}

/**
 * Действия под кнопками звонка на телефоне. Блок «Следующий шаг · Пока не назначен» убран (владелец 22.11.2026),
 * «Записать результат» показывается только при включённом рубильнике в Настройках (по умолчанию выкл): `onRecord` не передан — кнопки нет.
 */
export function ClientCardActions({ locked, onSchedule, onRecord }: { locked: boolean; onSchedule: () => void; onRecord?: () => void }) {
  if (locked) return null;
  return <div className="client-workspace-nav client-card-actions">
    <button type="button" className="pill ghost sm" onClick={onSchedule}>Назначить показ</button>
    {onRecord && <button type="button" className="pill ghost sm" onClick={onRecord}>Записать результат</button>}
  </div>;
}
