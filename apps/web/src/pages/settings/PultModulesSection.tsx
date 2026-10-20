import { Radar } from "lucide-react";
import type { PultModuleState } from "@royal-home/shared";
import { SwitchRow } from "../../components/Switch";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { usePultModules, useUpdatePultModule } from "../../hooks/usePultModules";

/**
 * Тумблеры модулей пульта директора (требование владельца 02.09.2026: любую часть
 * пульта можно выключить из настроек, выключенная не считается на сервере и не
 * тратит токены). Подпись описывает текущее положение тумблера — правило от 11.08.2026.
 *
 * Разметка — эталон темы «Royal Home 2026»: раскрывающийся раздел `.acc`
 * (SettingsSection) со счётчиком `.cnt` в шапке, внутри — группы `.grp-lab` и
 * строки-тумблеры `.mod`.
 */
export function PultModulesSection() {
  const { data, isLoading, isError } = usePultModules();
  const update = useUpdatePultModule();
  const modules = data?.modules ?? [];
  const sections = modules.filter((m) => m.kind === "section");
  const ai = modules.filter((m) => m.kind === "ai");
  const offCount = modules.filter((m) => !m.enabled).length;

  return (
    <SettingsSection icon={Radar} title="Пульт директора" badge={offCount > 0 ? `выключено ${offCount}` : undefined}>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Что показывает пульт и какие ночные задания ИИ запускаются. Выключенная плитка не считается на
          сервере, выключенное задание не тратит токены. Изменения видны на пульте сразу.
        </span>
      </div>
      {isLoading && (
        <div className="state">
          <span className="sk w40" />
          <span className="sk w22" /> Загружаем список модулей
        </div>
      )}
      {isError && (
        <div className="state err">
          <span className="dot crit" /> Не удалось загрузить список модулей.
        </div>
      )}
      {update.isError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">
            {update.error instanceof Error ? update.error.message : "Не удалось переключить модуль"}
          </span>
        </div>
      )}
      {modules.length > 0 && (
        <>
          <ModuleGroup title="Плитки пульта" modules={sections} update={update} />
          <ModuleGroup title="Задания ИИ (тратят токены)" modules={ai} update={update} />
        </>
      )}
    </SettingsSection>
  );
}

function ModuleGroup({
  title,
  modules,
  update,
}: {
  title: string;
  modules: PultModuleState[];
  update: ReturnType<typeof useUpdatePultModule>;
}) {
  return (
    <>
      <div className="grp-lab">{title}</div>
      {modules.map((m) => (
        <SwitchRow
          key={m.id}
          title={m.label}
          on={m.enabled}
          hint={m.enabled ? m.onHint : m.offHint}
          disabled={update.isPending && update.variables?.id === m.id}
          onToggle={() => update.mutate({ id: m.id, enabled: !m.enabled })}
        />
      ))}
    </>
  );
}
