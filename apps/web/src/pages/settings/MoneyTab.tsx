import { useState } from "react";
import { useServerSyncedFields } from "../../hooks/useServerSyncedForm";
import { RefreshCw } from "lucide-react";
import { Switch } from "../../components/Switch";
import { useSettings, useUpdateSettings, useRefreshExchangeRate } from "../../hooks/useSettings";

/** Вкладка «Деньги»: доли комиссии между агентством и агентами и курс доллара,
 *  по которому долларовые сделки сводятся в сомони.
 *
 *  Разметка — эталон темы «Royal Home 2026»
 *  (docs/pult/theme-2026/screens/settings.html, раздел «Деньги»): карточки
 *  `.card` с шапкой `.sec-h.stack`, поля `.fgrid`/`.fld`, строки-переключатели
 *  `.mod`, курс — строка `.mod` с числовым полем `.nf`. Все настройки этой
 *  вкладки сохраняются одной мутацией, поэтому кнопка «Сохранить» одна на все
 *  карточки формы — она стоит последней строкой. */

export function CommissionSection({ part }: { part?: "commission" | "operations" } = {}) {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  /**
   * ПОКА НАСТРОЙКИ НЕ ПРИШЛИ — СОХРАНЯТЬ НЕЧЕГО (аудит 22.08.2026, раунд 6).
   *
   * Все поля ниже стартуют пустой строкой и заполняются только внутри
   * `if (settings)`. Если запрос не дошёл, форма показывает пустоту и «сейчас
   * 0%», а кнопка «Сохранить» была активна — один клик отправлял `Number("")`,
   * то есть НОЛЬ, в доли комиссии, лимиты лидов, порог скоринга и сроки
   * конвейера, плюс зашитые умолчания в оба рубильника. Одним нажатием
   * переписывались денежные правила агентства.
   */
  const loaded = !!settings;
  const [realtorP, setRealtorP] = useState("");
  const [companyP, setCompanyP] = useState("");
  const [plan, setPlan] = useState("");
  const [acceptMinutes, setAcceptMinutes] = useState("");
  const [callMinutes, setCallMinutes] = useState("");
  const [callMinSeconds, setCallMinSeconds] = useState("");
  const [activeLimit, setActiveLimit] = useState("");
  const [propertyLimit, setPropertyLimit] = useState("");
  const [scoreThreshold, setScoreThreshold] = useState("");
  const [reviewDays, setReviewDays] = useState("");
  const [photoDays, setPhotoDays] = useState("");
  const [videoDays, setVideoDays] = useState("");
  const [editingDays, setEditingDays] = useState("");
  const [maxTransfers, setMaxTransfers] = useState("");
  const [reservationDays, setReservationDays] = useState("");
  const [reassignOnMissedCall, setReassignOnMissedCall] = useState(false);

  useServerSyncedFields(
    settings && {
      realtorP: String(settings.commissionRealtorPercent ?? "0.5"),
      companyP: String(settings.commissionCompanyPercent ?? "1"),
      plan: settings.monthlyCommissionPlan,
      acceptMinutes: String(settings.leadAcceptMinutes ?? 15),
      callMinutes: String(settings.leadCallMinutes ?? 15),
      callMinSeconds: String(settings.leadCallMinSeconds ?? 30),
      activeLimit: String(settings.leadActiveLimit ?? 6),
      propertyLimit: String(settings.propertyActiveLimit ?? 0),
      scoreThreshold: String(settings.hotScoreThreshold ?? 70),
      reviewDays: String(settings.propertyReviewDays ?? 1),
      photoDays: String(settings.propertyPhotoDays ?? 2),
      videoDays: String(settings.propertyVideoDays ?? 2),
      editingDays: String(settings.propertyEditingDays ?? 2),
      maxTransfers: String(settings.leadMaxTransfers ?? 3),
      reservationDays: String(settings.dealReservationBusinessDays ?? 3),
      reassignOnMissedCall: settings.leadReassignOnMissedCallEnabled ?? false,
    },
    {
      realtorP: [realtorP, setRealtorP],
      companyP: [companyP, setCompanyP],
      plan: [plan, setPlan],
      acceptMinutes: [acceptMinutes, setAcceptMinutes],
      callMinutes: [callMinutes, setCallMinutes],
      callMinSeconds: [callMinSeconds, setCallMinSeconds],
      activeLimit: [activeLimit, setActiveLimit],
      propertyLimit: [propertyLimit, setPropertyLimit],
      scoreThreshold: [scoreThreshold, setScoreThreshold],
      reviewDays: [reviewDays, setReviewDays],
      photoDays: [photoDays, setPhotoDays],
      videoDays: [videoDays, setVideoDays],
      editingDays: [editingDays, setEditingDays],
      maxTransfers: [maxTransfers, setMaxTransfers],
      reservationDays: [reservationDays, setReservationDays],
      reassignOnMissedCall: [reassignOnMissedCall, setReassignOnMissedCall],
    }
  );

  const total = (Number(realtorP) || 0) + (Number(companyP) || 0);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const commission = {
      commissionRealtorPercent: Number(realtorP),
      commissionCompanyPercent: Number(companyP),
      monthlyCommissionPlan: Number(plan),
    };
    const operations = {
      leadAcceptMinutes: Number(acceptMinutes),
      leadCallMinutes: Number(callMinutes),
      leadCallMinSeconds: Number(callMinSeconds),
      leadActiveLimit: Number(activeLimit),
      propertyActiveLimit: Number(propertyLimit),
      hotScoreThreshold: Number(scoreThreshold),
      propertyReviewDays: Number(reviewDays),
      propertyPhotoDays: Number(photoDays),
      propertyVideoDays: Number(videoDays),
      propertyEditingDays: Number(editingDays),
      leadMaxTransfers: Number(maxTransfers),
      dealReservationBusinessDays: Number(reservationDays),
      leadReassignOnMissedCallEnabled: reassignOnMissedCall,
    };
    // Separate task views must never submit hidden fields from the other task.
    await updateSettings.mutateAsync(part === "commission" ? commission : part === "operations" ? operations : { ...commission, ...operations });
  }

  const pipeline: [string, string, (v: string) => void][] = [
    ["Проверка", reviewDays, setReviewDays],
    ["Фото", photoDays, setPhotoDays],
    ["Видео", videoDays, setVideoDays],
    ["Монтаж", editingDays, setEditingDays],
  ];

  return (
    <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
      {part !== "operations" && (
      <section className="card">
        <div className="sec-h stack">
          <h2>Структура комиссии сделки</h2>
          <span className="note">Клиент платит сумму двух долей: сейчас {total}% от цены</span>
        </div>
        <p className="sub" style={{ marginBottom: "var(--s4)" }}>
          Доли фиксируются в сделке в момент закрытия: смена этих цифр не меняет уже выплаченные деньги.
        </p>
        <div className="fgrid">
          <label className="fld">
            <span className="lab">Кто продал (риелтор), %</span>
            <input type="number" step="0.1" min="0" value={realtorP} onChange={(e) => setRealtorP(e.target.value)} />
          </label>
          <label className="fld">
            <span className="lab">Компания, %</span>
            <input type="number" step="0.1" min="0" value={companyP} onChange={(e) => setCompanyP(e.target.value)} />
          </label>
          <label className="fld">
            <span className="lab">План комиссии на месяц, сомони</span>
            <input type="number" value={plan} onChange={(e) => setPlan(e.target.value)} />
            <span className="msg" style={{ color: "var(--faint)" }}>
              Только для сравнения плана и факта на главной. На доли и раздачу лидов не влияет.
            </span>
          </label>
        </div>
      </section>

      )}
      {part !== "commission" && <>
      <section className="card">
        <div className="sec-h stack">
          <h2>Сроки и лимиты по лидам</h2>
          <span className="note">Сколько ждём агента и сколько клиентов он держит одновременно</span>
        </div>
        <div className="fgrid">
          <label className="fld">
            <span className="lab">Приём лида, минут</span>
            <input
              type="number"
              min={3}
              max={1440}
              value={acceptMinutes}
              onChange={(e) => setAcceptMinutes(e.target.value)}
            />
            <span className="msg" style={{ color: "var(--faint)" }}>
              Потом лид уходит следующему агенту.
            </span>
          </label>
          <label className="fld">
            <span className="lab">Первый звонок, минут</span>
            <input
              type="number"
              min={3}
              max={1440}
              value={callMinutes}
              onChange={(e) => setCallMinutes(e.target.value)}
            />
            <span className="msg" style={{ color: "var(--faint)" }}>
              За это время после принятия агент обязан поговорить с клиентом, иначе штраф Royal Score
              (передача дальше — только если включена ниже).
            </span>
          </label>
          <label className="fld">
            <span className="lab">Разговор состоялся, секунд</span>
            <input
              type="number"
              min={0}
              max={600}
              value={callMinSeconds}
              onChange={(e) => setCallMinSeconds(e.target.value)}
            />
            <span className="msg" style={{ color: "var(--faint)" }}>
              Короче этого звонок не засчитывается: гудки и «алло, перезвоню» разговором не считаются.
              0 — засчитывать любой ответ.
            </span>
          </label>
          <label className="fld">
            <span className="lab">Лимит активных лидов</span>
            <input
              type="number"
              min={0}
              max={100}
              value={activeLimit}
              onChange={(e) => setActiveLimit(e.target.value)}
            />
            <span className="msg" style={{ color: "var(--faint)" }}>
              Предел смешанного портфеля: заполненный агент новых не получает. Лиды по его собственным
              объектам за этот предел выходят — правила во вкладке «Лиды». 0 — без лимита.
            </span>
          </label>
          <label className="fld">
            <span className="lab">Лимит активных объектов</span>
            <input
              type="number"
              min={0}
              max={100}
              value={propertyLimit}
              onChange={(e) => setPropertyLimit(e.target.value)}
            />
            <span className="msg" style={{ color: "var(--faint)" }}>
              Агент не заводит новый, пока не завершит текущие. 0 — без лимита.
            </span>
          </label>
          <label className="fld">
            <span className="lab">Порог скоринга для передачи, %</span>
            <input
              type="number"
              min={0}
              max={100}
              value={scoreThreshold}
              onChange={(e) => setScoreThreshold(e.target.value)}
            />
            <span className="msg" style={{ color: "var(--faint)" }}>
              0 выключает автопередачу. Когда разговор заканчивается отказом, ИИ оценивает клиента по всей
              истории: оценка выше порога — клиент помечается горячим и уходит агенту с лучшим KPI.
              Передаются только заполненные карточки, не больше трёх переходов на клиента.
            </span>
          </label>
          <label className="fld">
            <span className="lab">Предел передач лида</span>
            <input
              type="number"
              min={0}
              max={20}
              value={maxTransfers}
              onChange={(e) => setMaxTransfers(e.target.value)}
            />
            <span className="msg" style={{ color: "var(--faint)" }}>
              Дальше карточка становится «Потерянной»; 0 — без предела. Считаются и отказы агентов, и
              автоматические передачи горячего клиента: трое уже не смогли, четвёртому её выдавать
              бессмысленно. Руководитель по-прежнему может назначить агента вручную.
            </span>
          </label>
        </div>

        <div className="mod">
          <div className="t">
            <b>Забирать лид у агента, который не позвонил</b>
            <span>
              По умолчанию выключено (решение от 18.08.2026, чтобы принятый лид не уходил от агента без
              объяснений) — принявший, но не позвонивший вовремя агент получает штраф, а лид остаётся у него.
              Включите — и лид сразу снимается и уходит следующему по очереди агенту вместо штрафа-без-передачи.
              Щиток занятости («Лиды» → «Занятость агента в раздаче») по-прежнему не даёт новому лиду прийти
              агенту, который прямо сейчас на показе или в звонке.
            </span>
          </div>
          <div className="acts">
            <Switch
              on={reassignOnMissedCall}
              onToggle={() => setReassignOnMissedCall((v) => !v)}
              label="Забирать лид у агента, который не позвонил"
            />
          </div>
        </div>
      </section>

      {/* Сроки конвейера подготовки объекта. Стоят рядом с лидами нарочно: это
          такие же «сколько ждём, прежде чем считать просрочкой» числа, и искать их
          будут здесь же. Просрочка объект никуда не двигает — красит этап. */}
      <section className="card">
        <div className="sec-h stack">
          <h2>Сроки подготовки объекта, дни</h2>
          <span className="note">
            Просроченный этап краснеет в списке объектов — сам объект никуда не переезжает: снимать нечего,
            если собственник не открыл дверь, и автоматический перевод спрятал бы именно это
          </span>
        </div>
        <div className="fgrid">
          {pipeline.map(([label, value, set]) => (
            <label className="fld" key={label}>
              <span className="lab">{label}</span>
              <input type="number" min={1} max={30} value={value} onChange={(e) => set(e.target.value)} />
            </label>
          ))}
        </div>
      </section>

      {/* Резерв на сделке (Путь покупателя, решение владельца 30.07.2026): объект
          занят под конкретную сделку не бессрочно — если она не закрылась и не
          отменилась за отведённый срок, объект сам возвращается в продажу. */}
      <section className="card">
        <div className="sec-h stack">
          <h2>Резерв объекта на сделке</h2>
          <span className="note">
            Как только заведена сделка, объект резервируется — выходные пропускаем. Если сделка за это время
            не закрылась и не отменилась, объект автоматически возвращается в продажу
          </span>
        </div>
        <div className="mod">
          <div className="t">
            <b>Держать резерв</b>
            <span>Рабочих дней, без выходных.</span>
          </div>
          <div className="acts">
            <span className="nf">
              <input
                type="number"
                min={1}
                max={30}
                value={reservationDays}
                onChange={(e) => setReservationDays(e.target.value)}
                aria-label="Рабочих дней резерва"
              />
              <span className="u">дней</span>
            </span>
          </div>
        </div>
      </section>

      </>}
      <div className="card tight">
        <div className="wrap">
          <button className="pill ghost" type="submit" disabled={updateSettings.isPending || !loaded}>
            Сохранить
          </button>
          {updateSettings.isSuccess && <span className="saved on">Сохранено</span>}
        </div>
        {!loaded && (
          <div className="quiet crit" role="alert">
            <span className="dot crit" />
            <span className="txt">
              Настройки ещё не загрузились — значения на экране не настоящие, сохранять нельзя.
            </span>
          </div>
        )}
      </div>
    </form>
  );
}

/** Курс USD→TJS для конвертации цен объектов в долларах при публикации на сайт
 * (сайт всегда показывает только сомони). Правится вручную в любой момент; ночной
 * cron (01:00 по Душанбе) освежает его официальным курсом продажи с alif.tj. */

export function ExchangeRateSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const refreshRate = useRefreshExchangeRate();
  const [rate, setRate] = useState("");
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useServerSyncedFields(
    // The settings cache is optimistic while saving. A rollback must not
    // become a server refill that erases the user's unsaved rate.
    !updateSettings.isPending && settings ? {
      rate: settings.usdToTjsRate ?? "",
    } : undefined,
    {
      rate: [rate, setRate],
    }
  );

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    try {
      await updateSettings.mutateAsync({ usdToTjsRate: Number(rate) });
    } catch {
      // The mutation error remains visible beside this form.
    }
  }

  async function handleRefresh() {
    setRefreshError(null);
    try {
      const fresh = await refreshRate.mutateAsync();
      // Человек просил свежий курс — кладём его в поле, даже если там было
      // набрано своё (форма не перезаливает поле, которое правят, — F3).
      setRate(String(fresh.rate));
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : "Не удалось обновить курс");
    }
  }

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Курс доллара к сомони</h2>
        <span className="note">Цены публикуются в сомони, курс обновляется ночью с alif.tj</span>
      </div>
      <p className="sub" style={{ marginBottom: "var(--s3)" }}>
        Объекты с ценой в долларах публикуются на сайте в сомони по этому курсу — на сайте цены всегда
        только в TJS. Вручную поставленный курс держится до следующей ночи.
      </p>
      <form onSubmit={handleSave} className="mod">
        <div className="t">
          <b>1 доллар</b>
          <span>
            {settings?.usdToTjsRateUpdatedAt
              ? `Обновлён ${new Date(settings.usdToTjsRateUpdatedAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe" })} — ${
                  settings.usdToTjsRateSource === "alif-auto" ? "автоматически с alif.tj" : "вручную"
                }`
              : "Курс ещё ни разу не обновлялся."}
          </span>
        </div>
        <div className="acts">
          <span className="nf">
            <input
              type="number"
              step="0.0001"
              min="5"
              max="15"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              aria-label="1 доллар в сомони"
            />
            <span className="u">сомони</span>
          </span>
          <button className="pill ghost sm" type="submit" disabled={updateSettings.isPending || !rate}>
            Сохранить
          </button>
          <button className="pill ghost sm" type="button" onClick={handleRefresh} disabled={refreshRate.isPending}>
            <RefreshCw className={`i${refreshRate.isPending ? " animate-spin" : ""}`} aria-hidden="true" />
            Обновить с alif.tj
          </button>
        </div>
      </form>
      {updateSettings.isError && (
        <div className="quiet crit" role="alert">
          <span className="txt">{updateSettings.error instanceof Error ? updateSettings.error.message : "Не удалось сохранить курс"}</span>
        </div>
      )}
      {refreshError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{refreshError}</span>
        </div>
      )}
    </section>
  );
}
