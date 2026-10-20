import { Link } from "react-router-dom";
import { useDeferredClientsFeed, useReturnDeferredClient, type DeferredClient } from "../../hooks/useClients";
import { Pagination } from "../Pagination";
import { MhLane, MhListScreen } from "./mh/MhList";
import { useClientSectionChips } from "./mh/MhClientSections";
import { MhQuiet } from "../home/mh/MhScreen";
import { relativeTime } from "../../lib/format";
import { CLIENT_KIND_LABELS, formatClientCode, formatClientName } from "../../lib/clientFormat";
import { avatarInitial, avatarToneClass } from "../../lib/avatarTone";

/**
 * «ОТЛОЖЕННЫЕ КЛИЕНТЫ» НА ТЕЛЕФОНЕ — прямой близнец `MobileLostClients.tsx`:
 * тот же облик макета `.rh2 .mh` из того же файла-источника
 * (`pages/Clients.tsx`), переодето 17.09.2026 с ПК-эталона
 * `.rh2 .screens > .scr` по той же причине — соседний раздел одного списка не
 * должен выглядеть из другой программы.
 *
 * Право `clients.assign` здесь не нужно: сервер сам скоупит выдачу
 * (GET /clients/deferred, scopeToOwnAgent) — агент видит свои отложенные
 * карточки, руководство все, поэтому в отличие от «Потерянных» гейта по
 * `useCan` нет ни в десктопной версии (pages/DeferredClients.tsx), ни здесь.
 *
 * Данные и действия — общие с десктопом: та же лента страниц
 * (`useDeferredClientsFeed`, «Показать ещё» с 02.10.2026), та же кнопка
 * «Поднять» (`useReturnDeferredClient`).
 */
export function MobileDeferredClients() {
  const feed = useDeferredClientsFeed();
  const { items, total, isLoading, error, refetch } = feed;
  const sections = useClientSectionChips("deferred");

  return (
    <MhListScreen title="Отложенные" count={total ?? null}>
      {sections.length > 0 && <MhLane label="Другие разделы клиентов" chips={sections} />}

      <div className="sec" style={{ marginTop: 10 }}>
        <MhQuiet>
          Отказом это не считается: счётчик отказов и Royal Score не трогаются, агент остаётся прежним.
        </MhQuiet>
      </div>

      <div className="sec" style={{ marginTop: 4 }}>
        <div className="list">
          {error ? (
            <div className="state err">
              Список не загрузился. Это сбой связи, а не «отложенных нет».
              <button type="button" className="lnk" onClick={() => refetch()}>
                Повторить
              </button>
            </div>
          ) : isLoading ? (
            <div className="state">Загружаем отложенных</div>
          ) : items.length === 0 ? (
            <div className="state">
              Отложенных клиентов нет. Как только клиент скажет «дорого» или «не подошли объекты», карточка
              появится здесь с датой возврата.
            </div>
          ) : (
            items.map((client) => (
              <MobileDeferredRow key={client.id} client={client} onReturned={() => feed.forget(client.id)} />
            ))
          )}
        </div>
      </div>

      {/* Остальные — кнопкой «Показать ещё» (02.10.2026), вместо прежнего
          «Показаны ближайшие N из M» без способа увидеть дальше. */}
      {total !== undefined && (
        <div className="sec">
          <Pagination
            variant="loadMore"
            page={feed.page}
            pageSize={feed.pageSize}
            total={total}
            onPageChange={feed.setPage}
          />
        </div>
      )}
    </MhListScreen>
  );
}

/**
 * Строка отложенного клиента: `.row` макета — аватар-инициал, имя с чипом
 * срока возврата, причина отсрочки строкой `.s` (без тревожного цвета: это
 * обычный исход рынка, а не отказ). Номер карточки, тип и телефон — вторым
 * куском той же строки: полезны на карточке, но не суть раздела.
 */
function MobileDeferredRow({ client, onReturned }: { client: DeferredClient; onReturned: () => void }) {
  const returnClient = useReturnDeferredClient(client.id);
  const name = client.fullName.trim() || formatClientName(client);
  const parts = [
    client.deferredReason?.trim() || null,
    `${formatClientCode(client.shortId, client.kind)} · ${CLIENT_KIND_LABELS[client.kind]} · ${client.phone}`,
  ].filter(Boolean) as string[];

  return (
    <div className="row">
      <span className={`av ${avatarToneClass(name)}`} aria-hidden="true">
        {avatarInitial(name)}
      </span>
      {/* Кнопка «Поднять» стоит в той же строке, поэтому ссылкой сделан только
          текстовый блок: кнопка внутри ссылки — недопустимая разметка. */}
      <Link className="b" to={`/clients/${client.shortId}`} aria-label={`Открыть карточку: ${name}`}>
        <span className="n">
          <span className="nm">{name}</span>
          <span className="chip warn xs">
            {client.deferredUntil ? relativeTime(client.deferredUntil) : "без срока"}
          </span>
        </span>
        <span className="s">
          {parts.map((p, i) => (
            <span key={i} className="tx">
              {i > 0 ? `· ${p}` : p}
            </span>
          ))}
        </span>
      </Link>
      <button
        type="button"
        className="btn pill sm"
        title="Поднять клиента из «Отложенных» раньше срока"
        disabled={returnClient.isPending}
        onClick={() => returnClient.mutate(undefined, { onSuccess: onReturned })}
      >
        {returnClient.isPending ? "Поднимаю" : "Поднять"}
      </button>
    </div>
  );
}
