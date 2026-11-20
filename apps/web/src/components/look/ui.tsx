import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { RoyalBrandIcon, RoyalIcon } from "./RoyalIcon";
import type { RoyalBrandName, RoyalIconName } from "./royalIconData";

/**
 * ОБЩИЕ ДЕТАЛИ «НОВОГО ВИДА» (облик royal, 18.11.2026) — одна дверь на каждую.
 *
 * Оформление — в theme-look-royal.css, только под `:root[data-ui-look="royal"]`,
 * на токенах `--ry-*`. Здесь только разметка и смысл. Дальше по экранам брать
 * отсюда, а не рисовать заново: круг-значок, строка, группа, раздел, плитка,
 * кнопка, переключатель.
 *
 * Тон круга: `a0..a5` — спокойная пастель за пунктом (без красного и
 * янтарного), `crit | warn | ok | info` — смысл. Смысл держится не только
 * оттенком: у каждого свой значок и своя яркость круга (разбор психолога 18.11).
 */
export type RhTone = "a0" | "a1" | "a2" | "a3" | "a4" | "a5" | "crit" | "warn" | "ok" | "info";
export type RhBrand = RoyalBrandName | "site" | "calls";

export const RH_SEVERITY_ICON: Record<"crit" | "warn" | "info" | "ok", RoyalIconName> = {
  crit: "flame",
  warn: "circle-alert",
  info: "bell",
  ok: "list-checks",
};

/** In-page anchors scroll without touching the router history. */
function scrollToHash(hash: string) {
  return (event: { preventDefault: () => void }) => {
    event.preventDefault();
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  };
}

export function RhCircle({ icon, tone = "a0", brand, size = 48, filled, children }: {
  icon?: RoyalIconName; tone?: RhTone; brand?: RhBrand; size?: 44 | 48 | 60; filled?: boolean; children?: ReactNode;
}) {
  const glyph = brand === "whatsapp" || brand === "telegram" || brand === "instagram"
    ? <RoyalBrandIcon name={brand} />
    : brand === "calls" ? <RoyalIcon name="phone" filled />
    : brand === "site" ? <RoyalIcon name="globe" />
    : icon ? <RoyalIcon name={icon} filled={filled} /> : null;
  return (
    <span className="ry-circle" data-tone={brand ? undefined : tone} data-brand={brand} data-size={size} aria-hidden="true">
      {glyph ?? children}
    </span>
  );
}

/** Строка списка: круг/аватар слева, название (17) и одна короткая подпись, справа значение или действие. */
export function RhRow({ to, onClick, lead, title, sub, subTone, right, label }: {
  to?: string; onClick?: () => void; lead?: ReactNode; title: ReactNode; sub?: ReactNode;
  subTone?: "crit" | "warn" | "ok"; right?: ReactNode; label?: string;
}) {
  const body = <>
    {lead}
    <span className="ry-row-text">
      <span className="ry-row-title">{title}</span>
      {sub !== undefined && sub !== null && sub !== "" && <span className="ry-row-sub" data-tone={subTone}>{sub}</span>}
    </span>
    {right !== undefined && <span className="ry-row-right">{right}</span>}
  </>;
  if (to?.startsWith("#")) return <a href={to} className="ry-row ry-row-link" aria-label={label} onClick={scrollToHash(to)}>{body}</a>;
  if (to) return <Link to={to} className="ry-row ry-row-link" aria-label={label}>{body}</Link>;
  if (onClick) return <button type="button" className="ry-row ry-row-link" aria-label={label} onClick={onClick}>{body}</button>;
  return <div className="ry-row">{body}</div>;
}

export function RhGroup({ children, label }: { children: ReactNode; label?: string }) {
  return <div className="ry-group" role={label ? "group" : undefined} aria-label={label}>{children}</div>;
}

/** Раздел главной: заголовок 20 и, при наличии, ссылка «Все» справа. */
export function RhSection({ id, title, to, linkLabel = "Все", children, className }: {
  id?: string; title: string; to?: string; linkLabel?: string; children: ReactNode; className?: string;
}) {
  return (
    <section id={id} className={`ry-section${className ? ` ${className}` : ""}`} aria-label={title}>
      <header className="ry-section-head">
        <h2>{title}</h2>
        {to && <Link to={to} className="ry-section-link">{linkLabel}</Link>}
      </header>
      {children}
    </section>
  );
}

/**
 * Плитка с крупной цифрой: `brand` — лайм, `ink` — чёрная (цифра лаймом), `plain` — белая;
 * по смыслу (вариант выдаёт `tileTone()` из ./tileTone): `calm` — ноль, серая;
 * `crit` — срочное, светло-красная с красной цифрой; `ok` — хороший итог, светло-зелёная.
 */
export function RhTile({ variant, icon, label, value, unit, to, alert, note }: {
  variant: "brand" | "ink" | "plain" | "calm" | "crit" | "ok"; icon: RoyalIconName; label: string; value: ReactNode; unit?: string; to?: string;
  /** Ошибка блока, к которому ведёт плитка: точка-знак, чтобы ошибку ниже сгиба было видно наверху. */
  alert?: boolean;
  /** Одна короткая строка под цифрой: период или пояснение («сегодня», «дольше всех ждёт 40 мин»). */
  note?: ReactNode;
}) {
  const inner = <>
    <span className="ry-tile-label"><RoyalIcon name={icon} size={26} />{label}{alert && <span className="ry-tile-alert" role="img" aria-label="Часть данных не загрузилась" />}</span>
    <span className="ry-tile-value ry-num">{value}{unit && <small>{unit}</small>}</span>
    {note && <span className="ry-tile-note">{note}</span>}
  </>;
  if (to?.startsWith("#")) return <a href={to} className="ry-tile" data-variant={variant} onClick={scrollToHash(to)}>{inner}</a>;
  if (to) return <Link to={to} className="ry-tile" data-variant={variant}>{inner}</Link>;
  return <div className="ry-tile" data-variant={variant}>{inner}</div>;
}

export function RhButton({ variant = "soft", children, ...rest }: {
  variant?: "primary" | "soft" | "dark" | "gray";
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest} className={`ry-btn${rest.className ? ` ${rest.className}` : ""}`} data-variant={variant}>{children}</button>;
}

export function RhLinkButton({ to, variant = "soft", children, label }: { to: string; variant?: "primary" | "soft" | "dark" | "gray"; children: ReactNode; label?: string }) {
  return <Link to={to} className="ry-btn" data-variant={variant} aria-label={label}>{children}</Link>;
}

/** Переключатель 56×34: переключается сразу (optimistic), подпись — снаружи. */
export function RhSwitch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className="ry-switch" onClick={() => onChange(!checked)}>
      <span className="ry-switch-knob" />
    </button>
  );
}

/** Аватар: фото или инициалы на пастели, тон закреплён за именем. */
export function RhAvatar({ name, src, size = 48 }: { name: string; src?: string | null; size?: 44 | 48 | 64 }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <span className="ry-avatar" data-tone={`a${hash % 6}`} data-size={size} aria-hidden="true">
      {src && broken !== src ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(src)} /> : initials}
    </span>
  );
}

/** Короткое состояние блока: «Не загрузилось» + «Повторить», без первого лица. */
export function RhBlockState({ kind, onRetry }: { kind: "loading" | "error" | "empty"; onRetry?: () => void }) {
  if (kind === "loading") return <div className="ry-skeleton" role="status" aria-label="Загрузка"><span /><span /><span /></div>;
  if (kind === "error") return (
    <div className="ry-state" role="alert">
      <span>Не загрузилось</span>
      {onRetry && <RhButton variant="gray" onClick={onRetry}>Повторить</RhButton>}
    </div>
  );
  return <div className="ry-state">Пусто</div>;
}
