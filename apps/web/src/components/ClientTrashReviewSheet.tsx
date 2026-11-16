import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { CallClientButton } from "./CallClientButton";
import { InteractionTimeline } from "./InteractionTimeline";
import { useClientTrashReview } from "../hooks/useClients";
import { exactDateTime } from "../lib/format";
import { useCan } from "../lib/permissions";

/**
 * «РАЗБОР УДАЛЁННОГО КЛИЕНТА» (владелец 16.11.2026): РОП открывает карточку из Корзины, чтобы
 * понять, почему клиент там и что с ним сделал агент, и при желании сразу позвонить ему через АТС.
 *
 * Одна шторка на ПК и телефон (Rh2Sheet сам становится нижней шторкой на узком экране).
 * Карточка удалённого клиента обычно закрыта (404), поэтому данные идут отдельной ручкой
 * GET /clients/trash/:id/review; номер здесь не показывается, звонит станция.
 */
export function ClientTrashReviewSheet({
  clientId,
  phone,
  onClose,
}: {
  clientId: string;
  /** Маска из списка Корзины: нужна только кнопке «Позвонить», набирает станция. */
  phone: string;
  onClose: () => void;
}) {
  const can = useCan();
  const { data, isLoading, isError, refetch } = useClientTrashReview(clientId);
  const canCall = can("clients.callArchived") && (data?.canCall ?? true);

  return (
    <Rh2Sheet
      onClose={onClose}
      wide
      title={data ? `Разбор: ${data.client.fullName}` : "Разбор удалённого клиента"}
      // «Закрыть» уже есть в шапке шторки; в подвале остаётся только звонок.
      footer={
        canCall ? (
          <CallClientButton
            clientId={clientId}
            phone={phone}
            variant="full"
            label="Позвонить клиенту"
            className="pill"
            title="Звонок идёт через АТС. Карточка останется в Корзине"
          />
        ) : undefined
      }
    >
      {isLoading && <p className="sub">Загружаем историю…</p>}
      {isError && (
        <p className="sub">
          Не удалось загрузить разбор.{" "}
          <button className="lk" type="button" onClick={() => void refetch()}>
            Повторить
          </button>
        </p>
      )}
      {data && (
        <div style={{ display: "grid", gap: 16 }}>
          <section className="card flat" style={{ padding: "12px 14px" }}>
            <h3 className="sec-t">Что случилось</h3>
            <dl style={{ display: "grid", gap: 6, margin: 0 }}>
              <div>
                <dt className="quiet">Кто удалил</dt>
                <dd style={{ margin: 0 }}>
                  {data.client.deletedBy
                    ? data.client.deletedBy.fullName
                    : data.client.deletedAutomatically
                      ? "Автоматически (система)"
                      : "Не записано"}
                  {data.client.deletedAt ? `, ${exactDateTime(data.client.deletedAt)}` : ""}
                </dd>
              </div>
              <div>
                <dt className="quiet">Чей клиент был</dt>
                <dd style={{ margin: 0 }}>{data.client.owner?.fullName ?? "Агент не назначен"}</dd>
              </div>
              <div>
                <dt className="quiet">Причина</dt>
                <dd style={{ margin: 0 }}>
                  {data.deleteRequest ? (
                    <>
                      {data.deleteRequest.reasonLabel}
                      {data.deleteRequest.comment ? `. ${data.deleteRequest.comment}` : ""}
                      <span className="quiet">
                        {" "}
                        Просил {data.deleteRequest.requestedBy.fullName}, {exactDateTime(data.deleteRequest.createdAt)}
                        {data.deleteRequest.decidedBy ? `; решил ${data.deleteRequest.decidedBy.fullName}` : ""}
                      </span>
                    </>
                  ) : (
                    "Причина не указана: заявки на удаление нет. Позвоните клиенту и уточните."
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <section className="card flat" style={{ padding: "12px 14px" }}>
            <h3 className="sec-t">Что делали с карточкой</h3>
            {data.audit.length === 0 ? (
              <p className="quiet">В журнале действий записей нет.</p>
            ) : (
              <div className="list">
                {data.audit.map((a) => (
                  <div className="row" key={a.id}>
                    <div className="t">
                      <b>{a.label}</b>
                      <span>
                        {a.agentName}, {exactDateTime(a.createdAt)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card flat" style={{ padding: "12px 14px" }}>
            <h3 className="sec-t">Заметки и звонки</h3>
            {data.interactions.length === 0 ? (
              <p className="quiet">Записей нет.</p>
            ) : (
              <InteractionTimeline
                interactions={data.interactions}
                clientId={clientId}
                total={data.interactionsTotal}
                truncated={data.hasMore === true}
                timelinePath={`/clients/trash/${clientId}/review/timeline`}
              />
            )}
          </section>
        </div>
      )}
    </Rh2Sheet>
  );
}
