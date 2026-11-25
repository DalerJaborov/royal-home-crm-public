import { useEffect, useMemo, useRef } from "react";
import { ImagePlus } from "lucide-react";
import { SOCIAL_PHOTO_POST_MAX_IMAGES } from "@royal-home/shared";
import { mediaSrc } from "./helpers";
import { UploadProgressLine } from "../../components/UploadProgressLine";
import type { UploadLive } from "../../lib/upload/progressText";

/**
 * Выбор фото для фото-поста (16.11.2026). Пока черновика нет — показывает выбранные
 * файлы с устройства; после загрузки — фото с сервера в том порядке, в каком уйдут.
 * Новый выбор при готовом черновике заменяет весь набор (подтверждение — в Composer).
 */
export function PhotoPicker({
  local,
  existing,
  uploadProgress,
  uploadLive = null,
  processing,
  disabled,
  onPick,
}: {
  local: File[];
  existing: string[];
  uploadProgress: number | null;
  /** МБ из МБ, скорость, осталось — общая строка прогресса (25.11.2026). */
  uploadLive?: UploadLive | null;
  processing: boolean;
  disabled: boolean;
  onPick: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const localUrls = useMemo(() => local.map((f) => URL.createObjectURL(f)), [local]);
  useEffect(() => () => localUrls.forEach((u) => URL.revokeObjectURL(u)), [localUrls]);

  const shown = localUrls.length > 0 ? localUrls : existing.map(mediaSrc);
  const tooMany = local.length > SOCIAL_PHOTO_POST_MAX_IMAGES;

  return (
    <div>
      <input
        ref={input}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          onPick(files);
        }}
      />
      {shown.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(88px, 1fr))", gap: 8, marginBottom: 12 }}>
          {shown.map((src, i) => (
            <span
              key={src}
              style={{ position: "relative", aspectRatio: "4 / 5", borderRadius: "var(--r-md)", overflow: "hidden", background: "var(--track)" }}
            >
              <img src={src} alt={`Фото ${i + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              <span className="chip" style={{ position: "absolute", left: 6, top: 6 }}>
                {i + 1}
              </span>
            </span>
          ))}
        </div>
      )}
      {uploadProgress !== null ? (
        uploadLive && !processing ? (
          <UploadProgressLine live={uploadLive} />
        ) : (
          <p className="state" role="status">
            {processing ? "Готовим фото на сервере…" : `Загружаем фото: ${uploadProgress}%`}
          </p>
        )
      ) : (
        <button className="pill" type="button" disabled={disabled} onClick={() => input.current?.click()}>
          <ImagePlus className="i" aria-hidden />
          {shown.length > 0 ? "Выбрать другие фото" : "Выбрать фото"}
        </button>
      )}
      {tooMany && <p className="note">Выбрано больше {SOCIAL_PHOTO_POST_MAX_IMAGES}: в пост уйдут первые {SOCIAL_PHOTO_POST_MAX_IMAGES}.</p>}
    </div>
  );
}
