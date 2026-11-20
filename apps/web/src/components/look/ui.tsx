import { useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
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

/**
 * КНОПКА — четыре вида (конституция оболочки, пачка C): `primary` — главное действие, одна на
 * блок; `secondary` — обычное; `ghost` — только текст; `danger` — необратимое. Прежние `soft` и
 * `gray` — синонимы `secondary`, `dark` — `primary` (старые вызовы не ломаются, вид один).
 * `disabledReason` — кнопка выключена, причина видна подписью под ней и озвучивается чтецом:
 * выключенная кнопка без причины для новичка выглядит сломанной (critic-uiux P1-11).
 */
export type RhButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type RhButtonVariantInput = RhButtonVariant | "soft" | "gray" | "dark";
export function rhButtonVariant(variant: RhButtonVariantInput = "secondary"): RhButtonVariant {
  return variant === "soft" || variant === "gray" ? "secondary" : variant === "dark" ? "primary" : variant;
}

export function RhButton({ variant = "secondary", disabledReason, children, ...rest }: {
  variant?: RhButtonVariantInput;
  /** Причина, почему кнопка выключена. Есть причина — кнопка выключена всегда. */
  disabledReason?: string | null;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const reasonId = useId();
  const button = (
    <button type="button" {...rest}
      disabled={rest.disabled || !!disabledReason}
      title={disabledReason || rest.title}
      aria-describedby={disabledReason ? reasonId : rest["aria-describedby"]}
      className={`ry-btn${rest.className ? ` ${rest.className}` : ""}`} data-variant={rhButtonVariant(variant)}>{children}</button>
  );
  if (!disabledReason) return button;
  return <span className="ry-btn-hold">{button}<span id={reasonId} className="ry-btn-reason">{disabledReason}</span></span>;
}

export function RhLinkButton({ to, variant = "secondary", children, label }: { to: string; variant?: RhButtonVariantInput; children: ReactNode; label?: string }) {
  return <Link to={to} className="ry-btn" data-variant={rhButtonVariant(variant)} aria-label={label}>{children}</Link>;
}

/** Следующий вариант по клавише: стрелки по кругу, Home/End; из невидимого значения — с края. */
export function rhStepByKey<Id extends string>(ids: readonly Id[], current: Id | undefined, key: string): Id | undefined {
  if (!ids.length) return undefined;
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  if (!step) return undefined;
  const index = current === undefined ? -1 : ids.indexOf(current);
  const from = index < 0 ? (step > 0 ? -1 : 0) : index;
  return ids[(from + step + ids.length) % ids.length];
}

export type RhChoice<Id extends string> = {
  id: Id;
  label: ReactNode;
  /** Подпись для чтеца, когда видимая подпись — значок или сокращение. */
  ariaLabel?: string;
  disabled?: boolean;
  /** Свои атрибуты варианта (data-*) — для тестов и слоёв экранов. */
  attrs?: Record<string, string | undefined>;
};

/**
 * SEGMENTED — 2–4 взаимоисключающих варианта ОДНОГО списка («Ждут / Мои / Все», «Продавцы /
 * Покупатели»). Радиогруппа: стрелки переключают, в порядке Tab — одна кнопка. Вид — серый
 * трек, выбранный на светлой таблетке (theme-look-royal.css, .ry-seg). Значение вне вариантов
 * (спрятанный срез) — ни один не выбран, в Tab-порядке первый.
 */
export function RhSegmented<Id extends string>({ value, options, onChange, label, className }: {
  value: Id | undefined; options: readonly RhChoice<Id>[]; onChange: (id: Id) => void; label: string; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ids = options.filter((o) => !o.disabled).map((o) => o.id);
  const checked = options.findIndex((o) => o.id === value);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = rhStepByKey(ids, value, event.key);
    if (!next) return;
    event.preventDefault();
    onChange(next);
    ref.current?.querySelector<HTMLButtonElement>(`[data-rh-choice="${next}"]`)?.focus();
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={`ry-seg${className ? ` ${className}` : ""}`} onKeyDown={onKeyDown}>
      {options.map((o, index) => (
        <button key={o.id} type="button" role="radio" {...o.attrs} data-rh-choice={o.id}
          aria-checked={o.id === value} aria-label={o.ariaLabel} disabled={o.disabled}
          tabIndex={index === (checked < 0 ? 0 : checked) ? 0 : -1}
          onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * TABS — разделы одной страницы («Кратко / Объекты / Переписка»). Список вкладок: стрелки и
 * Home/End, у панели — `${idPrefix}-panel-<id>`, у вкладки — `${idPrefix}-tab-<id>`. Вид — без
 * трека, выбранная на мягком синем (.ry-tabs). Переход между страницами — RhNavTabs.
 */
export function RhTabs<Id extends string>({ value, tabs, onChange, label, idPrefix, className, tabClassName }: {
  value: Id; tabs: readonly RhChoice<Id>[]; onChange: (id: Id) => void; label: string;
  idPrefix: string; className?: string; tabClassName?: string;
}) {
  const ids = tabs.filter((t) => !t.disabled).map((t) => t.id);
  return (
    <div role="tablist" aria-label={label} className={`ry-tabs${className ? ` ${className}` : ""}`}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" {...t.attrs} id={`${idPrefix}-tab-${t.id}`}
          aria-selected={t.id === value} aria-label={t.ariaLabel} aria-controls={`${idPrefix}-panel-${t.id}`}
          tabIndex={t.id === value ? 0 : -1} disabled={t.disabled} className={tabClassName}
          onClick={(event) => { onChange(t.id); event.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }}
          onKeyDown={(event) => {
            const next = rhStepByKey(ids, t.id, event.key);
            if (!next) return;
            event.preventDefault();
            onChange(next);
            event.currentTarget.ownerDocument.getElementById(`${idPrefix}-tab-${next}`)?.focus();
          }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Вкладки-ссылки между страницами одного раздела: тот же вид, что RhTabs, смысл — навигация. */
export function RhNavTabs({ items, label, className }: {
  items: readonly { to: string; label: ReactNode; current: boolean; ariaLabel?: string; title?: string }[]; label: string; className?: string;
}) {
  return (
    <nav aria-label={label} className={`ry-tabs${className ? ` ${className}` : ""}`}>
      {items.map((item) => (
        <Link key={item.to} to={item.to} aria-current={item.current ? "page" : undefined} aria-label={item.ariaLabel} title={item.title}>{item.label}</Link>
      ))}
    </nav>
  );
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
      {onRetry && <RhButton variant="secondary" onClick={onRetry}>Повторить</RhButton>}
    </div>
  );
  return <div className="ry-state">Пусто</div>;
}
