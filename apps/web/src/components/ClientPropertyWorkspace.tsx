import { useState } from "react";
import { Link } from "react-router-dom";
import { Home } from "lucide-react";
import { clientIntents, type ClientActivityProperty, type ClientPropertyActivity } from "@royal-home/shared";
import { useProperties } from "../hooks/useProperties";
import { useClientPropertyActivity } from "../hooks/useClientPropertyActivity";
import { formatMoney, PROPERTY_STATUS_LABELS, relativeTime } from "../lib/format";
import type { Client, Property } from "../types";
import { ClientShowingActions } from "./ClientShowingActions";

function PropertyLine({ property }: { property: ClientActivityProperty | Property }) {
  const thumb = "thumbUrl" in property ? property.thumbUrl : property.photos?.[0]?.thumbUrl;
  return <Link className="client-property-line" to={`/properties/${property.shortId}`}>
    {thumb ? <img src={thumb} alt="" loading="lazy" width={72} height={60} /> : <Home aria-hidden="true" size={28} />}
    <span><b>№{property.shortId} · {property.title}</b>
      <span>{formatMoney(property.price, property.currency)} · {PROPERTY_STATUS_LABELS[property.status as keyof typeof PROPERTY_STATUS_LABELS] ?? property.status}</span>
    </span>
  </Link>;
}

const stateLabels: Record<ClientPropertyActivity["items"][number]["state"], string> = {
  sent: "Отправлено", scheduled: "Назначен", completed: "Проведён", cancelled: "Отменён", unrecorded: "Результат не отмечен",
};
const channelLabels: Record<string, string> = { WHATSAPP: "WhatsApp", INSTAGRAM: "Instagram", FACEBOOK: "Messenger", TELEGRAM: "Telegram" };

export function ClientPropertyWorkspace({ client, locked, canCreate, onCreate, onSchedule, variant = "history" }: {
  client: Client; locked: boolean; canCreate: boolean; onCreate: () => void;
  onSchedule: (propertyId?: string) => void; variant?: "portfolio" | "history";
}) {
  const { sells, buys } = clientIntents(client);
  const portfolio = variant === "portfolio";
  const [section, setSection] = useState<"sent" | "showings">(buys ? "sent" : "showings");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const gated = !!client.pendingAcceptance && locked;
  const seller = useProperties({ sellerClientId: client.id, page }, sells && portfolio && !gated);
  const activity = useClientPropertyActivity(client.id, section, page, !portfolio && !gated);
  if (gated) return <p className="state">Объекты и история отправок откроются после принятия лида.</p>;
  if (portfolio && !sells) return null;
  const selected = portfolio ? seller : activity;
  const total = selected.data?.total ?? 0;
  const pageSize = selected.data?.pageSize ?? 20;
  const sellerItems = seller.data?.items ?? [];
  const visibleSellerItems = expanded ? sellerItems : sellerItems.slice(0, 3);
  return <section className="client-property-workspace" aria-label={portfolio ? "Объекты продавца" : "Отправки и показы"}>
    {!portfolio && <div className="client-workspace-nav" role="group" aria-label="История работы с объектами">
      {buys && <button type="button" className="pill ghost" aria-pressed={section === "sent"} onClick={() => { setSection("sent"); setPage(1); }}>Отправлены</button>}
      <button type="button" className="pill ghost" aria-pressed={section === "showings"} onClick={() => { setSection("showings"); setPage(1); }}>Показы</button>
    </div>}
    <div className="sec-h"><h2>{portfolio ? "Объекты продавца" : section === "sent" ? "Отправленные объекты" : "Показы"}</h2>
      {portfolio && canCreate && <button type="button" className="pill" onClick={onCreate}>Добавить объект</button>}
      {!portfolio && section === "showings" && !locked && <button type="button" className="pill" onClick={() => onSchedule()}>Назначить показ</button>}
    </div>
    {selected.isLoading ? <p role="status">Загружаем объекты…</p> : selected.isError ? <div role="alert"><p>Не удалось загрузить объекты. Проверьте соединение и повторите.</p><button type="button" className="pill ghost" onClick={() => void selected.refetch()}>Повторить</button></div> : <>
      {total === 0 && <p className="state">{portfolio ? "Объекты продавца ещё не добавлены в CRM." : section === "sent" ? "В журнале пока нет зарегистрированных отправок объектов." : "Показы пока не зарегистрированы."}</p>}
      {portfolio ? <>
        <div>{visibleSellerItems.map(property => <div key={property.id} className="client-property-entry"><PropertyLine property={property} />
          {!locked && <button type="button" className="pill ghost sm" onClick={() => onSchedule(property.id)}>Назначить показ</button>}</div>)}</div>
        {!expanded && total > 3 && <button className="pill ghost" type="button" onClick={() => setExpanded(true)}>Показать все объекты · {total}</button>}
      </> : <div>{activity.data?.items.map(item => <article className="client-property-entry" key={item.id}>
        {item.property ? <PropertyLine property={item.property} /> : <p>Объект {item.shortId ? `№${item.shortId}` : "без привязки"} · карточка недоступна</p>}
        <p className="sub">{stateLabels[item.state]} · {relativeTime(item.scheduledAt ?? item.at)}{item.channel ? ` · ${channelLabels[item.channel] ?? item.channel}` : ""}{item.kind === "PHOTO" ? " · фото" : item.kind === "LINK" ? " · ссылка" : ""}</p>
        {item.kind === "SHOWING" && !locked && item.canManage && item.state !== "completed" && item.state !== "cancelled" && <ClientShowingActions id={item.id} scheduledAt={item.scheduledAt} />}
      </article>)}</div>}
      {(!portfolio || expanded) && total > pageSize && <div className="client-workspace-nav" aria-label="Страницы объектов">
        <button className="pill ghost" type="button" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Назад</button>
        <span aria-live="polite">{page} из {Math.ceil(total / pageSize)}</span>
        <button className="pill ghost" type="button" disabled={page * pageSize >= total} onClick={() => setPage(p => p + 1)}>Далее</button>
      </div>}
    </>}
  </section>;
}
