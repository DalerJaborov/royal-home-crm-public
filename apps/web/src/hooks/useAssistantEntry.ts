import { useSettings } from "./useSettings";
import { useIsReadOnly } from "../lib/permissions";
import { useAssistantUi } from "../store/assistantUi";
import { preloadAssistantPanel } from "../components/AssistantPanelLazy";

/**
 * ВХОД В ПАНЕЛЬ ИИ-ПОМОЩНИКА ДЛЯ КНОПОК ОБОЛОЧКИ НА КОМПЬЮТЕРЕ (31.10.2026).
 *
 * Одно условие показа и одно действие на обе оболочки (прежняя — Topbar, чистая —
 * CleanShell): помощник включён в Настройках и у человека не режим чтения. Ровно
 * то же условие держит сочетание Ctrl+/ в AssistantHost — кнопка и клавиша не
 * расходятся. Панель сама здесь не монтируется (она одна, в AssistantHost).
 *
 * `preloadProps` вешается на кнопку: кусок панели начинает скачиваться на
 * наведение, фокус и касание, пока человек ещё тянется к клику.
 */
export function useAssistantEntry() {
  const { data: settings } = useSettings();
  const readOnly = useIsReadOnly();
  const openAssistant = useAssistantUi((s) => s.openAssistant);
  return {
    visible: Boolean(settings?.aiAssistantEnabled) && !readOnly,
    open: () => openAssistant(),
    preloadProps: {
      onPointerEnter: preloadAssistantPanel,
      onFocus: preloadAssistantPanel,
      onPointerDown: preloadAssistantPanel,
    },
  };
}

/** Подсказка кнопки: сочетание клавиш показываем там, где оно есть (компьютер). */
export const ASSISTANT_ENTRY_LABEL = "ИИ-помощник";
export const ASSISTANT_ENTRY_TITLE = "ИИ-помощник · Ctrl+/";
