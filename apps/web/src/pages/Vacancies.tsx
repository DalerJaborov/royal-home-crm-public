import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useCan } from "../lib/permissions";
import {
  useVacancies,
  type JobApplication,
  type VacancyBucket,
  type VacancyPriorityFilter,
  type VacancyStage,
} from "../hooks/useVacancies";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useCounters, useMarkSectionSeen } from "../hooks/useCounters";
import { useUiPrefs } from "../store/uiPrefs";
import { VacancyRow } from "../components/VacancyRow";
import { VacancyStageActions } from "../components/VacancyStageActions";
import { useOversightSummary } from "../hooks/useOversight";
import {
  VACANCY_BUCKET_HINT,
  VACANCY_BUCKET_LABEL,
  VACANCY_BUCKET_ORDER,
  VACANCY_LIST_MAX,
  VACANCY_LIST_STEP,
  VACANCY_PIPELINE,
  VACANCY_PRIORITY_LABEL,
  VACANCY_STATUS_HINT,
  VACANCY_SEARCH_MAX,
  VACANCY_STATUS_LABEL,
  vacancyEmptyReason,
  vacancyInterviewLabel,
  vacancyShownNote,
  vacancyTodayInterviews,
  vacanciesLoadErrorText,
} from "../lib/vacanciesView";
import { TeamTabs } from "../components/SectionTabs";
import { RecruitmentPositions } from "../components/RecruitmentPositions";

/**
 * «Вакансии»: кандидаты, которых бот собрал в переписке (решение владельца
 * 16.08.2026: раздел для руководителя и администратора).
 *
 * ОБЛИК: дословный перенос утверждённого прототипа темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/vacancies.html). Порядок блоков и подписи из
 * прототипа: шапка `.pg-h`, тихая подсказка `.quiet`, плитки корзин отбора
 * `.stg` в `.hscroll`, строка `.filters` с поиском и сегментом опыта, внутри
 * корзины «Подходят» — ещё одна `.stg` со стадиями воронки, карточка
 * «Сегодня» со строкой `.solve`, дальше секции по стадиям (или один плоский
 * список в «Дособрать»/«Не подходят»), где каждая анкета — строка
 * `.list`/`.row` с действиями в `.act`.
 *
 * ДВЕ КОРЗИНЫ ПОВЕРХ ОДНОЙ ВОРОНКИ (25.09.2026, разбор жалобы «мне приходят и
 * 23-летние, и те, кто работает; в зелёных электрики; всего этого нет на
 * экране»). Раньше `eligible: null` (бот ещё не всё спросил) читался как
 * «прошёл отбор» — 133 анкеты из 177 молча лежали вперемешку с шестью
 * настоящими совпадениями. Корзина (`bucket`) — решение автоматического
 * отбора: fit/incomplete/rejected; стадия (`status`, VACANCY_PIPELINE) —
 * отдельное измерение, где кандидат в процессе найма, и показывается только
 * внутри «Подходят», потому что только там идёт работа с человеком.
 *
 * Анкета копится по ходу разговора, поэтому пустые поля это «кандидат ещё не
 * ответил», а не ошибка; в раскрытой анкете они так и подписаны.
 *
 * Экран один на обе ширины: разметка прототипа сама перестраивается
 * медиазапросом `.rh2 .row` (max-width:820px), второй копии карточек нет.
 * Словари подписей и тонов — в lib/vacanciesView.ts.
 */
/** Стадии, которые прототип показывает отдельными секциями внутри «Подходят». */
const SECTION_ORDER: VacancyStage[] = [...VACANCY_PIPELINE, "REJECTED"];

export function Vacancies() {
  const [view, setView] = useState<"applications" | "positions">("applications");
  // Открытие раздела гасит красный счётчик в сайдбаре (у текущего агента).
  useMarkSectionSeen("vacancies");
  const can = useCan();
  const canView = can("vacancies.view");
  // Вкладки раздела «Команда» (перенос меню 15.09.2026) — тот же набор и та же
  // логика подписи, что в pages/Team.tsx / lib/navigation.ts.
  const { data: sectionCounters } = useCounters();
  const { data: oversightSummary } = useOversightSummary(can("dashboard.analytics"));
  // Корзина отбора (25.09.2026) — по умолчанию «Подходят», её и звонят первой.
  const [bucket, setBucket] = useState<VacancyBucket>("fit");
  // Стадия воронки значима только внутри «Подходят» — там идёт работа с
  // человеком; в двух других корзинах фильтра по стадии нет.
  const [filter, setFilter] = useState<VacancyStage | undefined>(undefined);
  const [priority, setPriority] = useState<VacancyPriorityFilter | undefined>(undefined);
  const [search, setSearch] = useState("");
  const hintDismissed = useUiPrefs((s) => s.dismissedHints.includes(HINT_ID));
  const dismissHint = useUiPrefs((s) => s.dismissHint);
  // Запрос уходит не на каждую букву: поиск идёт по базе, и набор «Зарина»
  // означал бы шесть выборок подряд.
  const q = useDebouncedValue(search.trim(), 300);
  // Сколько анкет загружено. Новый фильтр — снова первая порция: «Показать
  // ещё» относится к тому списку, на который смотрели (02.10.2026). Сброс —
  // по ключу фильтра прямо при отрисовке, без лишнего прохода эффекта.
  const filterKey = `${bucket}|${filter ?? ""}|${priority ?? ""}|${q}`;
  const [paging, setPaging] = useState({ key: filterKey, limit: VACANCY_LIST_STEP });
  const limit = paging.key === filterKey ? paging.limit : VACANCY_LIST_STEP;
  const { data, isLoading, isError, error, refetch, isFetching } = useVacancies(canView, {
    bucket,
    status: bucket === "fit" ? filter : undefined,
    priority,
    q,
    limit,
  });

  const items = useMemo(() => data?.items ?? [], [data]);

  // «Сегодня»: все собеседования дня — сервер присылает их отдельно, не из
  // загруженной страницы (иначе старый кандидат с собеседованием сегодня
  // пропадал из блока, 02.10.2026).
  const todayInterviews = useMemo(() => vacancyTodayInterviews(data), [data]);
  const shownNote = vacancyShownNote(items.length, data?.total, limit);

  const grouped = useMemo(() => {
    const map = new Map<JobApplication["status"], JobApplication[]>();
    for (const item of items) {
      const list = map.get(item.status);
      if (list) list.push(item);
      else map.set(item.status, [item]);
    }
    return map;
  }, [items]);

  // Прямая ссылка у того, кому раздел закрыт: честное объяснение вместо 403 по
  // кругу (тот же приём, что в «Ключах»).
  if (!canView) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Вакансии</h1>
              <p className="sub">Кандидатов разбирает руководство: раздел вам закрыт.</p>
            </div>
          </div>

          <TeamTabs />
        </div>
      </div>
    );
  }

  const noPhoneCount = data?.noPhoneCount ?? 0;
  const counts = data?.counts;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const priorityCounts = data?.priorityCounts;
  const bucketCounts = data?.bucketCounts;
  const collecting = data?.collecting ?? true;
  const empty = vacancyEmptyReason({
    bucket,
    status: bucket === "fit" ? filter : undefined,
    collecting,
    bucketCounts,
    noPhoneCount,
    // Сервер при заданной корзине сам кладёт анкеты без номера в «Дособрать»
    // (routes/vacancies.ts, FIT/INCOMPLETE) — прятать здесь больше нечего.
    includeNoPhone: true,
  });
  const sections = filter ? [filter] : SECTION_ORDER;

  if (view === "positions") return <div className="rh2 screens"><div className="scr">
    <div className="pg-h"><h1>Вакансии</h1></div><TeamTabs />
    <nav aria-label="Раздел вакансий" className="flex flex-wrap gap-2 my-4">
      <button type="button" className="pill ghost" onClick={() => setView("applications")}>Анкеты кандидатов</button>
      <button type="button" className="pill" aria-current="page">Открытые позиции</button>
    </nav><RecruitmentPositions />
  </div></div>;

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Вакансии</h1>
            <p className="sub">
              Анкеты кандидатов, которые бот собрал в переписке. Сверху те, кто вероятнее подходит. Нажмите
              строку, чтобы увидеть поля, файлы и переписку.
            </p>
          </div>
        </div>

        <TeamTabs />
        <nav aria-label="Раздел вакансий" className="flex flex-wrap gap-2 my-4">
          <button type="button" className="pill" aria-current="page">Анкеты кандидатов</button>
          <button type="button" className="pill ghost" onClick={() => setView("positions")}>Открытые позиции</button>
        </nav>

        {/* Без опыта продаж это не отказ (владелец 31.08.2026): напоминание перед
            списком, чтобы категория RED не читалась как «не подходит». Закрывается
            навсегда, вернётся только сменой id. */}
        {!hintDismissed && (
          <div className="card tight">
            <div className="quiet">
              <span className="dot" />
              <span className="txt">
                Кандидаты без опыта продаж тоже подходят: есть обучение риелторов с нуля. Такие анкеты помечены
                «Без опыта, обучим», это не отказ.
              </span>
              <button className="lnk" type="button" onClick={() => dismissHint(HINT_ID)}>
                Понятно
              </button>
            </div>
          </div>
        )}

        {/* Корзина отбора: три крупные плитки, «Подходят» выбрана по умолчанию
            (25.09.2026). Цифра сверху, подпись снизу — тот же приём, что был у
            стадий, теперь на уровень выше. */}
        <div className="hscroll">
          <div className="stg" role="tablist" aria-label="Корзина отбора">
            {VACANCY_BUCKET_ORDER.map((b) => (
              <button
                key={b}
                type="button"
                role="tab"
                aria-selected={bucket === b}
                onClick={() => {
                  setBucket(b);
                  setFilter(undefined);
                }}
              >
                <b>{bucketCounts?.[b] ?? 0}</b>
                <span title={VACANCY_BUCKET_HINT[b]}>{VACANCY_BUCKET_LABEL[b]}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Стадии воронки — только внутри «Подходят»: только там идёт работа
            с человеком, в «Дособрать»/«Не подходят» решает не стадия, а
            корзина. */}
        {bucket === "fit" && (
          <div className="hscroll">
            <div className="stg" role="tablist" aria-label="Стадия кандидата">
              <button type="button" role="tab" aria-selected={filter === undefined} onClick={() => setFilter(undefined)}>
                <b>{total}</b>
                <span>Все</span>
              </button>
              {SECTION_ORDER.map((s) => (
                <button key={s} type="button" role="tab" aria-selected={filter === s} onClick={() => setFilter(s)}>
                  <b>{counts?.[s] ?? 0}</b>
                  <span>{VACANCY_STATUS_LABEL[s]}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="filters">
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            <span className="vh">Поиск по анкетам</span>
            <input
              className="inp"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              // Сервер принимает поиск не длиннее 80 знаков, а длиннее весь
              // список превращался в ошибку (02.10.2026).
              maxLength={VACANCY_SEARCH_MAX}
              placeholder="Имя, телефон, город, опыт"
              aria-label="Поиск по анкетам"
            />
          </label>
          <div className="hscroll">
            <div className="seg" role="tablist" aria-label="Опыт">
              <button type="button" role="tab" aria-selected={!priority} onClick={() => setPriority(undefined)}>
                Любой опыт
              </button>
              <button type="button" role="tab" aria-selected={priority === "GREEN"} onClick={() => setPriority("GREEN")}>
                {VACANCY_PRIORITY_LABEL.GREEN} <span className="n">{priorityCounts?.GREEN ?? 0}</span>
              </button>
              <button type="button" role="tab" aria-selected={priority === "YELLOW"} onClick={() => setPriority("YELLOW")}>
                {VACANCY_PRIORITY_LABEL.YELLOW} <span className="n">{priorityCounts?.YELLOW ?? 0}</span>
              </button>
              <button type="button" role="tab" aria-selected={priority === "RED"} onClick={() => setPriority("RED")}>
                {VACANCY_PRIORITY_LABEL.RED} <span className="n">{priorityCounts?.RED ?? 0}</span>
              </button>
              {/* «Не выяснен» — только в «Дособрать»: в двух других корзинах бот
                  уже определился с отбором, светофор там либо про цвет, либо
                  анкета ещё копится в этой самой корзине. */}
              {bucket === "incomplete" && (
                <button type="button" role="tab" aria-selected={priority === "NONE"} onClick={() => setPriority("NONE")}>
                  Не выяснен <span className="n">{priorityCounts?.NONE ?? 0}</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Ближайшее собеседование: единственная чёрная кнопка экрана. */}
        {todayInterviews.length > 0 && (
          <div className="card tight">
            <div className="sec-h">
              <h2>Сегодня</h2>
              <span className="note">
                {todayInterviews.length}{" "}
                {todayInterviews.length === 1 ? "собеседование" : todayInterviews.length < 5 ? "собеседования" : "собеседований"}
              </span>
            </div>
            {todayInterviews.map((i) => (
              <TodayInterviewLine key={i.id} item={i} />
            ))}
          </div>
        )}

        {isLoading ? (
          <div className="card tight">
            <div className="state">
              <span className="sk av" />
              <span className="sk w28" />
              <span className="sk w22" /> Загружаем анкеты
            </div>
          </div>
        ) : isError ? (
          /* Отказ читался как «анкет нет»: те же слова, что у честной пустоты
             (найдено аудитом 22.08.2026). Человек решал, что кандидатов
             действительно не было, а не что список не загрузился. */
          <div className="card tight">
            <div className="state err">
              <span className="dot crit" /> {vacanciesLoadErrorText(error)} Это не значит, что кандидатов нет.{" "}
              <button
                className="lk"
                type="button"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={() => refetch()}
              >
                Повторить
              </button>
            </div>
          </div>
        ) : items.length === 0 ? (
          /* Пустота обязана называть свою причину: выключенный сбор и «всех
             отсеяли» выглядели как «никто не писал» (разбор 03.09.2026). */
          <div className="card tight">
            <div className="empty">
              <span className="ic">
                <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7h16v13H4z" />
                  <path d="M9 7V5a3 3 0 0 1 6 0v2" />
                </svg>
              </span>
              <p>
                <b>{empty.title}</b>
              </p>
              <p className="sub">{empty.hint}</p>
              <span className="wrap">
                {empty.settingsLink && (
                  <Link className="pill ghost" to="/settings?tab=bot">
                    Открыть настройки бота
                  </Link>
                )}
              </span>
            </div>
          </div>
        ) : bucket !== "fit" ? (
          /* «Дособрать»/«Не подходят»: плоский список, без секций по стадии —
             там не воронка найма, а очередь до/после автоматического отбора. */
          <div className="sec">
            <div className="sec-h">
              <h2 title={VACANCY_BUCKET_HINT[bucket]}>{VACANCY_BUCKET_LABEL[bucket]}</h2>
              <span className="note">
                {items.length} {items.length === 1 ? "анкета" : items.length < 5 ? "анкеты" : "анкет"}
              </span>
            </div>
            <div className="card tight">
              <div className="list">
                {items.map((item, i) => (
                  <VacancyRow key={item.id} item={item} tone={i} bucket={bucket} />
                ))}
              </div>
            </div>
          </div>
        ) : (
          sections.map((s) => {
            const rows = grouped.get(s) ?? [];
            if (rows.length === 0) return null;
            return (
              <div className="sec" key={s}>
                <div className="sec-h">
                  <h2>{VACANCY_STATUS_LABEL[s]}</h2>
                  <span className="note">
                    {rows.length} {rows.length === 1 ? "анкета" : rows.length < 5 ? "анкеты" : "анкет"}
                  </span>
                </div>
                <div className="card tight">
                  <div className="list">
                    {rows.map((item, i) => (
                      <VacancyRow key={item.id} item={item} tone={i} bucket={bucket} />
                    ))}
                  </div>
                  <p className="state">{VACANCY_STATUS_HINT[s]}</p>
                </div>
              </div>
            );
          })
        )}

        {/* Список приходит порцией, а плитки считают всё: без этой строки
            кандидаты за пределами порции пропадали молча (02.10.2026). */}
        {!isLoading && !isError && shownNote && (
          <div className="card tight">
            <div className="quiet">
              <span className="dot" />
              <span className="txt">{shownNote.text}</span>
              {shownNote.canLoadMore && (
                <button
                  className="lnk"
                  type="button"
                  disabled={isFetching}
                  onClick={() =>
                    setPaging({ key: filterKey, limit: Math.min(limit + VACANCY_LIST_STEP, VACANCY_LIST_MAX) })
                  }
                >
                  {isFetching ? "Загружаем…" : "Показать ещё"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Строка карточки «Сегодня». Отдельный компонент ради своей полосы для формы
 * (02.10.2026): «Перенести» открывало дату прямо в узкой колонке `.acts`, и
 * поле с кнопками сжималось в щель. Хост стоит ВНУТРИ `.solve` с
 * display:contents — пустой не занимает места и не ломает черту между
 * строками, а открытая форма встаёт своей строкой под именем и кнопками
 * (`.solve` переносит элементы, см. place() в VacancyStageActions).
 */
function TodayInterviewLine({ item }: { item: JobApplication }) {
  const [formHost, setFormHost] = useState<HTMLDivElement | null>(null);
  return (
    <div className="solve">
      <span className="t">
        <b>{item.name ?? item.contactName ?? "Кандидат без имени"}</b>
        {item.age !== null ? `, ${item.age}` : ""}. Собеседование{" "}
        {item.interviewAt ? vacancyInterviewLabel(item.interviewAt) : ""}
        {item.experience ? `. ${item.experience}` : ""}
      </span>
      <span className="acts">
        <VacancyStageActions item={item} compact formHost={formHost} />
      </span>
      <div ref={setFormHost} style={{ display: "contents" }} />
    </div>
  );
}

/** id подсказки не меняется вместе с текстом: иначе закрывшие увидят её снова. */
const HINT_ID = "vacancies-no-experience-31-08-2026";
