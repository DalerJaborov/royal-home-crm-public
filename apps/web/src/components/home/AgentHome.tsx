import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Search, Sparkles } from "lucide-react";
import { useAuthStore } from "../../store/auth";
import { useDashboardSummary } from "../../hooks/useDashboard";
import { useClients, useDuplicateReviews, useReactivationOffers } from "../../hooks/useClients";
import { CommandPaletteLazy } from "../CommandPaletteLazy";
import { Button, Card, PageHeader, Rh2Screen, Skeleton, Tile, Tiles } from "../rh2";
import { Rh2ErrorState } from "../rh2/Rh2ErrorState";
import { dushanbeTime } from "../../lib/date";
import { pluralizeRu, todayLabel } from "../../lib/format";
import { buildNoContact, buildPortfolio, buildShowings } from "../../lib/agentDay";
import { buildAgentTodo, type SupervisorAssignedItem } from "../../lib/agentFocus";
import { AgentFocusCard } from "./agent/AgentFocusCard";
import { AgentQueue } from "./agent/AgentQueue";
import { AgentAskSheet, AiButton } from "./agent/AgentAsk";
import "./agent/agentHome.css";

/**
 * ГЛАВНАЯ АГЕНТА: один экран на ПК и телефон (контракт оболочки 06.10.2026,
 * раздел 4, задание E1). Прежние два экрана (этот для ПК и отдельный телефонный
 * из `components/home/mh/`) слиты, второе дерево разметки удалено;
 * жесты, запросы и решения переехали сюда, точки перелома только 820 и 1180.
 *
 * ОТВЕЧАЕТ НА ОДИН ВОПРОС: что сделать прямо сейчас. Сверху «Сначала это»
 * (тёмная карточка, никогда не пустая, а когда делать совсем нечего, одна строка
 * вместо карточки с нулём), под ней очередь с зелёными трубками. На ПК вторая
 * колонка: три плитки дня и «Сегодня». Порядок «что горит» считает
 * `lib/agentFocus.ts`, экран только рисует.
 *
 * ЧТО УБРАНО С ЭКРАНА И КУДА УШЛО (ревью review-pc.md и review-mobile.md):
 *   · четыре плитки Объекты/Звонки/Сделки/Задачи (телефон): это навигация,
 *     она в таббаре и в шторке «Ещё»;
 *   · карточка «0, на сегодня всё сделано», «Между встречами» (клиент встал
 *     строкой в очередь), «Мои клиенты» (дубль раздела «Клиенты»);
 *   · «Деньги / комиссия», «Показатели» и «Вы против себя»: Профиль и Отчёты,
 *     у агента кнопка «Отчёты» вела на «недоступно» и не рисуется;
 *   · абзац-доклад ИИ, «Заметил N», служебные подписи («обновлено», «свайп
 *     строки»): значок ИИ в шапке открывает шторку с тем же вопросом.
 *
 * Данные только те, что сервер уже отдаёт: те же хуки, что у двух прежних
 * экранов. Маска номера и право на CRM-звонок решаются в `CallClientButton`.
 */

const CLIENTS_PAGE = 30;

export function AgentHome() {
  const agent = useAuthStore((s) => s.agent);
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useDashboardSummary();
  // Короткая страница, а не сотня полных карточек ради одной строки: сервер сам
  // сортирует по давности контакта (`contact_asc`), самые остывшие стоят первыми
  // (разбор 19.09.2026: сотня карточек ехала на каждое открытие Главной).
  const { data: clientsPage, isLoading: clientsLoading } = useClients({
    pageSize: CLIENTS_PAGE,
    sort: "contact_asc",
  });
  // Тот же серверный фильтр и ключ кэша, что у IncomingLeadWindow: общий список, не второй.
  const { data: pendingPage, isLoading: pendingLoading } = useClients({ pageSize: 20, pendingAcceptance: true });
  const { data: offers, isLoading: offersLoading } = useReactivationOffers();
  const { data: duplicates, isLoading: duplicatesLoading } = useDuplicateReviews();

  const [askOpen, setAskOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const firstName = agent?.fullName?.split(" ")[0] ?? "";
  const title = `Салом${firstName ? `, ${firstName}` : ""}`;

  const tasks = useMemo(() => data?.tasksToday ?? [], [data]);
  const firstCall = useMemo(() => data?.firstCallDue ?? [], [data]);
  /** Назначил руководитель (23.09.2026): без тех, что уже стоят строкой по сроку первого звонка. */
  const supervisor = useMemo<SupervisorAssignedItem[]>(() => {
    const due = new Set(firstCall.map((c) => c.id));
    return (data?.assignedBySupervisor ?? []).filter((c) => !due.has(c.id));
  }, [data, firstCall]);

  const pending = useMemo(() => pendingPage?.items ?? [], [pendingPage]);
  const pendingTotal = pendingPage?.total ?? pending.length;
  const portfolio = useMemo(() => buildPortfolio(clientsPage?.items ?? [], Date.now()), [clientsPage]);
  const noContact = useMemo(() => buildNoContact(portfolio, Date.now()), [portfolio]);
  const showings = useMemo(() => buildShowings(tasks), [tasks]);

  const todo = useMemo(
    () =>
      buildAgentTodo({
        pending,
        duplicates: duplicates ?? [],
        offers: offers ?? [],
        supervisor,
        firstCall,
        tasks,
        portfolio,
        now: Date.now(),
      }),
    [pending, duplicates, offers, supervisor, firstCall, tasks, portfolio],
  );

  const sub = [
    todayLabel(),
    [
      pendingTotal > 0 && `${pendingTotal} ${pluralizeRu(pendingTotal, ["новый лид", "новых лида", "новых лидов"])}`,
      data && showings.length > 0 && `${showings.length} ${pluralizeRu(showings.length, ["показ", "показа", "показов"])}`,
    ]
      .filter(Boolean)
      .join(", "),
  ]
    .filter(Boolean)
    .join(" · ");

  // Кнопки шапки телефона. Узел стабилен (useMemo): `useShellClaim` пишет его в стор
  // оболочки при каждом изменении, а перерисовок у Главной много.
  const shellActions = useMemo(
    () => [
      <button
        key="search"
        type="button"
        className="sh-btn flex items-center justify-center"
        aria-label="Поиск клиентов, объектов и разделов"
        onClick={() => setSearchOpen(true)}
      >
        <Search className="w-[19px] h-[19px]" strokeWidth={1.8} aria-hidden="true" />
      </button>,
      <AiShellButton key="ai" onOpen={() => setAskOpen(true)} />,
    ],
    [],
  );

  const focusLoading = isLoading || pendingLoading || offersLoading || duplicatesLoading;
  const nextShowing = showings.find((s) => Date.parse(s.nextActionDate!) > Date.now());
  const limit = data?.activeLeadLoad;
  const atLimit = !!limit && limit.limit > 0 && limit.count >= limit.limit;

  return (
    <Rh2Screen title={title} actions={shellActions}>
      <div className="hidden md:block">
        <PageHeader
          title={title}
          sub={sub}
          actions={
            <>
              <AiButton onClick={() => setAskOpen(true)} />
              <Button variant="soft" size="sm" icon={<Plus className="i" aria-hidden="true" />} onClick={() => navigate("/clients?new=1")}>
                Клиент
              </Button>
            </>
          }
        />
      </div>
      <p className="rh-home-sub md:hidden">{sub}</p>

      <div className="rh-home">
        <div className="rh-home-main">
          <div className="rh-home-o1">
            {todo.focus ? (
              <AgentFocusCard todo={todo.focus} />
            ) : focusLoading ? (
              <Card tight aria-label="Сначала это">
                <Skeleton kind="row" />
                <Skeleton kind="line" width="70%" />
              </Card>
            ) : isError ? (
              <Card tight aria-label="Сначала это">
                <Rh2ErrorState
                  message={error instanceof Error ? error.message : "Сводка не загрузилась, проверьте соединение."}
                  onRetry={() => void refetch()}
                />
              </Card>
            ) : (
              <p className="quiet rh-home-calm">
                <span className="dot ok" />
                <span className="txt">
                  Все дела сделаны
                  {nextShowing ? `, следующий показ в ${dushanbeTime(nextShowing.nextActionDate!)}` : ""}
                </span>
              </p>
            )}
          </div>

          {atLimit && limit && (
            <Card tight className="rh-home-o1">
              <p className="quiet warn">
                <span className="dot warn" />
                <span className="txt">
                  Новые лиды не назначаются: у вас {limit.count} из {limit.limit}{" "}
                  {pluralizeRu(limit.count, ["активный лид", "активных лида", "активных лидов"])}, это лимит. Доведите
                  текущих до показа или отказа, и очередь откроется сама.{" "}
                  <Link className="lk" to="/clients">
                    К списку клиентов
                  </Link>
                </span>
              </p>
            </Card>
          )}

          <div className="rh-home-o4">
            <AgentQueue queue={todo.queue} loading={clientsLoading && todo.queue.length === 0} />
          </div>
        </div>

        <div className="rh-home-side">
          <div className="rh-home-o2">
            <Tiles>
              {data ? (
                <>
                  <Tile tone="lime" value={showings.length} label="показов сегодня" href="/calendar" />
                  <Tile tone="aqua" value={data.funnel[0]?.count ?? 0} label="лидов за месяц" href="/clients" />
                  <Tile tone="lav" value={noContact.length} label="ждут звонка" href="/clients" />
                </>
              ) : (
                <>
                  <Skeleton kind="tile" />
                  <Skeleton kind="tile" />
                  <Skeleton kind="tile" />
                </>
              )}
            </Tiles>
          </div>

          <div className="rh-home-o3">
            <Card tight title="Сегодня" aria-label="Сегодня" data-testid="agent-today">
              {!data ? (
                <Skeleton kind="line" width="60%" />
              ) : showings.length === 0 ? (
                <p className="quiet">
                  <span className="dot" />
                  <span className="txt">На сегодня показов нет</span>
                </p>
              ) : (
                <div className="rh-day">
                  {showings.map((s) => (
                    <Link
                      key={s.id}
                      className="ev"
                      to={
                        s.property?.shortId
                          ? `/properties/${s.property.shortId}`
                          : s.client?.shortId
                            ? `/clients/${s.client.shortId}`
                            : "/calendar"
                      }
                    >
                      <time>{dushanbeTime(s.nextActionDate!)}</time>
                      <span>
                        Показ{s.property?.title ? ` · ${s.property.title}` : ""}
                        {s.client?.fullName ? ` · ${s.client.fullName}` : ""}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>

      {askOpen && <AgentAskSheet onClose={() => setAskOpen(false)} />}
      {searchOpen && <CommandPaletteLazy onClose={() => setSearchOpen(false)} />}
    </Rh2Screen>
  );
}

/** Значок ИИ в шапке телефона: круг шапки (`sh-btn`), а не кнопка набора, потому что шапка живёт вне области `.scr`. */
function AiShellButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className="sh-btn flex items-center justify-center"
      aria-label="Спросить помощника (ИИ)"
      onClick={onOpen}
    >
      <Sparkles className="w-[19px] h-[19px]" strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}
