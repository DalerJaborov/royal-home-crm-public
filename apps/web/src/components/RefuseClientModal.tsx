import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  REASONS_REQUIRING_COMPETITOR,
  REFUSAL_INITIATORS,
  REFUSAL_INITIATOR_LABELS,
  selectableRefusalReasonsFor,
  REFUSAL_REASON_LABELS,
  type RefusalInitiator,
  type RefusalReason,
} from "@royal-home/shared";
import { useRefuseClient } from "../hooks/useClients";
import { VoiceNoteButton, type VoiceNote } from "./VoiceNoteButton";
import { CommentWithVoice } from "./CommentWithVoice";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { toast } from "../store/toast";
import type { Client } from "../types";
import { useCanViewInvestigations } from "../lib/permissions";

/**
 * «Завершить сделку → Без сделки» (ТЗ п. 16-18, переработка 12.08.2026 из бывшего
 * «Клиент отказался») — причина обязательна выбором из вариантов: следующий, более
 * опытный агент должен понимать контекст, а не начинать вслепую.
 *
 * Комментарий НЕОБЯЗАТЕЛЕН (владелец 18.08.2026: «упрости максимум» — было
 * обязательным при любой причине с 11.08.2026, но оказалось лишней преградой:
 * агенты застревали на форме, отказ откладывался). Причина из списка уже
 * называет суть; комментарий — место для деталей, кто хочет их оставить.
 *
 * Автопередача следующему агенту по очереди KPI — тоже настройкой
 * (Settings.autoRouteRefusedLeads, по умолчанию ВЫКЛЮЧЕНА тем же решением
 * 18.08.2026): выключено — карточка уходит на ручное назначение руководителем,
 * а не автоматике, пока с потоком отказов не разобрались.
 *
 * «Что приобрёл клиент?» — при «Купил самостоятельно» (ТЗ п. 18), необязательно:
 * «агент МОЖЕТ указать», а не обязан.
 *
 * После отказа сервер сам передаёт лид следующему агенту по очереди KPI (после
 * третьего отказа — руководству), поэтому по успеху уводим агента в список:
 * карточка, скорее всего, уже не его и ответила бы 403.
 *
 * Стекло подложки, о котором владелец просил 18.08.2026 («сделай бело нормальное
 * стеклянное окно»), теперь даёт сама тема: `.sheet-back` размывает фон, а
 * `.sheet` — полупрозрачное стекло с обводкой.
 */
export function RefuseClientModal({ client, onClose }: { client: Client; onClose: () => void }) {
  const investigations = useCanViewInvestigations();
  const refuse = useRefuseClient(client.id);
  const navigate = useNavigate();
  const [reason, setReason] = useState<RefusalReason | null>(null);
  const [initiator, setInitiator] = useState<RefusalInitiator | null>(null);
  const [competitorName, setCompetitorName] = useState("");
  const [boughtWhat, setBoughtWhat] = useState("");
  const [comment, setComment] = useState("");
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsCompetitor = !!reason && (REASONS_REQUIRING_COMPETITOR as readonly string[]).includes(reason);
  const needsBoughtWhat = reason === "BOUGHT_SELF";

  async function submit() {
    if (client.assignmentRefusedAt) {
      setError("Результат этой работы уже сохранён");
      return;
    }
    if (!reason) {
      setError("Выберите причину, без неё передать лид нельзя");
      return;
    }
    // Инициатор решает, уйдёт карточка в службу безопасности или следующему агенту
    // (спецификация владельца 01.08.2026), поэтому он обязателен.
    if (!initiator) {
      setError("Укажите, кто завершил работу с клиентом");
      return;
    }
    if (needsCompetitor && !competitorName.trim()) {
      setError("Укажите, через какое агентство прошла сделка");
      return;
    }
    setError(null);
    try {
      const result = await refuse.mutateAsync({
        reason,
        initiator,
        comment: comment.trim(),
        competitorName: competitorName.trim() || undefined,
        boughtWhat: reason === "BOUGHT_SELF" ? boughtWhat.trim() || undefined : undefined,
        voiceNoteUrl: voiceNote?.url,
        voiceNoteTranscript: voiceNote?.transcript ?? undefined,
      });
      // Как и в передаче: результат сообщаем всплывающим уведомлением. Через
      // location.state его никто не читал, и агент не узнавал, ушла ли карточка
      // следующему агенту, руководству или в службу безопасности.
      toast.success(investigations ? result.message : "Результат работы сохранён");
      navigate("/clients");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось оформить отказ");
    }
  }

  return (
    <Rh2Sheet
      title={`Без сделки: ${client.fullName}`}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="pill ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="pill" disabled={refuse.isPending || !!client.assignmentRefusedAt}>
            {refuse.isPending ? "Оформление…" : "Завершить без сделки"}
          </button>
        </>
      }
    >
      <p className="state">
        Выберите причину: следующий человек, кто откроет карточку, должен понимать, на чём сорвалось.
      </p>

      <div className="sec-t">Причина</div>
      {/* Только причины, подходящие типу карточки: покупателю не предлагаем
          «Продал самостоятельно» и прочие продавцовские. */}
      {selectableRefusalReasonsFor(client.kind).map((r) => (
        <label key={r} className="chk">
          <input type="radio" name="refusal-reason" checked={reason === r} onChange={() => setReason(r)} />
          {REFUSAL_REASON_LABELS[r]}
        </label>
      ))}

      {/* КТО ЗАВЕРШИЛ РАБОТУ. От этого зависит, уйдёт карточка следующему агенту
          или на проверку службы безопасности (спецификация владельца 01.08.2026),
          поэтому поле обязательное, а не справочное. */}
      <div className="sec-t">Кто завершил работу</div>
      <div className="filters">
        {REFUSAL_INITIATORS.map((i) => (
          <label key={i} className="chk">
            <input type="radio" name="refusal-initiator" checked={initiator === i} onChange={() => setInitiator(i)} />
            {REFUSAL_INITIATOR_LABELS[i]}
          </label>
        ))}
      </div>

      <div className="sec-t">Подробности</div>

      {/* Название конкурента — только там, где сделка ушла на сторону. Иначе
          разбор потерь строить не на чем: «ушёл к конкурентам» без имени
          одинаково подходит ко всем. */}
      {needsCompetitor && (
        <label className="fld">
          <span className="lab">Через какое агентство прошла сделка</span>
          <input
            value={competitorName}
            onChange={(e) => setCompetitorName(e.target.value)}
            maxLength={200}
            placeholder="Название агентства"
          />
        </label>
      )}

      {/* «Что приобрёл клиент?» — только при «Купил самостоятельно» (ТЗ п. 18).
          Необязательно: по ТЗ агент «может указать», а он часто и не знает. */}
      {needsBoughtWhat && (
        <label className="fld" style={{ marginTop: "var(--s3)" }}>
          <span className="lab">Что приобрёл клиент? (если известно)</span>
          <input
            value={boughtWhat}
            onChange={(e) => setBoughtWhat(e.target.value)}
            maxLength={500}
            placeholder="Объект или тип недвижимости"
          />
        </label>
      )}

      <div className="fld" style={{ marginTop: "var(--s3)" }}>
        <span className="lab">Комментарий (необязательно)</span>
        <CommentWithVoice
          value={comment}
          onChange={setComment}
          placeholder="Что именно произошло, если есть что добавить, увидит руководство в «Потерянных клиентах»"
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
