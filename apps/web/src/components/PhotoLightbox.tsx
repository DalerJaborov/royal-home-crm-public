import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useScrollLock } from "../hooks/useScrollLock";
import type { PropertyPhoto } from "../types";
import { Rh2Portal } from "./rh2/Rh2Scope";

/**
 * Полноэкранный просмотр фото — в языке макета «Royal Home 2026».
 *
 * ПОЧЕМУ ОКНО ПЕРЕРИСОВАНО, А НЕ ОСТАВЛЕНО ТЁМНЫМ ХОЛСТОМ. В эталоне темы
 * такого экрана нет вовсе: прототип знает галерею (`.gal`) и сетку фото
 * (`.pgrid`), но не просмотрщик. Первый заход оставил окно чёрным холстом «как
 * делают везде». Решение владельца 09.09.2026: рисовать недостающий экран
 * языком макета, а не оставлять его чужим. Поэтому здесь нет ни одного нового
 * имени класса — только то, что в теме уже есть:
 *
 *   `.sheet-back`   затемнение и размытие фона — ровно как под шторкой;
 *   `.card.tight`   нижняя панель управления (см. «ПОЧЕМУ ПАНЕЛЬ» ниже);
 *   `.pill.soft.icon` закрыть и листать — круглые 44 px (`--ic-lg`);
 *   `.chip`         счётчик кадров «3 из 12»;
 *   `.quiet`        подпись под фото;
 *   `.sk`           скелетон, пока кадр ещё грузится.
 *
 * ПОЧЕМУ `.rh2` ВОКРУГ ПОРТАЛА. Весь эталонный CSS ограничен областью `.rh2`, а
 * `createPortal` уносит разметку в `document.body`, то есть за пределы обёртки
 * экрана. Без своей обёртки классы темы не значат ничего: окно рендерится голой
 * разметкой, и ни сборка, ни типы, ни линтер об этом не сообщают. Обёртка здесь
 * же делает окно самодостаточным — просмотрщик открывается и с экранов, ещё не
 * переведённых на тему, и выглядит там так же.
 *
 * ПОЧЕМУ УПРАВЛЕНИЕ СОБРАНО В НИЖНЮЮ ПАНЕЛЬ, А НЕ РАЗБРОСАНО ПО КРАЯМ ФОТО.
 * Два требования сходятся в одно решение. Первое: кнопки не должны наезжать на
 * изображение — фотография здесь главная. Второе: подпись обязана читаться в
 * обеих темах, а подложка шторки в светлой теме даёт всего 25% затемнения, и
 * текст цвета `--body` на размытой светлой странице контраста 4.5 не набирает.
 * Панель `.card.tight` решает оба: у неё собственный фон (`--card`), то есть
 * контраст текста гарантирован темой, и она стоит ПОД фото, а не поверх него.
 * Стрелки по бокам от фото пришлось бы либо класть на изображение, либо
 * отъедать на телефоне 120 px ширины у самого фото.
 *
 * ПОЧЕМУ НА КРАЯХ СТРЕЛКА ГАСНЕТ, А НЕ ЗАЦИКЛИВАЕТ. Прежнее окно листало по
 * кругу: с последнего кадра вперёд попадаешь на первый. Со счётчиком «12 из 12»
 * это читается как сбой — человек уверен, что промотал не туда. Гашение
 * (`disabled`, тема сама делает его прозрачным) отвечает на вопрос «дальше
 * есть?» до нажатия. Клавиатура ведёт себя так же: на краю стрелка не делает
 * ничего.
 *
 * ОБОБЩЕНИЕ НА «ВСЕ ФОТО ПЕРЕПИСКИ» (21.09.2026). Просмотрщик объекта (`photos`,
 * PropertyPhoto[], url всегда готов сразу) и просмотрщик чата (`items`,
 * LightboxItem[], url фото клиента приходит асинхронно — файл лежит в закрытом
 * хранилище и качается только когда кадр открыт) — один и тот же компонент, а
 * не два: жест, счётчик, клавиатура, ловушка фокуса и фон у них общие, различий
 * ровно два — откуда берётся подпись и готов ли url сразу. `items` замещает
 * `photos` целиком, когда передан; вызывающий чата сам решает, когда очередной
 * кадр «догрузился», и обновляет `url` в своём списке.
 *
 * ЧТО СОХРАНЕНО ОТ ПРЕЖНЕГО ОКНА: листание стрелками клавиатуры и кнопками,
 * закрытие по Esc и кликом мимо фото, счётчик кадров. ЧТО ДОБАВЛЕНО: смахивание
 * пальцем влево-вправо (и теперь ВНИЗ — закрыть, чат-макет), подпись, ловушка
 * фокуса с возвратом на вызвавшую кнопку, неподвижный фон под окном, лента
 * миниатюр (`thumbnails`) и место для доп. кнопки в подвале (`footerExtra`,
 * «Добавить объект» продавцу).
 */

/** Порог смахивания: короче — это промах пальцем, а не жест. */
const SWIPE_PX = 48;
/** Смахивание вниз читается жестом закрытия только когда движение явно
 *  вертикальнее горизонтального — иначе обычное натяжение при листании
 *  влево-вправо (палец чуть промахнулся по высоте) закрывало бы окно само. */
const SWIPE_DOWN_PX = 80;

/** Нормализованный кадр просмотрщика. `url: null` — кадр ещё не готов
 *  (грузится) и не является ошибкой; `failed: true` — отдать не получилось. */
export interface LightboxItem {
  key: string;
  url: string | null;
  caption?: string | null;
  failed?: boolean;
}

/**
 * Подпись кадра выводится из самого фото, а не приходит отдельным полем: у
 * `PropertyPhoto` подписи нет, а состояние улучшения ИИ — единственное, что о
 * кадре вообще можно сказать, и в сетке фото оно уже показывается значком.
 * В просмотрщике значку места нет, поэтому то же самое говорится словами.
 */
function captionFor(photo: PropertyPhoto, index: number): string | null {
  if (photo.enhancedUrl) {
    return "Улучшение ИИ ждёт решения. Пока его не одобрили, и в CRM, и на сайте показывается это, исходное фото.";
  }
  if (photo.originalUrl) return "Улучшено ИИ, оригинал сохранён.";
  if (index === 0) return "Главное фото объекта.";
  return null;
}

function itemsFromPhotos(photos: PropertyPhoto[]): LightboxItem[] {
  return photos.map((p, i) => ({ key: p.id, url: p.url, caption: captionFor(p, i) }));
}

export function PhotoLightbox({
  photos,
  items,
  index,
  onClose,
  onIndexChange,
  thumbnails = false,
  footerExtra,
}: {
  /** Фото объекта — прежний путь входа, не тронут ни один существующий вызов. */
  photos?: PropertyPhoto[];
  /** Общий путь входа (чат и всё, что не объект) — см. докблок выше. */
  items?: LightboxItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
  /** Лента миниатюр снизу — только там, где кадров много и заранее известны
   *  все (чат «все фото переписки»); у карточки объекта её не было и не просили. */
  thumbnails?: boolean;
  /** Доп. кнопка(и) в нижней панели — например, «Добавить объект» продавцу. */
  footerExtra?: React.ReactNode;
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>(true);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // Появление: непрозрачность и лёгкий масштаб за 180 мс. Переход, а не
  // анимация, — у перехода конечный кадр наступает даже если браузер кадры не
  // проигрывает. `.rh2 *` в теме гасит длительность под prefers-reduced-motion.
  const [shown, setShown] = useState(false);

  useScrollLock(true);

  const resolved: LightboxItem[] = items ?? itemsFromPhotos(photos ?? []);
  const last = resolved.length - 1;
  const hasPrev = index > 0;
  const hasNext = index < last;

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      if (e.key === "ArrowRight" && index < resolved.length - 1) onIndexChange(index + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, resolved.length, onClose, onIndexChange]);

  const current = resolved[index];
  if (!current) return null;

  const loading = !current.url && !current.failed;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <Rh2Portal>
      <div className="sheet-back" style={{ zIndex: 70 }} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Фото ${index + 1} из ${resolved.length}`}
        tabIndex={-1}
        // Общее правило index.css превращает любое [role="dialog"] на узком
        // экране в шторку старого облика. У просмотрщика подача своя.
        data-no-sheet=""
        className="fixed inset-0 flex flex-col"
        style={{
          zIndex: 71,
          gap: "var(--s3)",
          padding: "var(--s3)",
          paddingBottom: "calc(var(--s3) + env(safe-area-inset-bottom))",
          opacity: shown ? 1 : 0,
          transform: shown ? "scale(1)" : "scale(0.98)",
          transition: "opacity .18s ease, transform .18s ease",
        }}
        // Клик мимо фотографии закрывает окно — как и раньше.
        onClick={onClose}
        onTouchStart={(e) => {
          const t = e.touches[0];
          touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchEnd={(e) => {
          const from = touchStart.current;
          touchStart.current = null;
          if (!from) return;
          const t = e.changedTouches[0];
          const dx = (t?.clientX ?? from.x) - from.x;
          const dy = (t?.clientY ?? from.y) - from.y;
          // Вертикальнее, чем горизонтальнее, и вниз, — жест закрытия (чат-макет:
          // «свайп вниз — закрыть»). Иначе — обычное листание влево-вправо.
          if (dy >= SWIPE_DOWN_PX && Math.abs(dy) > Math.abs(dx)) {
            onClose();
            return;
          }
          if (dx <= -SWIPE_PX && hasNext) onIndexChange(index + 1);
          if (dx >= SWIPE_PX && hasPrev) onIndexChange(index - 1);
        }}
      >
        {/* Шапка: одна кнопка закрытия справа — как крестик шторки. */}
        <div className="flex justify-end" onClick={stop}>
          <button type="button" className="pill soft icon" onClick={onClose} aria-label="Закрыть">
            <X className="i lg" strokeWidth={1.5} />
          </button>
        </div>

        {/* Сцена. minHeight:0 обязателен: без него flex-элемент не сжимается
            ниже высоты картинки и панель управления уезжает за нижний край. */}
        <div className="flex items-center justify-center" style={{ flex: 1, minHeight: 0 }}>
          {loading ? (
            <span
              className="sk"
              style={{ width: "min(70vw, 420px)", aspectRatio: "3 / 4", borderRadius: "var(--r-md)" }}
              aria-label="Загрузка фото"
            />
          ) : !current.url ? (
            <div className="quiet" onClick={stop}>
              <span className="txt">Фото не открылось</span>
            </div>
          ) : (
            <img
              src={current.url}
              alt={`Фото ${index + 1} из ${resolved.length}`}
              onClick={stop}
              className="max-w-full max-h-full object-contain select-none"
              style={{
                borderRadius: "var(--r-md)",
                border: "1px solid var(--line-strong)",
                boxShadow: "var(--shadow)",
              }}
            />
          )}
        </div>

        {/* Лента миниатюр — только там, где явно попросили (чат). Кадры без
            готового url показываются скелетоном плитки, не сорванным <img>. */}
        {thumbnails && resolved.length > 1 && (
          <div
            onClick={stop}
            className="flex"
            style={{ gap: "var(--s2)", overflowX: "auto", padding: "0 var(--s1)" }}
          >
            {resolved.map((it, i) => (
              <button
                key={it.key}
                type="button"
                onClick={() => onIndexChange(i)}
                aria-label={`Кадр ${i + 1}`}
                aria-current={i === index}
                style={{
                  flex: "none",
                  width: 46,
                  height: 46,
                  borderRadius: "var(--r-sm)",
                  overflow: "hidden",
                  padding: 0,
                  border: i === index ? "2px solid var(--acc)" : "1px solid var(--line-strong)",
                  opacity: i === index ? 1 : 0.6,
                  background: "var(--soft)",
                }}
              >
                {it.url && (
                  <img src={it.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                )}
              </button>
            ))}
          </div>
        )}

        {/* Панель управления: доп. кнопки, подпись и листание. */}
        {(footerExtra || current.caption || resolved.length > 1) && (
          <div
            className="card tight"
            onClick={stop}
            // Ширина по содержимому: без подписи панель сжимается до трёх
            // кнопок, с подписью растягивается до предела строки чтения.
            style={{ margin: "0 auto", width: "fit-content", maxWidth: "min(560px, 100%)" }}
          >
            {footerExtra && (
              <div className="flex items-center justify-center" style={{ gap: "var(--s2)" }}>
                {footerExtra}
              </div>
            )}
            {current.caption && (
              <div className="quiet" style={{ marginTop: footerExtra ? "var(--s2)" : 0 }}>
                <span className="txt">{current.caption}</span>
              </div>
            )}
            {resolved.length > 1 && (
              <div
                className="flex items-center justify-center"
                style={{ gap: "var(--s3)", marginTop: footerExtra || current.caption ? "var(--s2)" : 0 }}
              >
                <button
                  type="button"
                  className="pill soft icon"
                  onClick={() => onIndexChange(index - 1)}
                  disabled={!hasPrev}
                  aria-label="Предыдущее фото"
                >
                  <ChevronLeft className="i lg" strokeWidth={1.5} />
                </button>
                <span className="chip">
                  {index + 1} из {resolved.length}
                </span>
                <button
                  type="button"
                  className="pill soft icon"
                  onClick={() => onIndexChange(index + 1)}
                  disabled={!hasNext}
                  aria-label="Следующее фото"
                >
                  <ChevronRight className="i lg" strokeWidth={1.5} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Rh2Portal>
  );
}
