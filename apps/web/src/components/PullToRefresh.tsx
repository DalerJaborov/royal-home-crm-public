import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, ArrowDown } from "lucide-react";
import { useSheetMode } from "./BottomSheet";

/**
 * Потянуть вниз — обновить.
 *
 * ЗАЧЕМ. В телефонных приложениях это единственный способ сказать «покажи
 * свежее», и рука тянется к нему сама. В CRM его не было: чтобы увидеть новые
 * лиды, агент искал глазами кнопку или перезагружал страницу целиком, теряя
 * место в списке. Данные и так подтягиваются раз в 25 секунд, но человеку нужно
 * не «когда-нибудь», а «сейчас, я жду звонка от клиента».
 *
 * КАК УСТРОЕНО. Жест ловится только когда страница прокручена в самый верх, —
 * иначе он мешал бы обычной прокрутке. Тянуть нужно заметно (80 пикселей): жест
 * должен быть намеренным, случайное движение при листании обновление не запускает.
 * Обновляются все запросы страницы разом через invalidateQueries — это ровно то,
 * что делает автообновление, только по требованию человека.
 *
 * ГДЕ РАБОТАЕТ. Облик «Живая 2.0» на узком экране — как шторки и жесты в списках.
 */

/** Порог срабатывания в пикселях. */
const TRIGGER = 80;
/** Дальше индикатор не растягивается — резина, а не бесконечная лента. */
const MAX_PULL = 120;

export function PullToRefresh({ children }: { children: React.ReactNode }) {
  const enabled = useSheetMode();
  const qc = useQueryClient();
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const drag = useRef<{ y: number; active: boolean } | null>(null);

  // Обновление не должно висеть вечно, если запрос завис: снимаем индикатор,
  // даже когда сеть молчит.
  useEffect(() => {
    if (!refreshing) return;
    const t = window.setTimeout(() => setRefreshing(false), 8000);
    return () => window.clearTimeout(t);
  }, [refreshing]);

  if (!enabled) return <>{children}</>;

  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0;

  /**
   * Жест начался ВНУТРИ своего прокручиваемого блока — значит, человек листает
   * его, а не тянет страницу.
   *
   * Проверять только прокрутку окна мало: на «Сообщениях» переписка живёт в
   * собственном скроллере, а само окно прокручено в ноль. Агент листал историю
   * сообщений вверх — и сверху вылезало «Потяните вниз, обновим», страница
   * разъезжалась, а на отпускании перезапрашивались ВСЕ данные CRM.
   *
   * Ищем среди предков любой прокручиваемый блок, который уже пролистан: если
   * такой есть — жест не наш.
   */
  const insideScrolledArea = (target: EventTarget | null): boolean => {
    let node = target instanceof Element ? target : null;
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight + 1 && node.scrollTop > 0) return true;
      node = node.parentElement;
    }
    return false;
  };

  async function run() {
    setRefreshing(true);
    if (typeof navigator.vibrate === "function") navigator.vibrate(12);
    try {
      await qc.invalidateQueries();
    } finally {
      setRefreshing(false);
    }
  }

  const ready = pull >= TRIGGER;

  return (
    <div
      onTouchStart={(e) => {
        drag.current = {
          y: e.touches[0].clientY,
          active: atTop() && !refreshing && !insideScrolledArea(e.target),
        };
      }}
      onTouchMove={(e) => {
        const d = drag.current;
        if (!d || !d.active) return;
        const delta = e.touches[0].clientY - d.y;
        if (delta <= 0) {
          setPull(0);
          return;
        }
        // Сопротивление: чем дальше тянут, тем медленнее едет — как в нативных
        // списках. Без него жест ощущается «пустым».
        setPull(Math.min(MAX_PULL, delta * 0.5));
      }}
      onTouchEnd={() => {
        const shouldRun = pull >= TRIGGER;
        drag.current = null;
        setPull(0);
        if (shouldRun) void run();
      }}
    >
      {/* Индикатор занимает место только пока его тянут: в покое высота ноль,
          и разметка страницы не смещается. */}
      <div
        className="flex items-center justify-center overflow-hidden text-gray-400"
        style={{
          height: refreshing ? 44 : pull,
          transition: drag.current ? "none" : "height 220ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {refreshing ? (
          <span className="flex items-center gap-2 text-[15px] font-semibold">
            <Loader2 className="w-4 h-4 animate-spin" />
            Обновляем…
          </span>
        ) : (
          pull > 8 && (
            <span className={`flex items-center gap-2 text-[15px] font-semibold ${ready ? "text-blue" : ""}`}>
              <ArrowDown className={`w-4 h-4 transition-transform ${ready ? "rotate-180" : ""}`} />
              {ready ? "Отпустите, обновим" : "Потяните вниз"}
            </span>
          )
        )}
      </div>
      {children}
    </div>
  );
}
