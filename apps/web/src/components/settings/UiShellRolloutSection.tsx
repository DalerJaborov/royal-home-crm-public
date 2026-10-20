import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ROLE_LABELS, ROLES, type UiShellRollout, type UiShellRolloutConfig } from "@royal-home/shared";
import { api, ApiError } from "../../lib/api";
import { useCan } from "../../lib/permissions";
import { useAuthStore } from "../../store/auth";
import { useTeam } from "../../hooks/useTeam";
import { readShellDraft, rebaseShellDraft, writeShellDraft, type ShellDraft } from "./uiShellDraft";

const CONFIG_KEY = ["ui-shell", "config"];

/** Kept inside the existing desktop Settings StepUpGate, including legacy UI. */
export function UiShellRolloutSection() {
  const agent = useAuthStore((s) => s.agent);
  const sessionEpoch = useAuthStore((s) => s.sessionEpoch);
  const can = useCan();
  const allowed = (agent?.role === "DIRECTOR" || agent?.role === "ADMIN") && can("settings.manage");
  const config = useQuery({
    queryKey: [...CONFIG_KEY, agent?.id],
    queryFn: () => api<UiShellRolloutConfig>("/ui-shell/config", { expectAgentId: agent?.id }),
    enabled: allowed,
  });
  if (!allowed) return null;
  return (
    <section className="card shell-rollout" aria-labelledby="shell-rollout-title">
      <h2 id="shell-rollout-title">Новый интерфейс CRM</h2>
      <p className="sub">Включайте постепенно: сначала себе, затем сотрудникам или ролям. На компьютере и телефоне используется Royal Clean; у агентов на телефоне пока остаётся прежний интерфейс.</p>
      {config.isError && config.data && <p role="alert">Не удалось обновить настройки. Ваши несохранённые изменения сохранены на экране.</p>}
      {config.isPending ? <p role="status">Загружаем настройки…</p> : !config.data ? (
        <div role="alert"><p>Не удалось загрузить настройки.</p><button type="button" className="pill ghost" onClick={() => void config.refetch()}>Повторить</button></div>
      ) : <RolloutForm key={`${agent?.id}:${sessionEpoch}`} initial={config.data} />}
    </section>
  );
}

function RolloutForm({ initial: snapshot }: { initial: UiShellRolloutConfig }) {
  const { version, ...initial } = snapshot;
  // A background read may update the baseline, but must not erase a dirty draft.
  const agent = useAuthStore((s) => s.agent);
  const epoch = useAuthStore((s) => s.sessionEpoch);
  const [pendingDraft, setPendingDraft] = useState<ShellDraft | undefined>(() => agent ? readShellDraft(agent.id, epoch) : undefined);
  const draft = pendingDraft ? rebaseShellDraft(pendingDraft, initial) : initial;
  const setDraft = (value?: UiShellRollout) => {
    const actor = useAuthStore.getState();
    if (!agent || actor.agent?.id !== agent.id || actor.sessionEpoch !== epoch) return;
    const next = value ? { baseline: initial, value } : undefined;
    writeShellDraft(agent.id, epoch, next);
    setPendingDraft(next);
  };
  const can = useCan();
  const team = useTeam(can("team.viewFull"));
  const client = useQueryClient();
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    onMutate: () => client.cancelQueries({ queryKey: CONFIG_KEY }),
    mutationFn: ({ value, actorId, revision }: { value: UiShellRollout; actorId: string; epoch: number; revision: string }) => api<UiShellRolloutConfig>("/ui-shell/config", { method: "PUT", body: value, expectAgentId: actorId, ifMatch: `"${revision}"` }),
    onError: (error) => {
      // Preserve the local draft. A fresh baseline is shown for explicit review;
      // never retry a stale write or silently undo another administrator's off.
      if (error instanceof ApiError && (error.status === 409 || error.status === 428)) void client.invalidateQueries({ queryKey: [...CONFIG_KEY, agent?.id] });
    },
    onSuccess: async (value, request) => {
      // Also discard reads that started on window focus while the PUT ran.
      await client.cancelQueries({ queryKey: CONFIG_KEY });
      const current = useAuthStore.getState();
      if (current.agent?.id !== request.actorId || current.sessionEpoch !== request.epoch) return;
      client.setQueryData([...CONFIG_KEY, request.actorId], value);
      setDraft(undefined);
      setSaved(true);
      void client.invalidateQueries({ queryKey: ["ui-shell"], refetchType: "none" });
      void client.refetchQueries({ queryKey: ["ui-shell", agent?.id], exact: true });
    },
  });
  const members = team.data ?? (agent ? [agent] : []);
  const unavailableSelections = draft.agentIds.filter((id) => !members.some((member) => member.id === id));
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const editDraft = (value: UiShellRollout) => { setSaved(false); save.reset(); setDraft(value); };
  const toggleAgent = (id: string) => {
    editDraft({ ...draft, agentIds: draft.agentIds.includes(id) ? draft.agentIds.filter((item) => item !== id) : [...draft.agentIds, id] });
  };
  return (
    <form onSubmit={(event) => { event.preventDefault(); const actor = useAuthStore.getState(); if (!actor.agent || save.isPending) return; setSaved(false); save.mutate({ value: draft, actorId: actor.agent.id, epoch: actor.sessionEpoch, revision: version }); }}>
      <fieldset disabled={save.isPending}>
        <legend className="sr-only">Доступ к новой оболочке</legend>
        <label className="shell-rollout-choice"><input type="checkbox" checked={draft.enabled} onChange={(event) => editDraft({ ...draft, enabled: event.target.checked })} /> Включить новый интерфейс для выбранных ниже</label>
        <p className="sub">Выключение возвращает прежнюю оболочку после следующей успешной проверки сервера. В активной вкладке проверяем каждые 30 секунд. Права и данные не меняются.</p>
        <p className="sub">Новый интерфейс доступен на компьютере и на телефоне. У агентов на телефоне пока сохраняется прежний интерфейс независимо от выбора роли или сотрудника.</p>
        {pendingDraft && JSON.stringify(pendingDraft.baseline) !== JSON.stringify(initial) && <p role="status">Настройки на сервере изменились. Ваши правки перенесены на актуальный список; проверьте выбор перед сохранением.</p>}
        {draft.enabled && draft.agentIds.length === 0 && draft.roles.length === 0 && <p role="status">Никто не выбран: новый интерфейс пока не получит ни один сотрудник. Выберите сотрудника или роль.</p>}
        <fieldset>
          <legend>Сотрудники</legend>
          {team.isError && <p role="alert">Список команды недоступен. Можно выбрать себя или роли; сохранённые назначения сохранятся.</p>}
          <div className="shell-rollout-choices">
            {members.map((member) => <label className="shell-rollout-choice" key={member.id}><input type="checkbox" checked={draft.agentIds.includes(member.id)} onChange={() => toggleAgent(member.id)} />{member.fullName}{member.id === agent?.id ? " (вы)" : ""}</label>)}
            {unavailableSelections.map((id) => <label className="shell-rollout-choice" key={id}><input type="checkbox" checked onChange={() => toggleAgent(id)} /><span>Нет в загруженном списке · {id}</span></label>)}
          </div>
          {unavailableSelections.length > 0 && <p className="sub">Назначения сохранены. Если сервер сообщил об отключённом сотруднике, снимите его выбор и сохраните повторно.</p>}
        </fieldset>
        <fieldset>
          <legend>Вся роль</legend>
          <div className="shell-rollout-choices">
            {ROLES.map((role) => <label className="shell-rollout-choice" key={role}><input type="checkbox" checked={draft.roles.includes(role)} onChange={() => editDraft({ ...draft, roles: draft.roles.includes(role) ? draft.roles.filter((item) => item !== role) : [...draft.roles, role] })} />{ROLE_LABELS[role]}</label>)}
          </div>
        </fieldset>
        <div className="acts">
          <button className="pill" type="submit" disabled={!changed || saved}>{save.isPending ? "Сохраняем…" : "Сохранить доступ"}</button>
          <button className="pill ghost" type="button" onClick={() => { setSaved(false); setDraft(undefined); save.reset(); }} disabled={!changed}>Отменить изменения</button>
        </div>
      </fieldset>
      {save.isError && <p role="alert">{save.error instanceof Error ? save.error.message : "Не удалось сохранить доступ"}</p>}
      {saved && <p role="status">Доступ сохранён. Новый интерфейс включён для выбранных сотрудников; у агентов на телефоне остаётся прежний.</p>}
    </form>
  );
}
