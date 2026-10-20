import { useRef, useState } from "react";
import { api } from "../lib/api";
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
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("video", file);
      await api(`/properties/${property.id}/clip-video`, { method: "POST", body: form });
      /* Префикс, а не точный ключ: карточка лежит под id из адреса (строка),
         см. подробный разбор в PropertyVideoFixCard.tsx::refresh. */
      await qc.invalidateQueries({ queryKey: ["property"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить видео");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
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
