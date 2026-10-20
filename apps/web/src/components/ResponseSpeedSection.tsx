import { RESPONSE_SPEED_MIN_SAMPLE, type ResponseSpeedBucket } from "@royal-home/shared";
import { useResponseSpeed } from "../hooks/useReports";
import { pluralizeRu } from "../lib/format";

/**
 * «ЧЕМ БЫСТРЕЕ ОТВЕТ, ТЕМ ЧАЩЕ ПОКАЗ» (владелец, 03.10.2026): доля обращений,
 * дошедших до показа или сделки, по времени до первого ответа агента.
 * Живёт рядом с картой «когда пишут клиенты» на экране источников.
 *
 * Свой SVG-подобный столбчатый график на div'ах и токенах темы (новых
 * библиотек нет). Числа и пометка «мало данных» — текстом, не только высотой
 * столбца. Честные границы: «первый ответ» — это первая работа АГЕНТА в
 * карточке (Client.firstContactAt), ответы бота и переписка вне CRM сюда не
 * попадают.
 */

const pct = (v: number) => `${Math.round(v * 100)} %`;

function minutesText(m: number): string {
  if (m < 1) return "меньше минуты";
  if (m < 60) return `${Math.round(m)} мин`;
  const h = m / 60;
  return h < 24 ? `${h.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ч` : `${Math.round(h / 24)} дн.`;
}

function bucketWords(b: ResponseSpeedBucket): string {
  if (b.leads === 0) return `${b.label}: обращений нет`;
  if (b.showingRate == null) {
    return `${b.label}: ${b.leads} обращений, мало данных (меньше ${RESPONSE_SPEED_MIN_SAMPLE}), до показа дошли ${b.reachedShowing}`;
  }
  return `${b.label}: ${b.leads} обращений, до показа или сделки дошли ${b.reachedShowing}, это ${pct(b.showingRate)}`;
}

export function ResponseSpeedSection() {
  const { data, isLoading, isError, refetch } = useResponseSpeed();
  const max = Math.max(0.01, ...(data?.buckets.map((b) => b.showingRate ?? 0) ?? [0]));

  return (
    <div className="sec" id="response-speed-section">
      <div className="sec-h">
        <h2>Скорость ответа и показы</h2>
        <span className="note">за {data?.days ?? 90} дней</span>
      </div>
      <div className="card tight">
        {isError ? (
          <div className="state err">
            <span className="dot crit" /> График не загрузился.
            <button className="lk" type="button" style={{ color: "inherit", textDecoration: "underline" }} onClick={() => refetch()}>
              Повторить
            </button>
          </div>
        ) : isLoading || !data ? (
          <p className="state">Считаем скорость ответа…</p>
        ) : data.leads === 0 ? (
          <p className="state">За этот срок нет обращений покупателей старше {data.matureAfterDays} дней — сравнивать нечего.</p>
        ) : (
          <>
            <p className="sub" style={{ margin: 0 }}>
              Доля обращений, дошедших до показа или сделки, в зависимости от того, как быстро агент впервые взялся за
              карточку.
              {data.medianMinutes != null && ` Медиана первого ответа — ${minutesText(data.medianMinutes)}.`}
            </p>
            <div className="rsp-bars" role="group" aria-label="Доля обращений, дошедших до показа, по времени до первого ответа">
              {data.buckets.map((b) => {
                const low = b.showingRate == null;
                return (
                  <div
                    className={`rsp-col${low ? " is-low" : ""}`}
                    key={b.key}
                    role="img"
                    tabIndex={0}
                    aria-label={bucketWords(b)}
                    title={bucketWords(b)}
                  >
                    <span className="rsp-val">{b.leads === 0 ? "—" : low ? "мало" : pct(b.showingRate!)}</span>
                    <span className="rsp-track">
                      <span className="rsp-fill" style={{ height: `${low ? 4 : Math.max(3, ((b.showingRate ?? 0) / max) * 100)}%` }} />
                    </span>
                    <span className="rsp-lbl">{b.label}</span>
                    <span className="rsp-n">
                      {b.leads}<span className="rsp-n-label"> {pluralizeRu(b.leads, ["обращение", "обращения", "обращений"])}</span>
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="state" style={{ display: "block" }}>
              Выборка: {data.leads} {pluralizeRu(data.leads, ["обращение", "обращения", "обращений"])} покупателей, созданных за{" "}
              {data.days} дней, без самых свежих (моложе {data.matureAfterDays} дней: им ещё не успели ответить и показать).
              «Первый ответ» — первая работа агента в карточке (звонок или запись в хронологии). Ответы бота и переписка
              вне CRM сюда не попадают, поэтому «без ответа» означает «агент в карточке ничего не сделал». Корзины меньше{" "}
              {RESPONSE_SPEED_MIN_SAMPLE} обращений помечены «мало» — доли по ним не сравниваем.
              {data.excluded > 0 && ` Не вошло ${data.excluded}: агент связался раньше, чем появилась карточка.`}
              {data.truncated && " Выборка упёрлась в потолок — самые давние обращения не вошли."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
