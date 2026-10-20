import { DEAL_STAGE_LABELS, type CommissionForecast } from "@royal-home/shared";
import { useCommissionForecast } from "../../hooks/useFinance";

/**
 * ПРОГНОЗ ДЕНЕГ К КОНЦУ МЕСЯЦА — один компонент на все три места, где он нужен:
 * блок «Деньги» пульта на компьютере, тот же блок на телефоне
 * (пульт директора, DirectorHome) и карточка сверху раздела «Деньги» (/finance).
 *
 * Компонент один намеренно. Правило репозитория про два экрана уже стоило
 * агентству четырёх незамеченных доработок на Oversight: доработка уезжала на
 * компьютер и была невидима на телефоне, при этом ничего не падало и не
 * предупреждало. Здесь расхождению взяться неоткуда: и пульт на компьютере, и
 * пульт на телефоне вставляют одну и ту же `CommissionForecastLine`, а раздел
 * «Деньги» — `CommissionForecastCard`; фраза прогноза у обоих собирается одной
 * функцией `headline`, так что формулировка физически не может разъехаться.
 *
 * Прогноз считает сервер (GET /finance/forecast, lib/financeForecast.ts):
 * факт закрытых сделок + воронка по вероятности стадии + темп в верхнюю оценку.
 * Экран НИЧЕГО не досчитывает — иначе два места показали бы разные числа.
 */

function somoni(value: number): string {
  return `${Math.round(value).toLocaleString("ru-RU")} с.`;
}

function planProgress(percent: number): string {
  return percent > 200 ? `×${(percent / 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} плана` : `${percent} % плана`;
}

/** Строка «мало истории» — тихая, а не тревожная: это отсутствие данных, не сбой. */
function LowHistoryNote() {
  return (
    <p className="quiet">
      <i className="dot d-warn" aria-hidden="true" />
      Мало истории: закрытых сделок меньше чем за месяц, поэтому темп не считали — верхняя оценка без него.
    </p>
  );
}

function Reasons({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="list">
      {reasons.map((reason) => (
        <li className="row" key={reason}>
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

/** Одна фраза прогноза — общая для всех видов, чтобы формулировка не разъезжалась. */
function headline(f: CommissionForecast): string {
  return `К концу месяца: ~${somoni(f.expectedTjs)} (от ${somoni(f.lowTjs)} до ${somoni(f.highTjs)}), ${planProgress(f.percentOfPlan)}`;
}

/**
 * КОМПАКТНАЯ СТРОКА для блока «Деньги» пульта: вторая строка под полосой плана,
 * причины прячутся в раскрытие, чтобы не разносить карточку.
 */
export function CommissionForecastLine({ enabled = true }: { enabled?: boolean }) {
  const { data: f, isError, isLoading } = useCommissionForecast(enabled);

  if (!enabled) return null;
  if (isLoading) {
    return (
      <p className="quiet">
        <span className="sk w40" /> Считаем прогноз к концу месяца
      </p>
    );
  }
  // Отказ связи — это не «нулевой прогноз». Молчать тоже нельзя: строка просто
  // исчезла бы, и никто бы не понял, что число не показано.
  if (isError || !f) {
    return (
      <p className="quiet">
        <i className="dot d-crit" aria-hidden="true" />
        Прогноз к концу месяца не посчитался — это сбой связи, а не отсутствие денег.
      </p>
    );
  }

  return (
    <details className="fc-line">
      <summary>
        <b>{headline(f)}</b> <u>почему</u>
      </summary>
      <Reasons reasons={f.reasons} />
      {f.lowHistory && <LowHistoryNote />}
    </details>
  );
}

/**
 * КАРТОЧКА для раздела «Деньги»: то же число крупно, три причины сразу
 * (в разделе есть место) и разбивка воронки по стадиям.
 */
export function CommissionForecastCard({ enabled = true, month }: { enabled?: boolean; month?: string }) {
  const { data: f, isError, isLoading, refetch } = useCommissionForecast(enabled, month);

  if (!enabled) return null;

  return (
    <div className="sec">
      <div className="sec-h">
        <h2>Прогноз к концу месяца</h2>
        <span className="note">факт закрытых сделок плюс воронка по вероятности стадии</span>
      </div>
      <div className="card tight commission-forecast">
        {isLoading && (
          <div className="state">
            <span className="sk w40" />
            <span className="sk w22" /> Считаем прогноз
          </div>
        )}
        {!isLoading && (isError || !f) && (
          <div className="state err">
            <span className="dot crit" /> Не удалось посчитать прогноз. Это сбой связи, а не нулевые деньги.
            <button
              className="lk"
              type="button"
              style={{ color: "inherit", textDecoration: "underline" }}
              onClick={() => refetch()}
            >
              Повторить
            </button>
          </div>
        )}
        {!isLoading && f && (
          <>
            <div className="trio">
              <div className="tc lead">
                <small>Ожидаем</small>
                <b>{somoni(f.expectedTjs)}</b>
                <div className="sub">
                  {planProgress(f.percentOfPlan)} {somoni(f.planTjs)}
                </div>
              </div>
              <div className="tc">
                <small>Нижняя оценка</small>
                <b>{somoni(f.lowTjs)}</b>
                <div className="sub">факт и сделки, которые почти дошли</div>
              </div>
              <div className="tc">
                <small>Верхняя оценка</small>
                <b>{somoni(f.highTjs)}</b>
                <div className="sub">
                  {f.paceTjs !== null
                    ? `с темпом за ${f.workdaysLeft} оставшихся рабочих дней`
                    : "темп не считали"}
                </div>
              </div>
            </div>
            <Reasons reasons={f.reasons} />
            {f.stages.length > 0 && (
              <ul className="list">
                {f.stages.map((s) => (
                  <li className="row" key={s.stage}>
                    <span>
                      {DEAL_STAGE_LABELS[s.stage]}: {s.count} на {somoni(s.amountTjs)}
                    </span>
                    <span className="chip">{Math.round(s.probability * 100)} %</span>
                    <b>{somoni(s.weightedTjs)}</b>
                  </li>
                ))}
              </ul>
            )}
            <p className="quiet">
              Уже получено {somoni(f.factTjs)} · Доля компании в ожидаемой сумме — {somoni(f.expectedCompanyTjs)}
            </p>
            {f.lowHistory && <LowHistoryNote />}
          </>
        )}
      </div>
    </div>
  );
}
