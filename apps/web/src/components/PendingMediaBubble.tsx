import { AlertCircle, RotateCw } from "lucide-react";
import type { PendingMediaUpload } from "../store/mediaUploads";

/**
 * Пузырь фото/видео, которое ещё уходит клиенту (18.08.2026; общий для ПК и телефона с
 * 25.11.2026 — до этого одна и та же разметка жила копией в Messages.tsx и MobileChatView.tsx).
 *
 * Три стадии, как в мессенджере:
 *  - загрузка с телефона на сервер — проценты и полоска;
 *  - сервер готовит файл под канал (lib/outgoingMediaJobs.ts на сервере) — «Сжимаем N%»,
 *    «В очереди», «Отправляем…»: файл уже у нас, вкладку можно закрыть;
 *  - сбой — причина простыми словами, «Повторить» (без новой загрузки, если файл уже на
 *    сервере) и «Убрать».
 * «Отменить» доступно, пока файл не начал уходить клиенту.
 *
 * Плитка `.att-img` (180×120) — та же, которой приходит уже доставленное фото
 * (components/MessageAttachments.tsx): пузырь во время отправки и после неё не меняет размер.
 */
/** Тень под подписью: на светлом кадре видео белый текст иначе теряется (замер на стенде 25.11). */
const LABEL_SHADOW = { textShadow: "0 1px 3px rgba(0, 0, 0, 0.95)" } as const;

export function PendingMediaBubble({
  upload: u,
  onRetry,
  onCancel,
}: {
  upload: PendingMediaUpload;
  onRetry: (u: PendingMediaUpload) => void;
  onCancel: (localId: string) => void;
}) {
  const processingLabel =
    u.stage === "compress" ? (u.progress > 0 ? `Сжимаем ${u.progress}%` : "Сжимаем…") : u.stage === "send" ? "Отправляем…" : "В очереди…";
  const canCancel = u.status === "uploading" || (u.status === "processing" && u.stage !== "send");
  return (
    <div className="bub me">
      <div className="att-img" style={{ position: "relative" }}>
        {u.kind === "image" ? (
          <img src={u.previewUrl} alt="Загружается" className="w-full h-full object-cover" />
        ) : (
          <video src={u.previewUrl} className="w-full h-full object-cover" muted preload="metadata" />
        )}
        {u.status === "uploading" && (
          <div className="absolute inset-0 bg-black/45 flex flex-col items-center justify-center gap-1">
            <RotateCw className="w-5 h-5 text-white animate-spin" />
            <span className="text-[13px] font-semibold text-white tabular-nums" style={LABEL_SHADOW}>{u.progress}%</span>
            <div className="w-[70%] h-1 rounded-full bg-white/30 overflow-hidden">
              <div className="h-full bg-white" style={{ width: `${u.progress}%` }} />
            </div>
          </div>
        )}
        {u.status === "processing" && (
          <div
            className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-1 px-2 text-center"
            role="status"
            aria-live="polite"
          >
            <RotateCw className="w-5 h-5 text-white animate-spin" />
            <span className="text-[13px] font-semibold text-white tabular-nums" style={LABEL_SHADOW}>{processingLabel}</span>
            {u.stage === "compress" && u.progress > 0 && (
              <div className="w-[70%] h-1 rounded-full bg-white/30 overflow-hidden">
                <div className="h-full bg-white" style={{ width: `${u.progress}%` }} />
              </div>
            )}
          </div>
        )}
        {u.status === "error" && (
          <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-1 px-2 text-center">
            {/* Значок белый, а не красный: подложка тут всегда тёмная, и красный `--crit`
                на ней не добирает 4.5 контраста ни в одной из тем. Красным остаётся
                строка отказа под пузырём. */}
            <AlertCircle className="w-5 h-5 text-white" />
            <span className="text-[13px] font-semibold text-white">Не отправлено</span>
          </div>
        )}
      </div>
      {u.caption && <p style={{ marginTop: 6 }}>{u.caption}</p>}
      {u.status === "error" && (
        <div className="wrap" style={{ marginTop: 6 }}>
          <span className="txt" style={{ color: "var(--crit)" }}>
            {u.error || "Не удалось отправить"}
          </span>
          <button type="button" className="lnk" onClick={() => onRetry(u)}>
            Повторить
          </button>
          <button type="button" className="lnk" onClick={() => onCancel(u.localId)}>
            Убрать
          </button>
        </div>
      )}
      {canCancel && (
        <div className="wrap" style={{ marginTop: 6 }}>
          <button type="button" className="lnk" onClick={() => onCancel(u.localId)}>
            Отменить
          </button>
        </div>
      )}
    </div>
  );
}
