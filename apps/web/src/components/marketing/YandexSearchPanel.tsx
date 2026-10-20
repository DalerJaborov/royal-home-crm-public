import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "../../lib/api";
import { useYandexOverview } from "../../hooks/useMarketing";
import { ErrorLine, PeriodTabs, QueryList, ReturnBanner, SearchTiles, dmy, num } from "./searchBits";

/**
 * «САЙТ И ПОИСК» → ЯНДЕКС (24.09.2026). Яндекс Вебмастер о royalhome.tj:
 * те же плитки и запросы, что у Google, плюс ИКС и страницы в поиске.
 * Сервер — lib/yandexWebmaster.ts. Своё приложение Яндекса: ID и пароль
 * вносятся прямо здесь, дальше — кнопка «Подключить Яндекс».
 */

const YANDEX_REASONS: Record<string, string> = {
  cancelled: "Вход в Яндекс отменён.",
  state: "Ссылка входа устарела — нажмите «Подключить Яндекс» ещё раз.",
  "not-configured": "Не внесены ID и пароль приложения Яндекса.",
  "no-site": "У этого аккаунта Яндекса нет подтверждённого сайта royalhome.tj в Вебмастере. Войдите тем аккаунтом, где сайт добавлен.",
};

export function YandexSearchPanel({ returnStatus }: { returnStatus: { sc: string | null; reason: string | null } }) {
  const [days, setDays] = useState<number>(28);
  const q = useYandexOverview(days);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [editApp, setEditApp] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["marketing", "yandex-overview"] });

  async function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось, попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  }

  function saveApp(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api("/search-console/yandex/app", { method: "PUT", body: { clientId, clientSecret } });
      setClientSecret("");
      setEditApp(false);
      await refresh();
    });
  }

  function connect() {
    void run(async () => {
      const { url } = await api<{ url: string }>("/search-console/yandex/oauth/start");
      window.location.assign(url);
    });
  }

  const banner = <ReturnBanner status={returnStatus} okText="Яндекс Вебмастер подключён." reasons={YANDEX_REASONS} />;

  if (q.isLoading || !q.data) {
    return (
      <section className="card">
        {q.error ? (
          <div className="state">Не удалось загрузить: {q.error instanceof Error ? q.error.message : "ошибка"}</div>
        ) : (
          <div className="state">
            <span className="sk w40" /> Спрашиваем Яндекс
          </div>
        )}
      </section>
    );
  }

  const data = q.data;

  if (!data.connected) {
    const showForm = !data.appConfigured || editApp;
    return (
      <section className="card search-connect">
        {banner}
        <div className="sec-h stack">
          <h2>Сайт в поиске Яндекса</h2>
        </div>
        <p>
          Подключите Яндекс Вебмастер — и здесь появится: сколько людей пришло на royalhome.tj из Яндекса, что они искали, на
          каком месте сайт, его ИКС и сколько страниц в поиске.
        </p>
        {showForm ? (
          <form className="acts" onSubmit={saveApp}>
            <label className="fld">
              <span className="lab">ID приложения Яндекса (ClientID)</span>
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" required />
            </label>
            <label className="fld">
              <span className="lab">Пароль приложения (Client secret)</span>
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
            <button className="pill" type="submit" disabled={busy || !clientId.trim() || !clientSecret.trim()}>
              {busy ? "Сохраняем…" : "Сохранить"}
            </button>
          </form>
        ) : (
          <div className="acts">
            <button className="pill" type="button" onClick={connect} disabled={busy}>
              <Search className="i" aria-hidden /> {busy ? "Открываем Яндекс…" : "Подключить Яндекс"}
            </button>
            <button className="pill ghost sm" type="button" onClick={() => setEditApp(true)} disabled={busy}>
              Другое приложение
            </button>
          </div>
        )}
        {error && <p className="crit">{error}</p>}
        <details className="quiet">
          <summary>Как создать приложение Яндекса</summary>
          <p>
            На oauth.yandex.ru → «Создать приложение»: платформа «Веб-сервисы», адрес возврата <code>{data.redirectUri}</code>,
            доступ «Яндекс.Вебмастер: получение информации о сайтах». Затем впишите сюда его ClientID и Client secret.
          </p>
        </details>
      </section>
    );
  }

  const s = data.summary;

  return (
    <>
      {banner}
      <PeriodTabs days={days} onChange={setDays} />

      {data.error && <ErrorLine text={data.error} />}

      <SearchTiles totals={data.totals} previous={data.previous} engine="Яндексе" />

      {s && (
        <section className="card">
          <div className="sec-h stack">
            <h2>Сайт в Яндексе</h2>
          </div>
          <div className="list">
            <div className="row">
              <div className="t">
                <b>ИКС — качество сайта у Яндекса</b>
              </div>
              <span className="quiet">{s.sqi == null ? "—" : num(s.sqi)}</span>
            </div>
            <div className="row">
              <div className="t">
                <b>Страниц в поиске</b>
                {s.excludedPages ? <span>исключено из поиска: {num(s.excludedPages)}</span> : null}
              </div>
              <span className="quiet">{s.searchablePages == null ? "—" : num(s.searchablePages)}</span>
            </div>
            <div className="row">
              <div className="t">
                <b>Проблемы сайта</b>
                <span>{s.problems > 0 ? "подробности — в Яндекс Вебмастере, раздел «Диагностика»" : "Вебмастер проблем не видит"}</span>
              </div>
              <span className={s.problems > 0 ? "chip crit" : "chip ok"}>{s.problems}</span>
            </div>
          </div>
        </section>
      )}

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
          <span className="note">запросы, по которым сайт показывается в Яндексе</span>
        </div>
        <QueryList rows={data.queries} empty="За этот период запросов нет." />
      </section>

      <p className="state">
        {dmy(data.start)} – {dmy(data.end)}, данные Яндекса приходят с задержкой в несколько дней.{" "}
        <button
          className="pill ghost sm"
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api("/search-console/yandex/disconnect", { method: "POST" });
              await refresh();
            })
          }
        >
          Отключить Яндекс
        </button>
      </p>
      {error && <p className="crit">{error}</p>}
    </>
  );
}
