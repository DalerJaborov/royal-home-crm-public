import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTransferClient } from "../hooks/useClients";
import { useSettings } from "../hooks/useSettings";
import { VoiceNoteButton, type VoiceNote } from "./VoiceNoteButton";
import { CommentWithVoice } from "./CommentWithVoice";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { toast } from "../store/toast";
import type { Client } from "../types";

/**
 * «Передача» (ТЗ п. 19-21, голосовое уточнение владельца 12.08.2026): агент решает
 * не продолжать вести клиента.
 *
 * СУЖЕНО ДО ОДНОЙ ПРИЧИНЫ (задача F, план 03-04.09.2026, решение владельца):
 * раньше здесь был выбор из восьми причин («не справляюсь», «нужен другой
 * объект»…), но «дорого»/«финансы»/«не подошли объекты» уводили клиента другому
 * агенту, хотя это обычный исход рынка, а не повод сменить человека — такие
 * случаи теперь идут через «Завершить сделку → Без сделки» и уходят в
 * «Отложенные» (см. RefuseClientModal, lib/deferredClients.ts на сервере).
 * «Передача» осталась ровно для одного случая, который реально решается сменой
 * агента: с клиентом не сложился контакт (NO_TRUST) — z.literal("NO_TRUST") на
 * границе API (packages/shared/src/schemas.ts), не только в интерфейсе. Выбора
 * причины в форме больше нет — нечего выбирать из одного варианта.
 *
 * ГЕЙТ СНИЖЕН 22.08.2026 (мозговой штурм владельца, «рубеж 2: дверь передачи,
 * которой сейчас нет»): раньше требовался обязательно проведённый показ, теперь
 * достаточно хотя бы одной попытки реального контакта (звонок с ответом или
 * переписка) — кнопка рендерится в ClientDetail при hadRealContact, окончательно
 * проверяет сервер (lib/clientTransfer.ts::canTransferClient).
 */
export function TransferClientModal({ client, onClose }: { client: Client; onClose: () => void }) {
  const transfer = useTransferClient(client.id);
  const navigate = useNavigate();
  const [comment, setComment] = useState("");
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: settings } = useSettings();
  /** Предел переходов клиента между агентами (ТЗ п. 21). 0 — предел выключен. */
  const maxTransfers = settings?.leadMaxTransfers ?? 0;
  // refusalCount — общий счётчик переходов между агентами (и передачи, и отказы),
  // тот же, по которому сервер решает, исчерпан ли предел (lib/leadTransfers.ts).
  const transferNo = (client.refusalCount ?? 0) + 1;
  const isLastTransfer = maxTransfers > 0 && transferNo >= maxTransfers;

  async function submit() {
    setError(null);
    try {
      const result = await transfer.mutateAsync({
        reason: "NO_TRUST",
        comment: comment.trim() || undefined,
        voiceNoteUrl: voiceNote?.url,
        voiceNoteTranscript: voiceNote?.transcript ?? undefined,
      });
      /**
       * Результат — всплывающим уведомлением, а не через location.state.
       *
       * Раньше сообщение уходило в `state: { notice }`, но `notice` во всём вебе
       * никто не читал: агента молча выбрасывало в список, и он не узнавал ни
       * того, что клиент передан следующему агенту, ни того, что передач больше
       * не осталось и карточка ушла в «Потерянные».
       */
      toast.success(result.message);
      navigate("/clients");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось передать клиента");
    }
  }

  return (
    <Rh2Sheet
      title={`Передать клиента: ${client.fullName}`}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="pill ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="pill" disabled={transfer.isPending}>
            {transfer.isPending ? "Передача…" : "Передать клиента"}
          </button>
        </>
      }
    >
      <p className="state">
        Причина одна: с клиентом не сложился контакт. Клиент уйдёт со всей историей (карточка, звонки, показы)
        следующему агенту по очереди KPI. Это не отказ: работу продолжит другой агент с того места, где вы
        остановились. Другие причины («дорого», «не подошли объекты», «не хватает времени») сюда больше не входят —
        если дело в цене или объектах, закройте карточку через «Завершить сделку → Без сделки».
      </p>

      {/* ПРЕДЕЛ ПЕРЕДАЧ (ТЗ п. 21) — на глазах у агента, а не сюрпризом. Раньше
          окно обещало «клиент остаётся горячим», а на последней передаче сервер
          ставил статус «Потерянный»: агент узнавал об этом уже по факту. */}
      {maxTransfers > 0 && (
        <p className={isLastTransfer ? "quiet crit" : "quiet"}>
          <span className={isLastTransfer ? "dot crit" : "dot"} />
          <span className="txt">
            {isLastTransfer
              ? `Это последняя допустимая передача (${transferNo}-я из ${maxTransfers}). Если и следующий агент не справится, клиент уйдёт в «Потерянные» и распределяться больше не будет.`
              : `Передача ${transferNo}-я из ${maxTransfers} допустимых. После последней клиент уходит в «Потерянные».`}
          </span>
        </p>
      )}

      <div className="fld" style={{ marginTop: "var(--s4)" }}>
        <span className="lab">Комментарий</span>
        <CommentWithVoice
          value={comment}
          onChange={setComment}
          placeholder="Что стоит знать следующему агенту (необязательно)"
        />
        <VoiceNoteButton uploadUrl="/me/voice-notes" value={voiceNote} onChange={setVoiceNote} />
      </div>

      {error && (
        <p className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </p>
      )}
    </Rh2Sheet>
  );
}
