# 2026-10-23 — B1: мелкий шрифт, Manrope, зоны нажатия

Что изменено
- `theme-2026-vacancies.css`, `theme-2026-wizard-desktop.css`: все `font-size` 11/12/12.5px -> 13px. Эти два файла подключаются из страниц (не из `index.css`), грузятся позже `theme-2026-typeset.css` и на равной специфичности его перебивают, поэтому раньше мелкий текст там оставался. Печатные правила вакансий не тронуты.
- `CustomerRequestsPanel.tsx`: `text-xs` (12px) -> `text-[13px]`.
- `fonts-royal-home-2026.css`: удалены `@font-face` Manrope, удалены `public/fonts/manrope-*.woff2` (4 файла, ~57 КБ). Все правила и токены с Manrope перекрыты Onest (`theme-2026-brand.css` + `gen-typeset.mjs`: 50 правил с гарнитурой), шрифт нигде не запрашивался. `index.html`/`tailwind.config.js` — только комментарии.
- `theme-2026-mobile-chat.css`: чипы быстрых ответов 34px получили невидимую зону нажатия 44px (`::before inset:-5px 0`; 5px снизу ленты взяты у `padding-top` композера, видимая раскладка прежняя).
- `theme-2026-mobile-density.css`: пилюля «Мой вид» (40px) — невидимая накладка до 44px.
- `theme-2026-typeset.css` пересобран.

Почему остальные 10-12px в CSS не правил: все файлы из `index.css` генератор уже перекрывает до 13px, а поднять источник до 13 значит получить 15 (шкала 13 -> 15), то есть изменить вид. Чипы `.mh .btn.sm` (36) и `.mh .fchips button` (36) уже имеют `::before inset:-4px` = 44px.

Проверено: `build:web`, `test:web` (300 файлов, 1825 тестов), `audit:typeset` — код 0.

Осталось: поле ввода чата 40px (меняет вид); Tailwind-кнопки `h-8/h-9` в экранах (20 файлов) не обходил; `Manrope Fallback` в generated proto остаётся (локальный Arial, ничего не грузит).
