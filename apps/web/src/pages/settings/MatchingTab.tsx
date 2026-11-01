import { useState } from "react";
import { useServerSyncedFields } from "../../hooks/useServerSyncedForm";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { SwitchRow } from "../../components/Switch";
import { NumberRow, SaveRow } from "../../components/settings/SettingsRows";

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
  const [savedAutoMatch, setSavedAutoMatch] = useState(false);

  const [budgetTolerance, setBudgetTolerance] = useState("");
  const [areaTolerance, setAreaTolerance] = useState("");
  const [roomsTolerance, setRoomsTolerance] = useState("");
  const [savedTolerances, setSavedTolerances] = useState(false);

  const [defaultRadius, setDefaultRadius] = useState("");
  const [savedRadius, setSavedRadius] = useState(false);

  useServerSyncedFields(
    settings && {
      ttlDays: String(settings.matchRequirementTtlDays ?? 60),
      budgetTolerance: String(settings.matchBudgetTolerancePct ?? 10),
      areaTolerance: String(settings.matchAreaTolerancePct ?? 10),
      roomsTolerance: String(settings.matchRoomsTolerance ?? 1),
      defaultRadius: String(settings.matchDefaultRadiusM ?? 1500),
    },
    {
      ttlDays: [ttlDays, setTtlDays],
      budgetTolerance: [budgetTolerance, setBudgetTolerance],
      areaTolerance: [areaTolerance, setAreaTolerance],
      roomsTolerance: [roomsTolerance, setRoomsTolerance],
      defaultRadius: [defaultRadius, setDefaultRadius],
    }
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
    });
    setSavedRadius(true);
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
          <SaveRow pending={updateSettings.isPending} saved={savedRadius} />
        </form>
      </section>

      {/* Веса шкалы совпадения — константа с 01.11.2026 (MATCH_SCORE_WEIGHTS в
          packages/shared): внутренняя калибровка, а не рычаг. */}
    </>
  );
}
