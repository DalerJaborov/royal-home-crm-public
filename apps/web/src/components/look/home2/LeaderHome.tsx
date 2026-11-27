import { Suspense, type CSSProperties } from "react";
import { BlockBoundary, type BlockFallbackProps } from "../../BlockBoundary";
import { RoyalSection } from "../clients/RoyalSection";
import { RhBlockState, RhButton } from "../ui";
import { homeBlocksFor, type HomeBlockDef } from "../home/core";
import { RoyalGreeting } from "../home/parts";
import { DashboardHomeBlock } from "../home/blocks/dashboardHome";

/**
 * ГЛАВНАЯ РУКОВОДИТЕЛЯ «КАК В МАКЕТЕ» (пачка home2, 27.11.2026) — директор, админ и РОП с правом
 * на отчёты (lib/homeDashboard.ts). Владелец 27.11: «как в макете, но именно для директора Excel —
 * это он просил в ТЗ, ниже можешь оставить».
 *
 * Сверху — блоки макета из общего реестра главной (registry.tsx, раскладка `LEADER_LAYOUT`) с
 * личными выключателями и порядком из «Оформления»; ниже — заголовок «Аналитика» и дашборд
 * целиком (pages/DirectorDashboard.tsx: все показатели, Excel, печать, периоды, фильтры).
 *
 * Раскладка без измерений в JS: на телефоне один столбец в порядке раскладки (свойство `order`
 * ячейки), на ПК — две колонки как в макете (левая широкая, правая 330–372), каждая блоки своей
 * колонки сверху вниз. Колонки на узком экране — `display: contents`, поэтому порядок задаёт
 * `order`, а блок не пересоздаётся при повороте экрана.
 */
function Failed({ block, stale, retry, retrying, reload }: { block: HomeBlockDef } & BlockFallbackProps) {
  return (
    <section className="ry-section ry-block-failed" aria-label={block.title}>
      <header className="ry-section-head"><h2>{block.title}</h2></header>
      <div className="ry-state" role="alert">
        <span>{stale ? "Вышла новая версия" : "Не загрузилось"}</span>
        {stale
          ? <RhButton variant="secondary" onClick={reload}>Обновить страницу</RhButton>
          : <RhButton variant="secondary" onClick={retry} disabled={retrying} aria-busy={retrying}>Повторить</RhButton>}
      </div>
    </section>
  );
}

export function LeaderHome({ role, registry, layout, columns, order, hidden }: {
  role: string;
  registry: readonly HomeBlockDef[];
  layout: Readonly<Record<string, readonly string[]>>;
  /** Колонка блока на ПК: «a» — левая широкая, «b» — правая узкая (как LAYOUT макета: L/R). */
  columns: Readonly<Record<string, "a" | "b">>;
  order?: readonly string[];
  hidden?: ReadonlySet<string>;
}) {
  const blocks = homeBlocksFor(role, registry, layout, { order, hidden });
  const cell = (block: HomeBlockDef, index: number) => {
    const Block = block.component;
    return (
      <div key={block.id} className="h2-blk" data-block={block.id} style={{ order: index } as CSSProperties}>
        <BlockBoundary name={`today.${block.id}`} fallback={(props) => <Failed block={block} {...props} />}>
          {() => <Block role={role} />}
        </BlockBoundary>
      </div>
    );
  };
  const indexed = blocks.map((block, index) => ({ block, index }));
  const left = indexed.filter(({ block }) => (columns[block.id] ?? "a") === "a");
  const right = indexed.filter(({ block }) => columns[block.id] === "b");
  return (
    <RoyalSection name="home">
      <div className="ry-today ry-home" data-ry-section="home" data-role={role}>
        <RoyalGreeting />
        <div className="h2-home" data-ry-section="home2" data-testid="leader-home">
          <div className="h2-col" data-col="a">{left.map(({ block, index }) => cell(block, index))}</div>
          <div className="h2-col" data-col="b">{right.map(({ block, index }) => cell(block, index))}</div>
        </div>
        <div className="h2-analytics" data-ry-section="home2" data-block="analytics">
          <BlockBoundary name="today.dashboard" fallback={(props) => <Failed block={{ id: "dashboard", roles: [], title: "Аналитика", component: () => null }} {...props} />}>
            {() => <Suspense fallback={<RhBlockState kind="loading" />}><DashboardHomeBlock /></Suspense>}
          </BlockBoundary>
        </div>
      </div>
    </RoyalSection>
  );
}
