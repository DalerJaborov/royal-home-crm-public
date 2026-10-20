import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, ChevronRight, PhoneCall, ShieldAlert, Users, UsersRound } from "lucide-react";
import { useAuthStore } from "../../../store/auth";
import { useCan } from "../../../lib/permissions";
import { useLostClients, useLostProperties } from "../../../hooks/useSecurity";
import { exactDateTime, pluralizeRu } from "../../../lib/format";
import { MhNoData, MhQuick, MhScreen, MhSection, type MhQuickItem } from "./MhScreen";
import { REFUSAL_REASON_LABELS, type ClientKind } from "@royal-home/shared";

/**
 * ГЛАВНАЯ СЛУЖБЫ БЕЗОПАСНОСТИ НА ТЕЛЕФОНЕ — обёртка `MhScreen` вокруг тех же
 * данных, что у `components/home/SecurityHome.tsx` (десктоп): `useLostClients`
 * и `useLostProperties` c verdict="PENDING", тот же запрос, что кормит
 * вкладки «Клиенты в СБ»/«Потерянные объекты» на `/security`. Права и данные
 * не менялись — см. `MobileMarketingHome.tsx` про две несовместимые CSS-темы
 * (`.rh2 .screens` vs `.rh2 .mh`), почему тело переписано, а не обёрнуто как
 * есть.
 */
export function MobileSecurityHome() {
  const agent = useAuthStore((s) => s.agent);
  const navigate = useNavigate();
  const can = useCan();
  const firstName = agent?.fullName?.split(" ")[0] ?? "";
  const [expanded, setExpanded] = useState(false);

  const clientsQuery = useLostClients(1, "PENDING", undefined, true);
  const propertiesQuery = useLostProperties(1, "PENDING", undefined, true);

  const isLoading = clientsQuery.isLoading || propertiesQuery.isLoading;
  const isError = clientsQuery.isError || propertiesQuery.isError;
  const queueError = clientsQuery.error ?? propertiesQuery.error;

  const queue = useMemo(() => {
    const clients = clientsQuery.data?.items ?? [];
    const properties = propertiesQuery.data?.items ?? [];
    return [...clients, ...properties].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, [clientsQuery.data, propertiesQuery.data]);

  const [focus, ...rest] = queue;
  const clientsTotal = clientsQuery.data?.total;
  const propertiesTotal = propertiesQuery.data?.total;
  const visibleRest = expanded ? rest : rest.slice(0, 5);

  // Ряд быстрых кнопок макета — «Проверки, Агенты, Звонки, Архив». Без
  // «Архива»: у роли SECURITY нет права `archive.view` (packages/shared/src/
  // permissions.ts, пресет SECURITY — clients.viewAll/securityReview,
  // deals.viewAll, properties.viewOwners, reports.view, calls.transcripts/
  // hearRecording, clients.viewOrigin, архива среди них нет), а `/archive` в
  // меню гейтится тем же правом (navigation.ts) — плитку в закрытый раздел не
  // ставим (договор, п.4).
  const totalQueue = (clientsTotal ?? 0) + (propertiesTotal ?? 0);
  const rawQuickActions: (MhQuickItem | false)[] = [
    can("clients.securityReview") && { key: "проверки", label: "Проверки", icon: ShieldAlert, href: "/security", tone: "aqua", count: clientsTotal != null && propertiesTotal != null ? totalQueue : undefined },
    { key: "агенты", tone: "aqua", label: "Агенты", icon: UsersRound, href: "/team" },
    (can("calls.transcripts") || can("calls.ownTranscripts")) && { key: "звонки", tone: "lav", label: "Звонки", icon: PhoneCall, href: "/calls" },
  ];
  const quickItems = rawQuickActions.filter((x): x is MhQuickItem => Boolean(x));

  return (
    <MhScreen greeting={`Салом${firstName ? `, ${firstName}` : ""}`}>
      <MhQuick items={quickItems} />
      <section className="sec" style={{ marginTop: 6 }}>
        <div className="sec-t">
          <h2>Показатели</h2>
        </div>
        <div className="tiles">
          <button type="button" className="tile" onClick={() => navigate("/security")}>
            <Users className="i" strokeWidth={1.5} aria-hidden="true" />
            <div className="v">{clientsTotal ?? "—"}</div>
            <div className="l">Клиенты на проверке</div>
          </button>
          <button type="button" className="tile" onClick={() => navigate("/security")}>
            <Building2 className="i" strokeWidth={1.5} aria-hidden="true" />
            <div className="v">{propertiesTotal ?? "—"}</div>
            <div className="l">Объекты на проверке</div>
          </button>
        </div>
      </section>

      <MhSection title="Горит сейчас" note="ждёт проверки дольше всех">
        {isLoading ? (
          <MhNoData>Загружаем очередь проверки…</MhNoData>
        ) : isError ? (
          <MhNoData tone="crit">
            {queueError instanceof Error ? queueError.message : "Очередь не загрузилась, проверьте соединение."}{" "}
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                clientsQuery.refetch();
                propertiesQuery.refetch();
              }}
            >
              Повторить
            </button>
          </MhNoData>
        ) : focus ? (
          <div className="card-s">
            <button type="button" className="row" onClick={() => navigate(`/clients/${focus.shortId}`)}>
              <span className="av" style={{ background: "var(--pink)", color: "var(--pink-ink)" }} aria-hidden="true">
                {focus.fullName?.[0]?.toUpperCase() ?? "?"}
              </span>
              <span className="t" style={{ textAlign: "left" }}>
                <span className="n">{focus.fullName}</span>
                <span className="s warn">
                  {KIND_LABELS[focus.kind]}
                  {focus.refusalReason ? `, ${REFUSAL_REASON_LABELS[focus.refusalReason]}` : ""}
                  {focus.responsibleAgent?.fullName ? `, вёл агент ${focus.responsibleAgent.fullName}` : ", агент не указан"}
                </span>
              </span>
              <ChevronRight className="i" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <MhNoData tone="ok">Очередь проверки пуста. Новые карточки появятся здесь сами.</MhNoData>
        )}
      </MhSection>

      <MhSection title="Далее в очереди" note={rest.length || undefined}>
        {rest.length === 0 ? (
          <MhNoData tone="ok">Больше ничего не ждёт.</MhNoData>
        ) : (
          <div className="card-s">
            {visibleRest.map((row) => (
              <button
                key={row.id}
                type="button"
                className="row"
                onClick={() => navigate(`/clients/${row.shortId}`)}
              >
                <span className="plate soft" aria-hidden="true">
                  {row.kind === "SELLER" ? <Building2 className="i" /> : <Users className="i" />}
                </span>
                <span className="t" style={{ textAlign: "left" }}>
                  <span className="n">{row.fullName}</span>
                  <span className="s">
                    {KIND_LABELS[row.kind]}
                    {row.refusalReason ? `, ${REFUSAL_REASON_LABELS[row.refusalReason]}` : ""}
                  </span>
                </span>
                <span className="s" style={{ flex: "none" }}>
                  {exactDateTime(row.createdAt)}
                </span>
              </button>
            ))}
            {rest.length > visibleRest.length && (
              <button type="button" className="row morerow" onClick={() => setExpanded(true)}>
                <span className="t">
                  <span className="n">Показать ещё ({rest.length - visibleRest.length})</span>
                </span>
              </button>
            )}
          </div>
        )}
      </MhSection>
    </MhScreen>
  );
}

const KIND_LABELS: Record<ClientKind, string> = {
  BUYER: "Покупатель",
  SELLER: "Продавец",
  OTHER: "Прочее",
};
