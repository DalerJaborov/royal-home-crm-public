import { useState, type CSSProperties } from "react";

/**
 * `<video>` с честным запасным текстом на onError (23.09.2026, задание C).
 *
 * Готовые ролики монтажёра — HEVC (hvc1) mp4, исходники агента — HEVC/H.264
 * .mov с iPhone. Firefox и часть Chrome/Android не умеют HEVC вовсе — плеер
 * молчал чёрным прямоугольником, а жалоба доходила как «видео не открывается»
 * без единой причины в тексте (объект №127, аудит «звонок → лид → агент»).
 *
 * ОДИН компонент, не копия `<video>` с обработчиком в каждом месте, где ролик
 * показывается — используется в PropertyVideoManager (сырой плеер); тот же
 * компонент — готовое место для финального плеера, если/когда он появится.
 */
export function VideoPlayerWithFallback({
  src,
  onDownload,
  autoPlay = false,
  style,
}: {
  src: string;
  /** Тот же путь, что и обычная кнопка «Скачать» рядом с роликом. */
  onDownload: () => void;
  autoPlay?: boolean;
  style?: CSSProperties;
}) {
  const [failed, setFailed] = useState(false);

  const defaultStyle: CSSProperties = {
    width: "100%",
    maxHeight: "70vh",
    borderRadius: "var(--r-md)",
    background: "var(--track)",
  };

  if (failed) {
    return (
      <div className="quiet warn" style={style ?? defaultStyle}>
        <span className="dot warn" />
        <span className="txt">
          Браузер не воспроизводит этот формат (часто HEVC с iPhone).{" "}
          <button className="lnk" type="button" onClick={onDownload}>
            Скачать файл
          </button>
        </span>
      </div>
    );
  }

  return (
    <video
      controls
      autoPlay={autoPlay}
      src={src}
      onError={() => setFailed(true)}
      style={style ?? defaultStyle}
    />
  );
}
