import { useState } from "react";
import { useClients } from "../hooks/useClients";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { AddInteractionModal } from "./AddInteractionModal";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { RH2_ROW_BUTTON } from "./rh2/Rh2Scope";
import { ClientAvatar } from "./ClientAvatar";
import { showingClientView, showingSearchState } from "./clean/showingClientView";
import type { Client } from "../types";

/**
 * «ЗАПИСАТЬ ПОКАЗ» ИЗ МЕНЮ «+» (06.10.2026, ревью телефона).
 *
 * Раньше пункт вёл на `/calendar`, где формы показа нет: в CRM показ записывается
 * из карточки клиента (`AddInteractionModal`). Теперь меню «+» открывает ту же
 * форму прямо с любого экрана: сначала выбор клиента поиском, затем форма показа
 * (тип «Показ» выбран заранее). Никакой новой логики сохранения: после выбора
 * работает прежний `AddInteractionModal` со всеми его проверками и последствиями.
 */
export function ShowingQuickForm({
  onClose,
  initialPropertyId,
  clean = false,
}: {
  onClose: () => void;
  clean?: boolean;
  /** Показ назначается на этот объект («Назначить показ» с карточки объекта,
   *  06.10.2026): после выбора клиента форма откроется в режиме планирования
   *  (`AddInteractionModal`: дата, время, объект) уже с этим объектом. */
  initialPropertyId?: string;
}) {
  const [query, setQuery] = useState("");
  const q = useDebouncedValue(query.trim(), 250);
  const [picked, setPicked] = useState<Client | null>(null);
  const found = useClients({ q: q || undefined, page: 1, ...(clean ? { pageSize: 12 } : {}) });
  const items = (found.data?.items ?? []).slice(0, 12);

  if (picked) {
    return (
      <AddInteractionModal
        clientId={picked.id}
        selectedClientName={clean ? picked.displayName ?? picked.fullName : undefined}
        initialType="SHOWING"
        mode="schedule"
        initialPropertyId={initialPropertyId}
        isSeller={picked.kind === "SELLER"}
        onClose={onClose}
        onSaved={() => onClose()}
      />
    );
  }

  if (clean) {
    const state = showingSearchState(found.isLoading, found.isError, items.length);
    return <Rh2Sheet title="Назначить показ · выберите клиента" onClose={onClose}>
      <div className="fld">
        <label htmlFor="clean-showing-client-search">Имя, телефон или номер клиента</label>
        <input id="clean-showing-client-search" type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Начните вводить…" style={{ fontSize: 16, minHeight: 44 }} />
      </div>
      <div aria-live="polite">
        {state === "loading" && <p role="status">Ищем клиентов…</p>}
        {state === "error" && <div role="alert"><p>Не удалось загрузить клиентов.</p><button type="button" className="pill" onClick={() => void found.refetch()}>Повторить</button></div>}
        {state === "empty" && <p>Клиентов не найдено. Уточните имя, телефон или номер.</p>}
      </div>
      <div className="clean-showing-clients grid gap-2" aria-busy={found.isFetching}>
        {items.map((client) => {
          const view = showingClientView(client);
          return <button key={client.id} type="button" onClick={() => setPicked(client)} className="clean-showing-client-row flex min-h-11 w-full items-start gap-3 rounded-[14px] bg-row-alt p-4 text-left text-ink hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-blue">
            <span className="shrink-0"><ClientAvatar fullName={client.fullName} avatarUrl={client.avatarUrl} size={44} palette="tokens" /></span>
            <span className="min-w-0 space-y-1">
              <span className="block break-words text-[16px] font-semibold">{view.name}</span>
              <span className="block text-[14px] text-gray-500">{view.identity}</span>
              {view.phone && <span className="block text-[14px]">{view.phone}</span>}
              <span className="block break-words text-[14px]">{view.request}</span>
              {view.agent && <span className="block break-words text-[14px] text-gray-500">Ответственный: {view.agent}</span>}
            </span>
          </button>;
        })}
      </div>
      {!!found.data?.total && found.data.total > items.length && <p className="mt-3 text-[14px] text-gray-500">Показаны {items.length} из {found.data.total}. Уточните поиск, чтобы найти нужного клиента.</p>}
    </Rh2Sheet>;
  }

  return (
    <Rh2Sheet title="Записать показ" onClose={onClose}>
      <div className="fld">
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Кому показ: имя, телефон или номер клиента"
          aria-label="Поиск клиента"
        />
      </div>
      <div className="list">
        {items.map((c) => (
          <button key={c.id} type="button" className="row" style={RH2_ROW_BUTTON} onClick={() => setPicked(c)}>
            <span className="t">
              <b>{c.displayName ?? c.fullName}</b>
              <span>{c.kind === "SELLER" ? "Продавец" : "Покупатель"}</span>
            </span>
          </button>
        ))}
        {found.isLoading && (
          <div className="quiet">
            <div className="ln">
              <span>Ищем…</span>
            </div>
          </div>
        )}
        {!found.isLoading && items.length === 0 && (
          <div className="quiet">
            <div className="ln">
              <span>Клиентов не найдено</span>
            </div>
          </div>
        )}
      </div>
    </Rh2Sheet>
  );
}
