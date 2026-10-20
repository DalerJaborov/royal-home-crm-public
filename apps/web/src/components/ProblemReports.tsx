import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PROBLEM_PERIOD_LABELS,
  PROBLEM_REPORT_PERIODS,
  type ProblemMetric,
  type ProblemPeriod,
  type ProblemReportMetrics,
  type ProblemSection,
} from "@royal-home/shared";
import { api } from "../lib/api";
import { useCan } from "../lib/permissions";
import { Rh2Bars } from "./rh2/Rh2Bars";
import { VoiceNoteButton, type VoiceNote } from "./VoiceNoteButton";
import { VoiceNotePlayer } from "./VoiceNotePlayer";
import { createReportDraft, reconcileReportDraft, reportDraftConflict } from "../lib/reportDraft";

/**
 * РАЗБОР ПРОБЛЕМНЫХ МЕСТ — экран еженедельного и ежемесячного отчёта.
 *
 * Решение владельца 11.08.2026: отчёт живёт экраном в CRM с историей, а о готовом
 * разборе приходит push. Почты, PDF и Excel в системе нет и заводить их ради этого
 * не нужно — вместо выгрузки здесь ссылки прямо на проблемные карточки: из отчёта
 * надо иметь возможность пойти и починить, а не выписывать фамилии на бумажку.
 *
 * Форма данных описана один раз в @royal-home/shared (problemReport.ts) — сервер
 * кладёт её в metrics, экран читает оттуда же. Своя копия типа здесь означала бы
 * ровно ту же ловушку, что уже случилась с месячным отчётом.
 *
 * ОБЛИК — тема «Royal Home 2026», блок «Разбор проблемных мест» прототипа
 * (`docs/pult/theme-2026/screens/reports.html`): `.sec-h` с подписью, `.card tight`,
 * находки строками `.quiet` со ссылкой `.lnk`, ссылки на карточки строками `.row`.
 * Графических библиотек по-прежнему не добавляем: разбивка рисуется полосами
 * прототипа (`Rh2Bars`), теми же, что «Эффективность по агентам» на этой странице.
 *
 * Компонент используется ТОЛЬКО на `/reports`. Одноимённый `ProblemReportsSection`
 * в настройках (`pages/settings/SystemTab.tsx`) — другой компонент, он держит
 * тумблеры «собирать недельный / месячный», а не сам отчёт, поэтому вариант
 * оформления «старый облик вне темы» здесь не нужен.
 */

interface ProblemReport {
  id: string;
  period: ProblemPeriod;
  periodStart: string;
  periodEnd: string;
  metrics: ProblemReportMetrics;
  notes: string | null;
  notesVoiceUrl?: string | null;
  notesVoiceTranscript?: string | null;
  updatedBy: { fullName: string } | null;
  updatedAt: string;
}

/** Душанбе UTC+5: periodStart недели — полночь по Душанбе, в UTC это 19:00
 *  предыдущего дня. Без сдвига подпись отставала бы на сутки. */
const DUSHANBE_OFFSET_MS = 5 * 60 * 60 * 1000;

function wall(iso: string): Date {
  return new Date(new Date(iso).getTime() + DUSHANBE_OFFSET_MS);
}

function dayLabel(iso: string): string {
  const d = wall(iso);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** «04.08 по 10.08» для недели и «июль 2026» для месяца: у месяца обе даты
 *  читаются хуже, чем его имя. Разделитель словом, а не длинным тире: тире в
 *  видимом тексте владелец не хочет, и на экране «Отчёты» период уже подписан
 *  так же («с 01.09 по 09.09»). periodEnd не включён — берём день до него. */
function periodLabel(report: ProblemReport): string {
  if (report.period === "month") {
    return wall(report.periodStart).toLocaleDateString("ru-RU", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  const lastDay = new Date(new Date(report.periodEnd).getTime() - 1).toISOString();
  return `${dayLabel(report.periodStart)} по ${dayLabel(lastDay)}`;
}

export function ProblemReports() {
  const can = useCan();
  const canEdit = can("dashboard.analytics");
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  // Push «разбор готов» ведёт на /reports?problems=week|month — открываем сразу тот
  // отчёт, о котором уведомили, а не тот, что стоит по умолчанию.
  const requested = searchParams.get("problems");
  const [period, setPeriod] = useState<ProblemPeriod>(requested === "month" ? "month" : "week");
  const [openId, setOpenId] = useState<string | null>(null);

  const { data: reports, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ["problem-reports", period],
    queryFn: () => api<ProblemReport[]>(`/reports/problems?period=${period}`),
  });

  const generate = useMutation({
    mutationFn: () => api<{ created: boolean }>("/reports/problems/generate", { method: "POST", body: { period } }),
    // silent: «Собрать сейчас» ничего не сохраняет — оно считает разбор, и готовый
    // разбор тут же открывается ниже. Отказ печатается своей строкой под кнопкой,
    // которую общий тост повторял слово в слово (аудит 22.08.2026, раунд 5).
    meta: { silent: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["problem-reports", period] }),
  });

  // Свежий разбор открывается сам: чаще всего нужен именно он. При смене периода
  // выбор сбрасывается — id из недельного списка в месячном не существует.
  useEffect(() => {
    setOpenId(null);
  }, [period]);
  useEffect(() => {
    if (!openId && reports && reports.length > 0) setOpenId(reports[0].id);
  }, [reports, openId]);

  const open = reports?.find((r) => r.id === openId) ?? null;

  return (
    <>
      <div className="sec-h" id="problem-reports">
        <h2>Разбор проблемных мест</h2>
        <span className="wrap">
          <span className="note">где теряем клиентов, агентов, звонки и объекты</span>
          {canEdit && (
            <button
              className="pill ghost sm"
              type="button"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              title="Собрать разбор за прошедший период сейчас, не дожидаясь понедельника или первого числа"
            >
              {generate.isPending ? "Собираем…" : "Собрать сейчас"}
            </button>
          )}
        </span>
      </div>

      <div className="card tight">
        <div className="hscroll">
          <div className="seg" role="tablist" aria-label="Период разбора">
            {PROBLEM_REPORT_PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={period === p}
                onClick={() => { generate.reset(); setPeriod(p); }}
              >
                {PROBLEM_PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        {generate.isError && (
          <div className="state err" role="alert">
            <span className="dot crit" />{" "}
            {generate.error instanceof Error ? generate.error.message : "Не удалось собрать разбор"}
          </div>
        )}

        {isError && (
          <div className="state err" role="alert">
            <span>{reports ? "Не удалось обновить разборы. Показаны последние загруженные данные." : "Не удалось загрузить разборы проблемных мест."} {error instanceof Error ? error.message : ""}</span>
            <button className="pill ghost sm" type="button" onClick={() => void refetch()} disabled={isFetching}>
              {isFetching ? "Загружаем…" : "Повторить загрузку"}
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="state">
            <span className="sk w40" />
            <span className="sk w28" /> Считаем разбор
          </div>
        ) : !reports ? null : reports.length === 0 ? (
          <div className="empty">
            <span className="ic">
              <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="m15.5 8.5-2.4 4.6-4.6 2.4 2.4-4.6Z" />
              </svg>
            </span>
            <p>
              Разборов пока нет. Недельный собирается по понедельникам, месячный 1-го числа
              {canEdit ? ", а первый можно собрать прямо сейчас кнопкой выше." : "."}
            </p>
            <span className="sub">Включаются и выключаются разборы в Настройках → Данные и система.</span>
          </div>
        ) : (
          <>
            <div className="hscroll" style={{ marginTop: "var(--s3)" }}>
              <div className="seg" role="tablist" aria-label="Разбор за период">
                {(reports ?? []).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    role="tab"
                    aria-selected={openId === r.id}
                    onClick={() => setOpenId(r.id)}
                  >
                    {periodLabel(r)}
                  </button>
                ))}
              </div>
            </div>
            {open && <ReportBody key={open.id} report={open} canEdit={canEdit} period={period} />}
          </>
        )}
      </div>
    </>
  );
}

function ReportBody({
  report,
  canEdit,
  period,
}: {
  report: ProblemReport;
  canEdit: boolean;
  period: ProblemPeriod;
}) {
  const qc = useQueryClient();
  const remote = {
    notes: report.notes ?? "",
    notesVoiceUrl: report.notesVoiceUrl ?? null,
    notesVoiceTranscript: report.notesVoiceTranscript ?? null,
  };
  const [draft, setDraft] = useState(() => createReportDraft(report.id, remote));
  const { notes } = draft.value;
  const notesVoiceNote: VoiceNote | null = draft.value.notesVoiceUrl
    ? { url: draft.value.notesVoiceUrl, transcript: draft.value.notesVoiceTranscript }
    : null;
  const editing = draft.editing;
  const conflict = reportDraftConflict(draft, remote);

  // Переключились на другой период — подставляем его заметки, а не чужие.
  useEffect(() => {
    setDraft((current) => reconcileReportDraft(current, report.id, {
      notes: report.notes ?? "",
      notesVoiceUrl: report.notesVoiceUrl ?? null,
      notesVoiceTranscript: report.notesVoiceTranscript ?? null,
    }));
  }, [report.id, report.notes, report.notesVoiceUrl, report.notesVoiceTranscript]);

  const save = useMutation({
    mutationFn: () =>
      api<ProblemReport>(`/reports/problems/${report.id}`, {
        method: "PATCH",
        body: {
          notes,
          notesVoiceUrl: notesVoiceNote?.url ?? null,
          notesVoiceTranscript: notesVoiceNote?.transcript ?? null,
        },
      }),
    // silent: на успехе поле ввода схлопывается в сохранённый текст с подписью
    // «кто и когда», на отказе ошибка печатается строкой под кнопкой — общий тост
    // дублировал её (тот же класс, что и `generate` выше).
    meta: { silent: true },
    onSuccess: (saved) => {
      setDraft(createReportDraft(saved.id, {
        notes: saved.notes ?? "",
        notesVoiceUrl: saved.notesVoiceUrl ?? null,
        notesVoiceTranscript: saved.notesVoiceTranscript ?? null,
      }));
      qc.setQueryData<ProblemReport[]>(["problem-reports", period], (reports) => reports?.map((item) => item.id === saved.id ? saved : item));
      qc.invalidateQueries({ queryKey: ["problem-reports", period] });
    },
  });

  const m = report.metrics;

  return (
    <>
      {/* Главный вывод — первым и своей строкой: владелец просил разбор, а не таблицу. */}
      <div className="quiet warn" style={{ marginTop: "var(--s3)" }}>
        <span className="txt">{m.headline}</span>
      </div>

      {m.sections.map((section) => (
        <SectionBlock key={section.key} section={section} />
      ))}

      <div className="sec-h" style={{ marginTop: "var(--s5)" }}>
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
              <span>Дополнения изменились на сервере. Ваш текст и голосовой черновик сохранены. Выберите, какой вариант использовать.</span>
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
            rows={4}
            value={notes}
            aria-label="Дополнения к разбору проблемных мест"
            disabled={save.isPending}
            onChange={(e) => {
              const value = e.target.value;
              save.reset();
              setDraft((current) => ({ ...current, value: { ...current.value, notes: value } }));
            }}
            maxLength={10000}
            placeholder="Что решили по этим находкам: с кем поговорили, что меняем, к чему вернуться в следующем разборе…"
            style={{ maxWidth: "none", borderRadius: "var(--r-md)", padding: "12px 16px", resize: "vertical" }}
          />
          <div style={{ marginTop: "var(--s3)" }}>
            <VoiceNoteButton uploadUrl="/me/voice-notes" value={notesVoiceNote} disabled={save.isPending} onChange={(voice) => {
              if (save.isPending) return;
              save.reset();
              setDraft((current) => ({ ...current, value: {
                ...current.value, notesVoiceUrl: voice?.url ?? null, notesVoiceTranscript: voice?.transcript ?? null,
              } }));
            }} />
          </div>
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
        <>
          <p className="state" style={{ whiteSpace: "pre-wrap", display: "block" }}>
            {report.notes || "Пока пусто. Сюда можно записать, что решили по этим находкам."}
          </p>
          {report.notesVoiceUrl && (
            <div style={{ marginTop: "var(--s2)" }}>
              <VoiceNotePlayer url={report.notesVoiceUrl} />
            </div>
          )}
        </>
      )}
    </>
  );
}

function SectionBlock({ section }: { section: ProblemSection }) {
  const breakdownMax = Math.max(1, ...(section.breakdown?.rows ?? []).map((r) => r.count));

  return (
    <>
      <div className="sec-h" style={{ marginTop: "var(--s5)" }}>
        <h3>{section.title}</h3>
        <DirectionChip section={section} />
      </div>

      <div className="quiet">
        <span className="txt">{section.headline}</span>
      </div>

      <div className="list">
        {section.metrics.map((metric) => (
          <MetricRow key={metric.key} metric={metric} />
        ))}
      </div>

      {section.breakdown && section.breakdown.rows.length > 0 && (
        <>
          <div className="sec-t">{section.breakdown.title}</div>
          <Rh2Bars
            items={section.breakdown.rows.map((row) => ({
              key: row.label,
              name: row.label,
              share: row.count / breakdownMax,
              value: String(row.count),
            }))}
          />
        </>
      )}

      {section.links.length > 0 && (
        <>
          <div className="sec-t">Куда идти чинить</div>
          <div className="list">
            {section.links.map((link) => (
              <Link className="row" key={link.href + link.label} to={link.href}>
                <span className="t">
                  <b>{link.label}</b>
                  <span>{link.hint}</span>
                </span>
                <span className="act">
                  <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** Стало лучше или хуже — по сравнимой части раздела. Меньше потерь это хорошо,
 *  поэтому «лучше» зелёное при падении числа, а рост подсвечен красным (обратно
 *  привычному «рост = рост»). */
function DirectionChip({ section }: { section: ProblemSection }) {
  if (section.direction === "same") return <span className="chip mute">столько же</span>;
  const worse = section.direction === "worse";
  const diff = Math.abs(section.total - section.previousTotal);
  return <span className={worse ? "chip crit" : "chip ok"}>{worse ? `хуже на ${diff}` : `лучше на ${diff}`}</span>;
}

function MetricRow({ metric }: { metric: ProblemMetric }) {
  const delta = metric.previous === null ? null : metric.value - metric.previous;
  const body = (
    <>
      <span className="t">
        <b>{metric.label}</b>
        {metric.hint && <span>{metric.hint}</span>}
      </span>
      <span className="act">
        <b style={{ fontFamily: "var(--ff-head)", fontVariantNumeric: "tabular-nums", fontSize: "var(--fs-17)" }}>
          {metric.value}
        </b>
        {delta !== null && delta !== 0 && (
          <span className={delta > 0 ? "chip crit" : "chip ok"}>{delta > 0 ? `+${delta}` : delta}</span>
        )}
        {delta === 0 && <span className="chip mute">без изменений</span>}
        {/* «на сейчас» — показатель, который нечем сравнить с прошлым периодом:
            в базе лежит текущее состояние объекта, а не его история. */}
        {metric.previous === null && <span className="chip mute">на сейчас</span>}
      </span>
    </>
  );
  return metric.href ? (
    <Link className="row" to={metric.href}>
      {body}
    </Link>
  ) : (
    <div className="row">{body}</div>
  );
}
