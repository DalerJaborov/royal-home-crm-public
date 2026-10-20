import { useState } from "react";
import { Link } from "react-router-dom";
import { Clapperboard, Clock, Film, ImageIcon } from "lucide-react";
import { useAuthStore } from "../store/auth";
import { useEditorQueue } from "../hooks/useMarketing";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";
import { Pagination } from "./Pagination";
import type { MarketingQueueRow } from "../hooks/useMarketing";
import { StatusBadge } from "./StatusBadge";
import { StatTile } from "./ui/StatTile";
import { DismissibleHint } from "./ui/DismissibleHint";
import { pluralizeRu, todayLabel } from "../lib/format";
import { dushanbeTime } from "../lib/date";

/**
 * Главная монтажёра. Разметка перенесена дословно из прототипа темы
 * «Royal Home 2026» (`docs/pult/theme-2026/screens/home-editor.html`):
 * `.scr` → `.pg-h` → `.sec-t` + `.tiles` (4 плитки) → `.card.tight` с `.sec-h`
 * и списками `.list`/`.row`.
 *
 * ГЛАВНАЯ САМА И ЕСТЬ ОЧЕРЕДЬ: работа монтажёра целиком описывается состоянием
 * объектов, и список, который всегда свеж, честнее ленты сообщений.
 * «На монтаже» — то, что делать сейчас, просроченные подняты наверх (просрочку
 * считает сервер, api/lib/propertyPipeline.ts). «Скоро на монтаж» — этап
 * «Ожидает видео»: объекты придут следующими.
 *
 * Данные и права не менялись: тот же `useEditorQueue`.
 */
export function EditorDashboard() {
  const agent = useAuthStore((s) => s.agent);
  // Два списка — две независимые страницы (02.10.2026): раньше сервер отдавал
  // по 50 строк без продолжения, а числа над списком были настоящими — 51-й
  // объект на монтаже было не увидеть вовсе. Теперь «Показать ещё» под каждым.
  const [editingPage, setEditingPage] = useState(1);
  const [upcomingPage, setUpcomingPage] = useState(1);
  const { data, isLoading, error } = useEditorQueue(true, { editingPage, upcomingPage });
  const head = useEditorQueue(editingPage > 1 || upcomingPage > 1, { editingPage: 1, upcomingPage: 1 });
  const editingRows = useAccumulatedPages(data?.inEditing, editingPage, "editing", head.data?.inEditing);
  const upcomingRows = useAccumulatedPages(data?.upcoming, upcomingPage, "upcoming", head.data?.upcoming);
  // Пока догружается следующая страница, data на мгновение пуст — числа и
  // плитки берём с первой страницы, чтобы они не мигали нулями.
  const shown = data ?? head.data;
  const firstName = agent?.fullName?.split(" ")[0] ?? "";
  const [openedAt] = useState(() => new Date());
  const listLoading = isLoading && editingRows.length === 0 && upcomingRows.length === 0;

  // Просроченные — наверх: очередь монтажа читают сверху вниз, и объект,
  // переваливший срок, не должен оказаться на десятой строке только потому, что
  // вошёл в этап позже. Внутри групп порядок сервера (дольше всех ждущий первым).
  // Сортировка — по уже показанным строкам: просроченный с непрочитанной
  // страницы поднимется наверх, когда страница догрузится.
  const inEditing = [...editingRows].sort(
    (a, b) => Number(b.pipeline.overdue) - Number(a.pipeline.overdue)
  );

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Монтаж</h1>
            <p className="sub">
              {agent?.fullName ?? ""}, монтажёр. {todayLabel()}.{" "}
              {shown
                ? shown.counts.inEditing === 0
                  ? "Объектов на монтаже нет, очередь пуста."
                  : `У вас ${shown.counts.inEditing} ${pluralizeRu(shown.counts.inEditing, ["объект", "объекта", "объектов"])}${shown.counts.overdue > 0 ? `, ${shown.counts.overdue} просрочено` : ""}.`
                : "Загрузка очереди…"}
            </p>
          </div>
        </div>
        {/* Блок помощника по макету tpl-home-editor: что делаю, «Сначала это»,
            самый горящий объект и доклад одной фразой. Только из очереди. */}
        <section className="card aib" aria-labelledby="aib-hi">
          <div className="aib-now">
            <i aria-hidden="true" />
            <span className="tx">слежу за очередью монтажа, проверено {dushanbeTime(openedAt)}</span>
          </div>
          <div className="aib-hd">
            <h2 className="aib-hi" id="aib-hi">
              Салом{firstName ? `, ${firstName}` : ""}. Сначала это:
            </h2>
          </div>
          <div className="aib-fire">
            <div className="aib-fh">
              <h3>Горит сейчас</h3>
              <span className="note">просроченные сверху</span>
            </div>
            {listLoading ? (
              <div className="state">
                <span className="sk w40" /> Загружаем очередь монтажа
              </div>
            ) : inEditing[0] ? (
              <div className="list">
                <QueueRow row={inEditing[0]} />
              </div>
            ) : (
              <p className="quiet">
                <span className="dot ok" />
                <span className="txt">Горящего нет: на монтаже пусто. Новые объекты встанут сюда сами.</span>
              </p>
            )}
          </div>
          {shown && (
            <p className="aib-rep">
              На монтаже{" "}
              <Link className="lk" to="/properties?status=EDITING">
                {shown.counts.inEditing} {pluralizeRu(shown.counts.inEditing, ["объект", "объекта", "объектов"])}
              </Link>
              {shown.counts.overdue > 0 ? (
                <>
                  , из них <b>{shown.counts.overdue} просрочено</b>
                </>
              ) : (
                ", просроченных нет"
              )}
              . Скоро придут ещё {shown.counts.upcoming}: агенты ещё снимают видео.
            </p>
          )}
        </section>
        {error && (
          <div className="card tight">
            <div className="state err">
              <span className="dot crit" />
              {error instanceof Error ? error.message : "Не удалось загрузить очередь монтажа"}
            </div>
          </div>
        )}

        <div className="card tight">
          <DismissibleHint id="editor-dashboard-intro">
            Это ваша очередь. Объект попадает в «На монтаже» сам, как только маркетинг одобрил фото и видео, и уходит
            отсюда, когда вы вставите в карточку ссылку на опубликованный обзор в Instagram. «Скоро на монтаж» это
            объекты, для которых агент ещё снимает видео: работой они станут через день-два. Сроки этапов и просрочка
            берутся из Настроек CRM.
          </DismissibleHint>
        </div>

        <div className="sec-t">Показатели</div>
        <div className="tiles">
          <StatTile
            icon={Clapperboard}
            label="На монтаже сейчас"
            value={shown?.counts.inEditing ?? 0}
            line="ваша очередь"
            to="/properties?status=EDITING"
            title="Объекты на монтаже"
          />
          <StatTile
            icon={Clock}
            label="Из них просрочено"
            value={shown?.counts.overdue ?? 0}
            line="срок этапа вышел"
            critical={(shown?.counts.overdue ?? 0) > 0}
            to="/properties?status=EDITING&overdue=1"
            title="Просроченные объекты на монтаже"
          />
          <StatTile
            icon={Film}
            label="Скоро придёт"
            value={shown?.counts.upcoming ?? 0}
            line="агент ещё снимает видео"
            to="/properties?status=AWAITING_VIDEO"
            title="Объекты на этапе «Ожидает видео»"
          />
        </div>

        <div className="card tight">
          <div className="sec-h">
            <h2>На монтаже</h2>
            <span className="note">{shown?.counts.inEditing ?? 0}, просроченные сверху</span>
            <Link to="/properties?status=EDITING" className="lnk">
              Все объекты
            </Link>
          </div>
          {/* Пока грузим или упали — не утверждаем «работы нет»: пустой список при
              отказе сервера прочитался бы как разрешение уйти домой. */}
          {listLoading ? (
            <div className="state">
              <span className="sk w40" /> Загружаем очередь монтажа
            </div>
          ) : error ? (
            <div className="state err">
              <span className="dot crit" /> Очередь недоступна, обновите страницу
            </div>
          ) : inEditing.length === 0 ? (
            <p className="quiet">
              <span className="dot ok" />
              <span className="txt">Ничего не ждёт монтажа.</span>
            </p>
          ) : (
            <>
              <div className="list">
                {inEditing.map((row) => (
                  <QueueRow key={row.id} row={row} />
                ))}
              </div>
              {shown && (
                <Pagination
                  variant="loadMore"
                  page={editingPage}
                  pageSize={shown.pageSize}
                  total={shown.counts.inEditing}
                  onPageChange={setEditingPage}
                />
              )}
            </>
          )}
        </div>

        <div className="card tight">
          <div className="sec-h">
            <h2>Скоро на монтаж</h2>
            <span className="note">{shown?.counts.upcoming ?? 0} ждут видео</span>
          </div>
          {listLoading ? (
            <div className="state">
              <span className="sk w40" /> Загружаем список
            </div>
          ) : error ? (
            <div className="state err">
              <span className="dot crit" /> Список недоступен
            </div>
          ) : upcomingRows.length === 0 ? (
            <p className="quiet">
              <span className="dot ok" />
              <span className="txt">Пока ничего не снимают.</span>
            </p>
          ) : (
            <>
              <div className="list">
                {upcomingRows.map((row) => (
                  <Link key={row.id} to={`/properties/${row.shortId}`} className="row wrapt">
                    <span className={row.pipeline.overdue ? "dot crit" : "dot ok"} aria-hidden="true" />
                    <div className="t">
                      <b>{row.title}</b>
                      <span>
                        {row.pipeline.overdue ? "видео просрочено у агента" : `снимают ${row.pipeline.daysInStage} дн`}
                        {row.responsibleAgent ? `, ${row.responsibleAgent.fullName}` : ""}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
              {shown && (
                <Pagination
                  variant="loadMore"
                  page={upcomingPage}
                  pageSize={shown.pageSize}
                  total={shown.counts.upcoming}
                  onPageChange={setUpcomingPage}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Строка очереди. Ссылка на карточку объекта целиком — на телефоне попасть в
 * маленький заголовок сложнее, чем в строку.
 */
function QueueRow({ row }: { row: MarketingQueueRow }) {
  return (
    <Link to={`/properties/${row.shortId}`} className="row wrapt" aria-label={`Открыть объект: ${row.title}`}>
      <span className={row.pipeline.overdue ? "dot crit" : "dot"} aria-hidden="true" />
      <div className="t">
        <b>{row.title}</b>
        <span>
          {row.photoCount} {pluralizeRu(row.photoCount, ["фото", "фото", "фото"])}
          {row.responsibleAgent ? `, агент ${row.responsibleAgent.fullName}` : ""}
          {row.instagramUrl ? ", ссылка на Reels есть" : ""}
          {row.reviewRejectionReason ? `. Возвращали: ${row.reviewRejectionReason}` : ""}
        </span>
      </div>
      <span className="meta">
        <ImageIcon className="i" strokeWidth={1.5} aria-hidden="true" />
      </span>
      <StatusBadge status={row.status} stage={row.pipeline} />
    </Link>
  );
}
