import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PERMISSION_GROUPS,
  ROLE_LABELS,
  ROLE_PRESETS,
  ROLE_PRESET_SUMMARY,
  type PermissionGroupId,
  type PermissionId,
  type Role,
} from "@royal-home/shared";
import { api } from "../lib/api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Switch } from "./Switch";
import { Rh2Sheet } from "./rh2/Rh2Sheet";

interface PermissionItem {
  id: PermissionId;
  label: string;
  group: PermissionGroupId;
  hint?: string;
  enabled: boolean;
  overridden: boolean;
}

interface PermissionsResponse {
  agentId: string;
  fullName: string;
  role: Role;
  roleSummary: string;
  editable: boolean;
  items: PermissionItem[];
}

/**
 * Раздача прав конкретному сотруднику. Галочка = что человек видит и может делать,
 * независимо от должности: роль задаёт лишь стартовый набор.
 *
 * Отличия от роли подсвечиваются («изменено»), чтобы через месяц было видно, где
 * настроено вручную, а где всё по умолчанию. Кнопка «Вернуть как у роли» снимает
 * все надстройки разом.
 *
 * ОБЛИК — шторка `.sheet` эталона: группы прав заголовками `.sec-t`, каждое
 * право строкой `.mod` с тумблером `.tgl`, отличие от роли пилюлей `.chip`,
 * действия кнопками `.pill` в подвале. Галочки заменены тумблерами не ради
 * красоты: в эталоне бинарный переключатель один, и это `.tgl`; своих имён
 * классов тема не заводит.
 *
 * Тумблер берётся из `components/Switch` — того же, что во всех остальных
 * вкладках Настроек (окно открывается из «Настройки → Сотрудники», значит
 * «один тумблер на все Настройки» распространяется и на него). Разметка у
 * `Switch` и `ProtoToggle` одна и та же (`label.tgl > input + i`), но второй
 * живёт в Профиле и «Виде приложения»; смешивать их внутри Настроек значило бы
 * заводить вторую копию там, где договорились держать одну.
 */
export function AgentPermissionsModal({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["agent-permissions", agentId],
    queryFn: () => api<PermissionsResponse>(`/agents/${agentId}/permissions`),
  });

  const [enabled, setEnabled] = useState<Set<PermissionId> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    if (data) setEnabled(new Set(data.items.filter((i) => i.enabled).map((i) => i.id)));
  }, [data]);

  const preset = useMemo(
    () => new Set<PermissionId>(data ? (ROLE_PRESETS[data.role] ?? []) : []),
    [data]
  );

  const save = useMutation({
    mutationFn: (body: { granted: PermissionId[]; revoked: PermissionId[] }) =>
      api(`/agents/${agentId}/permissions`, { method: "PUT", body }),
    // silent: на успехе окно закрывается само, на отказе текст ошибки печатается
    // строкой в подвале окна (`saveError`) — общий тост повторял её вторым
    // сообщением (аудит 22.08.2026, раунд 5).
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-permissions", agentId] });
      // Если директор правит права сам себе через другую учётку — профиль подтянет новые.
      qc.invalidateQueries({ queryKey: ["me"] });
      onClose();
    },
    onError: (e) => setSaveError(e instanceof Error ? e.message : "Не удалось сохранить"),
  });

  function toggle(id: PermissionId) {
    setEnabled((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSave() {
    if (!enabled || !data) return;
    setSaveError(null);
    const granted = [...enabled].filter((id) => !preset.has(id));
    const revoked = [...preset].filter((id) => !enabled.has(id));
    save.mutate({ granted, revoked });
  }

  const changedCount = useMemo(() => {
    if (!enabled || !data) return 0;
    return data.items.filter((i) => enabled.has(i.id) !== preset.has(i.id)).length;
  }, [enabled, data, preset]);

  /**
   * НЕСОХРАНЁННЫЕ ПРАВА НЕ ВЫБРАСЫВАЕМ МОЛЧА (аудит 22.08.2026, раунд 5).
   *
   * Клик мимо окна закрывал его вместе со всеми переключёнными галочками. Сверять
   * надо с СОХРАНЁННЫМ состоянием (`i.enabled`), а не с changedCount выше: тот
   * считает отличия от роли по умолчанию, то есть у агента с давно настроенными
   * правами он ненулевой, даже когда человек ничего не трогал.
   */
  const dirty = useMemo(() => {
    if (!enabled || !data) return false;
    return data.items.some((i) => enabled.has(i.id) !== i.enabled);
  }, [enabled, data]);
  const requestClose = () => (dirty ? setConfirmClose(true) : onClose());

  return (
    <>
      <Rh2Sheet
        open
        onClose={requestClose}
        title="Права доступа"
        ariaLabel="Права доступа сотрудника"
        footer={
          data?.editable ? (
            // В подвале только действия: «Вернуть как у роли» и счётчик отличий
            // живут в теле окна, иначе четыре элемента не влезают в 440 px
            // шторки и «Сохранить» переносится на вторую строку.
            <>
              <button type="button" className="pill ghost" onClick={requestClose}>
                Отмена
              </button>
              <button type="button" className="pill" onClick={handleSave} disabled={save.isPending}>
                {save.isPending ? "Сохраняем…" : "Сохранить"}
              </button>
            </>
          ) : undefined
        }
      >
        <p className="kvp">{data ? `${data.fullName} · ${ROLE_LABELS[data.role]}` : "Загрузка…"}</p>

        {isLoading && <p className="state">Загружаем список прав…</p>}
        {error && (
          <p className="state err">
            <span className="dot crit" />
            Не удалось загрузить права
          </p>
        )}
        {saveError && (
          <p className="state err">
            <span className="dot crit" />
            {saveError}
          </p>
        )}

        {data && !data.editable && (
          <p className="state">
            У директора всегда полный доступ ко всей системе: это защита от ситуации, когда владелец случайно
            запирает сам себя снаружи. Настроить можно права любого другого сотрудника.
          </p>
        )}

        {data?.editable && enabled && (
          <>
            <div className="mod">
              <div className="t">
                <b>{changedCount === 0 ? "Всё по умолчанию" : `Изменено прав: ${changedCount}`}</b>
                <span>Отличия от набора, который даёт сама должность</span>
              </div>
              <div className="acts">
                <button
                  type="button"
                  className="pill ghost sm"
                  onClick={() => setEnabled(new Set(preset))}
                  disabled={changedCount === 0}
                >
                  Вернуть как у роли
                </button>
              </div>
            </div>

            <p className="state">
              Роль «{ROLE_LABELS[data.role]}» по умолчанию: {ROLE_PRESET_SUMMARY[data.role]} Переключателями ниже
              можно открыть или закрыть что угодно лично этому сотруднику, не меняя должность.
            </p>

            {PERMISSION_GROUPS.map((group) => {
              const items = data.items.filter((i) => i.group === group.id);
              if (items.length === 0) return null;
              return (
                <div key={group.id}>
                  <div className="sec-t">{group.label}</div>
                  {group.hint && <p className="state">{group.hint}</p>}
                  {items.map((item) => {
                    const on = enabled.has(item.id);
                    const differs = on !== preset.has(item.id);
                    return (
                      <div key={item.id} className="mod">
                        <div className="t">
                          <b>{item.label}</b>
                          {item.hint && <span>{item.hint}</span>}
                        </div>
                        <div className="acts">
                          {differs && <span className="chip">изменено</span>}
                          <Switch on={on} label={item.label} onToggle={() => toggle(item.id)} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}

            <p className="state">
              Раздавать права может только директор: администратор с доступом к учёткам не сможет повысить ни себя,
              ни коллегу. Смена двухфакторной защиты и пароля админки сайта тоже остаются за директором и в списке
              выше не появляются.
            </p>
          </>
        )}
      </Rh2Sheet>

      {confirmClose && (
        <ConfirmDialog
          title="Закрыть без сохранения?"
          description="Переключённые права не сохранены и будут потеряны."
          confirmLabel="Закрыть"
          onConfirm={onClose}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </>
  );
}
