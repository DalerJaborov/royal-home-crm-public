import { useState } from "react";
import type { ConversationMessage } from "@royal-home/shared";
import { useCan } from "../lib/permissions";
import { useReplyFeedback } from "../hooks/useConversations";
import { clearIfUnchanged } from "../lib/clearSentText";

/**
 * ОЦЕНКА ОТВЕТА БОТА ПРЯМО В ЧАТЕ (17.09.2026).
 *
 * Владелец разметил ответы бота на отдельных страницах — и это дало готовые
 * правила без правки кода. Здесь то же самое, но под самим пузырём ответа:
 * «Верно» уходит в образцы стиля (StyleExample, источник APPROVED), «Неверно» —
 * в BotLesson: с заметкой правило действует сразу, без заметки — в очередь
 * ночного разбора (см. routes/conversations.ts POST /:id/reply-feedback).
 *
 * Тот же приём инлайн-кнопок под текстом реплики, что и у «Показать перевод»
 * (MessageTranslateToggle.tsx) — `.lnk`/`.note`, без своей вёрстки.
 *
 * Право `settings.manage` — то же, что открывает экран «Обучение бота»: текст
 * заметки уходит прямо в промт КАЖДОГО следующего разговора, показывать кнопку
 * и уже проставленную оценку тем, кто это право не получал, незачем.
 */
export function BotReplyFeedback({
  conversationId,
  message,
  messageKey,
  index,
}: {
  conversationId: string;
  message: ConversationMessage;
  /** `mid` реплики или `"idx:<index>"` — см. useReplyFeedback. */
  messageKey: string;
  /** Абсолютный индекс реплики в `messages` — по нему кэш правится точечно. */
  index: number;
}) {
  const can = useCan();
  const feedback = useReplyFeedback(conversationId);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  // «Изменить» открывает кнопки заново поверх уже проставленной оценки —
  // сервер умеет менять вердикт (см. reply-feedback: выключает прежний
  // BotLesson/StyleExample), интерфейсу нужен только путь туда.
  const [override, setOverride] = useState(false);

  if (!can("settings.manage")) return null;

  const current = message.feedback;
  const showButtons = !current || override;

  async function markGood() {
    if (feedback.isPending) return;
    try {
      await feedback.mutateAsync({ messageKey, index, verdict: "good" });
      setOverride(false);
      setNoteOpen(false);
    } catch { /* Keep the current controls available; the error is shown below. */ }
  }

  async function saveBad() {
    if (feedback.isPending) return;
    const text = note.trim();
    try {
      await feedback.mutateAsync({ messageKey, index, verdict: "bad", note: text || undefined });
      setOverride(false);
      setNoteOpen(false);
      setNote((currentNote) => clearIfUnchanged(currentNote, text));
    } catch { /* The operator's correction stays editable after an API refusal. */ }
  }

  return (
    <div className="clean-bot-feedback" style={{ marginTop: 4, fontSize: 13, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {showButtons ? (
        <>
          <button type="button" className="lnk" disabled={feedback.isPending} onClick={markGood}>
            Верно
          </button>
          <button type="button" className="lnk" disabled={feedback.isPending} aria-expanded={noteOpen} onClick={() => setNoteOpen((v) => !v)}>
            Неверно
          </button>
          {noteOpen && (
            <span className="clean-bot-feedback-note" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 300))}
                placeholder="Как надо было ответить"
                aria-label="Как надо было ответить"
                autoFocus
                style={{
                  font: "inherit",
                  fontSize: 13,
                  padding: "3px 8px",
                  minWidth: 200,
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-sm, 6px)",
                  background: "var(--card)",
                  color: "inherit",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); saveBad(); }
                }}
              />
              <button type="button" className="lnk" disabled={feedback.isPending} onClick={saveBad}>
                Сохранить
              </button>
            </span>
          )}
        </>
      ) : (
        <>
          <span className="note">
            {current.verdict === "good" ? "Отмечено верным" : `Отмечено: неверно${current.note ? ` — ${current.note}` : ""}`}
          </span>
          <button type="button" className="lnk" onClick={() => setOverride(true)}>
            Изменить
          </button>
        </>
      )}
      {feedback.isError && <span className="chip crit">Не удалось сохранить оценку</span>}
    </div>
  );
}
