import { useRef, useState } from "react";
import { CHUNKED_UPLOAD_PURPOSES } from "@royal-home/shared";
import { uploadClipVideo } from "../lib/clipVideoUpload";
import { UploadCancelledError, type ChunkedSessionHolder } from "../lib/chunkedUpload";
import { checkClipVideoBeforeUpload } from "../lib/upload/videoMeta";
import type { UploadLive } from "../lib/upload/progressText";
import { UploadProgressLine } from "./UploadProgressLine";
import { useQueryClient } from "@tanstack/react-query";
import type { Property } from "../types";

/**
 * Короткий сжатый ролик карточки объекта (docs/plan-18-08-private-listings-and-video.md
 * §3) — отдельно от «Сырого видео» (PropertyVideoManager, исходники монтажёру) и
 * от instagramUrl (готовая ссылка на Reels). Задуман в первую очередь для
 * несайтовых (offSite) объектов — они не проходят конвейер Маркетинга и Reels
 * вовсе, — но показывается на любой карточке: лишний UI-элемент для обычного
 * объекта дешевле, чем скрытая от агента возможность.
 *
 * Прогресс сжатия — простое ручное обновление (кнопка «Проверить готовность»),
 * без вебсокетов/поллинга в фоне: v1, короткие ролики (до 3 мин) сжимаются быстро,
 * а лишний интервал на каждой открытой карточке — ненужная нагрузка.
 */
export function PropertyClipVideoCard({ property, readOnly = false }: { property: Property; readOnly?: boolean }) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  /**
   * Состояние отправки строкой (25.11.2026, находка 12): МБ из МБ, скорость, сколько
   * осталось, «ждём связь» / «повтор через N с», причина отказа и «Повторить». Раньше —
   * только «Загружаем… N%» на кнопке, а после отказа — ни повтора, ни причины.
   */
  const [live, setLive] = useState<UploadLive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /** Последний выбранный файл и его сессия: «Повторить» докачивает, а не грузит заново. */
  const lastFile = useRef<File | null>(null);
  const session = useRef<ChunkedSessionHolder>({});
  // Ушли с карточки посреди загрузки — отправка идёт дальше (как и раньше), вкладку
  // закрыть тихо не даст workGuard; рвёт её только «Отменить».
  const controller = useRef<AbortController | null>(null);

  async function upload(file: File) {
    setError(null);
    setUploading(true);
    setLive({ phase: "preparing", loaded: 0, total: file.size });
    // Находка 11: размер и длительность — ДО отправки, а не после сотен мегабайт.
    const refusal = await checkClipVideoBeforeUpload(file, CHUNKED_UPLOAD_PURPOSES["clip-video"].maxBytes);
    if (refusal) {
      setUploading(false);
      setLive(null);
      lastFile.current = null;
      setError(refusal);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    try {
      // Частями (17.11.2026): одним запросом ролик тяжелее ~90 МБ отбивал прокси (413).
      await uploadClipVideo(property.id, file, undefined, session.current, { onLive: setLive, signal: abort.signal });
      session.current = {};
      lastFile.current = null;
      setLive(null);
      /* Префикс, а не точный ключ: карточка лежит под id из адреса (строка),
         см. подробный разбор в PropertyVideoFixCard.tsx::refresh. */
      await qc.invalidateQueries({ queryKey: ["property"] });
    } catch (err) {
      if (err instanceof UploadCancelledError) {
        setLive(null);
        session.current = {};
        lastFile.current = null;
      } else {
        const message = err instanceof Error ? err.message : "Не удалось загрузить видео";
        setLive((prev) => ({ phase: "failed", loaded: prev?.loaded ?? 0, total: file.size, error: message }));
      }
    } finally {
      if (controller.current === abort) controller.current = null;
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    // Другой файл — другая сессия.
    if (lastFile.current !== file) session.current = {};
    lastFile.current = file;
    await upload(file);
  }

  async function handleCheck() {
    setChecking(true);
    try {
      await qc.invalidateQueries({ queryKey: ["property"] });
    } finally {
      setChecking(false);
    }
  }

  const status = property.clipVideoStatus;

  return (
    /* Карточка эталона: `.sec-h` с кнопкой справа, состояние — тихой строкой
       или блоком `.empty`, ошибка — `.quiet.crit`. Бесконечных спиннеров нет
       (§6.4 договора): о работе говорит текст кнопки. */
    <div className="card">
      <div className="sec-h stack">
        <h2>Короткий ролик объекта</h2>
        {!readOnly && (
          <button
            className="pill ghost sm"
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={uploading || status === "PROCESSING"}
          >
            {uploading ? "Загружаем…" : status === "READY" ? "Заменить" : "Загрузить"}
          </button>
        )}
      </div>
      {live && (
        <UploadProgressLine
          live={live}
          keepAwakeHint
          onCancel={
            uploading
              ? () => controller.current?.abort()
              : () => {
                  setLive(null);
                  session.current = {};
                  lastFile.current = null;
                }
          }
          onRetry={!uploading && live.phase === "failed" && lastFile.current ? () => void upload(lastFile.current!) : undefined}
          style={{ margin: "4px 0 8px" }}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          void handleFile(e.target.files);
        }}
      />

      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
          <button className="lnk" type="button" onClick={() => setError(null)}>
            Понятно
          </button>
        </div>
      )}

      {status === "READY" && property.clipVideoUrl ? (
        <video
          controls
          preload="metadata"
          src={property.clipVideoUrl}
          style={{ width: "100%", maxHeight: 420, borderRadius: "var(--r-md)", background: "var(--track)" }}
        >
          Браузер не умеет проигрывать видео.
        </video>
      ) : status === "PROCESSING" ? (
        <div className="quiet">
          <span className="dot warn" />
          <span className="txt">Видео сжимается, обычно недолго.</span>
          <button className="pill ghost sm" type="button" onClick={handleCheck} disabled={checking}>
            {checking ? "Проверяем…" : "Проверить готовность"}
          </button>
        </div>
      ) : status === "FAILED" ? (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">Не удалось обработать видео. Попробуйте загрузить ещё раз.</span>
        </div>
      ) : (
        <div className="empty">
          <span className="ic">
            <svg className="i" viewBox="0 0 24 24">
              <rect x="3" y="5" width="18" height="14" rx="3" />
              <path d="m10 9 5 3-5 3z" />
            </svg>
          </span>
          <p>Ролик пока не загружен.</p>
          <p className="sub">До 5 минут. Он показывается клиенту по приватной ссылке.</p>
        </div>
      )}
    </div>
  );
}
