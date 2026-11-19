import { RoyalHomeCore, type HomeBlockDef } from "./core";
import { AskBlock, ChartsBlock, SecurityLinks } from "./blocks/common";
import { EditorEditing, EditorHint, EditorQuick, EditorTiles, EditorUpcoming } from "./blocks/editor";
import { MarketingAds, MarketingFocus, MarketingQueue, MarketingQuick, MarketingStale, MarketingTiles } from "./blocks/marketing";
import { ManagerFocus, ManagerQuick, ManagerTeam, ManagerTiles, ManagerUnread, ManagerWaiting } from "./blocks/manager";

/**
 * РЕЕСТР БЛОКОВ ГЛАВНОЙ «НОВОГО ВИДА» (пачка home, 20.11.2026) — одна дверь на
 * состав главной: блок появляется у роли, только если он здесь и роль в его
 * `roles`. `default` — роли без своей раскладки (как прежняя развилка Dashboard:
 * менеджер, акционер и прочие получают главную менеджера).
 *
 * Директор, админ, РОП и агент пока живут в pages/TodayRoyal.tsx; перевод их
 * блоков сюда — следующий шаг (см. журнал пачки).
 */
const MANAGERS = ["MANAGER", "SHAREHOLDER", "default"] as const;

export const HOME_BLOCKS: readonly HomeBlockDef[] = [
  { id: "editorTiles", roles: ["EDITOR"], title: "Показатели монтажа", component: EditorTiles },
  { id: "editorQuick", roles: ["EDITOR"], title: "Быстрые переходы", component: EditorQuick },
  { id: "editorHint", roles: ["EDITOR"], title: "Подсказка", component: EditorHint },
  { id: "editorEditing", roles: ["EDITOR"], title: "На монтаже", component: EditorEditing },
  { id: "editorUpcoming", roles: ["EDITOR"], title: "Скоро на монтаж", component: EditorUpcoming },

  { id: "marketingTiles", roles: ["MARKETING"], title: "Подготовка объектов", component: MarketingTiles },
  { id: "marketingQuick", roles: ["MARKETING"], title: "Быстрые переходы", component: MarketingQuick },
  { id: "marketingFocus", roles: ["MARKETING"], title: "Горит сейчас", component: MarketingFocus },
  { id: "marketingQueue", roles: ["MARKETING"], title: "Далее по приоритету", component: MarketingQueue },
  { id: "marketingAds", roles: ["MARKETING"], title: "Реклама за неделю", component: MarketingAds },
  { id: "marketingStale", roles: ["MARKETING"], title: "Объекты простаивают", component: MarketingStale },

  { id: "securityLinks", roles: ["SECURITY"], title: "Рабочие разделы", component: SecurityLinks },

  { id: "managerTiles", roles: MANAGERS, title: "Заявки и команда", component: ManagerTiles },
  { id: "managerQuick", roles: MANAGERS, title: "Быстрые переходы", component: ManagerQuick },
  { id: "managerFocus", roles: MANAGERS, title: "Горит сейчас", component: ManagerFocus },
  { id: "managerWaiting", roles: MANAGERS, title: "Ждут распределения", component: ManagerWaiting },
  { id: "managerTeam", roles: MANAGERS, title: "Кто сейчас свободен", component: ManagerTeam },
  { id: "managerUnread", roles: MANAGERS, title: "Сообщения без ответа", component: ManagerUnread },
  { id: "teamCharts", roles: MANAGERS, title: "Графики по команде", component: ChartsBlock },

  { id: "ask", roles: ["MARKETING", ...MANAGERS], title: "Спросить помощника", component: AskBlock },
];

/** Порядок блоков по умолчанию; на ПК половинные блоки встают парами в две колонки. */
export const HOME_LAYOUT: Readonly<Record<string, readonly string[]>> = {
  EDITOR: ["editorTiles", "editorQuick", "editorHint", "editorEditing", "editorUpcoming"],
  MARKETING: ["marketingTiles", "marketingQuick", "marketingFocus", "ask", "marketingQueue", "marketingAds", "marketingStale"],
  SECURITY: ["securityLinks"],
  MANAGER: ["managerTiles", "managerQuick", "managerFocus", "ask", "managerWaiting", "managerTeam", "managerUnread", "teamCharts"],
  SHAREHOLDER: ["managerTiles", "managerQuick", "managerFocus", "ask", "managerWaiting", "managerTeam", "managerUnread", "teamCharts"],
  default: ["managerTiles", "managerQuick", "managerFocus", "ask", "managerWaiting", "managerTeam", "managerUnread", "teamCharts"],
};

/** Главная роли (кроме ролей TodayRoyal): ядро с реестром и раскладкой по умолчанию. */
export function RoyalRoleHome() {
  return <RoyalHomeCore registry={HOME_BLOCKS} layout={HOME_LAYOUT} />;
}
