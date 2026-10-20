import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "../../lib/api";
import { formatPropertyCode } from "../../lib/clientFormat";
import { useSearchOverview } from "../../hooks/useMarketing";
import { ErrorLine, PeriodTabs, QueryList, ReturnBanner, SearchTiles, dmy, num, place } from "./searchBits";
import { YandexSearchPanel } from "./YandexSearchPanel";

/**
 * «МАРКЕТИНГ → САЙТ И ПОИСК» (24.09.2026, Dan: «seo сайта, что лучше позиция в
 * поиске, полный контроль — в другую вкладку»). Два поисковика переключателем:
 * Google Search Console (сервер — lib/searchConsole.ts) и Яндекс Вебмастер
 * (lib/yandexWebmaster.ts, YandexSearchPanel): сколько людей пришло из поиска,
 * по каким запросам, на каком месте сайт и какие страницы находят.
 *
 * Подключение — одна кнопка: вход своим аккаунтом в своём браузере, CRM сама
 * находит сайт. Вернувшись, поисковик приводит сюда с `?sc=ok` или
 * `?sc=error&reason=…` (и `engine=yandex` у Яндекса) — итог показываем словами.
 */

type Engine = "google" | "yandex";

export interface SearchReturnStatus {
  sc: string | null;
  reason: string | null;
  engine: string | null;
}

const GOOGLE_REASONS: Record<string, string> = {
  cancelled: "Вход в Google отменён.",
  state: "Ссылка входа устарела — нажмите «Подключить Google» ещё раз.",
  "not-configured": "Не внесено Google-приложение (Client ID и Client secret) — Настройки → Каналы связи → YouTube.",
  "no-site": "У этого аккаунта Google нет сайта royalhome.tj в Search Console. Войдите тем аккаунтом, где сайт добавлен.",
};

export function SearchPanel({ returnStatus }: { returnStatus: SearchReturnStatus }) {
  const [engine, setEngine] = useState<Engine>(returnStatus.engine === "yandex" ? "yandex" : "google");
  const mine = (e: Engine) => ((returnStatus.engine === "yandex" ? "yandex" : "google") === e ? returnStatus : { sc: null, reason: null });

  return (
    <>
      <div className="hscroll">
        <div className="seg" role="tablist" aria-label="Поисковик">
          <button type="button" role="tab" aria-selected={engine === "google"} onClick={() => setEngine("google")}>
            Google
          </button>
          <button type="button" role="tab" aria-selected={engine === "yandex"} onClick={() => setEngine("yandex")}>
            Яндекс
          </button>
        </div>
      </div>
      {engine === "google" ? <GoogleSearchPanel returnStatus={mine("google")} /> : <YandexSearchPanel returnStatus={mine("yandex")} />}
    </>
  );
}

function GoogleSearchPanel({ returnStatus }: { returnStatus: { sc: string | null; reason: string | null } }) {
  const [days, setDays] = useState<number>(28);
  const q = useSearchOverview(days);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>("/search-console/oauth/start");
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось, попробуйте ещё раз");
      setBusy(false);
    }
  }

  async function disconnect() {
    setError(null);
    setBusy(true);
    try {
      await api("/search-console/disconnect", { method: "POST" });
      await qc.invalidateQueries({ queryKey: ["marketing", "search-overview"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось, попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  }

  const banner = <ReturnBanner status={returnStatus} okText="Search Console подключён." reasons={GOOGLE_REASONS} />;

  if (q.isLoading || !q.data) {
    return (
      <section className="card">
        {q.error ? (
          <div className="state">Не удалось загрузить: {q.error instanceof Error ? q.error.message : "ошибка"}</div>
        ) : (
          <div className="state">
            <span className="sk w40" /> Спрашиваем Google — первый раз до полуминуты
          </div>
        )}
      </section>
    );
  }

  const data = q.data;

  if (!data.connected) {
    return (
      <section className="card search-connect">
        {banner}
        <div className="sec-h stack">
          <h2>Сайт в поиске Google</h2>
        </div>
        <p>
          Подключите Search Console — и здесь появится: сколько людей пришло на royalhome.tj из поиска, что они искали, на каком
          месте сайт и какие объекты находят чаще всего.
        </p>
        {data.appConfigured ? (
          <div className="acts">
            <button className="pill" type="button" onClick={() => void connect()} disabled={busy}>
              <Search className="i" aria-hidden /> {busy ? "Открываем Google…" : "Подключить Google"}
            </button>
          </div>
        ) : (
          <p className="quiet">
            Сначала нужно Google-приложение — то же, что для YouTube: Настройки → Каналы связи → YouTube, поля Client ID и Client
            secret.
          </p>
        )}
        {error && <p className="crit">{error}</p>}
        <details className="quiet">
          <summary>Для настройки Google Cloud</summary>
          <p>
            В проекте Google Cloud включите «Google Search Console API», а в Google-приложении (OAuth client) добавьте адрес
            возврата: <code>{data.redirectUri}</code>
          </p>
        </details>
      </section>
    );
  }

  return (
    <>
      {banner}
      <PeriodTabs days={days} onChange={setDays} />

      {data.error && <ErrorLine text={data.error} />}

      <SearchTiles totals={data.totals} previous={data.previous} engine="Google" />

      <section className="card">
        <div className="sec-h stack">
          <h2>Почти в топе</h2>
          <span className="note">сайт на 4–20 месте, а ищут часто — подтянуть их выше дешевле всего</span>
        </div>
        <QueryList rows={data.nearTop} empty="Таких запросов пока нет." />
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Что ищут</h2>
          <span className="note">запросы, по которым приходят на сайт</span>
        </div>
        <QueryList rows={data.queries} empty="За этот период запросов нет." />
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Какие страницы находят</h2>
        </div>
        {data.pages.length === 0 ? (
          <div className="empty">
            <p>За этот период страниц нет.</p>
          </div>
        ) : (
          <div className="list">
            {data.pages.map((r) => (
              <div className="row" key={r.page}>
                <div className="t">
                  <b>
                    {r.property ? (
                      <Link className="lk" to={`/properties/${r.property.shortId}?tab=stats`}>
                        {formatPropertyCode(r.property.shortId)} · {r.property.title}
                      </Link>
                    ) : (
                      <a className="lk" href={r.page} target="_blank" rel="noreferrer">
                        {r.path}
                      </a>
                    )}
                  </b>
                  <span>
                    {num(r.clicks)} кликов · {num(r.impressions)} показов
                  </span>
                </div>
                <span className="quiet">{place(r.position)} место</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="state">
        Данные Google приходят с задержкой в 2–3 дня: {dmy(data.start)} – {dmy(data.end)}.{" "}
        <button className="pill ghost sm" type="button" onClick={() => void disconnect()} disabled={busy}>
          Отключить Google
        </button>
      </p>
      {error && <p className="crit">{error}</p>}
    </>
  );
}
