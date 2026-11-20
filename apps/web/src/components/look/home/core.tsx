import type { ComponentType } from "react";
import type { PermissionId } from "@royal-home/shared";
import { useAuthStore } from "../../../store/auth";
import { BlockBoundary, type BlockFallbackProps } from "../../BlockBoundary";
import { RhButton } from "../ui";
import { RoyalHomeFrame } from "./parts";

/**
 * ЯДРО ГЛАВНОЙ «НОВОГО ВИДА» — одно на все роли (пачка home 20.11.2026; директор,
 * админ, РОП и агент переведены на него правкой home-core 20.11.2026).
 *
 * Владелец 20.11: «через одно ядро на все роли», всё включается и выключается.
 * Главная — это не ветка разметки на роль, а НАБОР БЛОКОВ:
 *  - реестр (`registry.tsx`): у блока id, для каких ролей, имя (заголовок запасного
 *    состояния и строка в «Оформлении»), место в сетке ПК и компонент. Данные блок
 *    грузит сам, своим хуком (TanStack Query сводит одинаковые запросы соседних
 *    блоков в один поход);
 *  - раскладка по роли (`HOME_LAYOUT`): порядок id по умолчанию — всё включено;
 *  - рамка `RoyalHomeCore`: приветствие и блоки роли по порядку, каждый за СВОЕЙ
 *    границей (`components/BlockBoundary.tsx` — одна дверь на «блок упал»: журнал
 *    с именем блока, «Повторить» перезапрашивает упавшее, вкладка на старой сборке
 *    получает «Обновить страницу»).
 *
 * Выключатели и перестановка — `order` и `hidden` (личные, Профиль → Оформление,
 * `home.blocks[роль]` в Agent.preferences). Сохранённое ПРАВ НЕ РАСШИРЯЕТ: блок
 * не своей роли и неизвестный id отсеиваются здесь, а блок, появившийся в реестре
 * позже сохранения, встаёт на своё место по умолчанию включённым.
 */
export interface HomeBlockProps { role: string }

/** Место блока в сетке ПК: колонка «а», колонка «б» или вся строка. */
export type HomeBlockSpan = "a" | "b" | "wide";

export interface HomeBlockDef {
  id: string;
  /** Для каких ролей блок существует вообще. Сохранённый порядок это не расширяет. */
  roles: readonly string[];
  /** Имя блока: заголовок запасного состояния и строка в «Оформлении». */
  title: string;
  /** Где встаёт заглушка упавшего блока; по умолчанию — вся строка. */
  span?: HomeBlockSpan;
  /**
   * Права, без которых блок ничего не рисует (он проверяет их сам). Нужны «Оформлению»:
   * выключатель блока, которого человеку всё равно не видно, не показывается.
   */
  requires?: readonly PermissionId[] | ((role: string) => readonly PermissionId[]);
  component: ComponentType<HomeBlockProps>;
}

/** Блок может что-то нарисовать этому человеку: у него есть все права блока для его роли. */
export function homeBlockVisible(block: HomeBlockDef, role: string, can: (permission: PermissionId) => boolean): boolean {
  const need = typeof block.requires === "function" ? block.requires(role) : block.requires ?? [];
  return need.every((permission) => can(permission));
}

/**
 * Порядок роли: сохранённый (только id из раскладки по умолчанию), а блоки раскладки,
 * которых в сохранённом нет (появились позже), — на своё место по умолчанию: сразу
 * после ближайшего предшественника из раскладки.
 */
export function mergeHomeOrder(defaults: readonly string[], saved: readonly string[] | undefined): string[] {
  if (!saved?.length) return [...defaults];
  const allowed = new Set(defaults);
  const out = [...new Set(saved.filter((id) => allowed.has(id)))];
  defaults.forEach((id, index) => {
    if (out.includes(id)) return;
    let at = 0;
    for (let i = index - 1; i >= 0; i--) {
      const pos = out.indexOf(defaults[i]);
      if (pos >= 0) { at = pos + 1; break; }
    }
    out.splice(at, 0, id);
  });
  return out;
}

/** Блоки, которые роль может видеть вообще, в порядке по умолчанию (для «Оформления»). */
export function homeBlocksAllowed(
  role: string,
  registry: readonly HomeBlockDef[],
  layout: Readonly<Record<string, readonly string[]>>,
): HomeBlockDef[] {
  const byId = new Map(registry.map((block) => [block.id, block]));
  const ownLayout = !!layout[role];
  const out: HomeBlockDef[] = [];
  for (const id of layout[role] ?? layout.default ?? []) {
    const block = byId.get(id);
    if (!block || out.includes(block)) continue;
    if (block.roles.includes(role) || (!ownLayout && block.roles.includes("default"))) out.push(block);
  }
  return out;
}

/** Блоки роли по порядку: свой порядок (если задан), выключенные убраны, чужие роли отсеяны. */
export function homeBlocksFor(
  role: string,
  registry: readonly HomeBlockDef[],
  layout: Readonly<Record<string, readonly string[]>>,
  options: { order?: readonly string[]; hidden?: ReadonlySet<string> } = {},
): HomeBlockDef[] {
  const allowed = homeBlocksAllowed(role, registry, layout);
  const byId = new Map(allowed.map((block) => [block.id, block]));
  return mergeHomeOrder(allowed.map((block) => block.id), options.order)
    .filter((id) => !options.hidden?.has(id))
    .map((id) => byId.get(id)!)
    .filter(Boolean);
}

/** Заглушка упавшего блока: его имя, «Не загрузилось» и «Повторить» — в той же клетке сетки. */
function HomeBlockFailed({ block, stale, retry, retrying, reload }: { block: HomeBlockDef } & BlockFallbackProps) {
  const span = block.span ?? "wide";
  return (
    <section className={`ry-section ry-block-failed${span === "a" ? " ry-col-a" : span === "b" ? " ry-col-b" : ""}`} data-span={span} aria-label={block.title}>
      <header className="ry-section-head"><h2>{block.title}</h2></header>
      <div className="ry-state" role="alert">
        <span>{stale ? "Вышла новая версия" : "Не загрузилось"}</span>
        {stale
          ? <RhButton variant="gray" onClick={reload}>Обновить страницу</RhButton>
          : <RhButton variant="gray" onClick={retry} disabled={retrying} aria-busy={retrying}>Повторить</RhButton>}
      </div>
    </section>
  );
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
      {blocks.map((block) => {
        const Block = block.component;
        return (
          <div key={block.id} className="ry-home-blk" data-block={block.id}>
            {/* Имя в журнале — `today.<id>`, как у прежних блоков «Сегодня» (разбор ошибок по имени). */}
            <BlockBoundary name={`today.${block.id}`} fallback={(props) => <HomeBlockFailed block={block} {...props} />}>
              {() => <Block role={role} />}
            </BlockBoundary>
          </div>
        );
      })}
    </RoyalHomeFrame>
  );
}
