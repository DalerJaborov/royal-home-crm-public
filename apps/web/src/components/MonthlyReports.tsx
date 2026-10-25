import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClientSource, PostShowingCohortView } from "@royal-home/shared";
import { api } from "../lib/api";
import { CLIENT_SOURCE_LABELS } from "../lib/clientFormat";
import { useCan } from "../lib/permissions";
import { Rh2Bars } from "./rh2/Rh2Bars";
import { Rh2Money } from "./rh2/Rh2Money";
import { PostShowingCohort, PostShowingCohortFacts } from "./PostShowingCohort";
import { scrollableRegion } from "../lib/a11y";
import { createReportDraft, reconcileReportDraft, reportDraftConflict } from "../lib/reportDraft";

interface MonthlyMetrics {
  postShowingCohort?: PostShowingCohortView | { version: 2; evaluation: "DATA_UNAVAILABLE" };
  publicInteractionCountersBasis?: "CURRENT_RECORDED_PUBLIC_EVENTS" | "UNAVAILABLE";
  funnel: { key: string; label: string; count: number | null }[];
  /** null — у смотрящего нет права на финансы (аудит 23.09.2026, №44). */
  commission: number | null;
  dealsCompleted: number;
  expenses: number | null;
  agents: { agentId: string; fullName: string; leads: number; showings: number | null; deals: number; commission: number | null }[];
  sources: { source: string; count: number }[];
  propertiesAdded: number;
  propertiesSold: number;
  /** Порог 4 антифрод-воронки. `undefined` — отчёт старше 16.09.2026: снапшот
   *  задним числом не пересчитывается, раздела там просто не было. */
  postShowingSilence?: {
    agents: {
      agentId: string;
      agentName: string;
      showings: number;
      silent: number;
      ratePercent: number;
      peerRatePercent: number;
      peerShowings: number;
      suspicious: boolean;
    }[];
    provableCase: {
      clientName: string;
      clientShortId: number;
      agentName: string;
      propertyTitle: string | null;
      what: string;
      quote: string | null;
      at: string;
    } | null;
  };
}

interface MonthlyReport {
  id: string;
  periodStart: string;
  metrics: MonthlyMetrics;
  notes: string | null;
  updatedBy: { fullName: string } | null;
  updatedAt: string;
}

/** periodStart — полночь ПЕРВОГО числа по Душанбе, а в UTC это 19:00 предыдущего дня.
 *  Без сдвига на +5 часов отчёт за июнь подписывался «май»: браузер честно показывал
 *  UTC-дату 31 мая. Сдвигаем и форматируем в UTC — так подпись совпадает с той, что
 *  сервер шлёт в push. */
const DUSHANBE_OFFSET_MS = 5 * 60 * 60 * 1000;

function monthLabel(iso: string) {
  return new Date(new Date(iso).getTime() + DUSHANBE_OFFSET_MS).toLocaleDateString("ru-RU", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Месячные отчёты руководству (примечание владельца от 30.07).
 *
 * Цифры — снапшот на момент составления: отчёт за март, открытый в декабре, показывает
 * март таким, каким он был. Заметки владелец правит когда угодно — это то, чего цифры
 * не показывают: почему месяц вышел таким и что делать дальше.
 *
 * ОБЛИК — тема «Royal Home 2026»: блок отдаёт `.sec-h` и `.card tight` прототипа и
 * живёт внутри `.sec` экрана «Отчёты» (`pages/Reports.tsx`). Своей карточки со
 * своими Tailwind-классами больше нет: на перенесённом экране она нарушала договор
 * дизайна (длинные тире в подписях, контраст 4.17 у `text-gray-400`, кнопка 32 px
 * на 390). Компонент используется ТОЛЬКО на `/reports` — одноимённый
 * `ProblemReportsSection` в настройках это другой компонент (тумблеры), поэтому
 * необязательный вариант оформления здесь не нужен.
 */
export function MonthlyReports() {
  const can = useCan();
  const canEdit = can("dashboard.analytics");
  const qc = useQueryClient();
  const { data: reports, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ["monthly-reports"],
    queryFn: () => api<MonthlyReport[]>("/reports/monthly"),
  });
  const [openId, setOpenId] = useState<string | null>(null);

  const generate = useMutation({
    mutationFn: () => api<{ created: boolean }>("/reports/monthly/generate", { method: "POST" }),
    meta: { silent: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["monthly-reports"] }),
  });

  // Первый открывается сам: чаще всего нужен именно свежий отчёт.
  useEffect(() => {
    if (!openId && reports && reports.length > 0) setOpenId(reports[0].id);
  }, [reports, openId]);

  const open = reports?.find((r) => r.id === openId) ?? null;

  return (
    <>
      <PostShowingCohort />
      <div className="sec-h">
        <h2>Месячные отчёты</h2>
        <span className="wrap">
          <span className="note">составляются 1-го числа за прошлый месяц</span>
          {canEdit && (
            <button
              className="pill ghost sm"
              type="button"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              title="Собрать отчёт за прошлый месяц сейчас, не дожидаясь первого числа"
            >
              {generate.isPending ? "Собираем…" : "Собрать сейчас"}
            </button>
          )}
        </span>
      </div>

      <div className="card tight">
        {generate.isError && (
          <div className="state err" role="alert">
            {generate.error instanceof Error ? generate.error.message : "Не удалось собрать отчёт"}
          </div>
        )}
        {isError && (
          <div className="state err" role="alert">
            <span>{reports ? "Не удалось обновить отчёты. Показаны последние загруженные данные." : "Не удалось загрузить месячные отчёты."} {error instanceof Error ? error.message : ""}</span>
            <button className="pill ghost sm" type="button" onClick={() => void refetch()} disabled={isFetching}>
              {isFetching ? "Загружаем…" : "Повторить загрузку"}
            </button>
          </div>
        )}
        {isLoading ? (
          <div className="state">
            <span className="sk w40" />
            <span className="sk w28" /> Считаем отчёт
          </div>
        ) : !reports ? null : reports.length === 0 ? (
          <div className="empty">
            <span className="ic">
              <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
              </svg>
            </span>
            <p>
              Отчётов пока нет. Первый появится 1-го числа следующего месяца
              {canEdit ? ", или соберите его сейчас кнопкой выше." : "."}
            </p>
          </div>
        ) : (
          <>
            <div className="hscroll">
              <div className="seg" role="tablist" aria-label="Месяц отчёта">
                {(reports ?? []).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    role="tab"
                    aria-selected={openId === r.id}
                    onClick={() => setOpenId(r.id)}
                  >
                    {monthLabel(r.periodStart)}
                  </button>
                ))}
              </div>
            </div>
            {open && <ReportBody key={open.id} report={open} canEdit={canEdit} />}
          </>
        )}
      </div>
    </>
  );
}

export function ReportBody({ report, canEdit }: { report: MonthlyReport; canEdit: boolean }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(() => createReportDraft(report.id, { notes: report.notes ?? "" }));
  const { notes } = draft.value;
  const editing = draft.editing;
  const remote = { notes: report.notes ?? "" };
  const conflict = reportDraftConflict(draft, remote);

  // Переключились на другой месяц — подставляем его заметки, а не чужие.
  useEffect(() => {
    setDraft((current) => reconcileReportDraft(current, report.id, { notes: report.notes ?? "" }));
  }, [report.id, report.notes]);

  const save = useMutation({
    mutationFn: () => api<MonthlyReport>(`/reports/monthly/${report.id}`, { method: "PATCH", body: { notes } }),
    onSuccess: (saved) => {
      setDraft(createReportDraft(saved.id, { notes: saved.notes ?? "" }));
      qc.setQueryData<MonthlyReport[]>(["monthly-reports"], (reports) => reports?.map((item) => item.id === saved.id ? saved : item));
      qc.invalidateQueries({ queryKey: ["monthly-reports"] });
    },
  });

  const m = report.metrics;
  const funnelMax = Math.max(1, ...m.funnel.map((s) => s.count ?? 0));
  // Без права на финансы сервер отдаёт деньги пустыми — тогда полосы по сделкам.
  const seesMoney = m.commission !== null;
  const agentsMax = Math.max(1, ...m.agents.map((a) => (seesMoney ? (a.commission ?? 0) : a.deals)));
  const sourcesMax = Math.max(1, ...m.sources.map((s) => s.count));
  const silence = m.postShowingSilence;

  return (
    <>
      {m.postShowingCohort && <section className="mt-4 space-y-2"><h3>Факты после показов · сохранённый срез версии 2</h3>{"agents" in m.postShowingCohort ? <PostShowingCohortFacts data={m.postShowingCohort} /> : <p role="status">Источник был недоступен при сборке отчёта. Это не нулевая доля.</p>}</section>}
      <div className="prog-legend" style={{ flexWrap: "wrap", marginTop: "var(--s4)" }}>
        <span>
          <b>{m.dealsCompleted}</b>сделок закрыто
        </span>
        {m.commission !== null && (
          <span>
            <b>
              <Rh2Money value={m.commission} cur="с." />
            </b>
            комиссия за месяц
          </span>
        )}
        {m.expenses !== null && (
          <span>
            <b>
              <Rh2Money value={m.expenses} cur="с." />
            </b>
            расходы за месяц
          </span>
        )}
        <span>
          <b>{m.propertiesAdded}</b>объектов заведено
        </span>
      </div>

      {m.funnel.length > 0 && (
        <>
          <div className="sec-t">Воронка месяца</div>
          <Rh2Bars
            items={m.funnel.map((s) => ({
              key: s.key,
              name: s.label,
              share: (s.count ?? 0) / funnelMax,
              value: s.count === null ? "Недоступно" : String(s.count),
            }))}
          />
        </>
      )}
      {m.publicInteractionCountersBasis && <p role="status">{m.publicInteractionCountersBasis === "UNAVAILABLE" ? "Счётчики контактов и показов недоступны. Это не нулевые значения." : "Контакты и показы рассчитаны по сохранившимся доступным событиям за месяц. Остальные показатели — сохранённый снимок."}</p>}

      {m.agents.length > 0 && (
        <>
          <div className="sec-t">По агентам</div>
          <div className="tbl-wrap only-wide" {...scrollableRegion("Отчёт по агентам за месяц")}>
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">Агент</th>
                  <th scope="col" className="num">Лиды</th>
                  <th scope="col" className="num">Показы</th>
                  <th scope="col" className="num">Сделки</th>
                  {seesMoney && <th scope="col" className="num">Комиссия</th>}
                </tr>
              </thead>
              <tbody>
                {m.agents.map((a) => (
                  <tr key={a.agentId}>
                    <td>{a.fullName}</td>
                    <td className="num">{a.leads}</td>
                    <td className="num">{a.showings ?? "Недоступно"}</td>
                    <td className="num">{a.deals}</td>
                    {seesMoney && (
                      <td className="num">
                        <Rh2Money value={a.commission ?? 0} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* До 820 px таблица из пяти колонок не читается — прототип показывает
              полосы, а показы и сделки видно в карточке сотрудника. */}
          <div className="only-narrow">
            <Rh2Bars
              items={m.agents.map((a) => ({
                key: a.agentId,
                name: a.fullName,
                share: (seesMoney ? (a.commission ?? 0) : a.deals) / agentsMax,
                value: seesMoney ? Math.round(a.commission ?? 0).toLocaleString("ru-RU") : String(a.deals),
              }))}
            />
            <p className="state">
              {seesMoney
                ? "Полоса это комиссия за месяц. Лиды, показы и сделки видно на компьютере."
                : "Полоса это закрытые сделки за месяц. Лиды и показы видно на компьютере."}
            </p>
          </div>
        </>
      )}

      {silence && silence.agents.length > 0 && (
        <>
          {/* ТИШИНА ПОСЛЕ ПОКАЗА (просьба владельца 12.09.2026): «обе цифры рядом» —
              своя доля и доля ОСТАЛЬНЫХ, без него самого. Сравнение со средней по
              агентству дало бы перекос: сильный агент сам тянет среднюю вверх и сам
              себе поднимает планку, с которой его же сравнивают. */}
          <div className="sec-t">Показы, кончившиеся тишиной</div>
          <p className="state">Архивная формула по записям опросов, а не по всем показам. REFUSED/UNCLEAR означают неуточнённый результат. Сохранённые цифры не пересчитывались; это не доказательство виновности.</p>
          <div className="tbl-wrap only-wide" {...scrollableRegion("Тишина после показа по агентам")}>
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">Агент</th>
                  <th scope="col" className="num">Показов</th>
                  <th scope="col" className="num">Тишина</th>
                  <th scope="col" className="num">У него</th>
                  <th scope="col" className="num">У остальных</th>
                </tr>
              </thead>
              <tbody>
                {silence.agents.map((a) => (
                  <tr key={a.agentId}>
                    <td>
                      {a.agentName}
                      {a.suspicious && <span className="chip warn" style={{ marginLeft: 6 }}>разрыв</span>}
                    </td>
                    <td className="num">{a.showings}</td>
                    <td className="num">{a.silent}</td>
                    <td className="num">{a.ratePercent}%</td>
                    <td className="num">{a.peerRatePercent}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="only-narrow">
            <Rh2Bars
              items={silence.agents.map((a) => ({
                key: a.agentId,
                name: a.agentName,
                share: Math.min(1, a.ratePercent / 100),
                value: `${a.ratePercent}% против ${a.peerRatePercent}%`,
              }))}
            />
            <p className="state">Полоса — доля показов, после которых клиент не сказал ни слова.</p>
          </div>
        </>
      )}

      {silence?.provableCase && (
        <>
          {/* Самый ДОКАЗУЕМЫЙ случай месяца, а не самый долгий: владелец просил
              кликабельную карточку, чтобы посмотреть хронологию самому. */}
          <div className="sec-t">Случай, который можно предъявить</div>
          <div className="quiet warn">
            <span className="dot warn" />
            <span className="txt">
              {silence.provableCase.what}. Показ вёл {silence.provableCase.agentName}
              {silence.provableCase.propertyTitle ? `, объект «${silence.provableCase.propertyTitle}»` : ""}.{" "}
              {silence.provableCase.quote && <>Дословно: «{silence.provableCase.quote}». </>}
              <Link className="lk" to={`/clients/${silence.provableCase.clientShortId}`}>
                Открыть карточку {silence.provableCase.clientName}
              </Link>
            </span>
          </div>
        </>
      )}

      {m.sources.length > 0 && (
        <>
          <div className="sec-t">Откуда пришли клиенты</div>
          <Rh2Bars
            items={m.sources.map((s) => ({
              key: s.source,
              // Сервер отдаёт код канала (`INSTAGRAM`) — подпись человеку берём
              // из общего словаря, тем же, что кольцо «Откуда приходят» выше.
              name: CLIENT_SOURCE_LABELS[s.source as ClientSource] ?? s.source,
              share: s.count / sourcesMax,
              value: String(s.count),
            }))}
          />
        </>
      )}

      <div className="sec-h" style={{ marginTop: "var(--s4)" }}>
        <h3>Дополнения</h3>
        <span className="wrap">
          {report.updatedBy && (
            <span className="note">
              правил {report.updatedBy.fullName}, {new Date(report.updatedAt).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe" })}
            </span>
          )}
          {canEdit && !editing && (
            <button className="lnk" type="button" onClick={() => {
              save.reset();
              setDraft({ ...createReportDraft(report.id, remote), editing: true });
            }}>
              {report.notes ? "Изменить" : "Добавить"}
            </button>
          )}
        </span>
      </div>

      {editing ? (
        <>
          {conflict && (
            <div className="state err" role="alert">
              <span>Дополнения изменились на сервере. Ваш черновик сохранён. Выберите, какой вариант использовать.</span>
              <button className="pill ghost sm" type="button" disabled={save.isPending} onClick={() => {
                save.reset();
                setDraft({ ...createReportDraft(report.id, remote), editing: true });
              }}>Загрузить обновлённое</button>
              <button className="pill ghost sm" type="button" disabled={save.isPending} onClick={() => {
                save.reset();
                setDraft((current) => ({ ...current, baseline: remote }));
              }}>Оставить мой вариант</button>
            </div>
          )}
          <textarea
            className="inp"
            rows={5}
            value={notes}
            aria-label="Дополнения к месячному отчёту"
            disabled={save.isPending}
            onChange={(e) => {
              const value = e.target.value;
              save.reset();
              setDraft((current) => ({ ...current, value: { notes: value } }));
            }}
            maxLength={10000}
            placeholder="Что цифры не показывают: причины, договорённости, планы на следующий месяц…"
            style={{ maxWidth: "none", borderRadius: "var(--r-md)", padding: "12px 16px", resize: "vertical" }}
          />
          <div className="wrap" style={{ marginTop: "var(--s3)" }}>
            <button className="pill" type="button" onClick={() => { if (!conflict) save.mutate(); }} disabled={save.isPending || conflict}>
              {save.isPending ? "Сохраняем…" : "Сохранить"}
            </button>
            <button
              className="pill ghost"
              type="button"
              disabled={save.isPending}
              onClick={() => {
                save.reset();
                setDraft(createReportDraft(report.id, remote));
              }}
            >
              Отмена
            </button>
          </div>
          {save.isError && (
            <div className="state err" role="alert">
              <span className="dot crit" />{" "}
              {save.error instanceof Error ? save.error.message : "Не удалось сохранить"}
            </div>
          )}
        </>
      ) : (
        <p className="state" style={{ whiteSpace: "pre-wrap", display: "block" }}>
          {report.notes || "Пока пусто. Сюда можно добавить всё, чего не видно в цифрах."}
        </p>
      )}
    </>
  );
}
