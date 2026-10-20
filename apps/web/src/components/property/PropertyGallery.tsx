import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ImageOff, Images } from "lucide-react";
import { galleryDots } from "../../lib/galleryDots";
import { isMotionDisabled } from "../../lib/motionPolicy";
import type { PropertyPhoto } from "../../types";
import { PhotoLightbox } from "../PhotoLightbox";
import { Button } from "../rh2/Button";
import { Rh2EmptyState } from "../rh2/Rh2EmptyState";

/**
 * ГАЛЕРЕЯ КАРТОЧКИ ОБЪЕКТА — одна на ПК и телефон (контракт 06.10.2026, раздел 6).
 *
 * Фото показаны ОДИН раз: лента листается пальцем (scroll-snap) и кнопками-
 * стрелками, счётчик «1 / 14» и точки говорят, где мы, нажатие на кадр открывает
 * `PhotoLightbox` во весь экран. Прежняя карточка рисовала фото трижды (сетка
 * `.gal` на ПК, лента на телефоне, редактор внизу), редактор теперь живёт под
 * кнопкой «Изменить» (вкладка «Фото и видео»), а не в просмотре.
 *
 * ПОТОЛКА НА ВОСЬМОМ СНИМКЕ НЕТ (ревью владельца 21.09.2026). Подсветка точки
 * прежней ленты зажималась на восьмой, и лента читалась как сломанная; здесь
 * индекс считается по положению прокрутки без верхней границы, а точки это окно
 * вокруг текущего кадра (`galleryDots`). Счётчик «N / M» точек не заменяет.
 *
 * Битая картинка (404 на хранилище) подменяется заглушкой, а не рамкой с
 * alt-текстом: в кадрах стенда у объекта была именно такая (review-mobile.md).
 */
export function PropertyGallery({ photos }: { photos: PropertyPhoto[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const [index, setIndex] = useState(0);
  const [lightboxAt, setLightboxAt] = useState<number | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const total = photos.length;
  const current = Math.min(index, Math.max(0, total - 1));

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  /** Положение ленты → номер кадра. Без верхней границы, кроме самого числа кадров. */
  const syncFromScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = trackRef.current;
      if (!el) return;
      setIndex(Math.min(total - 1, Math.max(0, Math.round(el.scrollLeft / Math.max(1, el.clientWidth)))));
    });
  };

  const goTo = useCallback(
    (to: number, smooth = true) => {
      const el = trackRef.current;
      if (!el) return;
      const target = Math.min(total - 1, Math.max(0, to));
      const reduce = isMotionDisabled();
      el.scrollTo({ left: target * el.clientWidth, behavior: smooth && !reduce ? "smooth" : "auto" });
      setIndex(target);
    },
    [total],
  );

  if (total === 0) {
    return (
      <div className="card rh-card" data-testid="gallery">
        <Rh2EmptyState
          icon={Images}
          title="Фотографий пока нет"
          hint="Пока их нет, объект на проверку не уйдёт."
        />
      </div>
    );
  }

  return (
    <div
      className="rh-gallery"
      data-testid="gallery"
      role="group"
      aria-roledescription="карусель"
      aria-label="Фотографии объекта"
    >
      <div
        ref={trackRef}
        className="rh-gallery-track"
        tabIndex={0}
        onScroll={syncFromScroll}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            goTo(current + 1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            goTo(current - 1);
          }
        }}
      >
        {photos.map((ph, i) => {
          // Рядом с текущим кадром грузим полный размер, дальше миниатюру: четырнадцать
          // полноразмерных снимков разом на телефоне — это и есть «зависает».
          const near = Math.abs(i - current) <= 1;
          return (
            <button
              key={ph.id}
              type="button"
              className="rh-gallery-slide"
              onClick={() => setLightboxAt(i)}
              aria-label={`Открыть фото ${i + 1} из ${total} во весь экран`}
            >
              {broken.has(ph.id) ? (
                <span className="rh-gallery-ph" aria-hidden>
                  <ImageOff className="i" />
                </span>
              ) : (
                <img
                  src={near ? ph.url : ph.thumbUrl}
                  alt=""
                  loading={i === 0 ? "eager" : "lazy"}
                  decoding="async"
                  draggable={false}
                  onError={() => setBroken((prev) => new Set(prev).add(ph.id))}
                />
              )}
            </button>
          );
        })}
      </div>

      {total > 1 && (
        <>
          <span className="rh-gallery-count" aria-live="polite">
            {current + 1} / {total}
          </span>
          <div className="rh-gallery-nav">
            <NavButton label="Предыдущее фото" blocked={current === 0 ? "Это первое фото" : null} onClick={() => goTo(current - 1)}>
              <ChevronLeft className="i" aria-hidden />
            </NavButton>
            <NavButton
              label="Следующее фото"
              blocked={current === total - 1 ? "Это последнее фото" : null}
              onClick={() => goTo(current + 1)}
            >
              <ChevronRight className="i" aria-hidden />
            </NavButton>
          </div>
          <div className="rh-gallery-dots" aria-hidden>
            {galleryDots(current, total).map((d) => (
              <i key={d.index} className={d.active ? "on" : undefined} />
            ))}
          </div>
        </>
      )}

      {lightboxAt != null && (
        <PhotoLightbox
          photos={photos}
          index={lightboxAt}
          onClose={() => setLightboxAt(null)}
          onIndexChange={(i) => {
            setLightboxAt(i);
            goTo(i, false);
          }}
        />
      )}
    </div>
  );
}

/** Стрелка ленты; на краю гаснет и говорит почему (правило 10 контракта: серая кнопка без слов читается как поломка). */
function NavButton({
  label,
  blocked,
  onClick,
  children,
}: {
  label: string;
  blocked: string | null;
  onClick: () => void;
  children: ReactNode;
}) {
  return blocked ? (
    <Button variant="icon" aria-label={label} disabled disabledReason={blocked}>
      {children}
    </Button>
  ) : (
    <Button variant="icon" aria-label={label} onClick={onClick}>
      {children}
    </Button>
  );
}
