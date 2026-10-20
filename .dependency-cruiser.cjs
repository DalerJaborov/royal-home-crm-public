/**
 * Правила зависимостей монорепо Royal Home CRM.
 *
 * Задача конфига — ловить не «плохой стиль», а то, что ломает возможность
 * менять код по частям: циклы, обращение сервера к клиенту, импорт из
 * `packages/shared/src` в обход собранного `dist`, сироты.
 *
 * Запуск: `npm run depcruise` (текст) и `npm run depcruise:graph` (картинка).
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Цикл импортов. Такой модуль нельзя ни понять по частям, ни выкинуть: " +
        "порядок инициализации становится неявным, и правка на одном конце " +
        "цикла отзывается на другом (ровно так вылезла ошибка «Cannot access " +
        "'medianPricePerSqm' before initialization»).",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-api-to-web",
      severity: "error",
      comment: "Сервер не должен зависеть от кода браузера — это разные среды выполнения.",
      from: { path: "^apps/api/src" },
      to: { path: "^apps/web/src" },
    },
    {
      name: "no-web-to-api",
      severity: "error",
      comment:
        "Клиент не должен импортировать серверный код: в браузер утечёт Prisma, " +
        "ключи и логика прав, которую можно проверять только на сервере.",
      from: { path: "^apps/web/src" },
      to: { path: "^apps/api/src" },
    },
    {
      name: "prisma-client-only-from-generated",
      severity: "error",
      comment:
        "Prisma 7: клиент импортируется из src/generated/prisma, не из @prisma/client; " +
        "см. prismaAdapter.ts. " +
        "Правило заведено 14.09.2026 после того, как приехавший из main новый файл с " +
        "`import { Prisma } from \"@prisma/client\"` прошёл `npm run build` с НУЛЁМ и " +
        "упал только в рантайме — 39 файлов тестов из 44 с «Cannot find module " +
        "@prisma/client/runtime/library.js». Пакет @prisma/client в семёрке никуда не " +
        "делся и типы из него разрешаются, поэтому tsc такой импорт пропускает: сборка " +
        "на этом переходе перестала быть достаточной проверкой, и нужен отдельный страж. " +
        "@prisma/adapter-pg под запрет НЕ подпадает — это другой пакет, его и берёт " +
        "prismaAdapter.ts.",
      from: { path: "^apps/api/src" },
      to: { path: "node_modules/@prisma/client(/|$)" },
    },
    {
      name: "shared-only-via-package",
      severity: "error",
      comment:
        "Общий код берётся как пакет @royal-home/shared, а не прямым путём в его src: " +
        "main/types указывают на dist, и прямой импорт даёт две разные копии типов.",
      from: { path: "^apps/(api|web)/src" },
      to: { path: "^packages/shared/src" },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "Модуль, который никто не импортирует — мёртвый код либо забытая точка входа.",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$",
          "\\.d\\.ts$",
          "(^|/)tsconfig\\.json$",
          "(^|/)(babel|webpack)\\.config\\.(js|cjs|mjs|ts)$",
          "^apps/api/src/index\\.ts$",
          "^apps/web/src/main\\.tsx$",
          "^apps/web/src/sw\\.ts$",
        ],
      },
      to: {},
    },
    {
      name: "no-deprecated-core",
      severity: "warn",
      from: {},
      to: { dependencyTypes: ["core"], path: "^(punycode|domain|constants|sys)$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      // apps/api/src/generated — клиент Prisma 7 (генератор пишет в дерево
      // исходников, а не в node_modules). Это сгенерированный артефакт: правил
      // репозитория он не нарушает и нарушить не может, зато 89 его файлов
      // раздували бы разбор и давали ложных «сирот».
      //
      // node_modules исключён ЦЕЛИКОМ, КРОМЕ @prisma/client, и вырез именно
      // такой узкий не случайно. `exclude` выкидывает модуль из графа вместе с
      // рёбрами, то есть правило по `to.path` для пакета из node_modules без
      // выреза не сработало бы НИКОГДА — молча, что хуже отсутствия правила.
      // Одному пакету вход открыт ради стража prisma-client-only-from-generated;
      // за графом это оставляет ровно те же модули, что и раньше, — обход
      // внутрь по-прежнему запрещён `doNotFollow` ниже.
      path:
        "(^|/)node_modules/(?!@prisma/client(/|$))" +
        "|(^|/)(dist|build|coverage|test-results|playwright-report)(/|$)" +
        "|^apps/api/src/generated/",
    },
    // tsConfig намеренно не задан: в монорепо у каждого воркспейса свой, и один
    // общий путь ломает разбор второго (include в них указывают на свой src).
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".js", ".jsx", ".ts", ".tsx", ".d.ts"],
    },
    reporterOptions: {
      dot: { collapsePattern: "node_modules/(?:@[^/]+/[^/]+|[^/]+)" },
      archi: {
        collapsePattern:
          "^(?:packages|apps)/[^/]+/src/[^/]+|^node_modules/(?:@[^/]+/[^/]+|[^/]+)",
      },
    },
  },
};
