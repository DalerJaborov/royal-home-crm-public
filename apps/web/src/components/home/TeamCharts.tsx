import type { ReactNode } from "react";
import type { ClientSource } from "@royal-home/shared";
import { useCan } from "../../lib/permissions";
import { useDashboardCharts } from "../../hooks/useCharts";
import { useDashboardInsights } from "../../hooks/useDashboard";
import { CLIENT_SOURCE_LABELS } from "../../lib/clientFormat";
import { pluralizeRu } from "../../lib/format";
import { Rh2BarChart } from "../rh2/Rh2BarChart";
import { Rh2Bars } from "../rh2/Rh2Bars";
import { Rh2Inline } from "../rh2/Rh2Scope";
import { MhNoData, MhSection } from "./mh/MhScreen";

/**
 * ГРАФИКИ И ПОДСКАЗКИ ПО КОМАНДЕ НА ГЛАВНОЙ (28.09.2026, «сделанное — на экран»).
 *
 * Сервер давно считает `/dashboard/charts` (комиссия и объекты по месяцам,
 * источники клиентов месяца) и `/dashboard/insights` (слабое место недели, где
 * застревают клиенты, нагрузка агентов), но ни один экран их не звал. Один
 * компонент на все четыре места — пульт директора, главная директора на
 * телефоне, главная менеджера на ПК и на телефоне, — чтобы ПК и телефон не
 * разошлись (правило репозитория про `Mobile*.tsx`).
 *
 * ОБЁРТКА ПО МЕСТУ, СОДЕРЖИМОЕ ОДНО. У трёх мест разные наборы стилей: экран
 * `.rh2 .scr` (главная менеджера), пульт `.rh2 .pult` (`.v8 > .v8b`) и
 * телефонная главная `.rh2 .mh` (`MhSection` + `.card-s`). Заголовки и карточки
 * берутся из стиля места, а сами графики (`Rh2BarChart`, `Rh2Bars`) живут только
 * в `.rh2 .scr` — поэтому вне экрана они обёрнуты в `Rh2Inline`.
 *
 * ДЕНЬГИ. Комиссия по месяцам приходит `null` без права finance.view — тогда
 * блока нет вовсе. Прогноз плана из `/insights` здесь не рисуется: он уже стоит
 * в «Деньгах» и пульта, и телефонной главной.
 */

type Host = "screen" | "pult" | "phone";

const MONTH_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTH_NOM = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];
const monthIdx = (ym: string) => Math.max(0, Math.min(11, Number(ym.slice(5, 7)) - 1));
const monthTitle = (ym: string) => `${MONTH_NOM[monthIdx(ym)]} ${ym.slice(0, 4)}`;
const num = (n: number) => n.toLocaleString("ru-RU");

/** Сколько клиенты в среднем ждут на стадии: «5 ч», «3 дн.». */
function waitLabel(hours: number): string {
  if (hours < 24) return `${Math.max(1, hours)} ч`;
  return `${Math.round(hours / 24)} дн.`;
}

interface Block {
  key: string;
  title: string;
  note?: string;
  body: ReactNode;
}

export function TeamCharts({ host, showCommission = true }: { host: Host; showCommission?: boolean }) {
  const can = useCan();
  const enabled = can("dashboard.analytics");
  const charts = useDashboardCharts(enabled);
  const insights = useDashboardInsights(enabled);

  if (!enabled) return null;
  if (!charts.data && !insights.data) {
    if (charts.isError && insights.isError) {
      const text = "Графики по команде не загрузились. Обновите страницу чуть позже.";
      if (host === "phone") return <MhNoData tone="warn">{text}</MhNoData>;
      return (
        <p className={host === "pult" ? "hint" : "quiet"}>
          <span className="txt">{text}</span>
        </p>
      );
    }
    return null;
  }

  const blocks: Block[] = [];
  const c = charts.data;
  const ins = insights.data;

  // Комиссия по месяцам — только тем, кому сервер отдал деньги (не null).
  const commission = c?.commissionByMonth ?? [];
  const commissionTotal = commission.reduce((s, m) => s + (m.commission ?? 0), 0);
  if (showCommission && commission.some((m) => m.commission !== null) && commissionTotal > 0) {
    const last = commission[commission.length - 1];
    blocks.push({
      key: "commission",
      title: "Комиссия по месяцам",
      note: "сомони, за год",
      body: (
        <Rh2BarChart
          ariaLabel={`Комиссия по месяцам: ${commission.map((m) => `${monthTitle(m.month)} ${num(m.commission ?? 0)}`).join(", ")} сомони`}
          lastValueLabel={num(last.commission ?? 0)}
          items={commission.map((m) => ({
            key: m.month,
            label: MONTH_SHORT[monthIdx(m.month)],
            value: m.commission ?? 0,
            tip: `${monthTitle(m.month)}|${num(m.commission ?? 0)} сомони · ${m.deals} ${pluralizeRu(m.deals, ["сделка", "сделки", "сделок"])}`,
          }))}
        />
      ),
    });
  }

  // Объекты: сколько добавили и сколько продали по месяцам.
  const props = c?.propertiesByMonth ?? [];
  const addedTotal = props.reduce((s, m) => s + m.added, 0);
  const soldTotal = props.reduce((s, m) => s + m.sold, 0);
  if (addedTotal + soldTotal > 0) {
    blocks.push({
      key: "properties",
      title: "Объекты: добавлено и продано",
      note: `за год добавлено ${num(addedTotal)}, продано ${num(soldTotal)}`,
      body: (
        <Rh2BarChart
          ariaLabel={`Добавлено объектов по месяцам: ${props.map((m) => `${monthTitle(m.month)} ${m.added}, продано ${m.sold}`).join("; ")}`}
          lastValueLabel={num(props[props.length - 1]?.added ?? 0)}
          items={props.map((m) => ({
            key: m.month,
            label: MONTH_SHORT[monthIdx(m.month)],
            value: m.added,
            tip: `${monthTitle(m.month)}|добавлено ${num(m.added)} · продано ${num(m.sold)}`,
          }))}
        />
      ),
    });
  }

  // Откуда пришли клиенты в этом месяце.
  const sources = (c?.sourcesThisMonth ?? []).filter((s) => s.count > 0);
  if (c) {
    const total = sources.reduce((s, x) => s + x.count, 0);
    const max = Math.max(1, ...sources.map((s) => s.count));
    blocks.push({
      key: "sources",
      title: "Откуда клиенты в этом месяце",
      note: total > 0 ? `${num(total)} ${pluralizeRu(total, ["новый", "новых", "новых"])}` : undefined,
      body:
        sources.length > 0 ? (
          <Rh2Bars
            items={sources.slice(0, 8).map((s) => ({
              key: s.source,
              name: CLIENT_SOURCE_LABELS[s.source as ClientSource] ?? s.source,
              share: s.count / max,
              value: num(s.count),
            }))}
          />
        ) : (
          <p className="state">В этом месяце новых клиентов пока нет.</p>
        ),
    });
  }

  // Где застревают клиенты: стадии, отсортированные по долгому ожиданию.
  const stalled = ins?.stalledStages ?? [];
  if (stalled.length > 0) {
    const max = Math.max(1, ...stalled.map((s) => s.avgAgeHours));
    blocks.push({
      key: "stalled",
      title: "Где застревают клиенты",
      note: "сколько в среднем ждут",
      body: (
        <Rh2Bars
          items={stalled.map((s) => ({
            key: s.status,
            name: `${s.label} · ${num(s.count)}`,
            share: s.avgAgeHours / max,
            value: waitLabel(s.avgAgeHours),
          }))}
        />
      ),
    });
  }

  // Нагрузка: у кого сколько клиентов в работе.
  const workload = ins?.workload ?? [];
  if (workload.length > 0) {
    const max = Math.max(1, ...workload.map((w) => w.activeClients));
    blocks.push({
      key: "workload",
      title: "Нагрузка агентов",
      note: "клиентов в работе",
      body: (
        <Rh2Bars
          items={workload.slice(0, 10).map((w) => ({
            key: w.agentId,
            name: w.agentName,
            share: w.activeClients / max,
            value: num(w.activeClients),
          }))}
        />
      ),
    });
  }

  const weak = ins?.weakLink;
  const weakText = weak ? `Слабое место недели: у ${weak.agentName} меньше всего баллов за «${weak.categoryLabel}».` : null;

  if (blocks.length === 0 && !weakText) return null;

  if (host === "phone") {
    return (
      <>
        {weakText && (
          <MhSection title="Как идут дела у команды">
            <MhNoData tone="warn">{weakText}</MhNoData>
          </MhSection>
        )}
        {blocks.map((b) => (
          <MhSection key={b.key} title={b.title} note={b.note}>
            <div className="card-s" style={{ padding: 14 }}>
              <Rh2Inline>{b.body}</Rh2Inline>
            </div>
          </MhSection>
        ))}
      </>
    );
  }

  if (host === "pult") {
    return (
      <section id="sec-10" className="secwrap" aria-label="Графики по команде">
        <div className="v8">
          {weakText && (
            <section className="card v8b" aria-label="Слабое место недели">
              <div className="hint">{weakText}</div>
            </section>
          )}
          {blocks.map((b) => (
            <section key={b.key} className="card v8b" aria-labelledby={`tc-h-${b.key}`}>
              <div className="card-h">
                <h3 id={`tc-h-${b.key}`}>{b.title}</h3>
                {b.note && <span className="hint">{b.note}</span>}
              </div>
              <Rh2Inline>{b.body}</Rh2Inline>
            </section>
          ))}
        </div>
      </section>
    );
  }

  return (
    <>
      {weakText && (
        <div className="quiet">
          <span className="txt">{weakText}</span>
        </div>
      )}
      <div className="cols2">
        {blocks.map((b) => (
          <div className="sec" key={b.key}>
            <div className="sec-h">
              <h2>{b.title}</h2>
              {b.note && <span className="note">{b.note}</span>}
            </div>
            <div className="card tight">{b.body}</div>
          </div>
        ))}
      </div>
    </>
  );
}
