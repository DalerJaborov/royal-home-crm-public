import { todayLabel, pluralizeRu } from "../../lib/format";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Users } from "lucide-react";
import { useAuthStore } from "../../store/auth";
import { useLostClients, useLostProperties, type SecurityClientRow } from "../../hooks/useSecurity";
import { HomeAppHeader, HomePageHead } from "./HomeHead";
import { exactDateTime } from "../../lib/format";
import { REFUSAL_REASON_LABELS, type ClientKind } from "@royal-home/shared";

/**
 * Мобильная Главная — служба безопасности. Разметка перенесена дословно из
 * прототипа темы «Royal Home 2026» (`docs/pult/theme-2026/screens/home-security.html`):
 * `.scr` → `section.card.aib` (строка «что делаю сейчас», приветствие,
 * «Горит сейчас» с самой старой карточкой) → `.sec-t` + `.tiles` → `.card.tight`
 * с `.sec-h` и списком `.list`/`.row`.
 *
 * Данные и права не менялись: те же `useLostClients`/`useLostProperties` с
 * verdict="PENDING", тот же запрос, что открывает вкладки «Клиенты в СБ» /
 * «Потерянные объекты» на десктопе (SecurityCenter.tsx). Кнопки звонка здесь
 * по-прежнему нет вовсе: у пресета SECURITY нет ни calls.transcripts, ни
 * clients.viewPhone.
 *
 * Шапка `MobileHomeHeader` (поиск, звонки, уведомления, тема) остаётся выше
 * области `.rh2` — это рамка приложения (договор §4), а не содержимое экрана,
 * поэтому `.pg-h` из эталона здесь не повторяется: приветствие и дата уже в ней.
 */
export function SecurityHome() {
  const agent = useAuthStore((s) => s.agent);
  const navigate = useNavigate();
  const firstName = agent?.fullName?.split(" ")[0] ?? "";
  const [expanded, setExpanded] = useState(false);

  const clientsQuery = useLostClients(1, "PENDING", undefined, true);
  const propertiesQuery = useLostProperties(1, "PENDING", undefined, true);

  const isLoading = clientsQuery.isLoading || propertiesQuery.isLoading;
  // Хватает отказа ОДНОГО из двух списков: очередь ниже — их объединение, и без
  // одной половины она уже не «вся очередь», а обрезанная.
  const isError = clientsQuery.isError || propertiesQuery.isError;
  const queueError = clientsQuery.error ?? propertiesQuery.error;

  const queue = useMemo(() => {
    const clients = clientsQuery.data?.items ?? [];
    const properties = propertiesQuery.data?.items ?? [];
    return [...clients, ...properties].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, [clientsQuery.data, propertiesQuery.data]);

  const [focus, ...rest] = queue;
  // Счётчики плиток — «нет данных», а не 0, пока сервер не ответил: жирный ноль
  // в журнале СБ читается как «проверять нечего», хотя это отказ запроса.
  const clientsTotal = clientsQuery.data?.total;
  const propertiesTotal = propertiesQuery.data?.total;
  const visibleRest = expanded ? rest : rest.slice(0, 5);

  return (
    <>
      <HomeAppHeader firstName={firstName} />
      <div className="rh2 screens">
        <div className="scr" data-stagger>
          <HomePageHead title="Проверки" sub={`${agent?.fullName ?? ""}, служба безопасности. ${todayLabel()}.${clientsTotal !== undefined && propertiesTotal !== undefined ? ` На проверке ${clientsTotal + propertiesTotal} ${pluralizeRu(clientsTotal + propertiesTotal, ["закрытие", "закрытия", "закрытий"])}.` : ""}`} />
          <section className="card aib" aria-labelledby="aib-hi">
            <div className="aib-now">
              <i aria-hidden="true" />
              <span className="tx">слежу за очередью проверки клиентов и объектов</span>
            </div>
            <div className="aib-hd">
              <h2 className="aib-hi" id="aib-hi">
                Салом{firstName ? `, ${firstName}` : ""}. Сначала это:
              </h2>
            </div>

            <div className="aib-fire">
              <div className="aib-fh">
                <h3>Горит сейчас</h3>
                <span className="note">карточка ждёт проверки дольше всех</span>
              </div>
              {isLoading ? (
                <div className="state">
                  <span className="sk w40" /> Загружаем очередь проверки
                </div>
              ) : isError ? (
                /* «Очередь проверки пуста» при отказе запроса — прямая дезинформация
                   журнала подотчётности: СБ решит, что проверять сегодня нечего, хотя
                   карточки в очереди стоят и просто не доехали до экрана. */
                <div className="state err">
                  <span className="dot crit" />
                  {queueError instanceof Error ? queueError.message : "Очередь не загрузилась, проверьте соединение."}
                  <button
                    type="button"
                    className="lnk"
                    onClick={() => {
                      clientsQuery.refetch();
                      propertiesQuery.refetch();
                    }}
                  >
                    Повторить
                  </button>
                </div>
              ) : focus ? (
                <div className="list">
                  <div className="row wrapt">
                    <span className="av" style={{ background: "var(--pink)", color: "var(--pink-ink)" }} aria-hidden="true">
                      {focus.fullName?.[0]?.toUpperCase() ?? "?"}
                    </span>
                    <div className="t">
                      <b>{focus.fullName}</b>
                      <span>
                        {KIND_LABELS[focus.kind]}
                        {focus.refusalReason ? `, ${REFUSAL_REASON_LABELS[focus.refusalReason]}` : ""}
                        {focus.responsibleAgent?.fullName ? `, вёл агент ${focus.responsibleAgent.fullName}` : ", агент не указан"}
                      </span>
                    </div>
                    <div className="act">
                      <button
                        className="pill sm"
                        type="button"
                        data-endpoint="GET /api/v1/clients"
                        onClick={() => navigate(`/clients/${focus.shortId}`)}
                      >
                        Открыть
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="quiet">
                  <span className="dot ok" />
                  <span className="txt">Очередь проверки пуста. Новые карточки появятся здесь сами.</span>
                </p>
              )}
            </div>

            {/* Доклад одной фразой: только счётчики очереди, оценки риска сервер не считает. */}
            {clientsTotal !== undefined && propertiesTotal !== undefined && (
              <p className="aib-rep">
                На проверке{" "}
                <button className="lk" type="button" onClick={() => navigate("/security")}>
                  {clientsTotal + propertiesTotal} {pluralizeRu(clientsTotal + propertiesTotal, ["закрытие", "закрытия", "закрытий"])}
                </button>
                : {clientsTotal} по клиентам, {propertiesTotal} по объектам. Оценку риска и серии потерь CRM пока не
                считает, поэтому читать разумнее сначала свежие.
              </p>
            )}
          </section>

          <div className="sec-t">Показатели</div>
          <div className="tiles">
            <button type="button" className="tile" onClick={() => navigate("/security")}>
              <div className="hd">
                <span className="ic" aria-hidden="true">
                  <Users className="i" strokeWidth={1.5} />
                </span>
                Клиенты на проверке
              </div>
              <b>{clientsTotal ?? "нет данных"}</b>
              <small>ждут решения СБ</small>
            </button>
            <button type="button" className="tile" onClick={() => navigate("/security")}>
              <div className="hd">
                <span className="ic" aria-hidden="true">
                  <Building2 className="i" strokeWidth={1.5} />
                </span>
                Объекты на проверке
              </div>
              <b>{propertiesTotal ?? "нет данных"}</b>
              <small>сняты с продажи без сделки</small>
            </button>
          </div>

          {rest.length > 0 && (
            <div className="card tight">
              <div className="sec-h">
                <h2>Далее в очереди</h2>
                <span className="note">{rest.length}, сначала самые старые</span>
              </div>
              <div className="list">
                {visibleRest.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className="row"
                    onClick={() => navigate(`/clients/${row.shortId}`)}
                  >
                    <span className="av" aria-hidden="true">
                      {row.kind === "SELLER" ? <Building2 className="i" /> : <Users className="i" />}
                    </span>
                    <div className="t">
                      <b>{row.fullName}</b>
                      <span>
                        {KIND_LABELS[row.kind]}
                        {row.refusalReason ? `, ${REFUSAL_REASON_LABELS[row.refusalReason]}` : ""}
                      </span>
                    </div>
                    <span className="meta">{exactDateTime(row.createdAt)}</span>
                  </button>
                ))}
              </div>
              {!expanded && rest.length > visibleRest.length && (
                <button type="button" className="lnk" onClick={() => setExpanded(true)}>
                  Показать ещё ({rest.length - visibleRest.length})
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const KIND_LABELS: Record<ClientKind, string> = {
  BUYER: "Покупатель",
  SELLER: "Продавец",
  OTHER: "Прочее",
};
