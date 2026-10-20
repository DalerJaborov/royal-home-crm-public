#!/usr/bin/env node
/**
 * СВЕСТИ СВОЮ ВЕТКУ СО СВЕЖИМ `main` — ОДНОЙ КОМАНДОЙ.
 *
 * ЗАЧЕМ. Над репозиторием работают несколько сессий сразу, мержей в `main`
 * бывает двадцать в день, и КАЖДЫЙ ржавит все остальные ветки через
 * сгенерированные `docs/product-*`. Порядок лечения в CLAUDE.md описан точно
 * («Как читать карту продукта»), но он из пяти шагов, и два из них — ловушки:
 *
 *   1. `git add` раньше `npm run map` кладёт в коммит СТАРУЮ карту поверх новой;
 *   2. расхождение бывает и БЕЗ конфликта git — обе ветки зелёные по отдельности,
 *      слияние не конфликтует, а числа в карте тихо расходятся с кодом, и ловит
 *      это только `map:check`.
 *
 * За ночь 21→22.09 этот танец вручную повторили десятки раз в двух сессиях.
 * Скрипт делает ровно его и ничего сверх.
 *
 * ЧЕГО СКРИПТ НЕ ДЕЛАЕТ НАРОЧНО: не разрешает конфликты в коде (останавливается
 * и называет файлы — их разводит человек или агент, понимающий обе стороны), не
 * пушит (пуш перезапускает десятиминутную проверку на единственном раннере, это
 * решение вызывающего) и не трогает `main`.
 *
 * Запуск из корня репозитория:
 *   npm run sync:main
 *   node scripts/sync-main.mjs --onto=<sha>   # свести с ЯВНЫМ коммитом main
 *   node scripts/sync-main.mjs --continue     # ПОСЛЕ того, как конфликт развели руками
 *
 * ЗАЧЕМ `--continue` (25.09.2026). Выход по конфликту в коде стоит ДО безусловной
 * пересборки карты, и текст ошибки на этом заканчивался: «разреши и закоммить
 * сам». Повторный ПРОСТОЙ запуск карту таки пересобирал (слияние уже закоммичено
 * → «отставания нет» → пересборка), но об этом никто не знал, и ветку дособирали
 * руками — на #932 карта после ручного разрешения разошлась на восемь развилок и
 * уехала бы красной в main. Теперь шаг назван прямо в тексте ошибки, а
 * `--continue` доделывает ровно оставшийся хвост: пересобрать карту и сверить.
 *
 * Почему именно отдельный ключ, а не «зови ту же команду ещё раз»: простой
 * повторный запуск СНОВА идёт в `git fetch` и вливает main, который мог уехать,
 * пока разводили конфликт. `--continue` доделывает то дерево, которое человек
 * только что развёл, и ничего нового в него не тянет.
 *
 * `--onto` зовёт `npm run ship` (scripts/ship.mjs): он запоминает sha main один
 * раз и сводит, проверяет и отмечает ровно его. Без явного sha второй `fetch`
 * между шагами мог бы подменить main, и проверенное разошлось бы с влитым.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
/** Оболочка — только для npm/npx на Windows (там это `.cmd`), то же правило, что
 *  `needsShell` в ship.mjs. Для git она вредна: cmd склеивает аргументы без
 *  кавычек, и `git commit -m <сообщение из слов>` видел слова как пути (25.09.2026). */
const needsShell = (cmd) => process.platform === "win32" && (cmd === "npm" || cmd === "npx");

function run(cmd, args) {
  try {
    // shell нужен на Windows только для npm (.cmd); git — обычный exe, а через
    // shell его аргументы склеиваются без кавычек: сообщение коммита с пробелами
    // рассыпалось на pathspec и валило ship на шаге сведения (25.09).
    execFileSync(cmd, args, { stdio: "inherit", shell: needsShell(cmd) });
  } catch (err) {
    // Голый дамп ошибки Node читается как поломка репозитория, хотя упала
    // ровно одна команда — тот же довод, что у E2E_API_URL в playwright.config.ts.
    err.failedCommand = `${cmd} ${args.join(" ")}`;
    throw err;
  }
}
function fail(message) {
  console.error(`\n✘ ${message}`);
  process.exit(1);
}

process.on("uncaughtException", (err) => {
  const where = err?.failedCommand ? `«${err.failedCommand}»` : "скрипт";
  console.error(`\n✘ Не сложилось: ${where} вернула ошибку.`);
  console.error("Вывод команды выше. Слияние, если оно началось, оставлено как есть — разбери руками или откати: git merge --abort");
  process.exit(1);
});

const argv = process.argv.slice(2);
const ontoArg = argv.find((a) => a.startsWith("--onto="));
const onto = ontoArg ? ontoArg.slice("--onto=".length) : "origin/main";
const isContinue = argv.includes("--continue");

/**
 * Артефакты сборки лежат ВНЕ git и с деревом не переключаются: после слияния
 * двадцати коммитов main клиент Prisma и packages/shared/dist отстают от схемы и
 * общих типов, и tsc падает на коде, который совершенно исправен («X is not a
 * function», «свойство не существует в типе»). Полминуты против получаса на
 * охоту за несуществующей поломкой — CLAUDE.md, «Артефакты сборки общие».
 */
const ARTIFACTS_REMINDER = [
  "И пересобери артефакты — они вне git и от слияния устаревают:",
  "  npm run build:shared && npx prisma generate && (cd apps/api && npx prisma migrate deploy)",
].join("\n");

/** Конфликтные пути: собранные карты чинятся сами, остальное — человеку. */
export function splitConflicts(paths) {
  const all = [...new Set(paths.filter(Boolean))];
  return {
    generated: all.filter((p) => p.startsWith("docs/product-")),
    foreign: all.filter((p) => !p.startsWith("docs/product-")),
  };
}


function main() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "main" || branch === "HEAD") {
    fail(`Ветка «${branch}» — сводить нечего. Скрипт для своей рабочей ветки.`);
  }
  if (git("status", "--porcelain")) {
    fail(
      isContinue
        ? "В рабочем дереве есть неразведённые или незакоммиченные правки. Доразведи конфликт и закоммить слияние (git commit --no-edit), потом зови --continue."
        : "В рабочем дереве есть незакоммиченные правки. Закоммить их — иначе слияние их перемешает.",
    );
  }

  if (isContinue) {
    // Слияние уже сделано и разведено руками — остаётся хвост, до которого выход
    // по конфликту не доходил: пересобрать карту и сверить.
    console.log(`── Доделываю свод ${branch}: слияние уже разведено`);
  } else {
    console.log(`── Свожу ${branch} с ${onto === "origin/main" ? "origin/main" : `main ${onto.slice(0, 9)}`}`);
    run("git", ["fetch", "origin", "main"]);

    const behind = Number(git("rev-list", "--count", `HEAD..${onto}`));
    if (behind === 0) {
      console.log("Ветка уже на свежем main — слияние не нужно.");
    } else {
      console.log(`Отставание: ${behind} коммит(ов). Сливаю.`);
      try {
        run("git", ["merge", "--no-edit", onto]);
      } catch {
        // Конфликт — разбираем только сгенерированные карты, остальное человеку.
        const { generated, foreign } = splitConflicts(git("diff", "--name-only", "--diff-filter=U").split("\n"));
        if (foreign.length > 0) {
          console.error("\nКонфликты НЕ только в сгенерированных картах:");
          for (const p of foreign) console.error(`  ${p}`);
          console.error("\nИх разводит человек: обе стороны меняли смысл. Слияние оставлено как есть.");
          console.error("Разреши, закоммить (git commit --no-edit) и доделай свод:");
          console.error("  node scripts/sync-main.mjs --continue");
          console.error("Он пересоберёт карту и сверит её. Без этого шага карта остаётся от старого");
          console.error("кода, и краснеет она у ВСЕХ веток сразу.");
          fail(ARTIFACTS_REMINDER);
        }
        console.log("Конфликт только в сгенерированных картах — беру версию main и пересобираю.");
        // Именно в таком порядке: сперва версия main, потом пересборка, потом add.
        run("git", ["checkout", "--theirs", ...generated]);
        run("npm", ["run", "map"]);
        run("git", ["add", ...generated]);
        run("git", ["commit", "--no-edit"]);
      }
    }
  }

  // ВСЕГДА, даже когда конфликта не было: слияние могло свести код двух веток так,
  // что закоммиченная карта отстала от него молча (второй случай из докстринга).
  console.log("── Пересобираю карту продукта");
  run("npm", ["run", "map"]);
  const mapChanged = git("status", "--porcelain", "--", "docs");
  if (mapChanged) {
    run("git", ["add", "--", "docs"]);
    run("git", ["commit", "-m", "карта продукта пересобрана после слияния main"]);
    console.log("Карта разошлась с кодом после слияния — пересобрана отдельным коммитом.");
  }

  console.log("── Сверяю карту");
  run("npm", ["run", "map:check"]);

  const ahead = git("rev-list", "--count", `${onto}..HEAD`);
  // В режиме --continue fetch не делался: считаем от того main, который уже в
  // репозитории, и не обещаем «свежий» — слияние сделано раньше, руками.
  console.log(
    isContinue
      ? `\n✔ ${branch}: свод доделан, карта пересобрана и сверена. Впереди main на ${ahead} коммит(ов).`
      : `\n✔ ${branch} на свежем main, впереди на ${ahead} коммит(ов).`,
  );
  console.log(ARTIFACTS_REMINDER);
  console.log("Дальше: npm run precheck, и только потом пуш — каждый пуш перезапускает проверку на единственном раннере.");
}

// Запуск как команды (а не импорт из теста).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
