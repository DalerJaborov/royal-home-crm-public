import { Component, Fragment, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { useAuthStore } from "../../../store/auth";
import { RhBlockState, RhSection } from "../ui";
import { RoyalHomeFrame } from "./parts";

/**
 * ЯДРО ГЛАВНОЙ «НОВОГО ВИДА» — одно на все роли (пачка home, 20.11.2026).
 *
 * Владелец 20.11: «через одно ядро на все роли», всё включается и выключается.
 * Главная — это не ветка разметки на роль, а НАБОР БЛОКОВ:
 *  - реестр (`registry.tsx`): у блока id, для каких ролей, заголовок для запасного
 *    состояния и компонент. Данные блок грузит сам, своим хуком (TanStack Query
 *    сводит одинаковые запросы соседних блоков в один);
 *  - раскладка по роли (`HOME_LAYOUT`): порядок id по умолчанию;
 *  - рамка `RoyalHomeCore`: приветствие и блоки роли по порядку, каждый в СВОЕЙ
 *    границе ошибок — упавший блок показывает «Не загрузилось · Повторить», соседи
 *    живут дальше.
 *
 * Выключатели и перестановка: `order` (свой порядок) и `hidden` (выключенные id)
 * приходят снаружи — следующий шаг кладёт их в настройки сотрудника
 * (`home.blocks[роль]` в Agent.preferences). Неизвестный id пропускается молча,
 * блок не для этой роли не рисуется никогда (права — в самом реестре, а не в
 * сохранённом списке).
 */
export interface HomeBlockProps { role: string }

export interface HomeBlockDef {
  id: string;
  /** Для каких ролей блок существует вообще. Сохранённый порядок это не расширяет. */
  roles: readonly string[];
  /** Заголовок запасного состояния, если блок упал при отрисовке; для настроек — его имя. */
  title: string;
  component: ComponentType<HomeBlockProps>;
}

/** Блоки роли по порядку: свой порядок (если задан), выключенные убраны, чужие роли отсеяны. */
export function homeBlocksFor(
  role: string,
  registry: readonly HomeBlockDef[],
  layout: Readonly<Record<string, readonly string[]>>,
  options: { order?: readonly string[]; hidden?: ReadonlySet<string> } = {},
): HomeBlockDef[] {
  const byId = new Map(registry.map((block) => [block.id, block]));
  const ids = options.order ?? layout[role] ?? layout.default ?? [];
  const seen = new Set<string>();
  const out: HomeBlockDef[] = [];
  for (const id of ids) {
    const block = byId.get(id);
    if (!block || seen.has(id) || options.hidden?.has(id)) continue;
    const allowed = block.roles.includes(role) || (!layout[role] && block.roles.includes("default"));
    if (!allowed) continue;
    seen.add(id);
    out.push(block);
  }
  return out;
}

/** Граница ошибок одного блока: упавший блок не роняет главную. */
class HomeBlockBoundary extends Component<{ title: string; children: ReactNode }, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // В консоль разработчика; сам экран показывает короткое состояние блока.
    console.error(`Блок главной «${this.props.title}» не отрисовался`, error, info.componentStack);
  }
  render() {
    if (this.state.failed) {
      return (
        <RhSection title={this.props.title}>
          <RhBlockState kind="error" onRetry={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))} />
        </RhSection>
      );
    }
    // Новая попытка — новый экземпляр блока (ключ), его запросы спрашиваются заново.
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}

export function RoyalHomeCore({ registry, layout, order, hidden, role: roleProp }: {
  registry: readonly HomeBlockDef[];
  layout: Readonly<Record<string, readonly string[]>>;
  order?: readonly string[];
  hidden?: ReadonlySet<string>;
  role?: string;
}) {
  const stored = useAuthStore((s) => s.agent?.role);
  const role = roleProp ?? stored ?? "default";
  const blocks = homeBlocksFor(role, registry, layout, { order, hidden });
  return (
    <RoyalHomeFrame role={role}>
      {blocks.map((block) => (
        <div key={block.id} className="ry-home-blk" data-block={block.id}>
          <HomeBlockBoundary title={block.title}>
            <block.component role={role} />
          </HomeBlockBoundary>
        </div>
      ))}
    </RoyalHomeFrame>
  );
}
