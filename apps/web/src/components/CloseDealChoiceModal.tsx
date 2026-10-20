import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { RefuseClientModal } from "./RefuseClientModal";
import { formatPropertyCode } from "../lib/clientFormat";
import type { Client } from "../types";

/**
 * «Завершить сделку» (ТЗ п. 16-18) — доступна только после первого проведённого
 * показа (гейт — в ClientDetail, по hadShowing). Два исхода: «Успешно» переводит
 * агента на карточку объекта, где сделка создаётся уже существующей формой
 * (PropertyDetail — резерв на 3 рабочих дня заводится там же); «Без сделки»
 * открывает форму причин (см. RefuseClientModal, бывшая «Клиент отказался»).
 *
 * Облик — шторка темы 2026 (Rh2Sheet): ловушка фокуса, Esc, неподвижный фон и
 * смахивание на телефоне остались там, где были, — внутри шторки.
 *
 * ПЕРЕХОД НЕС ЁТ `state.openDealAssign` (18.09.2026, жалоба владельца «не
 * сработало» — три скриншота, клиент Умед/ОБ-000086). Карточка объекта
 * открывалась в режиме ПРОСМОТРА: блок «Назначить клиенту» рисуется только
 * при `isEditMode === true` (PropertyDetail.tsx), а тот по умолчанию false и
 * включается только явным кликом по карандашу «Изменить». Агент, пришедший
 * сюда специально завершать сделку, этой кнопки не видел вовсе — предыдущий
 * фикс (редирект на /deals после создания) был некуда применить, форма
 * создания сделки на экране не появлялась. `clientId` в state — чтобы
 * PropertyDetail сразу подставил того же клиента в селект, а не заставлял
 * агента искать его повторно в выпадающем списке из двух сотен покупателей.
 */
export function CloseDealChoiceModal({ client, onClose }: { client: Client; onClose: () => void }) {
  const navigate = useNavigate();
  const [showRefuse, setShowRefuse] = useState(false);

  // Объекты, которые показывали этому клиенту — оттуда агент продолжает уже
  // существующей формой создания сделки.
  const shownProperties = Array.from(
    new Map(
      (client.interactions ?? [])
        .filter((i) => i.type === "SHOWING" && i.property?.shortId)
        .map((i) => [i.property!.shortId, i.property!])
    ).values()
  );

  if (showRefuse) return <RefuseClientModal client={client} onClose={onClose} />;

  return (
    <Rh2Sheet
      title={`Завершить сделку: ${client.fullName}`}
      onClose={onClose}
      footer={
        <button type="button" className="pill ghost" onClick={() => setShowRefuse(true)}>
          Без сделки, указать причину
        </button>
      }
    >
      <p className="state">Чем закончилась работа с клиентом?</p>

      {shownProperties.length > 0 ? (
        <>
          <div className="sec-t">Успешно: выберите объект, сделка оформляется на его странице</div>
          <div className="list">
            {shownProperties.map((p) => (
              <button
                key={p.shortId}
                type="button"
                className="row"
                onClick={() =>
                  navigate(`/properties/${p.shortId}`, { state: { openDealAssign: true, clientId: client.id, clientName: client.fullName } })
                }
              >
                <div className="t">
                  <b>{p.title}</b>
                  <span>{formatPropertyCode(p.shortId!)}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        /**
         * Показ был, но объект в нём не указан — «Успешно» отсюда собрать не
         * из чего. Раньше здесь стояла фраза «открыть карточку объекта, чтобы
         * создать сделку, отсюда нельзя», и она была тупиком: агент не знал,
         * ни почему список пуст, ни что делать дальше. Даём и объяснение, и
         * выход — каталог объектов.
         */
        <>
          <div className="sec-t">Успешно</div>
          <p className="state">
            В показах этого клиента не указан объект, поэтому выбрать его здесь не из чего. Найдите объект в каталоге и
            оформите сделку на его странице.
          </p>
          <button type="button" className="pill soft" onClick={() => navigate("/properties")}>
            Открыть каталог объектов
          </button>
        </>
      )}
    </Rh2Sheet>
  );
}
