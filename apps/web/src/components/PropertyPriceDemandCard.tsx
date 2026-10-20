import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Flame, Info, Snowflake, Thermometer } from "lucide-react";
import {
  pluralizeRu,
  type PriceAdviceResponse,
  type PriceAdviceVerdict,
  type PriceWaitlistResponse,
  type PropertyHeatLabel,
} from "@royal-home/shared";
import { api } from "../lib/api";
import { formatMoney } from "../lib/format";

/**
 * БЛОК «ЦЕНА И СПРОС» КАРТОЧКИ ОБЪЕКТА (03.10.2026).
 *
 * Агент идёт к собственнику не с «давайте снизим», а с цифрами: лестница «цена → сколько клиентов подходит»,
 * совет по данным (без обещаний), готовый текст для разговора и температура объекта. Один адаптивный компонент на
 * телефон и компьютер (правило CLAUDE.md): узкий вид делают медиа-правила темы (`.ppd-*` и общие `.pvc-*`
 * в theme-2026-dashboard.css).
 *
 * Сам ничего не считает: совет, температура И лестница приходят ОДНИМ запросом GET /properties/:id/price-advice
 * (lib/priceAdvice.ts, lib/propertyHeat.ts; лист ожидания — lib/priceWaitlist.ts — сервер считает один раз).
 * Отдельный GET /properties/:id/price-waitlist зовётся только запасным путём: совет не посчитался, а лестница
 * исправна — тогда её показываем отдельно, не пряча за общей ошибкой. В числах нет имён и телефонов;
 * «ваши клиенты» приходят от сервера уже по правам (агент — только свои). Деньги компании сюда не попадают:
 * ни расход на рекламу, ни цены сделок.
 */

const HEAT_ICON: Record<PropertyHeatLabel, typeof Flame> = { cold: Snowflake, warm: Thermometer, hot: Flame };

const VERDICT_VIEW: Record<PriceAdviceVerdict, { tone: "info" | "warn"; word: string; Icon: typeof Info }> = {
  hold: { tone: "info", word: "Держать цену", Icon: Check },
  consider_drop: { tone: "warn", word: "Обсудить цену", Icon: AlertTriangle },
  insufficient_data: { tone: "info", word: "Данных мало", Icon: Info },
};

const num = (n: number) => n.toLocaleString("ru-RU");
const clientsWord = (n: number) => pluralizeRu(n, ["клиент", "клиента", "клиентов"]);

/** Запасной путь: лестница отдельно от совета — только когда совет не посчитался (иначе она приходит внутри совета). */
export function usePriceWaitlistFallback(propertyId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["property-price-waitlist", propertyId],
    queryFn: () => api<PriceWaitlistResponse>(`/properties/${propertyId}/price-waitlist`),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function usePriceAdvice(propertyId: string) {
  return useQuery({
    queryKey: ["property-price-advice", propertyId],
    queryFn: () => api<PriceAdviceResponse>(`/properties/${propertyId}/price-advice`),
    staleTime: 5 * 60_000,
  });
}

export function PropertyPriceDemandCard({ propertyId }: { propertyId: string }) {
  const advice = usePriceAdvice(propertyId);
  const fallback = usePriceWaitlistFallback(propertyId, advice.isError);

  if (advice.isLoading || (advice.isError && fallback.isLoading)) {
    return (
      <section className="card" aria-busy="true" aria-labelledby="ppd-h">
        <div className="sec-h stack">
          <h2 id="ppd-h">Цена и спрос</h2>
        </div>
        <div className="state">
          <span className="sk w40" /> Считаем, кому подходит цена
        </div>
      </section>
    );
  }

  // Совет не посчитался: лестница, если она исправна, всё равно показывается — отдельно, с понятной оговоркой.
  if (!advice.data) {
    const wl = fallback.data;
    return (
      <section className="card ppd" aria-labelledby="ppd-h">
        <div className="sec-h stack">
          <h2 id="ppd-h">Цена и спрос</h2>
        </div>
        <p className="state" role="alert">
          {wl ? "Совет по цене сейчас посчитать не получилось, лестница ниже посчитана." : "Цену и спрос сейчас посчитать не получилось."}{" "}
          <button
            type="button"
            className="pill ghost"
            onClick={() => {
              void advice.refetch();
              void fallback.refetch();
            }}
          >
            Повторить
          </button>
        </p>
        {wl && (
          <>
            <Ladder wl={wl} />
            <OwnClients wl={wl} />
          </>
        )}
      </section>
    );
  }

  const wl = advice.data.waitlist;
  const { advice: adv, heat } = advice.data;
  const verdict = VERDICT_VIEW[adv.verdict];
  const HeatIcon = HEAT_ICON[heat.label];

  return (
    <section className="card ppd" aria-labelledby="ppd-h">
      <div className="sec-h stack">
        <h2 id="ppd-h">Цена и спрос</h2>
        <span className="note">по ждущим покупателям базы, без обещаний результата</span>
      </div>

      <div className="ppd-head">
        <span className={`ppd-heat ${heat.label}`}>
          <HeatIcon className="i" aria-hidden />
          <span>
            Объект <b>{heat.word}</b>
          </span>
          <span className="ppd-score" aria-label={`температура ${heat.score} из 100`}>
            {heat.score}/100
          </span>
        </span>
      </div>
      {/* Из чего сложилась температура — текстом: в подсказке `title` на телефоне её не видно. */}
      {heat.reasons.length > 0 && <p className="quiet">{heat.reasons.join(". ")}</p>}

      <div className={`pvc-d ${verdict.tone}`}>
        <div className="pvc-d-head">
          <span className="pvc-sev">
            <verdict.Icon className="i" aria-hidden /> {verdict.word}
            {adv.suggestedDropPct != null ? `: до −${adv.suggestedDropPct}%` : ""}
          </span>
        </div>
        <p>{adv.text}</p>
        {adv.evidence.length > 0 && (
          <details className="pvc-ev">
            <summary>Цифры, на которых это основано</summary>
            <ul>
              {adv.evidence.map((e, i) => (
                <li key={`${i}-${e}`}>{e}</li>
              ))}
            </ul>
          </details>
        )}
        {adv.ownerArgument && <CopyArgument text={adv.ownerArgument} />}
      </div>

      {wl && (
        <>
          <Ladder wl={wl} />
          <OwnClients wl={wl} />
        </>
      )}
    </section>
  );
}

function Ladder({ wl }: { wl: PriceWaitlistResponse }) {
  const max = Math.max(1, ...wl.steps.map((s) => s.total), wl.fitNow);
  const pct = (n: number) => Math.round((n / max) * 100);
  return (
    <>
      <h3 className="sec-t">Лестница «цена → сколько ждущих покупателей подходит по анкете и бюджету»</h3>
      {!wl.enoughData && (
        <p className="quiet" role="status">
          Мало данных: покупателей, подходящих объекту по всему, кроме цены, и с указанным бюджетом — {wl.sample}. Для опоры нужно хотя бы три.
        </p>
      )}
      {wl.sample === 0 && wl.noBudget === 0 ? (
        <div className="empty">
          <p>Ждущих покупателей под этот объект в базе нет.</p>
          <p className="sub">Подбор смотрит район, тип, комнаты, площадь и этаж; цена — отдельно.</p>
        </div>
      ) : (
        <ol className="pvc-funnel" aria-label="Сколько клиентов подходит при каждой цене">
          <li>
            <div className="pvc-f-top">
              <b>Сейчас · {formatMoney(wl.price, wl.currency)}</b>
              <span>
                <b className="n">{num(wl.fitNow)}</b> {clientsWord(wl.fitNow)}
              </span>
            </div>
            <span className="pvc-bar" aria-hidden>
              <span style={{ width: `${pct(wl.fitNow)}%` }} />
            </span>
          </li>
          {wl.steps.map((s) => (
            <li key={s.dropPct}>
              <div className="pvc-f-top">
                <b>
                  −{s.dropPct}% · до {formatMoney(s.price, wl.currency)}
                </b>
                <span>
                  <b className="n">{num(s.total)}</b> {clientsWord(s.total)}
                  {s.additional > 0 && <span className="ppd-plus"> (+{num(s.additional)})</span>}
                </span>
              </div>
              <span className="pvc-bar" aria-hidden>
                <span style={{ width: `${pct(s.total)}%` }} />
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="pvc-facts">
        {wl.beyondLadder > 0 && (
          <span>
            Не дотянутся и при −15%: <b>{num(wl.beyondLadder)}</b>
          </span>
        )}
        {wl.noBudget > 0 && (
          <span>
            Бюджет не указан: <b>{num(wl.noBudget)}</b>
          </span>
        )}
        {wl.truncated && <span>Покупателей больше, чем мы смотрим за раз: числа занижены.</span>}
      </div>
    </>
  );
}

function OwnClients({ wl }: { wl: PriceWaitlistResponse }) {
  const waiting = wl.visibleClients.filter((c) => c.fitsAtDropPct > 0).slice(0, 5);
  if (waiting.length === 0) return null;
  return (
    <>
      <h3 className="sec-t">{wl.visibleScope === "own" ? "Ваши клиенты, которым мешает цена" : "Клиенты, которым мешает цена"}</h3>
      <ul className="ppd-clients">
        {waiting.map((c) => (
          <li key={c.id}>
            <Link className="lk" to={`/clients/${c.shortId}`}>
              {c.fullName}
            </Link>
            <span>
              подойдёт при −{c.fitsAtDropPct}%
              {c.budgetMax != null && c.budgetCurrency ? ` · бюджет до ${formatMoney(c.budgetMax, c.budgetCurrency)}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** «Скопировать аргумент для владельца»: если буфер недоступен, текст показывается для ручного копирования. */
function CopyArgument({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | undefined>(undefined);
  // Таймеры гасятся при закрытии карточки: иначе setState прилетит в уже снятый компонент.
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      timer.current = window.setTimeout(() => setState("idle"), 3000);
    } catch {
      setState("manual");
      timer.current = window.setTimeout(() => area.current?.select(), 0);
    }
  }
  return (
    <div className="ppd-copy">
      <button type="button" className="pill ghost" onClick={() => void copy()}>
        <Copy className="i" aria-hidden /> Скопировать аргумент для владельца
      </button>
      <span className="ppd-copied" role="status" aria-live="polite">
        {state === "copied" ? "Скопировано" : ""}
      </span>
      {state === "manual" && (
        <textarea ref={area} className="ppd-manual" readOnly rows={4} value={text} aria-label="Текст для владельца — скопируйте вручную" />
      )}
    </div>
  );
}
