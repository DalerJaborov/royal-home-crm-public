import { forwardRef } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";

/**
 * Иконка плитки. НЕ `LucideIcon`: половина экранов рисует свои иконки-компоненты
 * (`ProtoIcons` в Телефонии и пульте), и узкий тип заставлял агентов просто
 * выбрасывать иконку — плитка теряла узнаваемость. Требуется ровно то, что
 * плитка использует: компонент, принимающий класс и толщину линии.
 */
export type TileIcon = React.ComponentType<{ className?: string; strokeWidth?: number }>;

/**
 * Плитка с числом — единственный вид числового блока во всей CRM.
 *
 * Требование владельца (15.09.2026): «везде где есть плитки, они должны вести
 * куда-нибудь». До этого плитки на 16 экранах были обычными `<div>`: человек
 * видел «Пропущенные звонки 7», тыкал и ничего не происходило. Поэтому здесь
 * нет варианта «плитка без действия» — либо `to` (переход), либо `onClick`
 * (раскрыть список на этом же экране). Верстка остаётся эталонной `.tile`
 * (theme-2026-proto.css: `.hd` > `.ic` + подпись, `b` — число, `small` — строка
 * пояснения), меняется только корневой тег: `<Link>` или `<button>`.
 *
 * Стрелка `›` справа — единственная добавка к эталону: она отличает плитку,
 * которая куда-то ведёт, от таблички, которая просто показывает число. Скрыта
 * от скринридеров (роль ссылки/кнопки и так объявлена).
 */
export type StatTileProps = {
  icon?: TileIcon;
  /**
   * Цвет подложки под иконкой — токен темы (`var(--aqua)`, `var(--pink)`).
   * Эталон задаёт его переменной `--c` прямо на `.ic`: в Телефонии четыре
   * плитки различаются именно цветом, и без этого они становятся одинаковыми.
   */
  iconTone?: string;
  /** Цветная точка состояния в шапке плитки — как в эталоне `.hd .dot`. */
  dot?: "ok" | "warn" | "crit";
  /** Подпись над числом: «Пропущенные звонки». */
  label: string;
  /** Само число или готовая строка («82 400 с.»). */
  value: React.ReactNode;
  /** Пояснение под числом. Необязательно. */
  line?: React.ReactNode;
  /** Пояснение окрашено в красный (просрочка, потери). */
  critical?: boolean;
  /** Куда ведёт плитка. Взаимоисключимо с onClick. */
  to?: string;
  /** Действие на этом же экране (раскрыть список, открыть вкладку). */
  onClick?: () => void;
  /** Подсказка при наведении — чем именно будет отфильтрован список. */
  title?: string;
  className?: string;
};

const INNER = (
  Icon: TileIcon | undefined,
  iconTone: string | undefined,
  label: string,
  value: React.ReactNode,
  line: React.ReactNode | undefined,
  critical: boolean,
  dot: StatTileProps["dot"],
) => (
  <>
    <div className="hd">
      {Icon && (
        <span className="ic" aria-hidden="true" style={iconTone ? ({ "--c": iconTone } as React.CSSProperties) : undefined}>
          <Icon className="i" strokeWidth={1.5} />
        </span>
      )}
      {label}
      {dot && <span className={`dot ${dot}`} aria-hidden="true" />}
      <ChevronRight className="tile-go" aria-hidden="true" strokeWidth={2} />
    </div>
    <b>{value}</b>
    {line !== undefined && line !== null && <small className={critical ? "crit" : undefined}>{line}</small>}
  </>
);

export const StatTile = forwardRef<HTMLElement, StatTileProps>(function StatTile(
  { icon, iconTone, label, value, line, critical = false, dot, to, onClick, title, className },
  ref,
) {
  const cls = className ? `tile ${className}` : "tile";
  const inner = INNER(icon, iconTone, label, value, line, critical, dot);

  if (to) {
    return (
      <Link ref={ref as React.Ref<HTMLAnchorElement>} to={to} className={cls} title={title}>
        {inner}
      </Link>
    );
  }
  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type="button"
      className={cls}
      onClick={onClick}
      title={title}
    >
      {inner}
    </button>
  );
});

export default StatTile;
