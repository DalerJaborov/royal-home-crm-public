# Шрифты обложек соцсетей (`lib/video/coverPoster.ts`, `lib/video/coverTemplate.ts`)

| Файл | Где на обложке |
|---|---|
| `TTNormsPro-ExtraBold.ttf` | цифра комнат, «ХОНАГА», цена, «TJS», площадь, город, этаж |
| `TTNormsPro-Medium.ttf` | мелкие золотые подписи: МАСОҲАТ, РАЙОН, ОРИЕНТИР, ЭТАЖ, слоган |
| `PlayfairDisplay-Bold.ttf` | только «ROYAL / HOME TJ» под эмблемой (как в эталоне) |

**TT Norms Pro** (TypeType) — шрифт эталона владельца, файлы взяты из его
`Downloads/TT_norms_pro/TT Norms Pro v3.300/TTF` 22.09.2026. **Лицензию на
встраивание в серверный рендер обеспечивает владелец** — это его решение и его
ответственность.

Таджикская кириллица (Ғ ғ Ӣ ӣ Қ қ Ӯ ӯ Ҳ ҳ Ҷ ҷ Ё ё) и «²» в TT Norms Pro есть —
проверено по cmap файлов (fontTools), поэтому подписи набраны им же, без
запасного шрифта.

`TTNormsPro-Bold.ttf` намеренно НЕ положен: у файла нет typographic family
(nameID 16), и pango на запрос веса 700 молча отдавал серифный запасной шрифт —
«TJS» и «ДУШАНБЕ» выходили с засечками. Все жирные подписи — ExtraBold (800).

**Playfair Display** — SIL Open Font License 1.1 (`OFL.txt` рядом).

## Замена или добавление шрифта

1. Положить `.ttf` сюда (имя семейства смотреть `fc-scan <файл>`, не угадывать).
2. Поправить `FONT` в `coverTemplate.ts`.
3. Пересобрать таблицу ширин (шаблон по ней считает плашку цены и нижний ряд):
   `cd apps/api/assets/fonts/cover && PYTHONIOENCODING=utf-8 python genmetrics.py > ../../../src/lib/video/coverMetrics.ts`

`Dockerfile` копирует все `*.ttf` этой папки в системный каталог шрифтов и зовёт
`fc-cache` — librsvg берёт `font-family` только через системный fontconfig.
Локально на Windows то же даёт `FONTCONFIG_FILE` на свой `fonts.conf` с
`<dir>` этой папки. В веб-сессии Claude Code (claude.ai/code) это делает
`.claude/hooks/session-start-stand.sh` при старте сессии.

**Прогону тестов ничего из этого не нужно с 29.09.2026.** `tests/coverFonts.ts`
собирает конфиг fontconfig на время прогона и добавляет им эту папку к
системным настройкам; путь кладётся в `FONTCONFIG_FILE` из
`apps/api/vitest.config.ts`. Шрифты берутся прямо отсюда, из репозитория, на
любой машине — ставить в систему не надо. Заданный снаружи `FONTCONFIG_FILE`
правка не трогает.

**Установка в систему всё ещё нужна для всего, что рисует обложку МИМО тестов:**
прод (`Dockerfile`), ручной рендер скриптом, взгляд глазами.

**Забыть про шрифты — не косметика.** Без них подстановка идёт не тем шрифтом,
он шире, и пиксельная проверка «цена любой длины помещается в кремовую плашку»
(`cover-templates.test.ts`) честно краснеет. А `npm run ship` вливает только при
нуле падений в полном `test:api`. Проверить одной командой:

```
fc-match "TT Norms Pro"      # должен ответить TTNormsPro-*, а не DejaVu Sans
fc-match "RH Playfair Lining"
```
