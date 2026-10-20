import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useClients } from "../hooks/useClients";
import { useMergeClients, type SimilarNotesClient } from "../hooks/useDuplicates";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { toast } from "../store/toast";
import { formatClientCode, formatClientName } from "../lib/clientFormat";
import type { Client } from "../types";

/**
 * РУЧНОЕ ОБЪЕДИНЕНИЕ С РАЗНЫМИ НОМЕРАМИ (владелец 19.08.2026): живой случай —
 * клиент писал в чат с одного номера, потом позвонил с другого, и обычная
 * проверка телефона/Telegram (routes/clients.ts POST /merge) блокировала
 * объединение 409-й ошибкой. Здесь агент сам находит вторую карточку и
 * подтверждает force — сервер по-прежнему проверяет право clients.merge.
 *
 * Открывается либо с пустым поиском (агент ищет карточку сам), либо сразу с
 * `preselected` — когда клиент пришёл из баннера «похожее описание».
 */
export function MergeClientModal({
  client,
  preselected,
  onClose,
}: {
  client: Client;
  preselected?: SimilarNotesClient;
  onClose: () => void;
}) {
  const merge = useMergeClients();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  type MergeTarget = { id: string; fullName: string; phone: string; requirementsNotes?: string | null; similarity?: number };
  const [target, setTarget] = useState<MergeTarget | null>(
    preselected
      ? {
          id: preselected.id,
          fullName: preselected.fullName,
          phone: preselected.phone,
          requirementsNotes: preselected.requirementsNotes,
          similarity: preselected.similarity,
        }
      : null
  );
  const [error, setError] = useState<string | null>(null);

  const { data: found, isFetching, isError: searchFailed } = useClients(
    { q: search, pageSize: 8 },
    search.trim().length >= 2 && !target
  );
  const candidates = (found?.items ?? []).filter((c) => c.id !== client.id);

  async function submit() {
    if (!target) {
      setError("Выберите карточку для объединения");
      return;
    }
    setError(null);
    try {
      await merge.mutateAsync({ primaryId: client.id, duplicateId: target.id, force: true });
      toast.success(`Карточки объединены: «${target.fullName}» перенесена в эту`);
      navigate(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось объединить карточки");
    }
  }

  return (
    <Rh2Sheet
      title="Объединить с другой карточкой"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="pill ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="pill" disabled={merge.isPending || !target}>
            {merge.isPending ? "Объединяем…" : "Объединить"}
          </button>
        </>
      }
    >
      <p className="state">
        Для случая, когда это один и тот же человек, но телефон или Telegram у карточек разные (например, писал с
        одного номера, позвонил с другого). Вся переписка, звонки и сделки перейдут в карточку <b>{client.fullName}</b>,
        вторая карточка уйдёт в Корзину.
      </p>

      {target ? (
        <>
          <div className="list">
            <div className="row">
              <div className="t">
                <b>{target.fullName}</b>
                <span>{target.phone}</span>
              </div>
              <div className="act">
                <button type="button" className="pill ghost sm" onClick={() => setTarget(null)}>
                  Изменить
                </button>
              </div>
            </div>
          </div>
          {/* Пришли из баннера «похожее описание» (владелец 24.08.2026: «выходит
              имя, ничего не ясно что у них там общего») — показываем сами тексты,
              а не только процент, иначе решение слить/не слить принимается вслепую. */}
          {target.requirementsNotes != null && (
            <>
              <div className="sec-t">
                Заметки совпадают на {Math.round((target.similarity ?? 0) * 100)}%, сравните сами
              </div>
              <p className="quote">
                <b>{client.fullName}:</b> {client.requirementsNotes || "не указано"}
              </p>
              <p className="quote">
                <b>{target.fullName}:</b> {target.requirementsNotes || "не указано"}
              </p>
            </>
          )}
        </>
      ) : (
        <>
          <label className="fld">
            <span className="lab">Кого объединяем</span>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Имя или телефон клиента"
            />
          </label>
          {search.trim().length >= 2 && (
            <div className="list">
              {isFetching && <p className="state">Ищем…</p>}
              {/* «Никого не нашли» перед НЕОБРАТИМЫМ объединением обязано
                  означать настоящий ответ сервера, а не упавший поиск
                  (аудит 22.08.2026, раунд 5). */}
              {searchFailed && (
                <p className="state err">
                  Поиск не удался, не видно, есть ли такая карточка. Повторите, прежде чем объединять.
                </p>
              )}
              {!isFetching && !searchFailed && candidates.length === 0 && <p className="state">Никого не нашли</p>}
              {candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="row"
                  onClick={() => setTarget({ id: c.id, fullName: c.fullName, phone: c.phone })}
                >
                  <div className="t">
                    {/* Роль перед именем и приставка в номере: объединение
                        НЕОБРАТИМО, и «Покупатель Далер ПК-000227» против
                        «Продавец Далер ПР-000229» — единственное, что здесь
                        отличает две похожие карточки друг от друга. */}
                    <b>{formatClientName(c)}</b>
                    <span>
                      {formatClientCode(c.shortId, c.kind)} · {c.phone}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {error && (
        <p className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </p>
      )}
    </Rh2Sheet>
  );
}
