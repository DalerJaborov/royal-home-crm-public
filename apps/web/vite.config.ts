import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Версия сборки для автообновления вкладок (задача P2, 08.09.2026).
 *
 * GIT_SHA приходит build-arg'ом из Dockerfile (сам образ git не содержит —
 * .dockerignore отрезает .git, а слой сборки его не клонирует). Локально
 * (`npm run dev`/`vite build` без Docker) ARG не задан — берём момент сборки,
 * этого достаточно, чтобы отличить одну локальную сборку от другой.
 */
const APP_VERSION = process.env.GIT_SHA?.trim() || String(Date.now());

/**
 * Пишет `dist/version.json` — файл, который вкладка опрашивает поверх
 * X-App-Build/service worker (см. lib/appUpdate.ts). Раздаётся
 * nginx'ом по правилу `location /` (index.html) — то же самое "no-cache", какое
 * там уже стоит для index.html, так что отдельного правила не требуется.
 */
function versionJsonPlugin(): Plugin {
  return {
    name: "royal-home-version-json",
    apply: "build",
    generateBundle() {
      // Emit into Vite's actual output. A hardcoded dist/version.json leaves
      // custom preview outputs stale and makes the update guard reload forever.
      this.emitFile({ type: "asset", fileName: "version.json",
        source: JSON.stringify({ version: APP_VERSION, builtAt: new Date().toISOString() }, null, 2) });
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    react(),
    versionJsonPlugin(),
    VitePWA({
      /**
       * "prompt", а не "autoUpdate" — подтверждено 10.09.2026 при переходе на
       * мгновенное молчаливое обновление.
       *
       * ПОЧЕМУ НЕ autoUpdate И НЕ skipWaiting СРАЗУ ПРИ ГОТОВНОСТИ СБОРКИ.
       * Соблазн понятен: воркер встал — пусть тут же и забирает управление. Но
       * между этим мигом и перезагрузкой страницы вкладка оказывается в
       * запрещённом состоянии «часть файлов новая, часть старая»: старая
       * оболочка продолжает жить и подгружать свои ленивые чанки по СТАРЫМ
       * хешам, а новый воркер уже вычистил их из прекеша — и на сервере после
       * выката этих файлов тоже нет. Пустой экран вместо раздела.
       *
       * Поэтому смена воркера и перезагрузка обязаны быть ОДНИМ мгновением:
       * SKIP_WAITING шлётся не тогда, когда сборка готова, а тогда, когда
       * принято решение подменить (`store/appUpdate.ts` -> `applying`), и
       * страница перезагружается по controllerchange тем же движением
       * (`lib/appUpdateReload.ts`). До этой секунды старый воркер продолжает
       * отдавать цельную старую сборку.
       *
       * «Ждать разрешения» из-за этого не получается: файлы новой сборки качает
       * фоновая подготовка (`lib/appUpdatePrefetch.ts`) заранее, поэтому сама
       * подмена занимает доли секунды — и на телефоне в установленном
       * приложении ровно столько же, сколько во вкладке: код один и тот же.
       */
      registerType: "prompt",
      // injectManifest вместо generateSW: нужен кастомный src/sw.ts с обработчиками
      // push/notificationclick — генерируемый воркер их не поддерживает.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png}", "version.json"],
      },
      manifest: {
        name: "Royal Home CRM",
        short_name: "Royal Home",
        /**
         * Описание задано явно с 13.09.2026. vite-plugin-pwa 1.x, в отличие от
         * 0.20, подставляет в манифест `description` из package.json, если своего
         * нет, — и в окно установки приложения поехала строка для разработчика
         * («React 18 + Vite + Tailwind CSS, PWA»). Сотруднику она ничего не
         * говорит, а видит он её ровно в тот момент, когда решает ставить или нет.
         */
        description: "Рабочее место агентства недвижимости Royal Home: объекты, клиенты, сделки, переписка",
        theme_color: "#2B59FF",
        background_color: "#F7F8FA",
        display: "standalone",
        // Без этого standalone-PWA на iOS изредка «залипает» в альбомной
        // раскладке после поворота телефона (или после шторки шаринга/камеры) —
        // сам телефон уже вертикально, а окно приложения нет. CRM — мобильное
        // рабочее приложение, ландшафт ему не нужен нигде.
        orientation: "portrait",
        start_url: "/",
        // Интерфейс русский, а в манифесте по умолчанию проставлялось "en": по языку
        // магазины приложений и системный поиск решают, кому показывать установку.
        lang: "ru",
        /**
         * PNG, а не SVG (10.08.2026). Прежде здесь тремя строками стоял один
         * icon.svg — Android с SVG в манифесте справляется через раз, а iOS его
         * для домашнего экрана не читает вовсе и рисует вместо логотипа скриншот
         * страницы. Файлы собираются из того же icon.svg скриптом
         * scripts/generate-icons.mjs (`npm run icons`), руками не правятся.
         *
         * maskable отдельным файлом с полями: Android обрезает иконку под форму,
         * принятую в системе, и у логотипа «в край» срезало бы крышу дома.
         */
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
        /**
         * Быстрые действия по долгому нажатию на иконку приложения (на компьютере —
         * правой кнопкой по значку в панели задач).
         *
         * ЧТО СЮДА ПОПАДАЕТ. Только то, ради чего человек берёт телефон в руки:
         * записать объект, записать клиента, посмотреть, что сегодня, разобрать
         * переписку. Дублировать здесь всё меню бессмысленно — список показывают
         * до четырёх пунктов, и лишние вытесняют нужные.
         *
         * `/clients?new=1` открывает форму сразу, а не список (разбор параметра —
         * в pages/Clients.tsx). Ярлык, ведущий на тот же экран, что и обычный
         * запуск, экономит одно нажатие; ярлык, открывающий форму, экономит три.
         *
         * ГДЕ ЭТОГО НЕ БУДЕТ: Safari на iPhone меню ярлыков не поддерживает — там
         * долгое нажатие даёт системный список. Это не поломка и обходных путей
         * не имеет; на Android и на компьютере меню работает.
         *
         * Значки собирает scripts/generate-icons.mjs (`npm run icons`) — руками
         * файлы shortcut-*.png не правятся.
         */
        shortcuts: [
          {
            name: "Новый объект",
            short_name: "Объект",
            description: "Завести карточку объекта",
            url: "/properties/new",
            icons: [{ src: "/shortcut-property.png", sizes: "96x96", type: "image/png" }],
          },
          {
            name: "Новый клиент",
            short_name: "Клиент",
            description: "Записать покупателя",
            url: "/clients?new=1",
            icons: [{ src: "/shortcut-client.png", sizes: "96x96", type: "image/png" }],
          },
          {
            name: "Календарь",
            short_name: "Календарь",
            description: "Показы и задачи на сегодня",
            url: "/calendar",
            icons: [{ src: "/shortcut-calendar.png", sizes: "96x96", type: "image/png" }],
          },
          {
            name: "Сообщения",
            short_name: "Сообщения",
            description: "Переписка с клиентами",
            url: "/messages",
            icons: [{ src: "/shortcut-messages.png", sizes: "96x96", type: "image/png" }],
          },
        ],
      },
    }),
  ],
  build: {
    // Раньше цель не задана — Vite собирал под esbuild-дефолт (широкий охват старых
    // браузеров), а это лишний транспиль (лямбды, optional chaining, top-level await)
    // на КАЖДЫЙ чанк. Рабочее приложение открывают с телефонов и компьютеров 2022+,
    // так что цель можно поднять до es2022 — меньше полифиллов и транспиля, отсюда
    // меньше байт и меньше работы у движка на разборе. Сравнение размеров до/после
    // см. в отчёте задачи perf/web-instant-11-09.
    target: "es2022",
    rollupOptions: {
      output: {
        /**
         * Библиотеки — отдельным файлом от нашего кода.
         *
         * Имя файла содержит хеш содержимого, а nginx отдаёт /assets/ с
         * «кэшировать навсегда». Пока react и роутер не обновлялись, их файл при
         * выкате не меняется — сотрудник докачивает только наши изменения, а не
         * полторы сотни килобайт чужого кода заново.
         *
         * Всё в ОДНОМ куске намеренно: react, react-dom и react-router-dom
         * держатся друг за друга (контекст, хуки), и растащенные по разным файлам
         * они ловят порядок инициализации — ошибка вида «Cannot read properties
         * of undefined» на пустом экране, которую не видно ни в сборке, ни в
         * типах. Дробить эту тройку без крайней нужды нельзя.
         */
        /**
         * ПОЧЕМУ ЕЩЁ ТРИ КУСКА (10.09.2026, ревизия входного куска).
         *
         * `lucide-react` — 76 разных иконок из 30 файлов оболочки; меняются они
         * при каждой правке разметки, а сам пакет не обновляется месяцами.
         * Пока иконки лежали вместе с нашим кодом, любая правка экрана
         * инвалидировала их у всех сотрудников.
         *
         * `@royal-home/shared` — бочка с зодовыми схемами (`dist/schemas.js`
         * один весит 123 КБ). Веб берёт оттуда только таблицы подписей и
         * пресеты прав, но у пакета не проставлен `sideEffects`, и вызовы
         * `z.object(...)` на верхнем уровне Rollup считает побочными —
         * отряхнуть их он не может. Отдельным куском они хотя бы не смешаны с
         * нашим кодом и не перекачиваются при каждом выкате.
         *
         * `@tanstack/react-query` и `zustand` — состояние; свой ритм версий,
         * тот же довод про кэш.
         *
         * Куски по-прежнему грузятся при первой загрузке — это про кэш между
         * выкатами, а не про объём. Настоящее уменьшение первого экрана даёт
         * ленивая загрузка (App.tsx, AppLayout.tsx, pages/Dashboard.tsx).
         */
        /**
         * ФУНКЦИЯ, А НЕ ОБЪЕКТ (13.09.2026, переезд на vite 8).
         *
         * Под капотом у vite 8 вместо Rollup работает Rolldown, а он принимает у
         * `manualChunks` ТОЛЬКО функцию: объектная форма `{ имя: [пакеты] }`
         * даёт при сборке `TypeError: manualChunks is not a function`. Смысл
         * разбиения не меняется — те же четыре куска, только имена пакетов
         * сопоставляются с путём модуля, а не перечисляются списком.
         *
         * В список react-vendor добавлены `scheduler` и `@remix-run/router`:
         * раньше Rollup затягивал их сам как зависимости перечисленных пакетов,
         * а при сопоставлении по пути их нужно называть явно — иначе react-dom
         * и его планировщик разъезжаются по разным кускам, и возвращается ровно
         * тот порядок инициализации, от которого этот кусок и защищает.
         */
        manualChunks(id: string) {
          const path = id.replace(/\\/g, "/");

          // Бочка зодовых схем: приходит не из node_modules, а из workspace-пакета.
          if (path.includes("/packages/shared/dist/")) return "shared";

          const pkg = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1];
          if (!pkg) return undefined;

          if (["react", "react-dom", "react-router", "react-router-dom", "scheduler", "@remix-run/router"].includes(pkg))
            return "react-vendor";
          if (pkg === "lucide-react") return "icons";
          if (pkg === "@royal-home/shared") return "shared";
          if (["@tanstack/react-query", "zustand", "use-sync-external-store"].includes(pkg)) return "state-vendor";

          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.VITE_API_PROXY ?? "http://localhost:4000",
      "/uploads": process.env.VITE_API_PROXY ?? "http://localhost:4000",
    },
  },
  // Просмотр боевой сборки. Нужен для двух вещей, которых dev-сервер дать не может:
  // service worker (в dev он не регистрируется, поэтому офлайн-режим на нём не
  // проверить) и отсутствие ленивой компиляции — на dev первый заход в редкий
  // раздел под параллельными e2e иногда не укладывался в таймаут, и падал то один
  // тест, то другой, хотя приложение исправно. Прокси тот же, что у dev.
  preview: {
    port: 4173,
    proxy: {
      "/api": process.env.VITE_API_PROXY ?? "http://localhost:4000",
      "/uploads": process.env.VITE_API_PROXY ?? "http://localhost:4000",
    },
  },
});
