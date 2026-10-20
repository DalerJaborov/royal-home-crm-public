import { Mic, Send, X } from "lucide-react";
import { useVoiceMessageRecorder } from "../hooks/useVoiceMessageRecorder";
import { api } from "../lib/api";
import { VoiceNotePlayer } from "./VoiceNotePlayer";

export type VoiceNote = { url: string; transcript: string | null };

/**
 * Голосовая ЗАМЕТКА — общий вид на все формы CRM (01.09.2026, начато с окна «Как
 * прошёл звонок», см. SummaryVoiceNoteButton.tsx). Отдельно от диктовки (та
 * распознаёт речь и ВПИСЫВАЕТ текст в поле): здесь запись прикрепляется КАК ЕСТЬ,
 * само поле не трогает — владелец: «человек просто записал и оставил без
 * расшифровки». Расшифровка всё равно приходит с сервера (тот же Gemini) и
 * хранится рядом — не как замена текста поля, а как сырьё для дальнейшего
 * дополнения карточки (клиента, сотрудника — смотря какая форма).
 *
 * `uploadUrl` — куда грузить: у формы итога звонка своя привязка к требованию
 * (POST /me/summaries/:id/voice-note), у форм без такой привязки (заморозка
 * сотрудника, отказ вакансии и т.п.) — общий POST /me/voice-notes. Сама кнопка
 * не решает, куда положить результат — это отдаёт вызывающей форме через onChange.
 *
 * Механика записи — useVoiceMessageRecorder, тот же приём, что у голосового
 * сообщения клиенту (VoiceRecordButton): таймер, отмена, потолок 2 минуты, отмена
 * при уходе с экрана.
 */
export function VoiceNoteButton({
  uploadUrl,
  value,
  onChange,
  disabled,
  label = "Голосовая заметка",
}: {
  uploadUrl: string;
  value: VoiceNote | null;
  onChange: (v: VoiceNote | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const { supported, isRecording, isSending, elapsedMs, error, start, stop, cancel } = useVoiceMessageRecorder(
    async (blob) => {
      const form = new FormData();
      form.append("audio", blob, "voice-note.webm");
      const result = await api<VoiceNote>(uploadUrl, { method: "POST", body: form });
      onChange(result);
    }
  );

  if (!supported) return null;

  if (value) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 rounded-full bg-line-soft pl-2 pr-1 py-1 w-fit">
          {/* url — путь внутри API: сырой <audio src> шёл бы в корень домена без токена
              (CHAT03). Плеер качает файл через api() и играет blob-ссылку. */}
          <VoiceNotePlayer url={value.url} className="h-8 max-w-[220px]" />
          <button
            type="button"
            onClick={() => onChange(null)}
            title="Удалить голосовую заметку"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-gray-400 hover:text-gray-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {value.transcript && <p className="text-[13px] text-gray-400 pl-1">Распознано: «{value.transcript}»</p>}
      </div>
    );
  }

  if (isRecording || isSending) {
    const seconds = Math.floor(elapsedMs / 1000);
    return (
      <div className="flex items-center gap-2 rounded-full bg-red-50 px-3 py-1.5 text-[15px] font-semibold text-red-600 w-fit">
        {isSending ? (
          <span className="text-[13px] font-normal text-red-500">Сохраняю…</span>
        ) : (
          <>
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
            <span className="tabular-nums">
              {String(Math.floor(seconds / 60)).padStart(1, "0")}:{String(seconds % 60).padStart(2, "0")}
            </span>
            <button type="button" onClick={cancel} title="Отменить запись" className="grid h-11 w-11 place-items-center text-gray-400 hover:text-gray-600">
              <X className="h-4 w-4" />
            </button>
            <button type="button" onClick={stop} title="Сохранить" className="grid h-11 w-11 place-items-center text-red-600 hover:text-red-700">
              <Send className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={start}
        disabled={disabled}
        title={`${label} (необязательно): запись прикрепится как есть, без расшифровки в поле`}
        // Зона касания: кнопка живёт в том числе внутри окон, перенесённых на
        // тему 2026 (заморозка сотрудника), где действует правило «не меньше
        // 44 px» на телефоне. Ветка окон системы решала это классом `.tap-target`
        // (невидимая зона поверх 32-пиксельной кнопки), main — честной высотой
        // `min-h-11`. Оставлена одна, из main: она уже на проде, и высота, которую
        // видно, совпадает с высотой, по которой попадает палец.
        className="flex min-h-11 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13px] text-gray-500 hover:bg-line-soft hover:text-gray-700 disabled:opacity-40"
      >
        <Mic className="h-3.5 w-3.5" strokeWidth={1.8} />
        {label}
      </button>
      {error && <p className="text-[13px] text-red mt-1">{error}</p>}
    </div>
  );
}
