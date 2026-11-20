import { useMemo } from "react";
import { useAuthStore } from "../../../store/auth";
import { useUiPrefs } from "../../../store/uiPrefs";
import { RoyalHomeCore, type HomeBlockDef, type HomeBlockProps } from "./core";
import { AskBlock, ChartsBlock, SecurityLinks } from "./blocks/common";
import { EditorEditing, EditorHint, EditorQuick, EditorTiles, EditorUpcoming } from "./blocks/editor";
import { MarketingAds, MarketingFocus, MarketingQueue, MarketingQuick, MarketingStale, MarketingTiles } from "./blocks/marketing";
import { ManagerFocus, ManagerQuick, ManagerTeam, ManagerTiles, ManagerUnread, ManagerWaiting } from "./blocks/manager";
import { DirectorBurning, DirectorChannels, DirectorCheck, DirectorCommission, DirectorDecisions, DirectorFull, DirectorMoney, DirectorPulse, DirectorTeam } from "./blocks/director";
import { RopFull, RopLosses, RopSpread, RopTasks, RopTeam, RopTiles } from "./blocks/rop";
import { AgentFirstCalls, AgentFull, AgentMonth, AgentPending, AgentShowings, AgentTiles } from "./blocks/agent";

/**
 * РЕЕСТР БЛОКОВ ГЛАВНОЙ «НОВОГО ВИДА» — одна дверь на состав главной всех ролей:
 * блок появляется у роли, только если он здесь и роль в его `roles`. `default` —
 * роли без своей раскладки (как прежняя развилка Dashboard: менеджер, акционер и
 * прочие получают главную менеджера).
 *
 * Пачка home (20.11.2026) — монтажёр, маркетинг, СБ, менеджер, акционер; home-core
 * (20.11.2026) — директор и админ, РОП, агент (прежде pages/TodayRoyal.tsx).
 */
const MANAGERS = ["MANAGER", "default"] as const;
const DIRECTORS = ["DIRECTOR", "ADMIN"] as const;
/**
 * Деньги и тренды: директор, админ и акционер (главные руководителей, 20.11.2026). Акционеру —
 * своя раскладка без операционных блоков («эскалаций», раздачи заявок): он ничего не меняет,
 * а прав на деньги у него столько же, сколько отдаёт сервер (seesMoney в снимке пульта).
 */
const MONEY_VIEWERS = [...DIRECTORS, "SHAREHOLDER"] as const;

/** «Весь экран»: прежняя главная роли целиком (один id на три роли — один выключатель). */
function FullBlock({ role }: HomeBlockProps) {
  if (role === "HEAD_OF_SALES") return <RopFull />;
  if (role === "AGENT") return <AgentFull />;
  return <DirectorFull />;
}

export const HOME_BLOCKS: readonly HomeBlockDef[] = [
  { id: "money", roles: MONEY_VIEWERS, title: "Деньги и главное за день", component: DirectorMoney },
  { id: "decisions", roles: DIRECTORS, requires: ["dashboard.analytics"], title: "Нужно ваше решение", span: "a", component: DirectorDecisions },
  { id: "burning", roles: DIRECTORS, requires: ["dashboard.analytics"], title: "Горит сейчас", span: "b", component: DirectorBurning },
  { id: "check", roles: DIRECTORS, requires: ["dashboard.analytics"], title: "Проверить", span: "a", component: DirectorCheck },
  { id: "team", roles: DIRECTORS, requires: ["dashboard.analytics"], title: "Команда", span: "b", component: DirectorTeam },
  { id: "pulse", roles: MONEY_VIEWERS, requires: ["dashboard.analytics"], title: "Заявки за 30 дней", span: "a", component: DirectorPulse },
  { id: "commission", roles: MONEY_VIEWERS, requires: ["dashboard.analytics", "finance.view"], title: "Комиссия по месяцам", span: "b", component: DirectorCommission },
  { id: "channels", roles: MONEY_VIEWERS, requires: ["dashboard.analytics"], title: "Заявки за месяц по источникам", component: DirectorChannels },

  { id: "ropTiles", roles: ["HEAD_OF_SALES"], requires: ["dashboard.analytics"], title: "Ждут ответа, звонки и просрочки", component: RopTiles },
  { id: "ropSpread", roles: ["HEAD_OF_SALES"], requires: ["dashboard.analytics"], title: "Распределение заявок", span: "a", component: RopSpread },
  { id: "ropTeam", roles: ["HEAD_OF_SALES"], requires: ["dashboard.analytics", "team.viewFull"], title: "Команда", span: "b", component: RopTeam },
  { id: "ropTasks", roles: ["HEAD_OF_SALES"], title: "Мои задачи", span: "b", component: RopTasks },
  { id: "ropLosses", roles: ["HEAD_OF_SALES"], requires: ["reports.view"], title: "Где теряем клиентов", span: "a", component: RopLosses },

  { id: "agentTiles", roles: ["AGENT"], title: "Заявки, показы и дела", component: AgentTiles },
  { id: "agentFirstCalls", roles: ["AGENT"], title: "Позвонить сейчас", span: "a", component: AgentFirstCalls },
  { id: "agentPending", roles: ["AGENT"], title: "Ждут принятия", span: "a", component: AgentPending },
  { id: "agentShowings", roles: ["AGENT"], title: "Показы сегодня", span: "b", component: AgentShowings },
  { id: "agentMonth", roles: ["AGENT"], title: "Мой месяц", span: "b", component: AgentMonth },

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
  // РОП получает те же графики команды (источники месяца, нагрузка агентов): право
  // dashboard.analytics проверяет сам TeamCharts.
  { id: "teamCharts", roles: [...MANAGERS, "HEAD_OF_SALES"], requires: ["dashboard.analytics"], title: "Графики по команде", component: ChartsBlock },

  { id: "ask", roles: ["MARKETING", ...MANAGERS, "SHAREHOLDER"], title: "Спросить помощника", component: AskBlock },
  { id: "full", roles: [...DIRECTORS, "HEAD_OF_SALES", "AGENT"], title: "Весь прежний экран", component: FullBlock,
    // Пульт директора без права на аналитику не показывается (DirectorFull), у РОП и агента прав не нужно.
    requires: (role) => (role === "DIRECTOR" || role === "ADMIN" ? ["dashboard.analytics"] : []) },
];

const DIRECTOR_LAYOUT = ["money", "decisions", "burning", "check", "team", "pulse", "commission", "channels", "full"] as const;
const MANAGER_LAYOUT = ["managerTiles", "managerQuick", "managerFocus", "ask", "managerWaiting", "managerTeam", "managerUnread", "teamCharts"] as const;
/** Акционер: деньги и тренды — плита денег, комиссия и заявки по месяцам, источники, вопрос помощнику. */
const SHAREHOLDER_LAYOUT = ["money", "commission", "pulse", "channels", "ask"] as const;

/** Порядок блоков по умолчанию (всё включено); на ПК половинные блоки встают парами в две колонки. */
export const HOME_LAYOUT: Readonly<Record<string, readonly string[]>> = {
  DIRECTOR: DIRECTOR_LAYOUT,
  ADMIN: DIRECTOR_LAYOUT,
  HEAD_OF_SALES: ["ropTiles", "ropSpread", "ropTeam", "ropTasks", "ropLosses", "teamCharts", "full"],
  AGENT: ["agentTiles", "agentFirstCalls", "agentPending", "agentShowings", "agentMonth", "full"],
  EDITOR: ["editorTiles", "editorQuick", "editorHint", "editorEditing", "editorUpcoming"],
  MARKETING: ["marketingTiles", "marketingQuick", "marketingFocus", "ask", "marketingQueue", "marketingAds", "marketingStale"],
  SECURITY: ["securityLinks"],
  MANAGER: MANAGER_LAYOUT,
  SHAREHOLDER: SHAREHOLDER_LAYOUT,
  default: MANAGER_LAYOUT,
};

type StoredLayout = { order?: string[]; hidden?: string[] };

/**
 * Личная раскладка главной роли (Профиль → Оформление). Только своя: раскладка,
 * оставшаяся на общем устройстве от прежнего входа, не применяется.
 */
export function useHomeLayoutPrefs(role: string): { order?: readonly string[]; hidden: ReadonlySet<string> } {
  const actorId = useAuthStore((s) => s.agent?.id ?? null);
  const owner = useUiPrefs((s) => s.homeBlocksOwnerId);
  const layout = useUiPrefs((s) => (s.homeBlocks as Record<string, StoredLayout | undefined>)[role]);
  const own = owner !== null && owner === actorId ? layout : undefined;
  const hidden = useMemo(() => new Set(own?.hidden ?? []), [own]);
  return { order: own?.order, hidden };
}

/** Главная «Нового вида» любой роли: ядро с реестром, раскладкой и личными выключателями. */
export function RoyalRoleHome() {
  const role = useAuthStore((s) => s.agent?.role) ?? "default";
  const { order, hidden } = useHomeLayoutPrefs(role);
  return <RoyalHomeCore role={role} registry={HOME_BLOCKS} layout={HOME_LAYOUT} order={order} hidden={hidden} />;
}
