import { Fragment, type CSSProperties, type ReactNode } from "react";
import type { AssistantActionView, AssistantCard } from "@royal-home/shared";
import { AssistantCardList } from "../AssistantCards";
import { renderAssistantContent } from "../assistantContent";
import { stepLabel, type ThreadMessage, type TurnStep } from "./assistantTurn";

/**
 * ЛЕНТА РАЗГОВОРА ПАНЕЛИ ПОМОЩНИКА — одна разметка на телефон и ПК (П4а).
 *
 * Порядок внутри реплики помощника: текст → карточки результата → карточки
 * действий (`confirm`) — подтверждение привязано к реплике, которая о нём
 * говорит. Текущий ход: лента шагов (`.chip`, пройденные с «✓»), живой пузырь
 * с текстом по мере генерации (события `token`), то, что уже пришло.
 */

export interface LiveTurn {
  pending: boolean;
  steps: TurnStep[];
  /** Накопленный текст ответа (поток токенов); пусто — ещё не начал писать. */
  text: string;
  cards: AssistantCard[];
  actions: AssistantActionView[];
}

const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export function AssistantThread({
  messages,
  live,
  onNavigate,
  onStop,
  renderAction,
}: {
  messages: ThreadMessage[];
  live: LiveTurn;
  onNavigate: () => void;
  onStop: () => void;
  renderAction: (action: AssistantActionView) => ReactNode;
}) {
  // Диктору объявляем только итог: строку статуса хода и готовый ответ. Поток
  // токенов и карточки в живую область не попадают (карточка говорит сама).
  const lastReply = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const announce = live.pending ? (live.steps[live.steps.length - 1]?.text ?? (live.text ? "" : "Думаю…")) : lastReply;
  return (
    <>
      <p role="status" data-assistant-announce style={SR_ONLY}>
        {announce}
      </p>
      {messages.map((m, i) => (
        <Fragment key={i}>
          <div className={m.role === "user" ? "bub me" : "bub"} style={{ whiteSpace: "pre-wrap" }}>
            {m.role === "assistant" ? renderAssistantContent(m.content, onNavigate) : m.content}
          </div>
          {m.cards && <AssistantCardList cards={m.cards} onNavigate={onNavigate} />}
          {m.actions?.map((action) => <Fragment key={action.id}>{renderAction(action)}</Fragment>)}
        </Fragment>
      ))}
      {live.pending && (
        <>
          {live.steps.length > 0 && (
            <ul
              aria-label="Что делает помощник"
              data-assistant-steps
              style={{ display: "flex", flexWrap: "wrap", gap: 6, listStyle: "none", margin: 0, padding: 0 }}
            >
              {live.steps.map((step, i) => (
                <li key={i} className={step.done ? "chip ok" : "chip"} style={{ fontSize: 13 }}>
                  {stepLabel(step)}
                </li>
              ))}
            </ul>
          )}
          <div className="bub bot" aria-busy="true" data-assistant-live style={{ whiteSpace: "pre-wrap" }}>
            <span className="who">ИИ-ассистент</span>
            {live.text ? renderAssistantContent(live.text, onNavigate) : (live.steps[live.steps.length - 1]?.text ?? "Думаю…")}{" "}
            <button type="button" className="lk" onClick={onStop} style={{ minHeight: 44 }}>
              Остановить
            </button>
          </div>
          <AssistantCardList cards={live.cards} onNavigate={onNavigate} />
          {live.actions.map((action) => (
            <Fragment key={action.id}>{renderAction(action)}</Fragment>
          ))}
        </>
      )}
    </>
  );
}
