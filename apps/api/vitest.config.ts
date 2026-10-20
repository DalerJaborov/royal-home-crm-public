import { defineConfig } from "vitest/config";
import { RetriedTestsReporter } from "./tests/reporters/retriedTests.js";
import { resolveHeapMbPerWorker, resolveWorkerCount } from "./tests/dbPerWorker.js";
import { coverFontconfigFile } from "./tests/coverFonts.js";

/**
 * СТРАХОВКА ТОЛЬКО ДЛЯ CI, И ТОЛЬКО ГРОМКАЯ.
 *
 * Одна повторная попытка в CI (`retry: 1`) не «замазывает» плавающие тесты, а
 * снимает с них право останавливать выкат: красная ветка из-за одного мигания
 * стоит дороже, чем повтор. Чтобы страховка не превратилась в способ жить с
 * нестабильностью, рядом включается репортёр `RetriedTestsReporter`: он печатает
 * поимённый список всего, что прошло со ВТОРОЙ попытки. Пустой список — прогон
 * честно зелёный; непустой — это задача, а не фоновый шум.
 *
 * Локально повтора нет намеренно: разработчик должен видеть падение сразу и
 * ровно один раз, иначе плавающий тест не воспроизведёшь.
 */
const isCI = process.env.CI === "true" || process.env.CI === "1";

/**
 * Потолок кучи делится на число процессов прогона: их поднимает
 * `tests/runParallel.ts`, и каждый держит в N раз меньше файлов — значит и пик
 * у него в N раз ниже. При прямом `npx vitest run` процесс один и берёт весь
 * бюджет. Подробности — в `tests/dbPerWorker.ts`.
 */
const heapMb = resolveHeapMbPerWorker(process.env.VITEST_DB_INDEX ? resolveWorkerCount() : 1);

/**
 * ШРИФТЫ ОБЛОЖЕК — ИЗ РЕПОЗИТОРИЯ, ПО ТОЙ ЖЕ ПРИЧИНЕ, ЧТО И `TZ` НИЖЕ:
 * настройка обязана лечь в окружение раньше, чем ею воспользуются, а
 * fontconfig внутри librsvg читает `FONTCONFIG_FILE` при первой отрисовке.
 * Зачем это нужно и чем измерено — в шапке `tests/coverFonts.ts`. Конфиг
 * собирается здесь, при загрузке конфигурации vitest, поэтому его одинаково
 * видят и `npx vitest run <файлы>`, и процессы `tests/runParallel.ts`.
 */
const fontconfigFile = coverFontconfigFile();

export default defineConfig({
  test: {
    environment: "node",
    /**
     * ВРЕМЯ — ТОЛЬКО UTC (разбор 18.09.2026). Прод живёт в UTC (см. правило в
     * CLAUDE.md: «Часовой пояс Душанбе UTC+5, контейнер живёт в UTC»), и часть
     * тестов пишет даты голыми ISO-строками без `Z`
     * (`new Date("2026-09-16T10:00:00")`), рассчитывая, что окружение разберёт
     * их как UTC. Без явного `TZ` это работает только случайно — Node парсит
     * такую строку как ЛОКАЛЬНОЕ время процесса. На машине, где системный
     * часовой пояс отличается от UTC (например, Asia/Tashkent — тот же сдвиг
     * UTC+5, что и у Душанбе, но собственная зона, и тест удваивал поправку в
     * своей же `dushanbe()`-обёртке), это давало падения на ровном месте:
     * `post-showing-call-schedule.test.ts` и другие — не баг прод-кода, а
     * незакреплённое окружение теста. `Intl`/`Date` в Node проверяют `TZ` при
     * первом использовании в процессе, поэтому переменная объявлена здесь, а
     * не мутацией `process.env.TZ` внутри `setup.ts` — так гарантированно
     * раньше первого `new Date(...)` в тестовом файле.
     */
    env: { TZ: "UTC", ...(fontconfigFile ? { FONTCONFIG_FILE: fontconfigFile } : {}) },
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    retry: isCI ? 1 : 0,
    reporters: isCI ? ["default", new RetriedTestsReporter()] : ["default"],
    /**
     * ФАЙЛЫ ВНУТРИ ПРОЦЕССА — СТРОГО ПО ОДНОМУ, И ЭТО НЕ ПЕРЕЖИТОК.
     *
     * Историческая причина (все файлы делили одну базу, а часть сценариев
     * глобальна) снята: каждый процесс работает со своей базой. Но остаётся
     * вторая, чисто механическая, и она измерена 12.09.2026.
     *
     * `fileParallelism: true` при `isolate: true` заставляет vitest отдавать
     * каждый файл ОТДЕЛЬНОЙ задачей, а tinypool убивает и пересоздаёт процесс
     * после каждой задачи: 484 запуска Node и 484 холодных старта среды вместо
     * одного. Замер: 17 файлов за 2 минуты (≈7 с на файл) против 1,67 с у
     * последовательного прогона — вся четырёхкратная параллельность ушла на
     * пересоздание процессов. Убрать изоляцию, чтобы процессы не
     * пересоздавались, нельзя: 12.08.2026 `isolate: false` дал 6 упавших файлов
     * и десятки упавших тестов — файлы делят замоканные модули друг друга.
     *
     * Поэтому параллельность вынесена наружу, в `tests/runParallel.ts`: N
     * независимых процессов vitest, каждый со своей долей файлов и своей
     * базой. Внутри каждого — ровно то, что здесь и написано.
     */
    fileParallelism: false,
    // Vitest 4 removed poolOptions/singleFork. Keep file isolation and a single
    // concurrent fork; v4 may recreate that fork between isolated files.
    pool: "forks",
    maxWorkers: 1,
    isolate: true,
    // This must be top-level in v4; the former nested heap limit was ignored.
    execArgv: [`--max-old-space-size=${heapMb}`],
  },
});
