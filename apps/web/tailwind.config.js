/** @type {import('tailwindcss').Config} */
// Вся палитра — CSS-переменные (см. index.css): темы переключаются атрибутом
// data-theme на <html> без пересборки. Токены с alpha-modifier (text-blue/20 и т.п.)
// хранятся как каналы "R G B", поверхности с встроенной прозрачностью — как готовые цвета.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  /**
   * ЗАВИСШЕЕ НАВЕДЕНИЕ НА ТАЧ-ЭКРАНЕ (10.09.2026, «как родное приложение»).
   *
   * По умолчанию Tailwind 3 печатает `hover:*` обычным `:hover` без условия. У
   * пальца нет наведения, но браузер телефона всё равно оставляет состояние
   * :hover на последнем нажатом элементе — и подсветка кнопки/строки висит до
   * следующего тапа в другое место. В родном приложении так не бывает: нажатие
   * подсвечивает элемент ровно на время нажатия. Замер до правки: 33 правила с
   * `:hover` вне `@media (hover:hover)`.
   *
   * Флаг заворачивает все `hover:*`-утилиты в `@media (hover:hover)`: на
   * компьютере ничего не меняется, на телефоне подсветка больше не залипает.
   * Отклик на нажатие при этом не теряется — за него отвечают `active:*` и
   * общее правило `html[data-mobile-ux] button:active{transform:scale(.98)}`
   * в index.css.
   */
  future: {
    hoverOnlyWhenSupported: true,
  },
  theme: {
    // Две точки перелома контракта оболочки (06.10.2026): телефон < 820, широкий десктоп >= 1180.
    // Число `md - 1` и `lg - 1` читают hooks/useMobileUx.ts и useNarrowScreen.ts, тест
    // hooks/__tests__/breakpoints.test.ts следит, чтобы они не разошлись.
    screens: { sm: "640px", md: "820px", lg: "1180px", xl: "1440px" },
    extend: {
      colors: {
        blue: {
          DEFAULT: "rgb(var(--rgb-accent) / <alpha-value>)",
          hover: "rgb(var(--rgb-accent-hover) / <alpha-value>)",
        },
        // Текст/иконки поверх акцентного фона: белый в синих/зелёных темах,
        // тёмный в лаймовой — обычный text-white там нечитаем.
        "on-accent": "var(--c-on-accent)",
        // Текст поверх красного (кнопка «Удалить»). В тёмных темах --rgb-red —
        // светлый коралловый, и белая надпись на нём даёт 2.6:1 при норме 4.5;
        // в светлых темах красный тёмный и белый как раз читается.
        "on-danger": "var(--c-on-danger)",
        ink: "rgb(var(--rgb-ink) / <alpha-value>)",
        gray: {
          800: "rgb(var(--rgb-g800) / <alpha-value>)",
          700: "rgb(var(--rgb-g700) / <alpha-value>)",
          600: "rgb(var(--rgb-g600) / <alpha-value>)",
          500: "rgb(var(--rgb-g500) / <alpha-value>)",
          400: "rgb(var(--rgb-g400) / <alpha-value>)",
          300: "rgb(var(--rgb-g300) / <alpha-value>)",
        },
        bg: "var(--c-bg)",
        card: "var(--c-card)",
        // Непрозрачный вариант поверхности — для колец/обводок, где полупрозрачность даёт грязный край.
        "card-solid": "var(--c-card-solid)",
        "row-alt": "var(--c-row-alt)",
        line: "var(--c-line)",
        "line-soft": "var(--c-line-soft)",
        "hover-tint": "var(--c-hover-tint)",
        "avatar-from": "var(--c-avatar-from)",
        "avatar-to": "var(--c-avatar-to)",
        green: { DEFAULT: "rgb(var(--rgb-green) / <alpha-value>)", bg: "var(--c-green-bg)" },
        amber: { DEFAULT: "rgb(var(--rgb-amber) / <alpha-value>)", bg: "var(--c-amber-bg)" },
        red: { DEFAULT: "rgb(var(--rgb-red) / <alpha-value>)", bg: "var(--c-red-bg)" },
        violet: { DEFAULT: "rgb(var(--rgb-violet) / <alpha-value>)", bg: "var(--c-violet-bg)" },
      },
      fontFamily: {
        // Токены, не жёсткое имя: тема «Royal Home 2026» переопределяет
        // --font-sans/--font-num на Manrope/Onest (theme-royal-home-2026.css),
        // старые темы держат дефолт из index.css (:root). Fallback-цепочка
        // после var() на случай css-переменных недоступных браузеру совсем.
        sans: ["var(--font-sans)", "Inter", "sans-serif"],
        num: ["var(--font-num)", "Inter", "sans-serif"],
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        // Главная акцентная кнопка (Topbar) — блик + цветное свечение в тон акцента темы.
        "accent-btn": "var(--shadow-accent-btn)",
        // Тонкое внутреннее кольцо на фото-миниатюрах.
        thumb: "var(--shadow-thumb)",
      },
      borderRadius: {
        // Через переменные: живой облик задаёт метрики макета (карточка 16,
        // кнопка 10), классика живёт на прежних значениях из fallback.
        lg: "var(--r-lg, 11px)",
        card: "var(--r-card, 18px)",
        control: "var(--r-control, 12px)",
        badge: "8px",
      },
    },
  },
  plugins: [],
};
