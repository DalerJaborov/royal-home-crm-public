import { useState } from "react";
import { useServerSyncedFields } from "../../hooks/useServerSyncedForm";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { SwitchRow } from "../../components/Switch";
import { NumberRow, SaveRow } from "../../components/settings/SettingsRows";
import { Link } from "react-router-dom";
import { ownPropertyThresholdNote } from "../../lib/settingsDependencies";

/**
 * Вкладка «Подбор объектов» — единая политика «клиент ↔ объект»
 * (docs/match-policy-plan-17-09.md, §3), собрана по просьбе владельца 17.09.2026:
 * «все эти логики вывести в Настройки гармонично с другими».
 *
 * Идиома — дословно `LeadsTab.tsx`: тумблеры (`SwitchRow`) сохраняются сразу,
 * числа — по кнопке «Сохранить» (`NumberRow` + `SaveRow`, общие с «Лидами»,
 * см. `components/settings/SettingsRows.tsx`).
 *
 * Секция «Веса шкалы совпадения» перенесена сюда из «Лидов» без изменения
 * поведения (тот же `matchScore*`, тот же `handleSaveWeights`) — порог «свой
 * объект» остаётся в «Лидах», это про раздачу лидов, а не про подбор.
 */
export function MatchingTab() {
  const { data: settings, isError, error, refetch } = useSettings();
  const updateSettings = useUpdateSettings();

  const [ttlDays, setTtlDays] = useState("");
  const [priceDropPct, setPriceDropPct] = useState("");
  const [savedAutoMatch, setSavedAutoMatch] = useState(false);

  const [budgetTolerance, setBudgetTolerance] = useState("");
  const [areaTolerance, setAreaTolerance] = useState("");
  const [roomsTolerance, setRoomsTolerance] = useState("");
  const [savedTolerances, setSavedTolerances] = useState(false);

  const [defaultRadius, setDefaultRadius] = useState("");
  const [radiusMaxMultiplier, setRadiusMaxMultiplier] = useState("");
  const [minCandidates, setMinCandidates] = useState("");
  const [savedRadius, setSavedRadius] = useState(false);

  // Веса шкалы совпадения «клиент ↔ объект» (Путь покупателя, п.5.1) — перенесено
  // из LeadsTab.tsx 17.09.2026 без изменения поведения: та же шкала используется
  // и в обычном подборе с карточки клиента, и в решении «свой объект» («Лиды»).
  const [scoreBase, setScoreBase] = useState("");
  const [scoreDistrict, setScoreDistrict] = useState("");
  const [scoreRooms, setScoreRooms] = useState("");
  const [scoreBudget, setScoreBudget] = useState("");
  const [scoreHotBonus, setScoreHotBonus] = useState("");
  const [scoreDistance, setScoreDistance] = useState("");
  const [savedWeights, setSavedWeights] = useState(false);

  useServerSyncedFields(
    settings && {
      ttlDays: String(settings.matchRequirementTtlDays ?? 60),
      priceDropPct: String(settings.matchPriceDropRenotifyPct ?? 5),
      budgetTolerance: String(settings.matchBudgetTolerancePct ?? 10),
      areaTolerance: String(settings.matchAreaTolerancePct ?? 10),
      roomsTolerance: String(settings.matchRoomsTolerance ?? 1),
      defaultRadius: String(settings.matchDefaultRadiusM ?? 1500),
      radiusMaxMultiplier: String(settings.matchRadiusMaxMultiplier ?? 3),
      minCandidates: String(settings.matchMinCandidates ?? 3),
      scoreBase: String(settings.matchScoreBase ?? 40),
      scoreDistrict: String(settings.matchScoreDistrict ?? 25),
      scoreRooms: String(settings.matchScoreRooms ?? 20),
      scoreBudget: String(settings.matchScoreBudget ?? 15),
      scoreHotBonus: String(settings.matchScoreHotBonus ?? 10),
      scoreDistance: String(settings.matchScoreDistance ?? 25),
    },
    {
      ttlDays: [ttlDays, setTtlDays],
      priceDropPct: [priceDropPct, setPriceDropPct],
      budgetTolerance: [budgetTolerance, setBudgetTolerance],
      areaTolerance: [areaTolerance, setAreaTolerance],
      roomsTolerance: [roomsTolerance, setRoomsTolerance],
      defaultRadius: [defaultRadius, setDefaultRadius],
      radiusMaxMultiplier: [radiusMaxMultiplier, setRadiusMaxMultiplier],
      minCandidates: [minCandidates, setMinCandidates],
      scoreBase: [scoreBase, setScoreBase],
      scoreDistrict: [scoreDistrict, setScoreDistrict],
      scoreRooms: [scoreRooms, setScoreRooms],
      scoreBudget: [scoreBudget, setScoreBudget],
      scoreHotBonus: [scoreHotBonus, setScoreHotBonus],
      scoreDistance: [scoreDistance, setScoreDistance],
    }, settings
  );

  /** Пустой экран вместо объяснения (правило вкладки «Лиды», аудит 22.08.2026,
   *  раунд 6): при отказе запроса вкладка не должна рисовать ровно ничего. */
  if (!settings) {
    return (
      <div className="card tight">
        {isError ? (
          <div className="state err">
            <span className="dot crit" />
            {error instanceof Error ? error.message : "Не удалось загрузить настройки подбора"}{" "}
            <button
              className="lk"
              type="button"
              style={{ color: "inherit", textDecoration: "underline" }}
              onClick={() => refetch()}
            >
              Повторить
            </button>
          </div>
        ) : (
          <div className="state">
            <span className="sk w40" />
            <span className="sk w22" /> Загружаем настройки
          </div>
        )}
      </div>
    );
  }

  const autoMatchOn = settings.autoMatchEnabled;
  const includeInactiveOn = settings.matchIncludeInactive;
  const includeDeferredOn = settings.matchIncludeDeferred;
  const notifyOwnerOn = settings.matchNotifyPropertyOwner;

  async function handleSaveAutoMatch(e: React.FormEvent) {
    e.preventDefault();
    setSavedAutoMatch(false);
    await updateSettings.mutateAsync({
      matchRequirementTtlDays: Number(ttlDays),
      matchPriceDropRenotifyPct: Number(priceDropPct),
    });
    setSavedAutoMatch(true);
  }

  async function handleSaveTolerances(e: React.FormEvent) {
    e.preventDefault();
    setSavedTolerances(false);
    await updateSettings.mutateAsync({
      matchBudgetTolerancePct: Number(budgetTolerance),
      matchAreaTolerancePct: Number(areaTolerance),
      matchRoomsTolerance: Number(roomsTolerance),
    });
    setSavedTolerances(true);
  }

  async function handleSaveRadius(e: React.FormEvent) {
    e.preventDefault();
    setSavedRadius(false);
    await updateSettings.mutateAsync({
      matchDefaultRadiusM: Number(defaultRadius),
      matchRadiusMaxMultiplier: Number(radiusMaxMultiplier),
      matchMinCandidates: Number(minCandidates),
    });
    setSavedRadius(true);
  }

  async function handleSaveWeights(e: React.FormEvent) {
    e.preventDefault();
    setSavedWeights(false);
    await updateSettings.mutateAsync({
      matchScoreBase: Number(scoreBase),
      matchScoreDistrict: Number(scoreDistrict),
      matchScoreRooms: Number(scoreRooms),
      matchScoreBudget: Number(scoreBudget),
      matchScoreHotBonus: Number(scoreHotBonus),
      matchScoreDistance: Number(scoreDistance),
    });
    setSavedWeights(true);
  }

  return (
    <>
      <section className="card">
        <div className="sec-h stack">
          <h2>Автоподбор</h2>
          <span className="note">Новый объект сам находит ждущих покупателей</span>
        </div>

        <SwitchRow
          title="Автоподбор объектов покупателям"
          on={autoMatchOn}
          onToggle={() => updateSettings.mutate({ autoMatchEnabled: !autoMatchOn })}
          hint={
            autoMatchOn
              ? "Новый объект в продаже сам находит ждущих покупателей и уведомляет их агентов."
              : "Автоподбор выключен: агенты ищут объекты руками."
          }
        />

        <SwitchRow
          title="Учитывать неактивных клиентов"
          on={includeInactiveOn}
          onToggle={() => updateSettings.mutate({ matchIncludeInactive: !includeInactiveOn })}
          hint={
            includeInactiveOn
              ? "Клиенты в статусе «Неактивный» тоже участвуют в подборе и счётчике спроса."
              : "Неактивные клиенты в подбор и счётчик спроса не попадают."
          }
        />

        <SwitchRow
          title="Учитывать отложенных клиентов"
          on={includeDeferredOn}
          onToggle={() => updateSettings.mutate({ matchIncludeDeferred: !includeDeferredOn })}
          hint={
            includeDeferredOn
              ? "Отложенные (DEFERRED) клиенты тоже участвуют в подборе и счётчике спроса."
              : "Отложенные клиенты в подбор и счётчик спроса не попадают — у них свой таймер возврата."
          }
        />

        <SwitchRow
          title="Уведомлять хозяина объекта"
          on={notifyOwnerOn}
          onToggle={() => updateSettings.mutate({ matchNotifyPropertyOwner: !notifyOwnerOn })}
          hint={
            notifyOwnerOn
              ? "Хозяин объекта получает пуш, когда его объект предлагают чужому клиенту."
              : "Хозяин объекта не узнаёт, что его объект предложили чужому клиенту."
          }
        />

        <form onSubmit={handleSaveAutoMatch}>
          <NumberRow
            label="Пожелание актуально"
            unit="дней"
            min={0}
            max={365}
            value={ttlDays}
            onChange={setTtlDays}
            hint="Сколько дней после последнего контакта пожелания покупателя считаются актуальными. 0 — без срока."
          />
          <NumberRow
            label="Повторно уведомлять при снижении цены от"
            unit="%"
            min={1}
            max={50}
            value={priceDropPct}
            onChange={setPriceDropPct}
            hint="На сколько процентов должна упасть цена объекта, чтобы уже уведомлённого покупателя предупредили повторно."
          />
          <SaveRow pending={updateSettings.isPending} saved={savedAutoMatch} />
        </form>
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Допуски совпадения</h2>
          <span className="note">Насколько объект может отличаться от требований клиента</span>
        </div>

        <form onSubmit={handleSaveTolerances}>
          <NumberRow
            label="Бюджет"
            unit="%"
            min={0}
            max={50}
            value={budgetTolerance}
            onChange={setBudgetTolerance}
            hint="На сколько процентов цена объекта может превышать названный клиентом бюджет."
          />
          <NumberRow
            label="Площадь"
            unit="%"
            min={0}
            max={50}
            value={areaTolerance}
            onChange={setAreaTolerance}
            hint="На сколько процентов площадь объекта может быть меньше желаемой."
          />
          <NumberRow
            label="Комнаты"
            unit="комнат"
            min={0}
            max={3}
            value={roomsTolerance}
            onChange={setRoomsTolerance}
            hint="Допустимая разница в числе комнат между объектом и запросом клиента."
          />
          <SaveRow pending={updateSettings.isPending} saved={savedTolerances} />
        </form>
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Радиус по карте</h2>
          <span className="note">Где искать объекты вокруг точки клиента</span>
        </div>

        <form onSubmit={handleSaveRadius}>
          <NumberRow
            label="Радиус по умолчанию"
            unit="м"
            min={100}
            max={10000}
            step={100}
            value={defaultRadius}
            onChange={setDefaultRadius}
            hint="Радиус вокруг точки, которую агент ставит клиенту на карте, по умолчанию."
          />
          <NumberRow
            label="Максимальное расширение радиуса"
            unit="×"
            min={1}
            max={5}
            value={radiusMaxMultiplier}
            onChange={setRadiusMaxMultiplier}
            hint="Если в радиусе меньше N объектов, радиус расширяется до этого множителя."
          />
          <NumberRow
            label="Минимум кандидатов"
            unit="объектов"
            min={1}
            max={10}
            value={minCandidates}
            onChange={setMinCandidates}
            hint="Сколько объектов-кандидатов должно быть в радиусе, иначе радиус расширяется."
          />
          <SaveRow pending={updateSettings.isPending} saved={savedRadius} />
        </form>
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Веса шкалы совпадения клиента и объекта</h2>
          <span className="note">
            Одна шкала на два места: обычный подбор объекта клиенту и решение «отдать лид хозяину своего
            объекта» (вкладка «Лиды»). По умолчанию база + район + комнаты + бюджет = 100 — можно сдвинуть в
            любую сторону, потолок 100 всё равно не даст баллу перевалить за него
          </span>
        </div>
        {/* Порог «свой объект» (вкладка «Лиды») сравнивается с этим же баллом
            (services/leads/assignment.ts::pickByPropertyMatch) — правка весов здесь
            молча сдвигает его смысл. Считаем по набранным, ещё не сохранённым
            числам: видно до нажатия «Сохранить». */}
        <div className="quiet" style={{ marginBottom: "var(--s3)" }}>
          <span className="dot" />
          <span className="txt">
            Порог «свой объект» во вкладке «Лиды» — {settings.ownPropertyMatchThreshold ?? 90} из 100 — сравнивается
            с этим баллом.{" "}
            {ownPropertyThresholdNote(settings.ownPropertyMatchThreshold ?? 90, {
              base: Number(scoreBase) || 0,
              district: Number(scoreDistrict) || 0,
              rooms: Number(scoreRooms) || 0,
              budget: Number(scoreBudget) || 0,
              distance: Number(scoreDistance) || 0,
            })}
          </span>
          <Link className="lnk" to="/settings?tab=leads">
            Порог в «Лидах»
          </Link>
        </div>
        <form onSubmit={handleSaveWeights}>
          <NumberRow
            label="База"
            unit="баллов"
            min={0}
            max={100}
            value={scoreBase}
            onChange={setScoreBase}
            hint="Начисляется любой паре, уже прошедшей жёсткий фильтр по району, бюджету, площади и этажу."
          />
          <NumberRow
            label="Район совпал"
            unit="баллов"
            min={0}
            max={100}
            value={scoreDistrict}
            onChange={setScoreDistrict}
            hint="Желаемый район клиента совпал с районом объекта."
          />
          <NumberRow
            label="Комнат столько же"
            unit="баллов"
            min={0}
            max={100}
            value={scoreRooms}
            onChange={setScoreRooms}
            hint="Число комнат совпало ровно. Разница в одну комнату баллов не даёт, но и не отсеивает."
          />
          <NumberRow
            label="В бюджете"
            unit="баллов"
            min={0}
            max={100}
            value={scoreBudget}
            onChange={setScoreBudget}
            hint="Цена объекта укладывается в названный клиентом бюджет без растяжки."
          />
          <NumberRow
            label="Горячий клиент"
            unit="баллов"
            min={0}
            max={100}
            value={scoreHotBonus}
            onChange={setScoreHotBonus}
            hint="Бонус клиенту в статусе «горячий». Не применяется, когда шкалой ищут объекты под клиента — иначе порог означал бы для него другое."
          />
          <NumberRow
            label="Попал в желаемое место"
            unit="баллов"
            min={0}
            max={100}
            value={scoreDistance}
            onChange={setScoreDistance}
            hint="Точка объекта попала в одно из желаемых мест клиента (карточка клиента, вкладка «Коротко»). Отдельный вес — район (выше) не трогает."
          />
          <SaveRow pending={updateSettings.isPending} saved={savedWeights} />
        </form>
      </section>
    </>
  );
}
