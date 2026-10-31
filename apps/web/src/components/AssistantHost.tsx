import { useEffect } from "react";
import { useSettings } from "../hooks/useSettings";
import { useIsReadOnly } from "../lib/permissions";
import { useAssistantUi } from "../store/assistantUi";
import { AssistantPanelLazy, preloadAssistantPanel } from "./AssistantPanelLazy";

/**
 * ЕДИНСТВЕННОЕ МЕСТО, ГДЕ МОНТИРУЕТСЯ ПАНЕЛЬ ИИ-ПОМОЩНИКА (31.10.2026).
 *
 * Стоит один раз в AppLayout. Входы — удержание «+» (BottomNav), кнопка в шапке
 * (Topbar, CleanShell) и сочетание клавиш ниже — только вызывают
 * `useAssistantUi().openAssistant()`; панель у них не своя, поэтому две копии
 * открыться не могут, а новый вход не требует новой копии.
 *
 * СОЧЕТАНИЕ КЛАВИШ — Ctrl+/ (на Mac Cmd+/). Ctrl+K уже занят: он открывает поиск
 * по клиентам и объектам (Sidebar.tsx), и отбирать у людей привычное нельзя.
 * Распознаётся по физической клавише (`code === "Slash"`), а не по символу — на
 * русской раскладке на ней точка, и по `key` сочетание работало бы только на
 * английской. Срабатывает и в поле ввода (с Ctrl обычный текст не печатается).
 *
 * Только если помощник включён в Настройках и у пользователя не режим чтения —
 * те же условия, что у кнопки в шапке: спрятанная кнопка и живая клавиша не
 * должны расходиться.
 */
export function AssistantHost() {
  const { data: settings } = useSettings();
  const readOnly = useIsReadOnly();
  const enabled = Boolean(settings?.aiAssistantEnabled);
  const open = useAssistantUi((s) => s.open);
  const autoStartVoice = useAssistantUi((s) => s.autoStartVoice);
  const seed = useAssistantUi((s) => s.seed);
  const closeAssistant = useAssistantUi((s) => s.closeAssistant);

  useEffect(() => {
    if (!enabled || readOnly) return;
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Slash" || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const { open: isOpen, openAssistant, closeAssistant: close } = useAssistantUi.getState();
      if (isOpen) {
        close();
        return;
      }
      preloadAssistantPanel();
      openAssistant();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, readOnly]);

  // Помощник выключили, пока панель открыта, — закрываем, а не оставляем висеть.
  useEffect(() => {
    if (!enabled && open) closeAssistant();
  }, [enabled, open, closeAssistant]);

  if (!enabled || !open) return null;
  return <AssistantPanelLazy onClose={closeAssistant} autoStartVoice={autoStartVoice} initialPrompt={seed} />;
}
