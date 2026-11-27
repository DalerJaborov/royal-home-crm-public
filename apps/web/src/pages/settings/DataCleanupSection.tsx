import { useState } from "react";
import { Eraser } from "lucide-react";
import { AUTO_CLEANUP_DAYS, AUTO_CLEANUP_DAYS_KEYS, AUTO_CLEANUP_DAYS_LABELS, type AutoCleanupDaysKey } from "@royal-home/shared";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useCan } from "../../lib/permissions";
import { SwitchRow } from "../../components/Switch";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { CleanupButton } from "../../components/CleanupButton";

/**
 * «Очистка данных» (владелец 28.11.2026): кнопки «Очистить» и автоочистка старого мусора.
 * Только директор/админ (право settings.manage). Удаление безвозвратное; AuditLog, переписки, клиенты,
 * сделки и объекты не затрагиваются. Автоочистка по умолчанию ВЫКЛ — включает владелец сам.
 */
export function DataCleanupSection() {
  const can = useCan();
  const { data: settings, isError } = useSettings();
  const save = useUpdateSettings();
  if (!can("settings.manage")) return null;
  const on = settings?.autoCleanupEnabled ?? false;

  return (
    <SettingsSection icon={Eraser} title="Очистка данных">
      <p className="quiet">
        Старые уведомления, оповещения и ошибки копятся и мешают. Здесь их можно удалить. Удаление не отменить. Журнал действий
        сотрудников, переписки, клиенты, сделки и объекты не удаляются никогда.
      </p>

      <div className="wrap" style={{ marginTop: "var(--s3)", gap: 8 }}>
        <CleanupButton target="notifications" scope="all" label="Очистить уведомления всех" className="pill ghost sm" />
        <CleanupButton target="directorAlerts" label="Очистить оповещения директору" className="pill ghost sm" />
        <span className="quiet">Журнал ошибок чистится кнопкой «Очистить журнал» в разделе «Здоровье системы».</span>
      </div>

      {isError && (
        <p role="alert" className="quiet">
          Не удалось загрузить настройки автоочистки. Это не значит, что она выключена: обновите страницу.
        </p>
      )}
      <div style={{ marginTop: "var(--s4)" }}>
        <SwitchRow
          title="Автоочистка старого мусора"
          on={on}
          hint={
            on
              ? "Раз в сутки ночью удаляется всё, что старше сроков ниже. Непрочитанное и неразобранное остаётся."
              : "Выключена: само ничего не удаляется. Включите, когда будете готовы."
          }
          onToggle={() => save.mutate({ autoCleanupEnabled: !on })}
        />
        {AUTO_CLEANUP_DAYS_KEYS.map((key) => (
          <DaysInput key={`${key}:${settings?.[key] ?? AUTO_CLEANUP_DAYS[key].default}`} field={key} saved={settings?.[key] ?? AUTO_CLEANUP_DAYS[key].default} />
        ))}
      </div>
    </SettingsSection>
  );
}

function DaysInput({ field, saved }: { field: AutoCleanupDaysKey; saved: number }) {
  const save = useUpdateSettings();
  const [value, setValue] = useState(String(saved));
  const limits = AUTO_CLEANUP_DAYS[field];
  const meta = AUTO_CLEANUP_DAYS_LABELS[field];
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= limits.min && n <= limits.max;
  const hintId = `${field}-hint`;
  return (
    <div className="filters" style={{ marginTop: "var(--s3)", alignItems: "flex-end" }}>
      <label className="field">
        <span className="lab">{meta.label}</span>
        <input
          className="inp"
          type="number"
          inputMode="numeric"
          min={limits.min}
          max={limits.max}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby={hintId}
        />
      </label>
      <button type="button" className="pill" disabled={!valid || n === saved || save.isPending} onClick={() => save.mutate({ [field]: n })}>
        Сохранить
      </button>
      <span id={hintId} className="quiet">
        {meta.hint} От {limits.min} до {limits.max}.
      </span>
    </div>
  );
}
