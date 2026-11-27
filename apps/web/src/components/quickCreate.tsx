import { Suspense, useRef, useState, type ReactNode } from "react";
import { lazyWithReload } from "../lib/lazyWithReload";
import { hapticSuccess, hapticTap } from "../lib/haptics";
import { preloadAssistantPanel } from "./AssistantPanelLazy";
import { useAssistantUi } from "../store/assistantUi";
import { useSettings } from "../hooks/useSettings";

/**
 * «+» — ОДНА ДВЕРЬ НА БЫСТРЫЕ ДЕЙСТВИЯ И ГОЛОС (27.11.2026, пачка shell2).
 *
 * Логика кнопки «+» жила прямо в BottomNav.tsx. В «Новом виде» «+» переехал из
 * нижнего меню в шапку (макет: круглая «+» рядом с колоколом на телефоне и ПК),
 * а у прежнего вида остался внизу. Чтобы у двух кнопок не разъехалось поведение,
 * оно здесь одно: нажатие открывает меню быстрых действий (FabMenu — та же шторка),
 * удержание 450 мс открывает ассистента сразу с голосом, кольцо показывает остаток.
 */
const FabMenu = lazyWithReload(() => import("./FabMenu").then((m) => ({ default: m.FabMenu })));

export const QUICK_CREATE_HOLD_MS = 450;

export interface QuickCreate {
  open: boolean;
  holding: boolean;
  /** Обработчики и признаки для самой кнопки — те же на обеих кнопках. */
  buttonProps: {
    onClick: () => void;
    onPointerDown: () => void;
    onPointerUp: () => void;
    onPointerLeave: () => void;
    onPointerCancel: () => void;
    onContextMenu: (event: { preventDefault: () => void }) => void;
    "data-holding": "true" | undefined;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
  };
  /** Шторка быстрых действий: монтируется, только пока открыта (файл грузится по нажатию). */
  menu: ReactNode;
}

/** `ensureObjectNew` — «+» в шапке «Нового вида»: он же заменил кнопку «Создать объект» шапки ПК (FabMenu.buildItems). */
export function useQuickCreate({ ensureObjectNew = false }: { ensureObjectNew?: boolean } = {}): QuickCreate {
  const [open, setOpen] = useState(false);
  const [holding, setHolding] = useState(false);
  // Панель одна на все входы и монтируется в AssistantHost (AppLayout): здесь только просьба её открыть.
  const openAssistant = useAssistantUi((s) => s.openAssistant);
  // Настройки не загрузились — голос по удержанию не включаем: помощник мог быть выключен владельцем,
  // а включать его наугад нельзя. Нажатие (меню быстрых действий) работает и без настроек.
  const { data: settings, isError: settingsFailed } = useSettings();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);

  function start() {
    if (settingsFailed || !settings?.aiAssistantEnabled) return;
    // Кусок панели начинает скачиваться с касания: за 450 мс удержания он обычно успевает приехать.
    preloadAssistantPanel();
    fired.current = false;
    setHolding(true);
    timer.current = setTimeout(() => {
      fired.current = true;
      setHolding(false);
      // Отклик на СРАБАТЫВАНИЕ, а не на касание (lib/haptics.ts).
      hapticSuccess();
      openAssistant({ autoStartVoice: true });
    }, QUICK_CREATE_HOLD_MS);
  }
  function cancel() {
    if (timer.current) clearTimeout(timer.current);
    setHolding(false);
  }

  return {
    open,
    holding,
    buttonProps: {
      onClick: () => {
        // Долгое нажатие уже открыло ассистента — клик по отпусканию пальца не должен открыть меню поверх.
        if (fired.current) return;
        hapticTap();
        setOpen(true);
      },
      onPointerDown: start,
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      onContextMenu: (event) => event.preventDefault(),
      "data-holding": holding ? "true" : undefined,
      "aria-haspopup": "menu",
      "aria-expanded": open,
    },
    menu: open ? (
      <Suspense fallback={null}>
        <FabMenu open={open} onClose={() => setOpen(false)} ensureObjectNew={ensureObjectNew} />
      </Suspense>
    ) : null,
  };
}

/** Кольцо удержания: дорожка и дуга (геометрия артефакта — viewBox 66, r=31, длина 195). */
export function QuickCreateRing() {
  return (
    <svg data-fab-ring viewBox="0 0 66 66" aria-hidden="true">
      <circle cx="33" cy="33" r="31" />
      <circle cx="33" cy="33" r="31" />
    </svg>
  );
}
