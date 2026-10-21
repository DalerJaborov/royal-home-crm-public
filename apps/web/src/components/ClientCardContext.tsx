import { clientIntents } from "@royal-home/shared";
import { formatMoney, PROPERTY_TYPE_LABELS, relativeTime } from "../lib/format";
import type { Client } from "../types";

export function clientPropertyCountVisible(client: Client, role: "BUYER" | "SELLER") {
  const intents = clientIntents(client);
  return role === "SELLER" ? intents.sells && client.sellerDeclaredPropertyCount != null
    : intents.buys && client.buyerDesiredPropertyCount != null;
}

export function ClientCardFacts({ client }: { client: Client }) {
  if (!clientIntents(client).buys) return null;
  if (client.requirementsFieldsKind && client.requirementsFieldsKind !== "BUYER") {
    return <p className="sub" role="status">Параметры покупки нужно уточнить: сохранены сведения из прежнего обращения.</p>;
  }
  const facts = [client.desiredType ? PROPERTY_TYPE_LABELS[client.desiredType] : null,
    client.desiredRooms ? `${client.desiredRooms} комн.` : null, client.desiredDistrict?.name,
    client.budgetMin && client.budgetMax ? `${formatMoney(client.budgetMin, client.currency)} — ${formatMoney(client.budgetMax, client.currency)}` : client.budgetMax ? `до ${formatMoney(client.budgetMax, client.currency)}` : client.budgetMin ? `от ${formatMoney(client.budgetMin, client.currency)}` : null].filter(Boolean);
  return facts.length ? <p className="client-card-facts"><b>Ищет:</b> {facts.join(" · ")}</p> : <p className="sub">Параметры покупки ещё не заполнены.</p>;
}

export function ClientNextStep({ client, locked, onSchedule, onRecord }: {
  client: Client; locked: boolean; onSchedule: () => void; onRecord: () => void;
}) {
  if (client.pendingAcceptance && locked) return null;
  const step = client.nextStep;
  const overdue = !!step?.nextActionDate && new Date(step.nextActionDate).getTime() < Date.now();
  return <section className="client-next-step" aria-label="Следующий шаг">
    <div><b>{overdue ? "Просрочено" : "Следующий шаг"}</b>
      <p>{step ? `${step.nextAction || "Связаться с клиентом"}${step.nextActionDate ? ` · ${relativeTime(step.nextActionDate)}` : ""}` : "Пока не назначен"}</p>
    </div>
    {!locked && <div className="client-workspace-nav"><button type="button" className="pill ghost sm" onClick={onSchedule}>Назначить показ</button><button type="button" className="pill ghost sm" onClick={onRecord}>Записать результат</button></div>}
  </section>;
}
