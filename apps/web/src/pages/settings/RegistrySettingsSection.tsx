import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useRegistryStatus, useRegistrySync, type RegistryStatus } from "../../hooks/useConstructionRegistry";
import { useCan } from "../../lib/permissions";
import { dushanbeDate, dushanbeTime } from "../../lib/date";
import { SwitchRow } from "../../components/Switch";

/**
 * «РЕЕСТР СТРОЕК ДУШАНБЕ» (20.11.2026): два рубильника и статус забора.
 * Данные реестра видят только сотрудники. Забор раз в неделю делает сервер сам; «Забрать сейчас» нужна руководству,
 * когда не хочется ждать (право settings.manage, то же проверяет сервер). Тумблеры сохраняются сразу, как соседи в этой вкладке.
 */

/** Строка «Обновлено: …»: дата последнего удачного забора по Душанбе и сколько проектов в реестре. */
export function registryStatusLine(status: Pick<RegistryStatus, "runs" | "activeProjects" | "linkedProperties">): string {
  const lastOk = status.runs.find((r) => r.ok && r.finishedAt);
  if (!lastOk?.finishedAt) return "Реестр ещё не забирали";
  const when = `${dushanbeDate(lastOk.finishedAt)}, ${dushanbeTime(lastOk.finishedAt)}`;
  return `Обновлено: ${when}, в реестре ${status.activeProjects} проектов, связано объектов ${status.linkedProperties}`;
}

export function RegistrySettingsSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const { data: status } = useRegistryStatus();
  const sync = useRegistrySync();
  const can = useCan();
  if (!settings || settings.constructionRegistryEnabled === undefined) return null;

  const enabled = settings.constructionRegistryEnabled;
  const notify = settings.constructionRegistryNotify;
  const lastRun = status?.runs[0];

  return (
    <section className="card" data-testid="registry-settings">
      <div className="sec-h stack">
        <h2>Реестр строек Душанбе</h2>
        <span className="note">Данные городского реестра видят только сотрудники. Клиентам, на сайт и боту они не уходят</span>
      </div>
      <SwitchRow
        title="Реестр строек"
        on={enabled}
        onToggle={() => updateSettings.mutate({ constructionRegistryEnabled: !enabled })}
        hint={
          enabled
            ? "Раз в неделю забирать реестр разрешённых строек и показывать сотрудникам в карточке объекта и на карте."
            : "Реестр не забирается и нигде не показывается."
        }
      />
      <SwitchRow
        title="Сообщать агенту о смене статуса"
        on={enabled && notify}
        disabled={!enabled}
        onToggle={() => updateSettings.mutate({ constructionRegistryNotify: !notify })}
        hint={
          !enabled
            ? "Работает, только когда включён реестр строек."
            : notify
              ? "Ответственный агент получает сообщение, когда у его объекта сменился статус в реестре."
              : "Смену статуса агент не получает, она видна только в карточке объекта."
        }
      />
      {status && (
        <div className="quiet" data-testid="registry-status-line">
          <span className="dot" />
          <span className="txt">{registryStatusLine(status)}</span>
        </div>
      )}
      {lastRun && !lastRun.ok && lastRun.finishedAt && (
        <div className="quiet" data-testid="registry-last-failure">
          <span className="dot crit" />
          <span className="txt">
            Последний забор не удался ({dushanbeDate(lastRun.startedAt)}, {dushanbeTime(lastRun.startedAt)}
            {lastRun.error ? `): ${lastRun.error}` : ")"}. Показаны данные прошлого удачного забора.
          </span>
        </div>
      )}
      {can("settings.manage") && (
        <div className="quiet">
          <button
            type="button"
            className="pill sm"
            disabled={!enabled || sync.isPending}
            title={!enabled ? "Сначала включите реестр строек" : undefined}
            onClick={() => sync.mutate()}
          >
            {sync.isPending ? "Запускаю…" : "Забрать сейчас"}
          </button>
          {sync.isSuccess && <span className="txt">Забор начался, он идёт несколько минут. Итог появится здесь.</span>}
          {sync.isError && <span className="txt">Не удалось запустить забор, попробуйте ещё раз.</span>}
        </div>
      )}
    </section>
  );
}
