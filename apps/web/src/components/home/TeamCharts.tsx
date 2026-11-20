import type { ReactNode } from "react";
import { monthShort, monthTitle, type ClientSource } from "@royal-home/shared";
import { useCan } from "../../lib/permissions";
import { useDashboardCharts } from "../../hooks/useCharts";
import { useDashboardInsights } from "../../hooks/useDashboard";
import { CLIENT_SOURCE_LABELS } from "../../lib/clientFormat";
import { pluralizeRu } from "../../lib/format";
import { Rh2BarChart } from "../rh2/Rh2BarChart";
import { Rh2Bars } from "../rh2/Rh2Bars";
import { Rh2Inline } from "../rh2/Rh2Scope";
import { MhNoData, MhSection } from "./mh/MhScreen";
import { RhBlockState, RhCircle, RhGroup, RhRow, RhSection } from "../look/ui";

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

/** `royal` — главная «Нового вида» (components/look/home, 20.11.2026): разделы и строки нового вида. */
type Host = "screen" | "pult" | "phone" | "royal";

// Подписи месяца — одно правило на сервер и сайт (packages/shared/src/monthLabels.ts).
const num = (n: number) => n.toLocaleString("ru-RU");

interface Block {
  key: string;
  title: string;
  note?: string;
  body: ReactNode;
}

/**
 * `showWorkload: false` — у главной РОП «Нагрузка агентов» уже есть в «Распределении заявок»
 * (components/look/home/blocks/rop.tsx, 20.11.2026): второй такой же график рядом не нужен.
 */
export function TeamCharts({ host, showCommission = true, showWorkload = true }: { host: Host; showCommission?: boolean; showWorkload?: boolean }) {
  const can = useCan();
  const enabled = can("dashboard.analytics");
  const charts = useDashboardCharts(enabled);
  const insights = useDashboardInsights(enabled);

  if (!enabled) return null;
  if (!charts.data && !insights.data) {
    if (charts.isError && insights.isError) {
      const text = "Графики по команде не загрузились. Обновите страницу чуть позже.";
      if (host === "royal") return (
        <RhSection title="Графики по команде">
          <RhBlockState kind="error" onRetry={() => { void charts.refetch(); void insights.refetch(); }} />
        </RhSection>
      );
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
            label: monthShort(m.month),
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
            label: monthShort(m.month),
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

  // «Где застревают клиенты» по статусам снято 17.11.2026: статусы клиента не
  // показываются нигде (владелец).

  // Нагрузка: у кого сколько клиентов в работе.
  const workload = showWorkload ? ins?.workload ?? [] : [];
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

  if (host === "royal") {
    return (
      <>
        {weakText && (
          <RhSection title="Как идут дела у команды" className="ry-col-b">
            <RhGroup><RhRow lead={<RhCircle icon="circle-alert" tone="warn" />} title={weakText} /></RhGroup>
          </RhSection>
        )}
        {/* Графики по очереди в левую и правую колонку ПК (ядро главной закрепляет колонки). */}
        {blocks.map((b, i) => (
          <RhSection key={b.key} title={b.title} className={i % 2 === 0 ? "ry-col-a" : "ry-col-b"}>
            <div className="ry-home-chart">
              {b.note && <p className="ry-home-chart-note">{b.note}</p>}
              <Rh2Inline>{b.body}</Rh2Inline>
            </div>
          </RhSection>
        ))}
      </>
    );
  }

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
