# 23.10.2026 — «Подбор сотрудников» собран из компонентов эталона «Клиенты»

**Что изменилось.** Экран `/vacancies` переписан на идиому Clean-экрана «Клиенты»:
шапка (h1 28 + «N кандидатов · M новых», Segment «Кандидаты / Вакансии», «+ Кандидат»),
`Card tight` с поиском и «Фильтры · N» (шторка: вакансия, оценка со счётчиками),
этапы — `Tabs`, строки — новый `components/clean/CleanCandidateRow.tsx` в `List`,
«Показать ещё» — общая `Pagination variant="loadMore"`, массовые действия — `.bulk`.
Фильтры живут в адресе. Анкета открывается отдельной карточкой `/vacancies/:id`
(`pages/VacancyDetail.tsx`): шапка как у карточки клиента, `.acts` (Позвонить,
Пригласить, шаг этапа, Распечатать, Ещё), вкладки Анкета / Переписка / Связь / Материалы.
Сервер: `GET /api/v1/vacancies/:id` (тот же вид, что в списке; NOT_CANDIDATE — 404).
Вкладки карточки обобщены: `CleanRecordTabs` в `CleanClientDetailLayout.tsx`
(клиентская карточка рендерит то же самое). Удалены `VacancyRow`, `VacancyFilterChips`
и самодельные цвета/раскладка `theme-2026-vacancies.css` (остались текст анкеты и печать).

**Почему.** Владелец: «даже не похож на классы что у нас уже есть, бардак».

**Чем проверено.** build:api, build:web (eslint), test:web, audit:deps:gate,
gen:typeset + audit:typeset, map + map:check + map:gate.

**Что осталось.** Глазами (ПК + телефон) не смотрели; e2e `playwright.vacancies.config.ts`
не прогонялся.
