import { usePointsJournal } from "../hooks/usePoints";
import { relativeTime } from "../lib/format";
import { Rh2Sheet } from "./rh2/Rh2Sheet";

/** Только история: ручное начисление баллов запрещено спецификацией Fair Play
 * (03.08.2026, Royal Score Engine, часть 2) — «Ручное изменение KPI запрещено. Ни
 * агент. Ни руководитель. Ни администратор». Записи здесь — то, что было начислено
 * ДО запрета; журнал неудаляемый, но добавить новую запись больше нельзя ни через
 * это окно, ни через API.
 *
 * ОБЛИК — шторка `.sheet` эталона: итог тихой строкой `.kvp` в шапке тела,
 * начисления списком `.list`/`.row` со знаком в `.chip`. Ловушка фокуса, Esc,
 * блокировка прокрутки фона и смахивание пальцем живут в `Rh2Sheet`. */
export function PointsJournalModal({
  agentId,
  agentName,
  onClose,
}: {
  agentId: string;
  agentName: string;
  onClose: () => void;
}) {
  const { data: journal, isLoading } = usePointsJournal(agentId);

  return (
    <Rh2Sheet open onClose={onClose} title={`Баллы: ${agentName}`} ariaLabel="Журнал баллов">
      <p className="kvp">
        Итого: <b>{journal?.total ?? 0}</b>
      </p>

      {isLoading && <p className="state">Загружаем журнал…</p>}
      {!isLoading && journal?.entries.length === 0 && <p className="state">Начислений не было</p>}

      <div className="list">
        {journal?.entries.map((e) => {
          const value = e.meta?.points ?? 0;
          return (
            <div key={e.id} className="row">
              {/* Знак начисления пилюлей эталона: плюс зелёной, минус красной
                  обводкой. Цветных иконок в теме нет (договор дизайна §3). */}
              <span className={value > 0 ? "chip ok" : "chip crit"}>{value > 0 ? `+${value}` : value}</span>
              <div className="t">
                <b>{e.meta?.reason}</b>
                <span>
                  {e.agentName} · {relativeTime(e.createdAt)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Rh2Sheet>
  );
}
