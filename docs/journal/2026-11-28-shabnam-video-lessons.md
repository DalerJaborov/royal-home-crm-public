# 2026-11-28 Шабнам: видеоуроки по CRM

**Что.** Помощница находит, объясняет по тексту урока и присылает видеоуроки в Telegram: себе в личку, в группу, где попросили, и все разом.

- `lib/lessons/catalog.ts`: manifest.json (zod), кэш 60 с, поиск по номеру/названию/тексту (нормализация ё и таджикских букв, основа слова 5 букв), фрагмент ответа. Каталога нет или манифест битый: «Уроки пока не загружены», без падения. Пути из манифеста только внутри каталога.
- `lib/lessons/sender.ts`: отправка файлом с диска, затем по Telegram file_id (таблица `LessonVideoCache`, подпись файла размер:mtime). protect_content только в личке. Пределы в памяти процесса: 6 уроков в минуту на чат, тот же урок в тот же чат раз в минуту, «все уроки» раз в час на чат.
- `ai/assistant/tools/lessonTools.ts`: `find_lessons` (чтение), `send_lesson`, `send_all_lessons` (`sideEffect: "shared"`, режим просмотра закрыт). В группе не скрыты. «Все уроки» идёт в фоне, ответ человеку сразу.
- Промпт: `ASSISTANT_LESSONS_GUIDE` (promptSections.ts): «могу сделать сама» против «объясню по уроку» против «не знаю». Карта тема → инструменты проверена тестом по реестру.
- `telegram/api.ts`: `sendVideoByFileId`, `protectContent` у `sendVideoFromDisk`, file_id в ответе.
- Миграция `20261128150000_lesson_video_cache` (только добавляет таблицу).
- `docker-compose.prod.yml`: том `/opt/royalhome-lessons:/app/lessons:ro` и `LESSONS_DIR` у api и worker (Telegram-поллер помощницы живёт в worker).

**Проверено.** `tests/lessons-catalog.test.ts`, `tests/lessons-assistant-tools.test.ts` (30 тестов), `ai-assistant-tool-registry`, `shareholder-reports-27-11`.

**Осталось / риски.** Обложка шлётся как thumbnail только если файл до 200 КБ (иначе без неё). Счётчики пределов сбрасываются при перезапуске. Права на чтение `/opt/royalhome-lessons` для пользователя контейнера проверить на сервере. Ссылки на Академию и Mini App не делались.
