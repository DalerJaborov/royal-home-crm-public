import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { clearRecentSearches, loadRecentSearches, saveRecentSearch, type RecentSearch } from "../lib/recentSearches";
import { api } from "../lib/api";
import { formatMoney } from "../lib/format";
import { formatClientCode, formatPropertyCode } from "../lib/clientFormat";
import { useNavigation } from "../lib/navigation";
import { startPaletteSearch } from "../lib/paletteSearch";
import { rh2AvatarTone } from "../lib/rh2Avatar";
import { RH2_ROW_BUTTON } from "./rh2/Rh2Scope";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import type { Client, Deal, Paginated, Property } from "../types";

type Scope = "all" | "clients" | "properties" | "deals" | "sections";

const SCOPE_CHIPS: { key: Scope; label: string }[] = [
  { key: "all", label: "Всё" },
  { key: "clients", label: "Клиенты" },
  { key: "properties", label: "Объекты" },
  { key: "deals", label: "Сделки" },
  { key: "sections", label: "Разделы" },
];

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const actorId = useAuthStore(s => s.agent?.id ?? null);
  // Recreate query/results/history synchronously, including a mounted palette.
  return <ActorCommandPalette key={actorId ?? "anonymous"} actorId={actorId} onClose={onClose} />;
}

function ActorCommandPalette({ actorId, onClose }: { actorId: string | null; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [properties, setProperties] = useState<Property[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(false);
  // Every group failing is "search is down", not "nothing found".
  const [searchFailed, setSearchFailed] = useState(false);
  const [recent, setRecent] = useState<RecentSearch[]>(() => loadRecentSearches(actorId));
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  // Разделы — тот же реестр, что у Sidebar/BottomNav/ProfileMenu (lib/navigation.ts):
  // ни одного раздела, придуманного отдельно для поиска, только то, что реально
  // есть в меню (и с учётом прав текущего сотрудника — useNavigation их уже фильтрует).
  const { all: allSections } = useNavigation();

  useEffect(() => {
    // Ответ на УСТАРЕВШИЙ запрос не должен перетирать свежий (аудит №4, 27.08;
    // повторно FORMS08, 04.10): отмена в cleanup гасит и таймер, и уже улетевший
    // запрос, см. lib/paletteSearch.ts.
    return startPaletteSearch(
      query,
      async (q) => {
        // Каждая группа падает отдельно (05.10.2026): раньше один отказ /clients или
        // /properties ронял весь Promise.all, и в палитре молча не было НИЧЕГО —
        // «поиск не находит объекты» при том, что объекты отвечали.
        let failed = 0;
        const empty = <T,>(): Paginated<T> => { failed++; return { items: [], total: 0, page: 1, pageSize: 0 }; };
        const [p, c, d] = await Promise.all([
          api<Paginated<Property>>(`/properties?q=${encodeURIComponent(q)}`).catch(() => empty<Property>()),
          api<Paginated<Client>>(`/clients?q=${encodeURIComponent(q)}`).catch(() => empty<Client>()),
          // /deals не пагинирован (отдаёт массив, не Paginated) — доска сделок
          // сама забирает всё разом и режется на фронте; здесь берём только начало.
          api<Deal[]>(`/deals?q=${encodeURIComponent(q)}`).catch(() => { failed++; return []; }),
        ]);
        return { properties: p.items.slice(0, 5), clients: c.items.slice(0, 5), deals: d.slice(0, 5), allFailed: failed === 3 };
      },
      {
        clear: () => {
          setProperties([]);
          setClients([]);
          setDeals([]);
          setSearchFailed(false);
        },
        setLoading,
        setResults: (r) => {
          setProperties(r.properties);
          setClients(r.clients);
          setDeals(r.deals);
          setSearchFailed(r.allFailed);
        },
      }
    );
  }, [query]);

  // Разделы фильтруются чисто на клиенте, без похода на сервер — это статический
  // список пунктов меню, а не данные из базы.
  const matchedSections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return allSections.filter((s) => s.label.toLowerCase().includes(needle)).slice(0, 5);
  }, [allSections, query]);

  function go(path: string, label: string) {
    saveRecentSearch(actorId, { label, url: path, ts: Date.now() });
    navigate(path);
    onClose();
  }

  function goRecent(entry: RecentSearch) {
    navigate(entry.url);
    onClose();
  }

  function clearRecent() {
    clearRecentSearches(actorId);
    setRecent([]);
  }

  const showClients = (scope === "all" || scope === "clients") && clients.length > 0;
  const showProperties = (scope === "all" || scope === "properties") && properties.length > 0;
  const showDeals = (scope === "all" || scope === "deals") && deals.length > 0;
  const showSections = (scope === "all" || scope === "sections") && matchedSections.length > 0;
  const hasAnyResult = showClients || showProperties || showDeals || showSections;

  return (
    <Rh2Sheet open onClose={onClose} title="Поиск" ariaLabel="Поиск по CRM">
      {/* Поле поиска и область поиска — `.field`/`.inp` и сегменты `.seg`
          эталона. Фокус в поле ставит сама шторка: она выбирает первый
          `input` окна, и это ровно он. */}
      <label className="field">
        <span className="lab">Клиент, объект, сделка, раздел</span>
        <input
          ref={inputRef}
          autoFocus
          className="inp"
          style={{ maxWidth: "none" }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Имя, телефон, адрес или название раздела"
        />
      </label>

      <div className="hscroll" style={{ marginTop: 12 }}>
        <div className="seg">
          {SCOPE_CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              aria-pressed={scope === chip.key}
              onClick={() => setScope(chip.key)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      <p className="state" role="status" aria-live="polite">{loading ? "Ищу…" : query.trim() && !hasAnyResult ? (searchFailed ? "Поиск сейчас недоступен — попробуйте ещё раз" : "Ничего не найдено") : ""}</p>

      {showClients && (
        <>
          <div className="sec-t">Клиенты</div>
          <div className="list">
            {clients.map((c) => (
              <button key={c.id} type="button" className="row" style={RH2_ROW_BUTTON} onClick={() => go(`/clients/${c.shortId}`, c.fullName)}>
                <span className="av" style={rh2AvatarTone(c.fullName)}>
                  {initials(c.fullName)}
                </span>
                <div className="t">
                  <b>{c.fullName}</b>
                  <span>
                    {formatClientCode(c.shortId, c.kind)}
                    {c.phone ? ` · ${c.phone}` : ""}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {showProperties && (
        <>
          <div className="sec-t">Объекты</div>
          <div className="list">
            {properties.map((p) => (
              <button
                key={p.id}
                type="button"
                className="row"
                style={RH2_ROW_BUTTON}
                onClick={() => go(`/properties/${p.shortId}`, p.title)}
              >
                <div className="t">
                  <b>{p.title}</b>
                  <span>
                    {formatPropertyCode(p.shortId)}
                    {p.district?.name ? ` · ${p.district.name}` : ""}
                  </span>
                </div>
                <span className="meta">{formatMoney(p.price, p.currency)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {showDeals && (
        <>
          <div className="sec-t">Сделки</div>
          <div className="list">
            {deals.map((d) => (
              <button
                key={d.id}
                type="button"
                className="row"
                style={RH2_ROW_BUTTON}
                // У сделок нет отдельной страницы-карточки (см. pages/Deals.tsx —
                // доска канбан без deep-link на одну сделку) — ведём в раздел целиком.
                onClick={() => go(`/deals`, `${d.client.fullName}, ${d.property.title}`)}
              >
                <div className="t">
                  <b>{d.client.fullName}</b>
                  <span>
                    {formatPropertyCode(d.property.shortId)} · {d.property.title}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {showSections && (
        <>
          <div className="sec-t">Разделы</div>
          <div className="list">
            {matchedSections.map((sec) => (
              <button key={sec.to} type="button" className="row" style={RH2_ROW_BUTTON} onClick={() => go(sec.to, sec.label)}>
                <sec.icon className="i" />
                <div className="t">
                  <b>{sec.label}</b>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {!query.trim() &&
        (recent.length > 0 ? (
          <>
            <div className="sec-h" style={{ marginTop: 24 }}>
              <h2>Недавнее</h2>
              <button type="button" className="lnk" onClick={clearRecent}>
                Очистить
              </button>
            </div>
            <div className="list">
              {recent.map((r) => (
                <button key={r.url + r.ts} type="button" className="row" style={RH2_ROW_BUTTON} onClick={() => goRecent(r)}>
                  <div className="t">
                    <b>{r.label}</b>
                  </div>
                  <span className="meta">переход</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="empty">
            <p>Начните вводить имя, телефон, адрес или название раздела</p>
            <span className="sub">Поиск работает по клиентам, объектам, сделкам и разделам меню</span>
          </div>
        ))}
    </Rh2Sheet>
  );
}

/** Инициалы для аватара строки клиента — как в остальных списках темы. */
function initials(name: string) {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}
