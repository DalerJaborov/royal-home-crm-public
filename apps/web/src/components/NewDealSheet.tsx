import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { useClients } from "../hooks/useClients";
import { useProperties } from "../hooks/useProperties";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { formatPropertyCode } from "../lib/clientFormat";
import type { Client } from "../types";

/**
 * «Новая сделка» — выбор клиента и объекта (23.09.2026).
 *
 * ЗАЧЕМ. Агенты не находили, где заводится сделка: кнопка «Новая сделка» на
 * доске уводила в список клиентов, на карточке клиента было только «Завершить
 * сделку» за ⋮ и после показа, а на странице объекта форма пряталась за
 * режимом правки. Шторка собирает оба выбора в одном месте.
 *
 * ОДНА ФОРМА СОЗДАНИЯ. Сама сделка по-прежнему заводится блоком «Сделка по
 * объекту» на странице объекта (AssignClientCard в PropertyDetail.tsx): там
 * видны цена и условия объекта. Шторка только подводит туда с уже выбранным
 * клиентом (`state.clientId`), второй формы создания здесь нет — две формы
 * разошлись бы в правилах так же, как разошлись два редактора объекта.
 *
 * `client` передан — шаг выбора клиента пропускается (кнопка на карточке
 * клиента). Первыми идут объекты, которые клиенту показывали.
 */
/** Кнопка-строка в шторке по умолчанию центрирует текст; список читается слева. */
const ROW = { textAlign: "left", justifyContent: "flex-start", width: "100%" } as const;

export function NewDealSheet({ client, onClose }: { client?: Client; onClose: () => void }) {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<Pick<Client, "id" | "fullName" | "interactions"> | null>(client ?? null);
  const [clientQuery, setClientQuery] = useState("");
  const [propertyQuery, setPropertyQuery] = useState("");
  const clientQ = useDebouncedValue(clientQuery.trim());
  const propertyQ = useDebouncedValue(propertyQuery.trim());

  const clients = useClients({ kind: "BUYER", q: clientQ || undefined, pageSize: 20 }, !picked);
  const properties = useProperties({ q: propertyQ || undefined, status: "AVAILABLE" }, !!picked);

  const shown = picked
    ? Array.from(
        new Map(
          (picked.interactions ?? [])
            .filter((i) => i.type === "SHOWING" && i.property?.shortId)
            .map((i) => [i.property!.shortId!, i.property!])
        ).values()
      )
    : [];
  const shownIds = new Set(shown.map((p) => p.shortId));

  function openProperty(shortId: number) {
    if (!picked) return;
    onClose();
    navigate(`/properties/${shortId}`, { state: { openDealAssign: true, clientId: picked.id, clientName: picked.fullName } });
  }

  return (
    <Rh2Sheet title={picked ? `Сделка: ${picked.fullName}` : "Новая сделка"} onClose={onClose}>
      {!picked ? (
        <>
          <p className="state">Шаг 1 из 2. С кем сделка?</p>
          <label className="fld">
            <span className="lab">Покупатель</span>
            <input
              type="search"
              value={clientQuery}
              onChange={(e) => setClientQuery(e.target.value)}
              placeholder="Имя или номер карточки"
              autoFocus
            />
          </label>
          <div className="list" style={{ marginTop: 12 }}>
            {clients.isLoading && <p className="state">Загрузка…</p>}
            {clients.data?.items.length === 0 && <p className="state">Никого не нашли.</p>}
            {clients.data?.items.map((c) => (
              <button key={c.id} type="button" className="row" style={ROW} onClick={() => setPicked(c)}>
                <div className="t">
                  <b>{c.fullName}</b>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="state">
            {client ? "По какому объекту сделка?" : "Шаг 2 из 2. По какому объекту?"} Сделка заведётся на странице
            объекта, клиент уже будет выбран.
          </p>
          {shown.length > 0 && (
            <>
              <div className="sec-t">Показывали этому клиенту</div>
              <div className="list">
                {shown.map((p) => (
                  <button key={p.shortId} type="button" className="row" style={ROW} onClick={() => openProperty(p.shortId!)}>
                    <div className="t">
                      <b>{p.title}</b>
                      <span>{formatPropertyCode(p.shortId!)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
          <label className="fld" style={{ marginTop: 12 }}>
            <span className="lab">Другой объект из каталога</span>
            <input
              type="search"
              value={propertyQuery}
              onChange={(e) => setPropertyQuery(e.target.value)}
              placeholder="Номер, название, адрес"
            />
          </label>
          <div className="list" style={{ marginTop: 12 }}>
            {properties.isLoading && <p className="state">Загрузка…</p>}
            {properties.data?.items.length === 0 && <p className="state">Ничего не нашли.</p>}
            {properties.data?.items
              .filter((p) => !shownIds.has(p.shortId))
              .map((p) => (
                <button key={p.id} type="button" className="row" style={ROW} onClick={() => openProperty(p.shortId)}>
                  <div className="t">
                    <b>{p.title}</b>
                    <span>{formatPropertyCode(p.shortId)}</span>
                  </div>
                </button>
              ))}
          </div>
        </>
      )}
    </Rh2Sheet>
  );
}
