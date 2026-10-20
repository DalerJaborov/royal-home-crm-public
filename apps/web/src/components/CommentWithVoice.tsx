import { Mic, MicOff } from "lucide-react";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";

/**
 * Комментарий с голосовым вводом — то же поле, что и остальные текстовые поля
 * форм, плюс кнопка диктовки (владелец, мозговой штурм 20-21.08.2026: «голосовой
 * комментарий в формах»). Микрофон в углу textarea дописывает распознанный текст
 * к уже напечатанному, а не заменяет его — приём из AddInteractionModal.tsx.
 *
 * Вынесен в отдельный файл 02.09.2026 (было внутри PendingSummaryBanner.tsx) —
 * используется и окнами обязательного итога, и модалками карточки клиента
 * (Refuse/Deactivate/Transfer/RequestDelete*): владелец просил голосовой
 * комментарий «в формах» вообще, не только в одном месте, второй копии
 * текстового поля с диктовкой заводить незачем.
 */
export function CommentWithVoice({
  value,
  onChange,
  placeholder,
  rows = 2,
  size = "sm",
  showVoice = true,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  rows?: number;
  /** "lg" — большая стеклянная кнопка микрофона (референс владельца, iOS 26 Liquid
   *  Glass, редизайн 31.08.2026) для окон «Итог показа»/«Как прошёл звонок»; "sm" —
   *  прежний вид, для более тесных форм (передача клиента и т.п.), где такая крупная
   *  кнопка не помещается. */
  size?: "sm" | "lg";
  /**
   * Скрыть встроенный микрофон диктовки (01.09.2026) — для форм, где рядом уже стоит
   * SummaryVoiceNoteButton/VoiceNoteButton (голосовая заметка файлом). Два микрофона
   * в одном поле, делающие разное (один вписывает текст, другой прикрепляет запись),
   * путали владельца при живой проверке — «почему теперь два микрофона в одном
   * месте». По умолчанию true: в большинстве форм второй кнопки нет, там диктовка
   * остаётся единственным голосовым вводом.
   */
  showVoice?: boolean;
}) {
  const speech = useSpeechRecognition((transcript) => {
    onChange(value.trim() ? `${value.trim()} ${transcript}` : transcript);
  });
  if (size === "sm") {
    return (
      <div className="relative">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          className="w-full border border-line rounded-lg bg-card text-ink px-2.5 py-1.5 pr-12 text-[15px] outline-hidden focus:border-blue resize-none"
        />
        {showVoice && speech.supported && (
          <button
            type="button"
            disabled={speech.isTranscribing}
            onClick={() => (speech.isListening ? speech.stop() : speech.start())}
            title={speech.isListening ? "Остановить запись" : speech.isTranscribing ? "Распознаю…" : "Голосовой ввод"}
            className={`absolute right-1 top-1 grid h-11 w-11 place-items-center rounded-full ${
              speech.isListening
                ? "mic-recording text-red"
                : speech.isTranscribing
                  ? "mic-transcribing text-blue"
                  : "text-gray-400 hover:text-blue"
            }`}
          >
            {speech.isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>
        )}
        {speech.error && <p className="text-[13px] text-red mt-1">{speech.error}</p>}
      </div>
    );
  }
  return (
    <div className="relative">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={speech.isListening ? "Говорите…" : placeholder}
        className={`w-full min-h-[112px] rounded-[22px] border border-line-soft bg-card text-ink px-4 py-3.5 ${
          showVoice ? "pr-[76px]" : "pr-4"
        } text-[15px] leading-relaxed outline-hidden focus:border-blue resize-none`}
      />
      {/* Отдельной подписи «Запись…» рядом с кнопкой больше нет (редизайн
          31.08.2026) — на телефоне 390px она наезжала на саму кнопку
          микрофона (жалоба владельца — «едут друг на друга»). Пульс и
          красный цвет самой кнопки уже однозначно говорят «идёт запись»,
          вторая подпись рядом была лишней. */}
      {showVoice && speech.supported && (
        <button
          type="button"
          disabled={speech.isTranscribing}
          onClick={() => (speech.isListening ? speech.stop() : speech.start())}
          aria-label={speech.isListening ? "Остановить запись" : "Голосовой ввод"}
          title={speech.isListening ? "Остановить запись" : speech.isTranscribing ? "Распознаю…" : "Голосовой ввод"}
          className={`glass-mic-btn absolute right-3 top-3 ${speech.isListening ? "is-recording" : ""} ${
            speech.isTranscribing ? "opacity-70" : ""
          }`}
        >
          {speech.isListening ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
        </button>
      )}
      {speech.error && <p className="text-[13px] text-red mt-1.5">{speech.error}</p>}
    </div>
  );
}
