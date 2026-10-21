import { useIsReadOnly } from "../../lib/permissions";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ClientStatus, MatchingClient } from "@royal-home/shared";
import { ClientAvatar } from "../ClientAvatar";
import { ClientStateBadge } from "../ClientStateBadge";
import { ConfirmDialog } from "../ConfirmDialog";
import { useSendProperties, useSendTarget } from "../../hooks/useClients";
import { SendFallback, sendFallbackOf } from "./SendFallback";
import type { SendPropertiesFallback } from "@royal-home/shared";
import { useSendPropertyConfirm } from "../../hooks/useSendPropertyConfirm";

/**
 * Строка покупателя панели «Подбор», режим объекта (задание D, 17.09.2026,
 * `docs/agent-briefs/match-17-09-D-web-panel.md`).
 *
 * Перенесено из `MatchingClientsCard.tsx` (файл удалён): причины через «·»,
 * балл совпадения, «Отдать». Добавлено `assignedAgentName` — новое поле
 * контракта (раздел 6 плана матчинга), читается как `?? null`, отсутствие не
 * рисуется — сервер мог ещё не прислать его.
 *
 * ОТПРАВКА ЖИВЁТ В САМОЙ СТРОКЕ, а не поднята в панель: `useSendProperties`
 * привязан к id клиента при вызове хука, а строк в списке несколько сразу —
 * значит и хук должен жить в компоненте строки (каждая строка — свой
 * экземпляр), а не в общем родителе на один клиентский id.
 *
 * Вся строка кликабельна — та же причина, что у `MatchPropertyCard`: владелец
 * просил карточки, по которым не нужно искать, а сразу нажимать.
 */
export function MatchClientCard({
  client: c,
  propertyId,
  propertyTitle,
  onGive,
  giving,
  given,
  canGive,
  responsibleAgentName,
  onClosePanel,
}: {
  client: MatchingClient;
  /** Объект, который отправляем этому клиенту в один клик («Отправить объект»). */
  propertyId: string;
  /** Для текста подтверждения отправки — «объект №N» ничего не говорит без названия. */
  propertyTitle?: string;
  onGive?: () => void;
  giving?: boolean;
  given?: boolean;
  canGive?: boolean;
  /** Для текста подтверждения «Отдать» — кому именно уходит клиент. */
  responsibleAgentName?: string;
  onClosePanel?: () => void;
}) {
  const navigate = useNavigate();
  const readOnly = useIsReadOnly();
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const sendProperties = useSendProperties(c.id);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<{ message: string; fallback: SendPropertiesFallback | null } | null>(null);
  // Куда/можно ли СМС — спрашиваем только после отказа: заранее это десять
  // лишних запросов на каждое открытие подборки объекта.
  const target = useSendTarget(c.id, undefined, !!failure?.fallback);
  const sendConfirm = useSendPropertyConfirm();
  const [giveConfirmOpen, setGiveConfirmOpen] = useState(false);

  function open() {
    navigate(`/clients/${c.shortId}`);
    onClosePanel?.();
  }

  async function doSend() {
    if (readOnlyRef.current) return;
    setFailure(null);
    try {
      await sendProperties.mutateAsync({ propertyIds: [propertyId] });
      setSent(true);
    } catch (err) {
      setFailure({ message: err instanceof Error ? err.message : "Не удалось отправить", fallback: sendFallbackOf(err) });
    }
  }

  function send() {
    if (readOnlyRef.current) return;
    sendConfirm.request(
      doSend,
      `Клиент ${c.fullName} сразу получит сообщение со ссылкой${
        propertyTitle ? ` на «${propertyTitle}»` : ""
      } в тот мессенджер, где писал последним. Бот в этом диалоге после этого больше не отвечает — дальше переписку ведёте вы.`
    );
  }

  function confirmGive() {
    if (readOnlyRef.current) return;
    setGiveConfirmOpen(false);
    onGive?.();
  }

  return (
    <div>
      <div
        className="prow"
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
      >
        <span className="ph" style={{ borderRadius: "50%" }}>
          <ClientAvatar fullName={c.fullName} size={40} />
        </span>
        <div className="t">
          <b>{c.fullName}</b>
          <span style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 2 }}>
            <ClientStateBadge client={{ ...c, status: c.status as ClientStatus }} />
            {c.reasons.length > 0 && <span>{c.reasons.join(" · ")}</span>}
          </span>
        </div>
        <div className="who">
          <span className={c.score >= 75 ? "chip ok" : "chip"}>Совпало {c.score}%</span>
          {c.assignedAgentName && <span>{c.assignedAgentName}</span>}
        </div>
        <div className="act" onClick={(e) => e.stopPropagation()}>
          {sent ? (
            <span className="chip ok">Отправлено</span>
          ) : (
            <button
              type="button"
              className="pill ghost sm"
              onClick={send}
              disabled={readOnly || sendProperties.isPending}
              title="Отправить этому клиенту ссылку на объект"
            >
              {sendProperties.isPending ? "Отправляю…" : "Отправить"}
            </button>
          )}
          {onGive &&
            (given ? (
              <span className="chip ok">Отдан</span>
            ) : (
              !readOnly && canGive && (
                <button
                  type="button"
                  className="pill ghost sm"
                  onClick={() => setGiveConfirmOpen(true)}
                  disabled={giving}
                  title="Отдать ответственному за объект"
                >
                  Отдать
                </button>
              )
            ))}
        </div>
      </div>
      {!readOnly && failure && (
        <div onClick={(e) => e.stopPropagation()}>
          {failure.fallback ? (
            <SendFallback
              clientId={c.id}
              message={failure.message}
              fallback={failure.fallback}
              smsAvailable={target.data?.smsAvailable ?? false}
              onDone={() => setSent(true)}
            />
          ) : (
            <p className="quiet crit" role="alert">
              <span className="dot crit" />
              <span className="txt">{failure.message}</span>
            </p>
          )}
        </div>
      )}
      {!readOnly && sendConfirm.open && (
        <ConfirmDialog
          title="Отправить объект клиенту"
          description={sendConfirm.description}
          confirmLabel="Отправить"
          danger={false}
          onConfirm={sendConfirm.confirm}
          onCancel={sendConfirm.cancel}
        />
      )}
      {!readOnly && giveConfirmOpen && (
        <ConfirmDialog
          title="Отдать клиента"
          description={`Клиент ${c.fullName} сразу уйдёт${
            responsibleAgentName ? ` агенту ${responsibleAgentName}` : " ответственному за объект"
          } как новый лид — заберётся у текущего агента, таймер на принятие начнётся заново.`}
          confirmLabel="Отдать"
          onConfirm={confirmGive}
          onCancel={() => setGiveConfirmOpen(false)}
        />
      )}
    </div>
  );
}
