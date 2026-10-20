import {
  forwardRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Link, type LinkProps } from "react-router-dom";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * НАБОР «ROYAL CLEAN» (07.10.2026) — компоненты в стиле shadcn/ui: Tailwind-утилиты,
 * варианты через class-variance-authority, слияние классов через tailwind-merge.
 * Единственный источник размеров — шкала макета `docs/design/director-pult-2026-10/royal-clean.css`:
 * кнопки 36/42/48, чипы 26, аватары 28/36/40/44, радиусы 14/20/28, кегли 13/14/16/18/20/28/34/40.
 * Цвета — переменные темы (`--c-*`, `--rgb-accent`), чтобы работали день и ночь.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* ---------- Кнопка ---------- */
const button = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold transition-[transform,background-color,box-shadow] duration-200 ease-[cubic-bezier(.2,.8,.2,1)] active:scale-[.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue disabled:opacity-50 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        primary:
          "bg-blue text-white shadow-[0_8px_20px_-10px_rgb(var(--rgb-accent)/.8)] hover:bg-blue-hover",
        black: "bg-ink text-[var(--c-card)] hover:opacity-90",
        white:
          "bg-card text-ink border border-line-soft shadow-[0_1px_2px_rgba(16,24,40,.03),0_6px_20px_rgba(16,24,40,.05)] hover:shadow-md",
        outline:
          "bg-transparent text-gray-700 ring-1 ring-inset ring-line hover:bg-row-alt",
        soft: "bg-row-alt text-gray-700 hover:bg-line-soft",
      },
      size: {
        sm: "min-h-11 px-3.5 text-[13px] [&_svg]:size-4",
        md: "min-h-11 px-[18px] text-[14px] [&_svg]:size-[18px]",
        lg: "h-12 px-[22px] text-[16px] [&_svg]:size-[18px]",
        icon: "size-11 p-0 [&_svg]:size-4",
        "icon-md": "size-11 p-0 [&_svg]:size-[18px]",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type CleanButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button>;

export const CButton = forwardRef<HTMLButtonElement, CleanButtonProps>(
  function CButton(
    { className, variant, size, type = "button", ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        data-clean-control={size === "icon" || size === "icon-md" ? "icon" : "button"}
        data-clean-variant={variant ?? "primary"}
        data-clean-size={size ?? "md"}
        className={cn(button({ variant, size }), className)}
        {...rest}
      />
    );
  },
);

export function CLink({
  to,
  className,
  variant,
  size,
  children,
  ...rest
}: LinkProps & VariantProps<
  typeof button
>) {
  return (
    <Link {...rest} to={to} data-clean-control={size === "icon" || size === "icon-md" ? "icon" : "button"} data-clean-variant={variant ?? "primary"} data-clean-size={size ?? "md"} className={cn(button({ variant, size }), className)}>
      {children}
    </Link>
  );
}

/* ---------- Карточка ---------- */
export function CCard({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "clean-card min-w-0 rounded-[20px] border border-line-soft bg-card p-[22px_24px] shadow-[0_1px_2px_rgba(16,24,40,.03),0_10px_30px_rgba(16,24,40,.06)] transition-[transform,box-shadow] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(16,24,40,.04),0_14px_34px_rgba(16,24,40,.09)]",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Заголовок карточки: название 18/600, серый счётчик, справа ссылка или кнопки. */
export function CHead({
  title,
  count,
  right,
  className,
}: {
  title: string;
  count?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 flex min-h-9 items-center gap-2.5", className)}>
      <h3 className="m-0 text-[18px] font-semibold tracking-[-.015em] text-ink">
        {title}
      </h3>
      {count !== undefined && count !== null ? (
        <span className="text-[13px] text-gray-500">{count}</span>
      ) : null}
      {right ? (
        <div className="ml-auto flex items-center gap-2">{right}</div>
      ) : null}
    </div>
  );
}

/* ---------- Чип ---------- */
const chip = cva(
  "inline-flex min-h-[26px] items-center gap-1.5 whitespace-normal rounded-full px-2.5 py-1 text-[13px] font-semibold [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        ok: "bg-green-bg text-green",
        warn: "bg-amber-bg text-amber",
        crit: "bg-red-bg text-red",
        info: "bg-blue/10 text-blue",
        gray: "bg-row-alt text-gray-700",
        white: "bg-card text-ink",
      },
    },
    defaultVariants: { tone: "gray" },
  },
);
export function CChip({
  className,
  tone,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof chip>) {
  return <span className={cn(chip({ tone }), className)} {...rest} />;
}

/* ---------- Аватар ---------- */
export function CAvatar({
  src,
  name,
  size = 36,
  className,
}: {
  src?: string | null;
  name: string;
  size?: 28 | 36 | 40 | 44;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const initials =
    name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "•";
  const dim = { width: size, height: size };
  return src && src !== failedSrc ? (
    <img
      src={src}
      onError={() => setFailedSrc(src)}
      alt=""
      style={dim}
      className={cn("shrink-0 rounded-full object-cover", className)}
    />
  ) : (
    <span
      style={dim}
      aria-hidden
      className={cn(
        "clean-avatar-fallback grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-avatar-from to-avatar-to text-[13px] font-semibold text-white",
        className,
      )}
    >
      {initials}
    </span>
  );
}

/* ---------- Кольцо прогресса ---------- */
export function CRing({
  value,
  label,
  size = 36,
  tone = "accent",
}: {
  /** 0–100 */
  value: number;
  label: ReactNode;
  size?: 36 | 96;
  tone?: "accent" | "ok" | "warn" | "crit" | "gray";
}) {
  const color =
    tone === "ok"
      ? "rgb(var(--rgb-green))"
      : tone === "warn"
        ? "rgb(var(--rgb-amber))"
        : tone === "crit"
          ? "rgb(var(--rgb-red))"
          : tone === "gray"
            ? "rgb(var(--rgb-g400))"
            : "rgb(var(--rgb-accent))";
  const p = Math.max(0, Math.min(100, value));
  return (
    <span
      className="relative grid shrink-0 place-items-center rounded-full"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(${color} ${p}%, var(--c-line-soft) 0)`,
      }}
    >
      <span
        className="absolute rounded-full bg-card"
        style={{ inset: size === 96 ? 11 : 5 }}
      />
      <span
        className={cn(
          "relative font-semibold tabular-nums text-ink",
          size === 96 ? "text-[28px]" : "text-[13px]",
        )}
      >
        {label}
      </span>
    </span>
  );
}
