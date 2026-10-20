import { useState } from "react";
import { FileText, Lightbulb, Play } from "lucide-react";
import { MutationError } from "../../components/MutationError";
import { Rh2Sheet } from "../../components/rh2/Rh2Sheet";
import {
  useRehearseLeadMagnet,
  type LeadMagnetCampaignRow,
  type RehearsalStep,
} from "../../hooks/useLeadMagnets";

/**
 * Репетиция кампании — прогон подставным комментарием до запуска рекламы.
 *
 * Без неё первый настоящий прогон случается на оплаченном трафике: ключевое слово
 * не поймало живую фразу или текст читается не так — и это выясняется на людях,
 * пришедших за деньги. Здесь владелец пишет комментарий «как клиент», выбирает,
 * подписан ли он, и видит переписку ровно в том порядке, в каком её увидит человек.
 *
 * Считает всё сервер тем же кодом, что и боевой путь, — репетиция своей копией
 * логики через месяц репетировала бы другую воронку.
 *
 * Разметка — эталон темы «Royal Home 2026»: шторка `.sheet.right` с шапкой
 * `.sheet-h` и телом `.sheet-b`, переписка — пузыри `.bub` в ленте `.thread`.
 * Шторка рисуется здесь же, внутри области темы `.rh2` родительского экрана, —
 * не порталом в body, иначе классы макета к ней не применились бы.
 */
export function FunnelRehearsal({
  campaign,
  onClose,
}: {
  campaign: LeadMagnetCampaignRow;
  onClose: () => void;
}) {
  const [comment, setComment] = useState("");
  const [following, setFollowing] = useState<"yes" | "no" | "unknown">("yes");
  const rehearse = useRehearseLeadMagnet();

  function run() {
    rehearse.mutate({ id: campaign.id, comment, following });
  }

  // Общий корпус окон CRM, а не своя разметка: ловушка фокуса здесь была своя,
  // но ни Esc, ни неподвижного фона, ни возврата фокуса на вызвавшую кнопку.
  return (
    <Rh2Sheet
      onClose={onClose}
      title={`Репетиция: ${campaign.name}`}
      ariaLabel={`Репетиция кампании «${campaign.name}»`}
    >
    <label className="fld">
      <span className="lab">Напишите комментарий как клиент</span>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        maxLength={500}
        placeholder="хочу чек-лист пожалуйста"
      />
    </label>

    <fieldset style={{ border: 0, padding: 0, margin: "var(--s4) 0 0" }}>
      <legend className="lab" style={{ marginBottom: 6 }}>
        Этот человек подписан на нас?
      </legend>
      <div className="seg" role="group" aria-label="Этот человек подписан на нас?">
        {(
          [
            ["yes", "Подписан"],
            ["no", "Не подписан"],
            ["unknown", "Instagram не ответил"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFollowing(value)}
            aria-selected={following === value}
          >
            {label}
          </button>
        ))}
      </div>
    </fieldset>

    <div className="wrap" style={{ marginTop: "var(--s4)" }}>
      <button className="pill" type="button" onClick={run} disabled={rehearse.isPending}>
        <Play className="i" aria-hidden="true" />
        {rehearse.isPending ? "Прогоняем…" : "Прогнать"}
      </button>
    </div>

    <MutationError mutation={rehearse} fallback="Репетиция не запустилась" variant="rh2" />

    {rehearse.data && (
      <>
        {!rehearse.data.enabled && (
          <div className="quiet warn" role="status">
            <span className="dot warn" />
            <span className="txt">
              Кампания сейчас выключена: в жизни этот сценарий не сработает, пока вы её не включите.
            </span>
          </div>
        )}
        <div className="thread" style={{ marginTop: "var(--s3)" }}>
          {rehearse.data.steps.map((step, i) => (
            <Step key={i} step={step} />
          ))}
        </div>
      </>
    )}
    </Rh2Sheet>
  );
}

function Step({ step }: { step: RehearsalStep }) {
  if (step.who === "note") {
    return (
      <p className="quiet">
        <Lightbulb className="i" style={{ color: "var(--warn-dot)" }} aria-hidden="true" />
        <span className="txt">{step.text}</span>
      </p>
    );
  }
  const us = step.who === "us";
  return (
    <div className={`bub${us ? " me" : ""}`}>
      <span className="who">{step.place === "comment" ? "под постом" : "в директе"}</span>
      <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{step.text}</span>
      {step.file && (
        <span className="chip" style={{ marginTop: 6 }}>
          <FileText className="i" style={{ width: 12, height: 12 }} aria-hidden="true" />
          {step.file}
        </span>
      )}
      {step.button && (
        <span className="chip hot" style={{ marginTop: 6 }}>
          {step.button}
        </span>
      )}
    </div>
  );
}
