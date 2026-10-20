import { clientKindLabel } from "@royal-home/shared";
import type { Client } from "../../types";
import { formatClientCode } from "../../lib/clientFormat";
import { formatMoney, PROPERTY_TYPE_LABELS } from "../../lib/format";

/** Present the server-scoped client; never fetch or reconstruct an unmasked phone. */
export function showingClientView(client: Client) {
  const kind = client.kind ?? "BUYER";
  const stale = !!client.requirementsFieldsKind && client.requirementsFieldsKind !== kind;
  const min = client.budgetMin ? formatMoney(client.budgetMin, client.currency) : null;
  const max = client.budgetMax ? formatMoney(client.budgetMax, client.currency) : null;
  const budget = min && max ? `${min} – ${max}` : min ? `от ${min}` : max ? `до ${max}` : null;
  const facts = [client.desiredType ? PROPERTY_TYPE_LABELS[client.desiredType] : null, client.desiredRooms ? `${client.desiredRooms} комн.` : null, client.desiredDistrict?.name, budget].filter(Boolean).join(" · ");
  const request = kind === "OTHER" ? "Прочее обращение" : stale ? "Запрос требует уточнения после смены типа клиента" : facts ? `${kind === "SELLER" ? "Объект продавца" : "Ищет"}: ${facts}` : "Запрос пока не заполнен";
  return { name: client.displayName ?? client.fullName, identity: `${formatClientCode(client.shortId, kind)} · ${clientKindLabel({ ...client, kind })}`, phone: client.phone, request, agent: client.assignedAgent?.fullName ?? null };
}

export function showingSearchState(loading: boolean, error: boolean, count: number) {
  return error ? "error" : loading ? "loading" : count === 0 ? "empty" : "ready";
}
