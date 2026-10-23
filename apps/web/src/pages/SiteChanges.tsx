import { useState } from "react";
import { Pagination } from "../components/Pagination";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";
import { Link } from "react-router-dom";
import { CheckCircle2, ExternalLink, Plus, Trash2 } from "lucide-react";
import { useCan } from "../lib/permissions";
import {
  useResolveAllSiteNotifications,
  useResolveSiteNotification,
  useSiteNotifications,
  SITE_NOTIFICATIONS_PAGE_SIZE,
} from "../hooks/useSiteNotifications";
import { relativeTime } from "../lib/format";
import { ObjectsTabs } from "../components/SectionTabs";
import { ConfirmDialog } from "../components/ConfirmDialog";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Столько изменений разбирает одно нажатие «Разобрать все» — тот же потолок стоит
 *  на сервере (routes/siteNotifications.ts). Держим числа рядом осознанно: разъедутся
 *  — интерфейс снова начнёт обещать больше, чем делает. */
const RESOLVE_ALL_LIMIT = 500;

/** Подписи для ключей `changes` — сайт присылает их как есть, по-английски или
 *  техническим именем поля; неизвестный ключ печатается как пришёл, без
 *  выдумки. */
const CHANGE_LABELS: Record<string, string> = {
  // Сайт считает только в сомони, объект в CRM может быть в долларах — без
  // валюты «85000 стало 850000» читалось как правка в долларах (24.09.2026).
  price: "Цена на сайте, сомони",
  address: "Адрес",
  description: "Описание",
  area: "Площадь",
  areaSqm: "Площадь",
  district: "Район",
  rooms: "Комнат",
  editedBy: "Кто",
  status: "Статус",
};

/** «Было X, стало Y» — если сайт прислал пару значений; иначе печатаем как есть. */
function formatChangeValue(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    const from = rec.from ?? rec.old ?? rec.before;
    const to = rec.to ?? rec.new ?? rec.after;
    if (from !== undefined && to !== undefined) return `${String(from)} стало ${String(to)}`;
  }
  return String(v);
}

/**
 * «Изменения на сайте» — тема «Royal Home 2026», эталон
 * `screens/site-changes.html`: обёртка `.rh2 > .scr`, шапка `.pg-h` с кнопкой
 * «Обновить», предупреждение о просроченных — тихой строкой `.quiet.warn`,
 * список — `.prow.row.wrapt` со значком `.ph`, разбором правок `.diff`,
 * временем `.meta.only-wide` и парой решений `.pill`/`.lnk` в `.act`.
 *
 * Отмены решения на 10 секунд, нарисованной в эталоне, здесь нет: решение
 * уходит на сервер сразу, и заводить отложенную отправку значило бы менять
 * поведение, а не облик.
 */
export function SiteChanges() {
  const can = useCan();
  const canView = can("siteChanges.view");
  const canResolve = can("siteChanges.resolve");
  // Без enabled запрос уходил до проверки права и отвечал 403 каждые 25 секунд.
  /**
   * «ПОКАЗАТЬ ЕЩЁ» (02.10.2026): список кончался на двухстах самых свежих, и
   * старые изменения было не увидеть ничем. Теперь страницы копятся лентой.
   * Решённые строки прячем сразу по id: страница, где строка лежала, после
   * решения может не перечитаться (подписаны только текущая и первая).
   */
  const [page, setPage] = useState(1);
  // «Разобрать все» перекраивает весь список — лента начинается заново.
  const [generation, setGeneration] = useState(0);
  const { data: response, isLoading, isFetching, isError, error, refetch } = useSiteNotifications({ enabled: canView, page });
  // Свежая первая страница, пока пролистано дальше неё (аудит №38, useAccumulatedPages).
  const { data: headPage } = useSiteNotifications({ enabled: canView && page > 1, page: 1 });
  const accumulated = useAccumulatedPages(response?.items, page, generation, headPage?.items);
  const [resolvedIds, setResolvedIds] = useState<ReadonlySet<string>>(() => new Set());
  const data = response || accumulated.length > 0 ? accumulated.filter((n) => !resolvedIds.has(n.id)) : undefined;
  const resolveOne = useResolveSiteNotification();
  const resolve = {
    isPending: resolveOne.isPending,
    mutate: (vars: { id: string; resolution: "ACCEPTED" | "REJECTED" }) =>
      resolveOne.mutate(vars, { onSuccess: () => setResolvedIds((prev) => new Set(prev).add(vars.id)) }),
  };
  const resolveAll = useResolveAllSiteNotifications();
  const [confirmingResolveAll, setConfirmingResolveAll] = useState(false);
  // Сколько изменений висит дольше суток — покупатель всё это время не видит
  // новый объект. Считается из тех же данных, что уже пришли списком, ничего не
  // выдумываем: реальный createdAt каждого уведомления.
  const staleCount = data?.filter((n) => Date.now() - new Date(n.createdAt).getTime() > DAY_MS).length ?? 0;
  // Вкладки раздела «Объекты» (перенос меню 15.09.2026) — тот же набор, что в
  // pages/Properties.tsx / pages/PropertiesMap.tsx / lib/navigation.ts.

  if (!canView) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Изменения на сайте</h1>
            </div>
          </div>
          <ObjectsTabs />
          <div className="card tight">
            <div className="empty">
              <p>Раздел доступен только директору и администратору.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Изменения на сайте</h1>
            <p className="sub">
              Новые объекты с royalhome.tj ждут здесь и не видны публично, пока вы их не одобрите. Сюда же
              попадают правки и удаления, сделанные прямо в админке сайта.
            </p>
          </div>
          <div className="acts">
            {canResolve && (response?.total ?? 0) > 0 && (
              <button
                className="lnk"
                type="button"
                onClick={() => setConfirmingResolveAll(true)}
                disabled={resolveAll.isPending}
              >
                {resolveAll.isPending ? "Разбираем…" : "Разобрать все"}
              </button>
            )}
            <button className="pill ghost" type="button" onClick={() => refetch()}>
              Обновить
            </button>
          </div>
        </div>

        {confirmingResolveAll && (
          <ConfirmDialog
            title="Разобрать все изменения с сайта?"
            description={
              (response?.total ?? 0) > RESOLVE_ALL_LIMIT
                ? // Разбираем порциями (предел выборки на сервере), и сказать «все» здесь
                  // было бы неправдой: человек ушёл бы с экрана уверенным, что очередь пуста.
                  `Будут приняты как есть первые ${RESOLVE_ALL_LIMIT} изменений из ${response?.total ?? 0} — так же, как кнопка «Принять/Одобрить» у каждого по отдельности. Остальные разберутся следующим нажатием. Отменить массово нельзя.`
                : `Все ${response?.total ?? 0} неразобранных изменений будут приняты как есть — так же, как кнопка «Принять/Одобрить» у каждого по отдельности. Отменить массово нельзя.`
            }
            confirmLabel="Разобрать все"
            onConfirm={() => {
              setConfirmingResolveAll(false);
              resolveAll.mutate(undefined, {
                onSuccess: () => {
                  setPage(1);
                  setGeneration((g) => g + 1);
                },
              });
            }}
            onCancel={() => setConfirmingResolveAll(false)}
          />
        )}

        <ObjectsTabs />

        {!isLoading && !isError && staleCount > 0 && (
          <div className="card tight">
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">
                {staleCount === 1 ? "Одно изменение ждёт" : `${staleCount} изменения ждут`} дольше суток. Новый
                объект всё это время скрыт от покупателей.
              </span>
            </div>
          </div>
        )}

        {/* Отказ загрузки раньше рендерил ничего вообще — карточка ниже пуста и
            без единого объяснения, отличить «нет неразобранных изменений»
            (честная пустота) от «список не пришёл» было нечем (найдено
            аудитом 22.08.2026). */}
        {isError && !isLoading && (
          <div className="card tight">
            <div className="quiet crit" role="alert">
              <span className="dot crit" />
              <span className="txt">
                {error instanceof Error ? error.message : "Не удалось загрузить изменения с сайта"}
              </span>
              <button className="lnk" type="button" onClick={() => refetch()}>
                Повторить
              </button>
            </div>
          </div>
        )}

        <section className="card">
          <div className="sec-h stack">
            <h2>Ждут решения</h2>
            {data && data.length > 0 && (
              <span className="note">
                {response?.total ?? data.length} {(response?.total ?? data.length) === 1 ? "изменение" : "изменений"}
              </span>
            )}
          </div>

          {isLoading && !data?.length && (
            <div className="state">
              <span className="sk w40" />
              <span className="sk w22" /> Загружаем изменения
            </div>
          )}

          <div className="list">
            {data?.map((n) => {
              const created = n.action === "CREATED";
              const deleted = n.action === "DELETED";
              const changes = n.changes ? Object.entries(n.changes) : [];
              return (
                <div className="prow row wrapt" key={n.id}>
                  <span className="ph">
                    {deleted ? (
                      <Trash2 className="i" aria-hidden />
                    ) : created ? (
                      <Plus className="i" aria-hidden />
                    ) : (
                      <ExternalLink className="i" aria-hidden />
                    )}
                  </span>
                  <div className="t">
                    <b>
                      <Link className="lk" to={`/properties/${n.property.shortId}`}>
                        {n.property.title}
                      </Link>
                      {created ? ", новый объект с сайта" : deleted ? ", удалён на сайте" : ", изменён на сайте"}
                    </b>
                    {created && (
                      <span>Пока скрыт на сайте. «Одобрить» — опубликует; «Отклонить» — оставит скрытым.</span>
                    )}
                    {changes.length > 0 && (
                      <div className="diff">
                        {changes.map(([k, v]) => (
                          <span key={k}>
                            {CHANGE_LABELS[k] ?? k}: <b>{formatChangeValue(v)}</b>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="meta only-wide">{relativeTime(n.createdAt)}</span>
                  {canResolve && (
                    <div className="act">
                      <button
                        className="pill sm"
                        type="button"
                        onClick={() => resolve.mutate({ id: n.id, resolution: "ACCEPTED" })}
                        disabled={resolve.isPending}
                        title={created ? "Опубликовать объект на сайте" : "Принять правку сайта как есть"}
                      >
                        {created ? "Одобрить" : "Принять"}
                      </button>
                      <button
                        className="lnk"
                        type="button"
                        onClick={() => resolve.mutate({ id: n.id, resolution: "REJECTED" })}
                        disabled={resolve.isPending}
                        title={created ? "Оставить объект скрытым на сайте" : "Откатить: переслать версию CRM на сайт заново"}
                      >
                        {created ? "Отклонить" : "Откатить"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {data && data.length === 0 && !isLoading && !isError && (
            <div className="empty">
              <span className="ic">
                <CheckCircle2 className="i" aria-hidden />
              </span>
              <p>Нет неразобранных изменений с сайта.</p>
              <span className="sub">
                Сайт и CRM сходятся. Как только на royalhome.tj что-то поправят руками, это появится здесь.
              </span>
              <Link className="pill ghost" to="/properties">
                Открыть каталог
              </Link>
            </div>
          )}

          {response && (
            <Pagination
              loading={isFetching}
              variant="loadMore"
              page={page}
              pageSize={SITE_NOTIFICATIONS_PAGE_SIZE}
              total={response.total}
              onPageChange={setPage}
            />
          )}
        </section>
      </div>
    </div>
  );
}
