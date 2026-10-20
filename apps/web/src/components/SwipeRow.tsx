import { useEffect, useRef, useState } from "react";
import { Phone, ChevronRight } from "lucide-react";
import { useMobileUx } from "../hooks/useMobileUx";
import { EDGE_BACK_ZONE_PX } from "../hooks/useEdgeSwipeBack";

/**
 * Строка списка, которая понимает смахивание.
 *
 * ЗАЧЕМ. Чтобы позвонить клиенту из списка, агент сейчас должен попасть пальцем в
 * иконку трубки размером с ноготь. В телефонных приложениях это давно делают
 * иначе: смахнул строку — и действие выполнилось. Жест не требует точности и
 * делается одной рукой на ходу, что для риелтора в разъездах и есть основной
 * режим работы.
 *
 * МЕХАНИКА СВЕРЕНА С АРТЕФАКТОМ ВЛАДЕЛЬЦА (10.09.2026, c99db05f «Royal Home 2026 ·
 * мобильная навигация», `swipeRow` + `bindSwipes`). Что взято оттуда дословно:
 *
 * · подложка на всю строку, а не по ширине сдвига: слева зелёная «Позвонить»,
 *   справа лавандовая «Открыть». Надпись стоит у самого края и видна с первого
 *   миллиметра сдвига — раньше она появлялась только после 60 px, и до этого
 *   момента человек тянул строку вслепую;
 * · определение стороны с 8 px (`data-dir`), а срабатывание — с трети ширины;
 * · упор на 120 px и резиновое сопротивление за ним, а не жёсткая остановка;
 * · СКОРОСТЬ засчитывает жест наравне с расстоянием (0,11 px/мс): короткий
 *   резкий смах работает, не доходя до трети экрана;
 * · отклик вибрацией дважды: слабый в момент пересечения порога («уже сработает,
 *   можно отпускать») и обычный на самом действии;
 * · возврат пружиной 200 мс;
 * · клик, который браузер шлёт следом за перетаскиванием, гасится. Без этого в
 *   списке клиентов свайп, не дошедший до порога, всё равно открывал карточку:
 *   поверх строки лежит растянутая ссылка (`rh2-row-link`), и отпускание пальца
 *   читалось ею как нажатие.
 *
 * ЧЕГО ИЗ АРТЕФАКТА ЗДЕСЬ НЕТ НАМЕРЕННО: `touch-action: pan-y` на движущейся
 * части. В артефакте это правило есть, но в проекте оно уже ломало горизонтальный
 * жест (память проекта feedback_touch_action_pan_y_pitfall) — браузер забирал
 * касание себе, и строка не двигалась вовсе.
 *
 * ГДЕ РАБОТАЕТ. Только на телефоне и планшете (`useMobileUx`) и только внутри
 * области темы `.rh2 .scr` — там же, где живут списки. На компьютере жеста нет:
 * там мышь, и обычные кнопки удобнее; компонент отдаёт строку как есть.
 */

/** Насколько далеко надо утянуть строку, чтобы действие сработало. */
const THRESHOLD_FRACTION = 1 / 3;
/** Дальше этого строка не едет своим ходом — начинается резиновое сопротивление. */
const MAX_TRAVEL = 120;
/** Пока сдвиг меньше, считаем движение вертикальной прокруткой, а не жестом. */
const DIRECTION_LOCK = 10;
/** С этого сдвига показываем подложку: раньше — дрожание пальца, а не намерение. */
const DIR_VISIBLE_PX = 8;
/** Скорость (px/мс), при которой жест засчитан независимо от пройденного пути. */
const FLING_VELOCITY = 0.11;
/** Возврат строки на место. Столько же в артефакте (`.sw.anim .row`). */
const SPRING_MS = 200;

/** Отклик вибрацией. Где мотора нет, вызова просто не будет. */
function haptic(ms: number): void {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(ms);
}

interface Drag {
  x: number;
  y: number;
  locked: "none" | "swipe" | "scroll";
  dx: number;
  /** Последние точки пути — по ним считается скорость броска. */
  samples: [time: number, dx: number][];
  /** Порог уже пересекали: чтобы вибрация сработала один раз, а не на каждом кадре. */
  crossed: boolean;
}

export function SwipeRow({
  onCall,
  onOpen,
  openLabel = "Открыть",
  children,
}: {
  /** null — звонок недоступен (лид не принят, номер скрыт): вправо строка не едет. */
  onCall: (() => void) | null;
  onOpen: () => void;
  /** Подпись действия слева-направо. По умолчанию «Открыть», как в артефакте. */
  openLabel?: string;
  children: React.ReactNode;
}) {
  const enabled = useMobileUx();
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [offset, setOffset] = useState(0);
  const [dir, setDir] = useState<"left" | "right" | null>(null);
  const [springing, setSpringing] = useState(false);
  const clearDir = useRef<number | null>(null);

  useEffect(() => () => { if (clearDir.current) window.clearTimeout(clearDir.current); }, []);

  if (!enabled) return <>{children}</>;

  const width = () => wrapRef.current?.getBoundingClientRect().width ?? window.innerWidth;

  /**
   * Клик, который браузер отправляет сразу после перетаскивания, гасим на фазе
   * перехвата. Именно так это сделано в артефакте: слушатель ставится один раз и
   * снимается через 50 мс — дольше держать нельзя, иначе он съест уже настоящее
   * нажатие следом.
   */
  function swallowNextClick() {
    const node = wrapRef.current;
    if (!node) return;
    const kill = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    node.addEventListener("click", kill, { capture: true, once: true });
    window.setTimeout(() => node.removeEventListener("click", kill, { capture: true }), 50);
  }

  function finish() {
    const d = drag.current;
    drag.current = null;
    if (!d || d.locked !== "swipe") {
      setOffset(0);
      return;
    }

    let velocity = 0;
    if (d.samples.length > 1) {
      const [ta, da] = d.samples[0];
      const [tb, db] = d.samples[d.samples.length - 1];
      velocity = (db - da) / Math.max(1, tb - ta);
    }
    const passed = Math.abs(d.dx) >= width() * THRESHOLD_FRACTION || Math.abs(velocity) > FLING_VELOCITY;

    setSpringing(true);
    setOffset(0);
    if (clearDir.current) window.clearTimeout(clearDir.current);
    clearDir.current = window.setTimeout(() => {
      setDir(null);
      setSpringing(false);
    }, SPRING_MS);

    if (Math.abs(d.dx) > DIRECTION_LOCK) swallowNextClick();
    if (!passed) return;

    // Вибрация — подтверждение, что жест засчитан: без неё человек не уверен,
    // сработало ли, пока не начнётся звонок.
    haptic(10);
    if (d.dx > 0 && onCall) onCall();
    if (d.dx < 0) onOpen();
  }

  return (
    <div
      ref={wrapRef}
      className={`sw${springing ? " anim" : ""}`}
      data-dir={dir ?? undefined}
      onTouchStart={(e) => {
        const t = e.touches[0];
        // Жест «назад» начинается от той же кромки (hooks/useEdgeSwipeBack.ts).
        // Отдаём касание ему: два горизонтальных жеста из одной точки — это
        // строка, уезжающая вбок одновременно с уходом на предыдущий экран.
        if (!t || t.clientX <= EDGE_BACK_ZONE_PX) return;
        setSpringing(false);
        drag.current = { x: t.clientX, y: t.clientY, locked: "none", dx: 0, samples: [], crossed: false };
      }}
      onTouchMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.touches[0].clientX - d.x;
        const dy = e.touches[0].clientY - d.y;
        // Направление определяется один раз за жест. Без этого список нельзя
        // было бы прокрутить: любое движение пальца тянуло бы строку вбок.
        if (d.locked === "none") {
          if (Math.abs(dx) < DIRECTION_LOCK && Math.abs(dy) < DIRECTION_LOCK) return;
          d.locked = Math.abs(dx) > Math.abs(dy) ? "swipe" : "scroll";
        }
        if (d.locked !== "swipe") return;

        // Резина за упором: строка продолжает отзываться на палец, но всё
        // неохотнее. Формула из артефакта — жёсткая остановка на 120 px читается
        // как «жест сломался».
        let travel = Math.max(-MAX_TRAVEL, Math.min(MAX_TRAVEL, dx));
        if (Math.abs(dx) > MAX_TRAVEL) {
          const over = Math.abs(dx) - MAX_TRAVEL;
          travel = Math.sign(dx) * (MAX_TRAVEL + (over * MAX_TRAVEL * 0.55) / (MAX_TRAVEL + 0.55 * over));
        }
        // Вправо тянем только если звонок вообще доступен.
        d.dx = onCall ? travel : Math.min(0, travel);
        d.samples.push([performance.now(), dx]);
        if (d.samples.length > 6) d.samples.shift();

        setOffset(d.dx);
        setDir(d.dx > DIR_VISIBLE_PX ? "right" : d.dx < -DIR_VISIBLE_PX ? "left" : null);

        const over = Math.abs(d.dx) >= width() * THRESHOLD_FRACTION;
        if (over && !d.crossed) haptic(6);
        d.crossed = over;
      }}
      onTouchEnd={finish}
      onTouchCancel={finish}
    >
      {/* Подложка на всю строку: цвет говорит, что произойдёт, надпись — что именно. */}
      <div className="under" aria-hidden="true">
        <span className="l">
          <Phone className="i" />
          Позвонить
        </span>
        <span className="r">
          {openLabel}
          <ChevronRight className="i" />
        </span>
      </div>

      <div className="swm" style={{ transform: offset ? `translateX(${offset}px)` : undefined }}>
        {children}
      </div>
    </div>
  );
}
