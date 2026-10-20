import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAgents, useRevertHandover, type HandoverRevertResult } from "../hooks/useAgents";
import { Rh2Sheet } from "./rh2/Rh2Sheet";

interface HandoverResult {
  clients: number;
  tasks: number;
  openDeals: number;
  properties: number;
  unassigned: number;
  byAgent: { agentId: string; fullName: string; clients: number; properties: number }[];
  /** Учётка отключена этим же действием (галочка «отключить учётную запись»). */
  deactivated?: boolean;
  /** Снимок раздачи — по нему работает «Вернуть всё как было». */
  batchId?: string | null;
}

/**
 * Передача дел уходящего сотрудника: активные клиенты, незакрытые задачи по ним и
 * ВСЕ его объекты в работе (хозяин по правилу «принял ?? ведёт ?? завёл» —
 * lib/propertyHandover.ts на сервере).
 *
 * Отдельно от «деактивировать» окно было с самого начала: причины ухода разные
 * (увольнение, декрет, отпуск), а учётку иногда надо закрыть срочно и без разбора
 * портфеля. С 24.09.2026 (владелец: «после передачи клиентов деактивируем
 * аккаунт») отключение — галочка ЗДЕСЬ, включённая по умолчанию: два отдельных
 * действия в разных окнах кончались тем, что второе забывали, и уволенный ещё
 * день-два мог войти. Для отпуска и больничного есть своя кнопка рядом.
 *
 * Здесь же честно сказано, что сделки не переносятся — кому идёт комиссия,
 * решает руководитель.
 *
 * Два состояния в одном окне: форма выбора получателя и отчёт о том, что ушло и
 * кому. Отчёт остаётся отчётом — общий тост «Сохранено» ему только мешал бы
 * (meta.silent, аудит 22.08.2026, раунд 5).
 */
export function HandoverModal({
  agent,
  onClose,
}: {
  agent: { id: string; fullName: string; isActive?: boolean };
  onClose: () => void;
}) {
  const { data: agents } = useAgents();
  const qc = useQueryClient();
  const [toAgentId, setToAgentId] = useState("");
  // Уже отключённой учётке отключать нечего — галочку не показываем и не шлём.
  const canDeactivate = agent.isActive !== false;
  const [deactivate, setDeactivate] = useState(canDeactivate);
  const [result, setResult] = useState<HandoverResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revertHandover = useRevertHandover();
  const [reverted, setReverted] = useState<HandoverRevertResult | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  const handover = useMutation({
    mutationFn: () =>
      api<HandoverResult>(`/agents/${agent.id}/handover`, {
        method: "POST",
        body: { ...(toAgentId ? { toAgentId } : {}), ...(canDeactivate && deactivate ? { deactivate: true } : {}) },
      }),
    meta: { silent: true },
    onSuccess: (data) => {
      setResult(data);
      // Портфели изменились сразу у нескольких экранов; при отключении — и список сотрудников.
      for (const key of ["clients", "properties", "team", "agents", "dashboard-summary"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Не удалось передать дела"),
  });

  // Замороженным (отпуск, больничный) дела не передаются — сервер откажет
  // (B13, решение владельца 02.10.2026), поэтому их и не предлагаем.
  const candidates = (agents ?? []).filter((a) => a.id !== agent.id && a.isActive && !a.frozenAt);

  return (
    <Rh2Sheet
      title={`Передать дела: ${agent.fullName}`}
      onClose={onClose}
      onSubmit={
        result
          ? undefined
          : () => {
              setError(null);
              handover.mutate();
            }
      }
      footer={
        result ? (
          <button type="button" className="pill" onClick={onClose}>
            Готово
          </button>
        ) : (
          <>
            <button type="button" className="pill ghost" onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="pill" disabled={handover.isPending}>
              {handover.isPending ? "Передаём…" : "Передать дела"}
            </button>
          </>
        )
      }
    >
      {result && reverted ? (
        <>
          <p className="state">
            Возвращено: клиентов {reverted.clients}, задач {reverted.tasks}, объектов {reverted.properties}
          </p>
          {reverted.reactivated && (
            <p className="quiet ok">
              <span className="dot ok" />
              <span className="txt">Учётная запись включена.</span>
            </p>
          )}
          {(reverted.skippedClients > 0 || reverted.skippedProperties > 0) && (
            <p className="quiet">
              <span className="dot" />
              <span className="txt">
                Не тронуто: клиентов {reverted.skippedClients}, объектов {reverted.skippedProperties} — их уже
                передали дальше.
              </span>
            </p>
          )}
        </>
      ) : result ? (
        <>
          <p className="state">
            Передано клиентов: {result.clients}, задач: {result.tasks}, объектов: {result.properties}
          </p>
          {result.byAgent.length > 0 && (
            <div className="list">
              {result.byAgent.map((a) => (
                <div key={a.agentId} className="row">
                  <div className="t">
                    <b>{a.fullName}</b>
                    <span>
                      клиентов: {a.clients}, объектов: {a.properties}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {result.properties > 0 && (
            <p className="quiet">
              <span className="dot" />
              <span className="txt">
                Объекты ждут принятия: каждый новый хозяин увидит в карточке, от кого объект пришёл и почему, и
                нажмёт «Принять». Таймера у объектов нет.
              </span>
            </p>
          )}
          {result.deactivated && (
            <p className="quiet ok">
              <span className="dot ok" />
              <span className="txt">Учётная запись отключена: вход закрыт, из очереди звонков сотрудник убран.</span>
            </p>
          )}
          {result.unassigned > 0 && (
            <p className="quiet warn">
              <span className="dot warn" />
              <span className="txt">Не удалось никому передать: {result.unassigned}, свободных агентов нет.</span>
            </p>
          )}
          {result.openDeals > 0 && (
            <p className="quiet warn">
              <span className="dot warn" />
              <span className="txt">
                Открытых сделок: {result.openDeals}. Они НЕ переданы. Кому пойдёт комиссия, решаете вы: откройте
                «Сделки» и смените агента вручную.
              </span>
            </p>
          )}
          {result.batchId && (
            <>
              <button
                type="button"
                className="pill ghost"
                disabled={revertHandover.isPending}
                onClick={() => {
                  setRevertError(null);
                  revertHandover.mutate(result.batchId!, {
                    onSuccess: setReverted,
                    onError: (err) => setRevertError(err instanceof Error ? err.message : "Не удалось вернуть раздачу"),
                  });
                }}
              >
                {revertHandover.isPending ? "Возвращаем…" : "Вернуть всё как было"}
              </button>
              {revertError && (
                <p className="quiet crit">
                  <span className="dot crit" />
                  <span className="txt">{revertError}</span>
                </p>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <p className="state">
            Активные клиенты и незакрытые задачи по ним, а также все его объекты в работе перейдут другому
            сотруднику. Клиент придёт новому агенту уже принятым — принимать его не нужно, и
            другим агентам он не уйдёт. Объект новый хозяин принимает сам, прочитав, от кого он и почему, — без
            таймера. История взаимодействий и открытые сделки
            остаются как есть.
          </p>

          <label className="fld">
            <span className="lab">Кому передать</span>
            <select value={toAgentId} onChange={(e) => setToAgentId(e.target.value)}>
              <option value="">Распределить по команде</option>
              {candidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.fullName}
                </option>
              ))}
            </select>
            <span className="msg">
              «Распределить по команде» раздаёт клиентов и объекты по разным правилам: клиентов отдаёт агентам с высоким
              Royal Score, горячих первыми (разговор уже начат, его нельзя ставить на паузу), а объекты отдаёт агентам с
              низким (объект это материал для работы, он нужнее тому, у кого работы мало). Оба правила настраиваются в
              «Настройки → Лиды → Когда агент уходит из компании». Если выбрать конкретного человека, всё уйдёт ему.
            </span>
          </label>

          {canDeactivate && (
            <label className="fld">
              <span className="lab">
                <input
                  type="checkbox"
                  aria-label="Отключить учётную запись после передачи"
                  checked={deactivate}
                  onChange={(e) => setDeactivate(e.target.checked)}
                />{" "}
                Отключить учётную запись после передачи
              </span>
              <span className="msg">
                Сотрудник больше не войдёт в CRM и выпадет из очереди звонков. Снимите галочку, если учётка ещё нужна
                (декрет, смена роли). Для отпуска и больничного есть отдельная кнопка «Отпуск / больничный».
              </span>
            </label>
          )}

          {error && (
            <p className="quiet crit">
              <span className="dot crit" />
              <span className="txt">{error}</span>
            </p>
          )}
        </>
      )}
    </Rh2Sheet>
  );
}
