import { forwardRef } from "react";
import { Link } from "react-router-dom";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * КНОПКА НАБОРА 2026 (контракт 06.10, раздел «Набор»). Тонкая обёртка над
 * `.pill` темы: вид ведут классы `theme-2026-proto.css` и раздел «набор 2026»
 * в `theme-royal-home-2026.css`, своих стилей здесь нет.
 *
 * ПРАВИЛО 10 КОНТРАКТА: неактивная кнопка обязана говорить, чего не хватает.
 * Это закреплено ТИПОМ, а не линтером: `disabled: true` без `disabledReason`
 * не компилируется, причина уходит в `title`. Исключение одно, `loading`:
 * кнопка занята сама, причина очевидна («Сохраняем»), поэтому `aria-busy`
 * вместо подсказки.
 *
 * Высота: `md` 44, `sm` видимые 40 при зоне нажатия 44 (правило 6 контракта,
 * зона растянута псевдоэлементом `.rh-btn-sm::after`).
 */
export type ButtonVariant = "primary" | "soft" | "ghost" | "danger" | "icon" | "call" | "fab";
export type ButtonSize = "md" | "sm";

type DisabledProps =
  | { disabled?: false; disabledReason?: undefined }
  | { disabled: true; disabledReason: string };

type NativeProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "title" | "type">;

export type ButtonProps = NativeProps &
  DisabledProps & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    /** Идёт операция: кнопка не нажимается, `aria-busy`, подпись остаётся. */
    loading?: boolean;
    /** Значок слева от подписи. У `icon`/`call`/`fab` значок и есть содержимое (`children`). */
    icon?: ReactNode;
    type?: "button" | "submit" | "reset";
    /** Подсказка при наведении для активной кнопки (не причина отказа). */
    title?: string;
  };

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "",
  soft: "soft",
  ghost: "ghost",
  danger: "danger",
  icon: "icon soft rh-btn-round",
  call: "icon btn-call rh-btn-round",
  fab: "icon btn-fab rh-btn-round",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    icon,
    type = "button",
    disabled = false,
    disabledReason,
    title,
    className,
    children,
    ...rest
  },
  ref,
) {
  const isIconOnly = variant === "icon" || variant === "call" || variant === "fab";
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      title={disabled ? disabledReason : title}
      className={cx(
        "pill",
        "rh-btn",
        VARIANT_CLASS[variant],
        size === "sm" && !isIconOnly && "sm rh-btn-sm",
        loading && "is-loading",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
});

/**
 * ССЫЛКА В ВИДЕ КНОПКИ: тот же облик, что у `Button`, но это настоящая ссылка
 * (`<a>`): открывается в новой вкладке, читается скринридером как переход, а
 * не как действие. Нужна там, где «кнопка» только ведёт в раздел (пульт:
 * «Разбор к собранию», «Ответить» на вопрос ИИ), чтобы не плодить `<button>`
 * с `navigate()` внутри.
 */
export function LinkButton({
  to,
  variant = "primary",
  size = "md",
  className,
  children,
  ...rest
}: {
  to: string;
  variant?: Exclude<ButtonVariant, "icon" | "call" | "fab">;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
  "data-testid"?: string;
}) {
  return (
    <Link
      {...rest}
      to={to}
      className={cx("pill", "rh-btn", VARIANT_CLASS[variant], size === "sm" && "sm rh-btn-sm", className)}
    >
      {children}
    </Link>
  );
}
