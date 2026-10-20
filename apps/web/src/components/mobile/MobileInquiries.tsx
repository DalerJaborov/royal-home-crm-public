import { useState } from "react";
import { Link } from "react-router-dom";
import type { ClientSort } from "@royal-home/shared";
import { useClients, type ClientFilters } from "../../hooks/useClients";
import { useCan } from "../../lib/permissions";
import { useMarkSectionSeen } from "../../hooks/useCounters";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { CallClientButton } from "../CallClientButton";
import { ClientAvatar } from "../ClientAvatar";
import { Pagination } from "../Pagination";
import { useAccumulatedPages } from "../../hooks/useAccumulatedPages";
import { CalendarClock, UserRound } from "lucide-react";
import { relativeTime } from "../../lib/format";
import {
  CLIENT_SOURCE_LABELS,
  CLIENT_STATUS_CHIP,
  CLIENT_STATUS_CHIP_DOT,
  CLIENT_STATUS_LABELS,
  formatClientCode,
} from "../../lib/clientFormat";
import { ReturnedBadge } from "../ReturnedBadge";
import { InactiveLevelDot, showsInactiveLabel } from "../InactiveLevelBadge";
import type { Client } from "../../types";

/**
 * Мобильные «Прочие обращения» — подэкран, который на телефоне подменяет собой
 * срез общего списка клиентов (Clients.tsx: kind==="OTHER" && mobile).
 *
 * ОБЛИК — тема «Royal Home 2026». Своего фрагмента у этого экрана в эталоне
 * нет, поэтому разметка собрана из блоков clients.html: та же обёртка
 * `.rh2 > .scr`, та же шапка `.pg-h`, та же карточка со списком
 * (`.card` → `.filters` → `.hscroll`+`.seg` → `.list`+`.row` → `.pager`), те же
 * `.state`/`.empty` для загрузки, отказа и пустоты. Смысл — чтобы «прочие»
 * читались как тот же список клиентов, а не как отдельное приложение: строка
 * здесь собрана из тех же частей, что `ClientRow` в pages/Clients.tsx
 * (`.av`, `.t > b + span`, `.chip`, `.step`, `.meta`, `.act`).
 *
 * Прежняя шапка-компонент (MobileSectionHeader) снята: перенесённые мобильные
 * подэкраны носят `.pg-h` — так же сделали MobileHealth и MobileAiLearning,
 * а кнопка «назад» у них живёт в общей мобильной оболочке, а не внутри экрана.
 *
 * Функции без аналога в макете (правило MASTER п.1): поиск и фильтр по статусу —
 * лентой `.seg`, пагинация — `Pagination variant="rh2"`. Звонок — ТОЛЬКО через
 * CallClientButton (правило владельца 06.08.2026), никаких голых tel:.
 *
 * Раздел управленческий: сортировка и фильтр по району из общего списка клиентов
 * здесь не повторяются — обращения «не по недвижимости» к районам не привязаны,
 * а порядок «новые сверху» (серверный по умолчанию) и есть рабочий.
 */

/** Свежие обращения сверху — тот же DEFAULT_SORT, что в pages/Clients.tsx. */
const SORT: ClientSort = "created_desc";

export function MobileInquiries() {
  const can = useCan();
  const canView = can("otherInquiries.view");
  // Открытие раздела гасит красный счётчик в меню — до ранних возвратов.
  useMarkSectionSeen("otherInquiries");

  const [status, setStatus] = useState<string | undefined>(undefined);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  // Дебаунс поиска — тот же приём, что в списках клиентов и объектов.
  const debouncedQ = useDebouncedValue(q, 350);

  const filters: ClientFilters = {
    kind: "OTHER",
    status,
    q: debouncedQ?.trim() || undefined,
    sort: SORT,
    page,
  };
  const { data, isLoading, error } = useClients(filters, canView);

  // Мягкая подгрузка вместо страниц (решение владельца 15.09.2026): страницы
  // копятся в ленту, сброс — сменой статуса или поиска (resetKey ниже).
  // Стоит ДО проверки прав: ниже есть ранний возврат для того, кому раздел
  // закрыт, а хук, оказавшийся за ним, вызывался бы не в каждом отрисовке —
  // правило хуков это запрещает, и сборка падает.
  // Свежая первая страница, пока пролистано дальше неё (аудит №38, useAccumulatedPages).
  const { data: headPage } = useClients({ ...filters, page: 1 }, canView && page > 1);
  const items = useAccumulatedPages(data?.items, page, `${status}:${debouncedQ}`, headPage?.items);

  // Агентам сюда доступа нет (API и так не вернёт им записей, но сообщение
  // понятнее пустого списка) — тот же текст, что на десктопе, и тем же тихим
  // блоком `.state`, что RoleGate в pages/Clients.tsx.
  if (!canView) {
    return (
      <div className="rh2 screens">
        <div className="scr" data-stagger>
          <div className="pg-h">
            <div>
              <h1>Прочие обращения</h1>
              <p className="sub">Не покупатель и не продавец</p>
            </div>
          </div>
          <div className="card tight">
            <div className="state">Раздел доступен руководству.</div>
          </div>
        </div>
      </div>
    );
  }

  const filtered = !!q || !!status;

  return (
    <div className="rh2 screens">
      <div className="scr" data-stagger>
        <div className="pg-h">
          <div>
            <h1>Прочие обращения</h1>
            <p className="sub">Не покупатель и не продавец{data ? ` · ${data.total}` : ""}</p>
          </div>
        </div>

        <div className="card">
          <div className="filters">
            <input
              className="inp"
              type="search"
              placeholder="Имя, телефон, ПК-000042"
              aria-label="Поиск по обращениям"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>

          {/* Фильтр по статусу — лента `.seg` в `.hscroll`, как срезы списка клиентов. */}
          <div className="hscroll" style={{ marginTop: 12 }}>
            <div className="seg" role="tablist" aria-label="Фильтр по статусу">
              {[
                { value: "", label: "Все" },
                ...Object.entries(CLIENT_STATUS_LABELS).map(([value, label]) => ({ value, label })),
              ].map((chip) => {
                const active = (status ?? "") === chip.value;
                return (
                  <button
                    key={chip.value || "all"}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      setStatus(chip.value || undefined);
                      setPage(1);
                    }}
                  >
                    {chip.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Состояния блока — тихими строками (договор §6.12), как в списке клиентов. */}
          {isLoading && !error && (
            <div className="state">
              <span className="sk av" />
              <span className="sk w28" />
              <span className="sk w22" />
              Загружаем обращения
            </div>
          )}

          {error && (
            <div className="state err">
              <span className="dot crit" />
              {error instanceof Error ? error.message : "Не удалось загрузить обращения"}
            </div>
          )}

          {!isLoading && !error && items.length > 0 && (
            <div className="list" style={{ marginTop: 8 }}>
              {items.map((c) => (
                <InquiryRow key={c.id} client={c} />
              ))}
            </div>
          )}

          {!isLoading && !error && items.length === 0 && (
            <div className="empty">
              <span className="ic">
                <UserRound className="i" />
              </span>
              <p>{filtered ? "Никого не нашли." : "Обращений пока нет."}</p>
              <span className="sub">
                {filtered
                  ? "Под этот фильтр ничего не подходит: сбросьте поиск или откройте «Все»."
                  : "Сюда попадают обращения не по теме недвижимости: их разбирает руководство, агентам они не назначаются."}
              </span>
            </div>
          )}

          {data && (
            <div style={{ marginTop: 16 }}>
              <Pagination
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPageChange={setPage}
                variant="loadMore"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Строка обращения — те же части, что у `ClientRow` в pages/Clients.tsx:
 * аватар `.av`, имя-ссылка в `.t > b`, описание в `.t > span`, плашки `.chip`,
 * обещание `.step`, давность `.meta`, действия `.act`.
 *
 * Отличие от списка клиентов ровно одно и по смыслу раздела: у обращения нет
 * ни бюджета, ни района, ни назначенного агента, поэтому описание собирается из
 * номера карточки, источника и срока в работе.
 */
function InquiryRow({ client: c }: { client: Client }) {
  // Следующий шаг — то же поле и то же правило «просрочено красным»,
  // что в основном списке клиентов (pages/Clients.tsx).
  const step = c.nextStep;
  const stepOverdue = !!step?.nextActionDate && new Date(step.nextActionDate).getTime() < Date.now();
  const daysInWork = Math.max(0, Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 86400000));
  const statusDot = CLIENT_STATUS_CHIP_DOT[c.status];

  const descParts = [
    formatClientCode(c.shortId, c.kind),
    CLIENT_SOURCE_LABELS[c.source] ?? c.source,
    // Номер показываем, только когда он не маска: маску набирать нечем.
    c.phone && !c.phone.includes("•") ? c.phone : null,
    `в работе ${daysInWork} дн.`,
  ].filter(Boolean);

  return (
    <div className="row">
      <span className="av">
        <ClientAvatar fullName={c.fullName} avatarUrl={c.avatarUrl} size={36} />
      </span>

      <div className="t">
        <b>
          <Link className="lk" to={`/clients/${c.shortId}`} title={formatClientCode(c.shortId, c.kind)}>
            {c.displayName ?? c.fullName}
          </Link>
        </b>
        <span>{descParts.join(", ")}</span>
      </div>

      {showsInactiveLabel(c) && (
        <span className="chip mute">
          <InactiveLevelDot client={c} />
          Неактивный
        </span>
      )}
      <ReturnedBadge returnedAt={c.returnedAt} />
      {c.aiScore != null && <span className="chip mute">Скор {c.aiScore}%</span>}
      <span className={`chip ${CLIENT_STATUS_CHIP[c.status]}`}>
        {statusDot !== undefined && <span className={`dot ${statusDot}`} />}
        {CLIENT_STATUS_LABELS[c.status]}
      </span>

      {step?.nextActionDate && (
        <span className={`step${stepOverdue ? " crit" : ""}`}>
          <CalendarClock className="i" />
          {step.nextAction?.trim() || "Следующий шаг"}, {relativeTime(step.nextActionDate)}
        </span>
      )}
      <span className="meta">{relativeTime(c.lastContactAt)}</span>

      {/* Подписи «Открыть» в строке нет: карточку открывает вся строка
          (договор §3, растянутая ссылка в theme-2026-proto.css). Осталась
          только круглая кнопка звонка — ровно как в макете. */}
      <div className="act">
        <CallClientButton
          clientId={c.id}
          phone={c.phone}
          variant="icon"
          title="Позвонить через CRM"
          className="call"
        />
      </div>
    </div>
  );
}
