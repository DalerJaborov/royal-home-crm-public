import { useState } from "react";
import type { ConversationMessage } from "@royal-home/shared";
import { api } from "../lib/api";
import { MessageText } from "./MessageText";

/**
 * Текст реплики клиента с переключателем «Показать перевод на русский»
 * (13.09.2026) — тот же приём и тот же интерфейс, что уже есть у звонков
 * (CallDetails.tsx): перевод не готов заранее, считается по клику, оригинал и
 * перевод переключаются на месте текста, а не добавляются вторым блоком — так
 * уже сделано для расшифровки звонка, и переписке незачем выглядеть иначе.
 * См. messengers/translateChatMessage.ts на сервере — там же объяснено, почему
 * это по клику, а не автоматически на каждое входящее сообщение.
 *
 * Заменяет собой обычный `<MessageText>` в трёх местах, где рисуется лента
 * (Messages.tsx, mobile/MobileChatView.tsx, ClientChatPanel.tsx) — сама решает,
 * когда добавить переключатель, вызывающему коду думать об этом не нужно.
 *
 * КОСМЕТИЧЕСКИЙ ГЕЙТ, НЕ РЕШЕНИЕ. Буквы, специфичные для таджикского алфавита
 * (ӯ, ғ, қ, ҳ, ҷ, ӣ), решают только «стоит ли вообще рисовать кнопку под этой
 * репликой» — у звонка на весь разговор одна расшифровка, а в переписке реплик
 * десятки, и кнопка под каждой русской строкой была бы шумом. Настоящее решение
 * «нужен ли перевод» — на сервере, `detectClientLanguage` (ai/clientLanguage.ts):
 * он умеет то, чего этот беглый разбор не умеет (смесь языков, таджикская
 * латиница, короткие реплики). Ошибка тут не страшна — лишний клик просто
 * вернёт «Сообщение и так по-русски», как у звонков.
 */
const LIKELY_TAJIK = /[ӯғқҳҷӣЎҒҚҲҶӢ]/;

export function TranslatableMessageText({
  content,
  message,
  conversationId,
  clientId,
  rh2 = false,
  readOnly = false,
}: {
  /** Уже прогнан вызывающим кодом через humanizeAttachmentTags/stripBotHints —
   *  тот же текст, что раньше шёл прямо в MessageText. */
  content: string;
  message: ConversationMessage;
  /** "tg_"-префиксованный id у Telegram-диалога, как в остальном инбоксе (TG_PREFIX,
   *  routes/conversations.ts) — сервер сам отвечает честным 400 «перевод не
   *  поддержан для Telegram» по этому префиксу; кнопка всё равно рисуется и рабочим
   *  выглядит только запрос, а не молчаливая пропажа переключателя. */
  conversationId?: string | null;
  clientId?: string | null;
  rh2?: boolean;
  readOnly?: boolean;
}) {
  const [translatedRu, setTranslatedRu] = useState<string | null>(message.translatedRu ?? null);
  const [showTranslation, setShowTranslation] = useState(!!message.translatedRu);
  const [translating, setTranslating] = useState(false);
  const [notNeeded, setNotNeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Только реплика клиента, и только если у неё есть `at` — сервер ищет по нему
  // (см. routes/conversations.ts POST /:id/translate); у реплик до 01.08.2026
  // поля нет вовсе, для них переключателя не будет, как и у звонков без даты.
  const canTranslate = message.role === "user" && !!message.at && !!conversationId;
  const showToggle = canTranslate && (!!translatedRu || (!readOnly && LIKELY_TAJIK.test(message.content)));

  async function requestTranslation() {
    if (readOnly) return;
    setTranslating(true);
    setError(null);
    try {
      const result = await api<{ translatedRu: string | null }>(
        `/conversations/${conversationId}/translate`,
        { method: "POST", body: { at: message.at } }
      );
      if (result.translatedRu) {
        setTranslatedRu(result.translatedRu);
        setShowTranslation(true);
      } else {
        setNotNeeded(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось перевести");
    } finally {
      setTranslating(false);
    }
  }

  return (
    <>
      <MessageText content={showTranslation && translatedRu ? translatedRu : content} clientId={clientId} rh2={rh2} readOnly={readOnly} />
      {showToggle && (
        <div style={{ marginTop: 4, fontSize: 13 }}>
          {translatedRu ? (
            <button type="button" onClick={() => setShowTranslation((v) => !v)} className="lnk" style={{ cursor: "pointer" }}>
              {showTranslation ? "Как сказал клиент" : "По-русски"}
            </button>
          ) : notNeeded ? (
            <span className="note">Сообщение и так по-русски</span>
          ) : (
            <button type="button" onClick={requestTranslation} disabled={translating} className="lnk" style={{ cursor: "pointer" }}>
              {translating ? "Переводим…" : "Показать перевод на русский"}
            </button>
          )}
          {error && <span className="chip crit">{error}</span>}
        </div>
      )}
    </>
  );
}
