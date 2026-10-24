import { Link } from "react-router-dom";
import { Clock } from "lucide-react";
import { useDeferredClientsFeed, useReturnDeferredClient, type DeferredClient } from "../hooks/useClients";
import { Pagination } from "../components/Pagination";
import { ClientsTabs } from "../components/ClientsTabs";
import { ClientsSectionLane } from "../components/ClientsSectionLane";
import { relativeTime } from "../lib/format";
import { CLIENT_KIND_LABELS, formatClientCode, formatClientName } from "../lib/clientFormat";
import { initialsFromName } from "../lib/channelMeta";
import { useMobileUx } from "../hooks/useMobileUx";
import { MobileDeferredClients } from "../components/mobile/MobileDeferredClients";

/**
 * «Отложенные» (задача G, план вечерней сессии 03-04.09.2026, решение владельца).
 *
 * Клиент сказал «дорого» / «финансы не готовы» / «не подошли объекты»
 * (REFUSAL_REASONS EXPENSIVE/FINANCE_ISSUE/WRONG_OBJECT) — это обычный исход
 * рынка, не отказ и не передача другому агенту. Карточка остаётся ЗА ТЕМ ЖЕ
 * агентом, слот в лимите освобождён, светофора нет, никто не звонит — крон
 * вернёт клиента в обычную работу по таймеру (3 мес/1 мес), либо раньше срока,
 * если клиент написал или позвонил сам (lib/deferredClients.ts на сервере).
 *
 * В ОТЛИЧИЕ ОТ «Потерянных» раздел видит НЕ только руководство: сервер (GET
 * /clients/deferred) скоупит по scopeToOwnAgent — агент видит СВОИ отложенные,
 * у кого есть право clients.viewAll (руководство) — все. Поэтому пункт стоит и
 * в боковом меню (lib/navigation.ts), а не только вкладкой в ClientsTabs,
 * которые для роли AGENT не рендерятся вовсе.
 *
 * ОБЛИК — тема «Royal Home 2026»: шапка `.pg-h`, `.card`, список `.list`/`.row`,
 * тихие строки `.quiet`/`.state`/`.empty`. Сверка с мобильным макетом c99db05f
 * (14.09.2026, `renderDeferredClients`) завела отдельный `MobileDeferredClients`
 * (прямой близнец `MobileLostClients.tsx`) — раньше `useMobileUx` тут не был
 * подключён вовсе, и телефон получал десктопную разметку, просто сжатую
 * медиазапросами.
 */
export function DeferredClients() {
  const mobile = useMobileUx();
  if (mobile) return <MobileDeferredClients />;
  return <DeferredClientsDesktop />;
}

function DeferredClientsDesktop() {
  // Страницами с «Показать ещё» (02.10.2026) — общая лента с телефоном.
  const feed = useDeferredClientsFeed();
  const { items, total, isLoading, error, refetch } = feed;

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Отложенные</h1>
            <p className="sub">
              «Дорого» / «финансы» / «не подошли объекты» — обычный исход рынка, не отказ. Карточка остаётся за
              вами, слот свободен, звонков не будет до срока возврата или пока клиент не напишет сам.
            </p>
          </div>
        </div>

        <div className="card">
          <ClientsTabs />
          <ClientsSectionLane section="BUYER" />

          <div className="quiet" style={{ marginTop: 8 }}>
            <span className="dot" />
            <span className="txt">
              Отказом это не считается: счётчик отказов и Royal Score не трогаются, агент остаётся прежним.
            </span>
          </div>

          {error && (
            <div className="state err">
              <span className="dot crit" />
              Список не загрузился. Это сбой связи, а не «отложенных нет».
              <button
                className="lk"
                type="button"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={() => refetch()}
              >
                Повторить
              </button>
            </div>
          )}

          {isLoading && !error && (
            <div className="state">
              <span className="sk av" />
              <span className="sk w28" />
              <span className="sk w22" />
              Загружаем отложенных клиентов
            </div>
          )}

          {!isLoading && !error && items.length === 0 && (
            <div className="empty">
              <span className="ic">
                <Clock className="i" />
              </span>
              <p>Отложенных клиентов нет.</p>
              <span className="sub">
                Как только клиент скажет «дорого» или «не подошли объекты», карточка появится здесь с датой возврата.
              </span>
            </div>
          )}

          {items.length > 0 && (
            <div className="list" style={{ marginTop: 8 }}>
              {items.map((client) => (
                <DeferredClientRow key={client.id} client={client} onReturned={() => feed.forget(client.id)} />
              ))}
            </div>
          )}
          {total !== undefined && (
            <Pagination
              loading={feed.isFetching}
              variant="loadMore"
              page={feed.page}
              pageSize={feed.pageSize}
              total={total}
              onPageChange={feed.setPage}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DeferredClientRow({ client, onReturned }: { client: DeferredClient; onReturned: () => void }) {
  const kindLabel = CLIENT_KIND_LABELS[client.kind];
  const returnClient = useReturnDeferredClient(client.id);

  return (
    <div className="row">
      <span className="av">{initialsFromName(formatClientName(client))}</span>
      <div className="t">
        <b>
          <Link className="lk" to={`/clients/${client.shortId}`}>
            {formatClientName(client)}
          </Link>
        </b>
        <span>
          {formatClientCode(client.shortId, client.kind)} · {kindLabel} · {client.phone}
          {client.deferredReason ? ` · ${client.deferredReason}` : ""}
        </span>
      </div>
      <span className="chip warn">{client.deferredUntil ? relativeTime(client.deferredUntil) : "без срока"}</span>
      <span className="meta only-wide">{client.agentName ?? "без агента"}</span>
      <div className="act">
        <button
          className="pill ghost sm"
          type="button"
          title="Поднять клиента из «Отложенных» раньше срока"
          disabled={returnClient.isPending}
          onClick={() => returnClient.mutate(undefined, { onSuccess: onReturned })}
        >
          {returnClient.isPending ? "Поднимаю" : "Поднять"}
        </button>
      </div>
    </div>
  );
}
