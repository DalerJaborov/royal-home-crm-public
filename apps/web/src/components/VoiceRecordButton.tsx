import { useEffect } from "react";
import { Mic, Send, X } from "lucide-react";
import { useVoiceMessageRecorder } from "../hooks/useVoiceMessageRecorder";

/**
 * Кнопка записи голосового в форме ответа клиенту — рядом с textarea в
 * Messages.tsx (инбокс) и ClientChatPanel.tsx (карточка клиента). Обе формы
 * структурно одинаковы, поэтому кнопка одна на двоих: разница только в том, КУДА
 * уходит запись, а это решает переданный `send`.
 *
 * Пока не запись — обычная кнопка с иконкой микрофона. Во время записи форма
 * ответа подменяется индикатором (таймер + отмена + отправить) — печатать текст
 * одновременно с записью голоса всё равно бессмысленно.
 */
export function VoiceRecordButton({
  send,
  onError,
  disabled,
}: {
  send: (blob: Blob) => Promise<unknown>;
  /** Показ ошибки отдаёт вызывающему — у обеих форм уже есть своё место под неё
   *  (то же, где текстовая отправка показывает свой отказ). */
  onError: (message: string | null) => void;
  disabled?: boolean;
}) {
  const { supported, isRecording, isSending, elapsedMs, error, start, stop, cancel } =
    useVoiceMessageRecorder(send);

  useEffect(() => {
    onError(error);
    // onError сознательно не в зависимостях: обе формы передают инлайн-функцию
    // (setState), и стабильная ссылка на неё им не гарантирована — включи её
    // сюда, и эффект зациклился бы на каждом ре-рендере формы.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  if (!supported) return null;

  if (isRecording) {
    const seconds = Math.floor(elapsedMs / 1000);
    return (
      <div className="flex items-center gap-2 rounded-full bg-red-50 px-3 py-1.5 text-[15px] font-semibold text-red-600">
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
        <span className="tabular-nums">
          {String(Math.floor(seconds / 60)).padStart(1, "0")}:{String(seconds % 60).padStart(2, "0")}
        </span>
        <button type="button" onClick={cancel} title="Отменить запись" className="text-gray-400 hover:text-gray-600">
          <X className="h-4 w-4" />
        </button>
        <button type="button" onClick={stop} title="Отправить" className="text-red-600 hover:text-red-700">
          <Send className="h-4 w-4" />
        </button>
      </div>
    );
  }

  /* 44x44, а не 36x36 (сверка с макетом на 390, 10.09.2026): в строке ответа это
     единственные кнопки со значком без подложки, и на телефоне они не дотягивали
     до тап-цели владельца. Размер общий с ПК намеренно: строка ответа одна и та
     же, а 44 px мышке не мешают. */
  return (
    <button
      type="button"
      onClick={start}
      disabled={disabled || isSending}
      title="Записать голосовое"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-line-soft hover:text-gray-600 disabled:opacity-40"
    >
      <Mic className={`h-[18px] w-[18px] ${isSending ? "animate-pulse" : ""}`} strokeWidth={1.8} />
    </button>
  );
}
