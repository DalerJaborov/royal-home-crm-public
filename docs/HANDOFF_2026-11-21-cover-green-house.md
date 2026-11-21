# HANDOFF 2026-11-21 — новая автообложка «Royal Green» (макет Reels)

## Задача владельца
Новая обложка (вертикаль 1080×1920, макет владельца) должна ставиться автоматически, как сейчас, ВМЕСТО текущей. Макет: `C:\Users\Daler\Downloads\Telegram Desktop\Reels (new).psd` (PSD; в чат приходила только jpg-превью `C:\Users\Daler\.claude\uploads\084d2da9-565d-4cb4-9936-cfc3872410d6\bb39566d-image.jpg`). Владелец спросил «за сколько сможешь» — ответ: ~1,5–2 ч до выката (дизайн + тест + ship). Первым делом открыть PSD (поставить `psd-tools` через pip или читать слои иначе), снять точные шрифты, цвета, слои, вынуть иконки и подтвердить размеры ниже.

## Рабочая копия
Worktree `C:\Users\Daler\.claude\worktrees\cover-green-21-11`, ветка `feat/cover-green-house-21-11` от origin/main b514230c7. Ship — только оттуда (`npm run ship`, нужен GH_TOKEN; память reference_gh_token_needs_username_19_11, royalhome-worktree-precheck-missing-web-deps-18-11). Стенд запускался командой `node scripts/agent-stand.mjs up --api 4741 --web 5241` (лог `C:\Users\Daler\AppData\Local\Temp\claude\4dd76db928cc51f0\084d2da9-565d-4cb4-9936-cfc3872410d6\scratchpad\stand-up.log`; проверить, что дошёл, иначе повторить). Общая папка D:\CRM на чужой ветке с чужими правками в coverPoster/coverOpenAi/storyCard — НЕ трогать.

## Как устроено сейчас (проверено)
- Вход: `makePropertyCover` (`apps/api/src/lib/video/coverOpenAi.ts`): провайдер ChatGPT или TEMPLATE (`Settings.coverProvider`), при сбое ChatGPT — запасной шаблон «Royal Green». Рисует `renderCoverPosterImage` → `renderCustomTemplate` (`coverPoster.ts`), SVG-шаблон из `apps/api/assets/cover/templates/royal-green-{square,story}.svg`, собирается скриптом `royal-green.build.mjs` (источник правды — он). Реестр — `coverRegistry.ts` (GREEN_COVER_TEMPLATE, id `royal-green` = DEFAULT_COVER_TEMPLATE_ID).
- Подстановки `{{...}}`, `data-if`, `data-fit` (ужим по метрикам TT Norms), группа `<g data-bg="1">` плоская (без вложенных g), это фон для стража зоны.
- Кэш: `TEMPLATE_COVER_VERSION = "royal-green-1"` (coverOpenAi.ts, ~строка 1717): поднять до `royal-green-2`, иначе старые обложки по хэшу не перерисуются.
- Шрифты: TT Norms Pro 800/500 (`assets/fonts/cover`), логотип `assets/cover/royal-green-logo.png` (тот же знак, что в макете).
- Скрипт для замера цветов с jpg: `...\scratchpad\ref\sample.mjs` (импорт sharp как `file:///D:/CRM/node_modules/sharp/dist/index.cjs`).

## План (решено: заменить шаблон под тем же id royal-green)
1. Переписать `royal-green.build.mjs` под макет, перегенерировать оба SVG (квадрат тоже, в том же стиле, компактнее).
2. Новое поле `photoBox` у `CoverTemplateRecord` (coverRegistry.ts) и в `renderCustomTemplate`: фото кадрируется в верхнюю область (story: top 0, height 1262; square ~790), ниже холст кремовый `#f3e6e0`; `sharp(photo).extend(...).composite(layers)`.
3. `buildCoverPosterValues` (+ вызовы в coverPoster.ts, coverOpenAi.ts ~1431, routes/settingsCoverTemplates.ts ~78): необязательные входы `type`, `totalFloors`; новые значения шаблона `kind`, `kindSub`, `kindSolo`, `areaBig`, `areaUnit`, `placeLine`; добавить ключи в `CoverTemplateValues` и `buildTemplateSvgLayer`. Слова: APARTMENT «КВАРТИРАИ»/«N ХОНАГА»; HOUSE «ҲАВЛИИ»/«N ОШЁНА» (totalFloors, иначе комнаты); COMMERCIAL «ТИҶОРАТӢ» (одна строка); LAND «ЗАМИН», крупно сотки «сотих». placeLine: «ноҳияи {район}», без района «шаҳри Душанбе». Старые тесты с `buildCoverPosterValues` не ломать (поля необязательные).
4. Переписать блок тестов «встроенный Royal Green» в `apps/api/tests/cover-templates.test.ts` (старые числа плашки 57…715, полоса 345 устарели); проверить cover-poster и cover-openai тесты; страж: всё чернило вертикали в строках 240…1679 (сетка Instagram) с запасом; фон в data-bg.
5. Журнал `docs/journal/2026-11-21-cover-green-house.md`, `npm run map` + `map:check`, `precheck`; кадры обложек (story+square, 3 типа объектов, длинная цена) владельцу файлом (SendUserFile), затем `npm run ship`.

## Геометрия макета story (снято с jpg, 1080×1920; уточнить по PSD)
- Фото сверху 0…1262; мягкий переход в кремовый 1218→1262; кремовый `#f3e6e0` до волны.
- Логотип: x100 y285, 163×205. Цена «900 000»: центр x≈760, цифры y323–400, кегль ≈108, вес Medium (500), цвет `#0b4a3a`; «СОМОНӢ» y417–445, кегль ≈40, разрядка ≈5, центр x≈762. Над небом лёгкое белое свечение для читаемости на тёмных фото.
- Плашка: y1263–1403, от x0 до 530, правый край полукруг r70, золотая окантовка ≈5 px (градиент `#f6d98a→#c88e3c`), заливка тёмно-зелёная `#012a1e→#046244 (блик x≈390)→#012f23`. Текст белый 800: «ҲАВЛИИ» x101 кегль ≈57 база ≈1334 (ширина 251); «2 ОШЁНА» кегль ≈47 база ≈1378 (ширина 224); «90м²» справа, правый край 512, «90» кегль ≈66 база 1353, «м²» ≈50.
- Разделитель x572 y1262–1405 цвет `#0a4b3a`. Пин (заливка `#07513c`, белая точка) x613–667 y1299–1370; «ноҳияи Фирдавсӣ» x697 база 1341 кегль ≈31 вес 800, правый край 983.
- Ряд из трёх преимуществ (статичный текст владельца): значки y≈1453–1517 (дом x90, бриллиант x417, пин-контур x753), подписи x167/508/815, кегль ≈22, строки на 1479 и 1503: «Банақшагирии / васеъ», «Сатҳи баланди / бароҳатӣ», «Ҷойгиршавии / қулай»; цвет `#0a4b3a`.
- Волна: золотая линия (толщина ≈5) через точки (0,1544),(100,1563),(300,1583),(500,1580),(700,1572),(900,1546),(1080,1514), ниже тонкая вторая золотая 330…1000 примерно на +10; под волной глубокий зелёный `#05563c→#02402f→#012a1e` до низа (область пустая, под интерфейс Reels).
- Квадрат: то же, сжато (~0,8), фото 0…790, плашка с 792, волна у 1010.

## Что ждёт «да» владельца
- Какой провайдер сейчас в проде (`Settings.coverProvider`): если ChatGPT, новая обложка включится только как запасная; чтобы стала основной, нужно переключить на «Шаблон» (Настройки → обложки). Операция на проде, отдельное «да».
- Перерисовка уже опубликованных объектов новой обложкой (меняет картинки на сайте и в соцсетях) — отдельное «да».

## Отчёт владельцу (в конце)
Сделано / проверено / осталось; блок «Чего ещё не хватает».

## СТАТУС 21.11 (вечер) — код готов, выкат НЕ влит
- Сделано: шаблон, значения плашки, тесты, журнал `docs/journal/2026-11-21-cover-green-house.md`, коммит `a69d946de`, ветка `feat/cover-green-house-21-11`, черновик PR #377 (DalerJaborov/royal-home-crm-public).
- Облачный полный прогон один раз дал 22779 тестов, 0 упало, но `main` ушёл вперёд и ship отказался вливать. Дальше 3 повтора оборвались по ожиданию облака (UND_ERR_CONNECT_TIMEOUT, медленные раннеры) на 6–19 из 21 заданий; `main` снова сдвинулся (до 46e4ed15a, #371).
- Как продолжить: из этого worktree, с GH_TOKEN (рецепт в памяти reference_gh_token_needs_username_19_11), `npm run ship`; успех только по строке «✔ Правка #377 на main». Если main опять уехал — сразу повторить, не ждать.
- Локально: junction-ссылки на recharts/motion/jsdom/@testing-library в apps/web/node_modules уже сделаны; стенд на портах 4741/5241 поднят (погасить: `node scripts/agent-stand.mjs down --api 4741 --web 5241`).
- Ждёт «да» владельца: провайдер обложек в проде (ChatGPT или «Шаблон»); перерисовка уже опубликованных объектов.
