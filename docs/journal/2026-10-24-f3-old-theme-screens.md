# 24.10.2026 — F3: экраны и окна вне темы «Royal Home 2026»

Источник: перепись экранов 24.10 (П7–П11). Облик и тексты не менялись — только обёртка и классы.

## Что сделано
- `components/NotFound.tsx` — `Rh2Screen` + `.card` + `Rh2EmptyState` + `LinkButton` (было: Tailwind `text-gray-500`, `bg-blue` вне `.rh2`).
- `pages/ClientDetail.tsx` — ранние ответы «Не удалось загрузить карточку» и «Карточка не найдена» на `Rh2Screen` + `Rh2EmptyState` (вместо `EmptyState` + самодельной обёртки `.rh2`).
- `components/PropertyFormModal.tsx` (тело форм `/properties/:id/edit`; страница-обёртка `PropertyForm.tsx` уже была в `.rh2 .scr`; «новый объект» — мастер `property-wizard`, уже в теме) — убраны `text-gray-*`, `border-line-soft`, `bg-hover-tint`, ручные `flex/grid`: галочки на `.chk`, подсказки на `.msg`, кнопки на `.pill.ghost`/`.lnk`, «Характеристики» на `.fgrid .fld`, цена на `.pair`. Мелочи — `theme-2026-property-form.css`.
- `components/DialPad.tsx` — окно в `Rh2Portal`, классы `.dp-*` (`theme-2026-dialpad.css`). Причина просвета на телефоне: фон листа `bg-bg` = `--c-bg` с 60% альфы. Теперь `var(--page)` сплошной + подложка `--overlay`. Зоны нажатия: «назад» и чипы контакта 44px невидимой областью.
- `components/Topbar.tsx` — панель уведомлений в `Rh2Portal`: `.card.tight` + `.list .row` + `.chip.warn` + `.pill.ghost`, как меню профиля. Кнопки шапки не тронуты (зона F2).
- Тест `src/lib/__tests__/f3OldThemeScreens.test.ts`.

## Не менялось намеренно
- `BottomNav.tsx` / `lib/legacyAgentBottomNavStyles.ts`: вариант `legacy-agent` — «замороженный облик телефона агента» (`useLegacyAgentMobile`: узкий экран + роль AGENT + не clean), закреплён хэшами разметки в `BottomNav.test.tsx` (8 комбинаций). Вариант `current` — таббар контракта темы (`.sh-tabbar .rh-glass`), он вне `.rh2` по замыслу. Перевод на `.rh2` потребовал бы осознанного решения владельца о снятии «заморозки» и перезаписи хэшей — не делалось.
- `theme-2026-clean-records.css` (строки 60–65): правила под `button.aspect-square` для старого наборщика теперь неактивны (безвредны), лист и зелёная трубка по-прежнему перекрываются там по `aria-label`.

## Проверено
`npm run build --workspace=apps/web` (eslint + tsc + vite) код 0; `npm run test:web` код 0 (305 файлов, 1868 тестов); `npm run audit:typeset` код 0. Кадры — за сборщиком.
