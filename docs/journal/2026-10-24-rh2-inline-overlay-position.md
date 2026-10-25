# 24.10.2026 — подсказка «Поставьте CRM на экран» не плавала (P0 переписи)

**Что.** `Rh2Inline` ставил `className` на сам узел `.rh2`. Тема лежит в CSS без слоя и
задаёт `.rh2{position:relative;margin:0}`; утилиты Tailwind v4 живут в слое `utilities`,
и бесслойное правило бьёт слойное при любой специфичности. `fixed inset-x-0 bottom-… z-30`
из `InstallAppHint.tsx` проигрывали — подсказка оставалась в потоке и на третьем заходе
схлопывала приложение в колонку 32 px.

**Правка.** `components/rh2/Rh2Scope.tsx`: `className` у `Rh2Inline` уходит на внешнюю
обёртку, узел `.rh2 screens` остаётся без утилит. Без `className` разметка прежняя.
Семантические хуки (`cef-overview`) работают как раньше: `.scr .card` остаются потомками.

**Класс.** Найдены все `Rh2Inline className`: `InstallAppHint` (fixed), `OfflineBanner`
(`shrink-0`), `UploadIndicator` (`mt-2 max-h-64 overflow-y-auto`), `UploadQueueList` (`mb-3`),
`ClaudeMoneyPage` (`cef-overview`). Побочно ожили до сих пор мёртвые `mt-2` и `mb-3`
(`.rh2{margin:0}` их гасил) — это заложенный авторами отступ. Скан тем × className
(тема-класс с `position` + Tailwind-позиция в одной строке): других мест нет.

**Проверка.** `Rh2ScopeOverlay.test.tsx` (обёртка + сторож «rh2 и позиционирующая утилита в одной
строке className»); без правки красный. build:web и test:web — см. коммит.
