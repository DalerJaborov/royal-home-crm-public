# 12.11.2026 — переключатель озвучки доходит до контейнеров

**Что изменилось.** В `docker-compose.prod.yml` (общее окружение `&crm-env`, им же
пользуется worker) добавлены `CRM_NARRATION_EXECUTION_MODE` и
`CRM_OWNER_REPORT_EXECUTION_MODE`, по умолчанию `PREVIEW`.

**Почему.** Владелец сказал «Да, включай» на озвучку (PR #149). Перед включением
выяснилось: compose передаёт переменные поштучно, а этих двух в списке не было.
Строка `CRM_NARRATION_EXECUTION_MODE=LIVE` в `.env.production` в контейнер не попала
бы, и озвучка молча осталась бы в PREVIEW. Тот же класс, что `MARKET_CRAWL_ENABLED`
(PR #155).

**Чем проверено.** Новый тест в `scripts/bot-turn-trace-compose.test.mjs` берёт все
виды из `lib/mediaExecution.ts` и проверяет, что в api и worker по умолчанию
PREVIEW, а LIVE из env-файла доходит. Без строки в compose тест красный.

**Что осталось.** После выката: `.env.production` + LIVE, пересоздать api/worker,
автоозвучка в Настройках, живой прогон одного объекта. Похожие переключатели вне
`mediaExecution.ts` (`CUSTOMER_AGENT_MEDIA_EXECUTION_MODE`,
`CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE`, `CRM_OWNER_VERIFICATION_EXECUTION_MODE`)
в compose тоже не переданы — сейчас они нигде не включены, поведение не меняется;
решить отдельно.
